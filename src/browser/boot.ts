import { parseReleaseId } from "@fungi.computer/puffball";
import { z } from "zod";
import { causeClass } from "../cause-class.js";
import type { CdpClient, Json } from "./cdp-client.js";
import { CloudBrowserTimeout } from "./errors.js";
import { attachPage, navigatePage, pageLocation, type Page } from "./page.js";
import type { BrowserSessions } from "./sessions.js";

/**
 * The host boot check on the shared browser module: open one candidate's
 * capability page, wait for its UI to mount, capture what the page did, and
 * confirm the provider session closed.
 *
 * This is a separate port from the agent browser. It takes only a provider
 * (`BrowserSessions`), never a meter, so a boot check is never billed to a
 * Team, and the agent tool never receives it. It accepts no URL: it builds
 * `<origin>/_boot/<releaseId>/index.html` itself from the host's configured
 * origin. Browser Run also pins that host through a provider guardrail;
 * Chromium contexts have no provider host allowlist. The browser's request gate
 * fails every request whose exact origin (scheme, host, port) differs, on
 * the page and on every frame it admits, before that frame runs. The
 * capability token is added by that gate, and only to exact-origin
 * requests; nothing returned or reported contains it. Cleartext http is
 * accepted only for a loopback origin.
 */

/**
 * The version of this check's judgement. A recorded result is reused only
 * for the same version; changing what counts as mounted, or what is
 * recordable as a verdict, bumps it. v2: a host or transport failure (the
 * parent page not loading, a dropped browser) is never a verdict.
 */
export const BOOT_CHECK_VERSION = "boot-page-v2";

/** One boot check: the host's capability-route origin, the candidate and its token. */
export type BootPageTarget = Readonly<{
  /** The host's configured origin for its `/_boot/` capability route, e.g. `https://oyster.example`. */
  origin: string;
  /** The candidate Release whose host-boot page is opened. */
  releaseId: string;
  /** The capability header the route admits, by name, and its token. */
  capability: Readonly<{ header: string; token: string }>;
  /** The host's boot deadline (epoch ms); cleanup gets one more second. */
  deadlineAt: number;
}>;

/** Why a page that loaded did not count as mounted; the first observed wins. */
export type BootPageFailedPredicate =
  | "unexpected_candidate_request"
  | "response_status"
  | "request_failed"
  | "page_error"
  | "candidate_not_mounted";

/** One failed request, by path only (`out-of-scope` for another origin). */
export type BootPageFailedRequest = Readonly<{
  path: string;
  status?: number;
  failureKind:
    "unexpected_candidate_request" | "response_status" | "request_failed";
}>;

/** Bounded, page-supplied observations; the host's boot gate sanitizes the text. */
export type BootPageDiagnostics = Readonly<{
  failedPredicate: BootPageFailedPredicate;
  finalUrlPath: string;
  consoleErrors: readonly string[];
  pageErrors: readonly string[];
  failedRequests: readonly BootPageFailedRequest[];
  droppedCount: number;
}>;

/** The boot check's closed outcome. */
export type BootPageResult =
  | Readonly<{ kind: "mounted" }>
  | Readonly<{
      kind: "refused";
      code: "ui_mount_failed";
      diagnostics: BootPageDiagnostics;
    }>
  | Readonly<{
      kind: "refused";
      code: "boot_timeout" | "boot_cleanup_failed" | "boot_runner_unavailable";
    }>;

const limits = Object.freeze({
  maxEntriesPerKind: 20,
  maxEntriesTotal: 48,
  maxTextChars: 300,
  maxPathChars: 2_048,
  maxDroppedCount: 1_024,
  maxTrackedRequests: 2_000,
  cleanupGraceMs: 1_000,
  pollMs: 50,
  /** Browser Run's minimum keep-alive; the check itself is far shorter. */
  keepAliveMs: 10_000,
});

/**
 * Runs in an isolated world on the candidate frame: the page shares the DOM
 * but cannot patch the globals this reads. Mounted means a visible body with
 * text or a visible canvas, svg, img or video.
 */
const MOUNT_PROBE = `(() => {
  const body = document.body;
  if (body === null) return false;
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
  };
  if (!visible(body)) return false;
  if (body.innerText.trim().length > 0) return true;
  return Array.from(document.querySelectorAll("canvas,svg,img,video")).some(visible);
})()`;

type Pinned = Readonly<{
  parent: URL;
  candidatePrefix: string;
  /** Only requests under this release's `/_boot/<release>/` path carry the token. */
  releasePath: string;
}>;

/** The one URL a boot check may open, built from host configuration only. */
function pinnedBootUrl(origin: string, releaseId: string): Pinned {
  const base = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) ||
    base.username !== "" ||
    base.password !== "" ||
    base.pathname !== "/" ||
    base.search !== "" ||
    base.hash !== ""
  )
    throw new TypeError(
      "The boot origin must be a bare https origin (http only on loopback)",
    );
  const release = encodeURIComponent(parseReleaseId(releaseId));
  const parent = new URL(`/_boot/${release}/index.html`, base.origin);
  return {
    parent,
    candidatePrefix: new URL(`/_boot/${release}/candidate/`, base.origin).href,
    releasePath: `/_boot/${release}/`,
  };
}

const consoleSchema = z.object({
  type: z.string(),
  args: z.array(
    z.object({
      value: z.json().optional(),
      description: z.string().optional(),
    }),
  ),
});
const exceptionSchema = z.object({
  exceptionDetails: z.object({
    text: z.string(),
    exception: z.object({ description: z.string().optional() }).optional(),
  }),
});
const requestSchema = z.object({
  requestId: z.string(),
  request: z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
});
const responseSchema = z.object({
  requestId: z.string(),
  response: z.object({ url: z.string(), status: z.number().int() }),
});
const loadingFailedSchema = z.object({ requestId: z.string() });
const createdSchema = z.object({
  targetInfo: z.object({
    targetId: z.string(),
    type: z.string(),
    browserContextId: z.string().optional(),
  }),
});
const attachedSchema = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ type: z.string(), url: z.string() }),
});
type FrameNode = Readonly<{
  frame: Readonly<{ id: string; url: string }>;
  childFrames?: readonly FrameNode[];
}>;
const frameNodeSchema: z.ZodType<FrameNode> = z.lazy(() =>
  z.object({
    frame: z.object({ id: z.string(), url: z.string() }),
    childFrames: z.array(frameNodeSchema).optional(),
  }),
);
const frameTreeSchema = z.object({ frameTree: frameNodeSchema });
const isolatedWorldSchema = z.object({ executionContextId: z.number().int() });
const evaluateSchema = z.object({
  result: z.object({ value: z.json().optional() }),
});

/** Bounded observation state for one boot page. */
function createRecorder(origin: string) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: BootPageFailedRequest[] = [];
  const requests = new Map<string, string>();
  let droppedCount = 0;
  let failure: BootPageFailedPredicate | null = null;

  const total = () =>
    consoleErrors.length + pageErrors.length + failedRequests.length;
  const add = <Entry>(list: Entry[], entry: Entry): void => {
    if (
      list.length >= limits.maxEntriesPerKind ||
      total() >= limits.maxEntriesTotal
    )
      droppedCount = Math.min(droppedCount + 1, limits.maxDroppedCount);
    else list.push(entry);
  };
  const text = (value: string) => value.slice(0, limits.maxTextChars);
  const fail = (predicate: BootPageFailedPredicate): void => {
    failure ??= predicate;
  };
  const inScope = (raw: string): URL | null => {
    const parsed = URL.canParse(raw) ? new URL(raw) : null;
    return parsed?.origin === origin ? parsed : null;
  };
  const path = (raw: string): string =>
    inScope(raw)?.pathname.slice(0, limits.maxPathChars) ?? "out-of-scope";

  return {
    inScope: (raw: string) => inScope(raw) !== null,
    path,
    fail,
    get failure() {
      return failure;
    },
    console: (params: Json) => {
      const parsed = consoleSchema.safeParse(params);
      if (!parsed.success || parsed.data.type !== "error") return;
      add(
        consoleErrors,
        text(
          parsed.data.args
            .map((arg) => {
              const literal = z.string().safeParse(arg.value);
              return literal.success
                ? literal.data
                : (arg.description ?? JSON.stringify(arg.value ?? null));
            })
            .join(" "),
        ),
      );
    },
    exception: (params: Json) => {
      const parsed = exceptionSchema.safeParse(params);
      if (!parsed.success) return;
      const details = parsed.data.exceptionDetails;
      add(pageErrors, text(details.exception?.description ?? details.text));
      fail("page_error");
    },
    request: (params: Json) => {
      const parsed = requestSchema.safeParse(params);
      if (!parsed.success || requests.size >= limits.maxTrackedRequests) return;
      requests.set(parsed.data.requestId, parsed.data.request.url);
    },
    response: (params: Json) => {
      const parsed = responseSchema.safeParse(params);
      if (!parsed.success) return;
      const { url, status } = parsed.data.response;
      if (status < 400 || !inScope(url)) return;
      add(failedRequests, {
        path: path(url),
        status,
        failureKind: "response_status",
      });
      fail("response_status");
    },
    loadingFailed: (params: Json) => {
      const parsed = loadingFailedSchema.safeParse(params);
      if (!parsed.success) return;
      const url = requests.get(parsed.data.requestId);
      // Blocked foreign requests are already recorded as unexpected.
      if (url === undefined || !inScope(url)) return;
      add(failedRequests, { path: path(url), failureKind: "request_failed" });
      fail("request_failed");
    },
    unexpected: () => {
      add(failedRequests, {
        path: "out-of-scope",
        failureKind: "unexpected_candidate_request",
      });
      fail("unexpected_candidate_request");
    },
    /**
     * A gate answer or child setup the browser did not take. The request or
     * frame cannot complete, so the check cannot pass; the cause is logged
     * code-only, never its message.
     */
    transportFailed: (cause: unknown) => {
      console.warn("Oyster boot check transport", { cause: causeClass(cause) });
      fail("request_failed");
    },
    diagnostics: (
      failedPredicate: BootPageFailedPredicate,
      finalUrlPath: string,
    ): BootPageDiagnostics => ({
      failedPredicate,
      finalUrlPath,
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      failedRequests: [...failedRequests],
      droppedCount,
    }),
  };
}
type Recorder = ReturnType<typeof createRecorder>;

function findFrame(node: FrameNode, prefix: string): string | null {
  for (const child of node.childFrames ?? []) {
    if (child.frame.url.startsWith(prefix)) return child.frame.id;
    const nested = findFrame(child, prefix);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Evaluate the mount probe in an isolated world on the candidate frame,
 * wherever it lives: in the page's own frame tree or, out of process, as
 * the main frame of an admitted child session.
 */
async function candidateMounted(
  client: CdpClient,
  sessionIds: readonly string[],
  candidatePrefix: string,
): Promise<boolean> {
  for (const sessionId of sessionIds) {
    const tree = frameTreeSchema.parse(
      await client.call("Page.getFrameTree", {}, { sessionId }),
    );
    const frameId = tree.frameTree.frame.url.startsWith(candidatePrefix)
      ? tree.frameTree.frame.id
      : findFrame(tree.frameTree, candidatePrefix);
    if (frameId === null) continue;
    const world = isolatedWorldSchema.parse(
      await client.call(
        "Page.createIsolatedWorld",
        { frameId, worldName: "oyster-boot-probe" },
        { sessionId },
      ),
    );
    const evaluated = evaluateSchema.parse(
      await client.call(
        "Runtime.evaluate",
        {
          expression: MOUNT_PROBE,
          contextId: world.executionContextId,
          returnByValue: true,
        },
        { sessionId },
      ),
    );
    if (evaluated.result.value === true) return true;
  }
  return false;
}

/** Install the origin gate and observers on one CDP session of the boot page. */
async function instrument(client: CdpClient, sessionId: string): Promise<void> {
  const options = { sessionId };
  // The origin gate comes first, so no request leaves before it applies.
  await client.call(
    "Fetch.enable",
    { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
    options,
  );
  await client.call("Network.enable", {}, options);
  // A service worker the candidate registers would see in-scope fetches.
  await client.call(
    "Network.setBypassServiceWorker",
    { bypass: true },
    options,
  );
  await client.call("Runtime.enable", {}, options);
  // Frames this target starts wait paused for the same instrumentation.
  await client.call(
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    options,
  );
}

function observe(
  client: CdpClient,
  recorder: Recorder,
  pinned: Pinned,
  target: BootPageTarget,
  children: Set<string>,
  pages: PageTargets,
): () => void {
  const gate = (params: Json, sessionId: string | undefined) => {
    const paused = requestSchema.safeParse(params);
    if (!paused.success) return;
    const { requestId } = paused.data;
    const options = sessionId === undefined ? {} : { sessionId };
    const header = target.capability.header.toLowerCase();
    const { url } = paused.data.request;
    // B4: the token rides only an exact-origin request under this release's
    // boot path, added here; other same-origin requests go without it.
    const headers = Object.entries(paused.data.request.headers ?? {})
      .filter(([name]) => name.toLowerCase() !== header)
      .map(([name, value]) => ({ name, value }));
    if (
      recorder.inScope(url) &&
      new URL(url).pathname.startsWith(pinned.releasePath)
    )
      headers.push({
        name: target.capability.header,
        value: target.capability.token,
      });
    const decision = recorder.inScope(url)
      ? client.call("Fetch.continueRequest", { requestId, headers }, options)
      : (recorder.unexpected(),
        client.call(
          "Fetch.failRequest",
          { requestId, errorReason: "BlockedByClient" },
          options,
        ));
    decision.catch((cause: unknown) => {
      recorder.transportFailed(cause);
    });
  };
  const child = (params: Json, parentSessionId: string | undefined) => {
    // Auto-attached targets are reported on their parent's session; the
    // browser-level event is this check's own explicit attach of the page.
    if (parentSessionId === undefined) return;
    const attached = attachedSchema.safeParse(params);
    if (!attached.success) return;
    const { sessionId, targetInfo } = attached.data;
    // Only an in-scope frame is admitted; anything else stays paused until
    // the session closes, and is reported.
    const blank = targetInfo.url === "" || targetInfo.url === "about:blank";
    if (
      targetInfo.type !== "iframe" ||
      (!blank && !recorder.inScope(targetInfo.url))
    ) {
      recorder.unexpected();
      return;
    }
    // An admitted frame starts paused; it runs only once its origin gate is
    // in place. If that cannot be installed, it never runs.
    (async () => {
      await client.call("Page.enable", {}, { sessionId });
      await instrument(client, sessionId);
      children.add(sessionId);
      await client.call("Runtime.runIfWaitingForDebugger", {}, { sessionId });
    })().catch((cause: unknown) => {
      // The frame stays paused, so it cannot mount; say why, code-only.
      recorder.transportFailed(cause);
    });
  };
  const unsubscribe = [
    client.on("Runtime.consoleAPICalled", (params) => {
      recorder.console(params);
    }),
    client.on("Runtime.exceptionThrown", (params) => {
      recorder.exception(params);
    }),
    client.on("Network.requestWillBeSent", (params) => {
      recorder.request(params);
    }),
    client.on("Network.responseReceived", (params) => {
      recorder.response(params);
    }),
    client.on("Network.loadingFailed", (params) => {
      recorder.loadingFailed(params);
    }),
    client.on("Fetch.requestPaused", gate),
    client.on("Target.attachedToTarget", child),
    client.on("Target.targetCreated", (params) => {
      // Any page other than the ones that existed and the check's own is a
      // page the candidate opened (window.open, with or without an opener),
      // outside every gate.
      const created = createdSchema.safeParse(params);
      if (!created.success || created.data.targetInfo.type !== "page") return;
      if (
        client.browserContextId !== undefined &&
        created.data.targetInfo.browserContextId !== client.browserContextId
      )
        return;
      const { targetId } = created.data.targetInfo;
      if (!pages.sealed) pages.known.add(targetId);
      else if (!pages.known.has(targetId)) recorder.unexpected();
    }),
  ];
  return () => {
    for (const stop of unsubscribe) stop();
  };
}

/** Page targets that existed before the check, plus its own; sealed once attached. */
type PageTargets = { known: Set<string>; sealed: boolean };

async function inspect(
  client: CdpClient,
  pinned: Pinned,
  target: BootPageTarget,
): Promise<BootPageResult> {
  const origin = pinned.parent.origin;
  const recorder = createRecorder(origin);
  const children = new Set<string>();
  const pages: PageTargets = { known: new Set(), sealed: false };
  const stop = observe(client, recorder, pinned, target, children, pages);
  try {
    // Browser-level discovery reports existing pages first, then any page the
    // candidate opens.
    await client.call("Target.setDiscoverTargets", { discover: true });
    const page: Page = await attachPage(client);
    pages.known.add(page.targetId);
    pages.sealed = true;
    await instrument(client, page.cdpSessionId);
    const load = await loads(
      page,
      pinned.parent,
      Math.max(1, target.deadlineAt - Date.now()),
    );
    // The pinned parent is the host's own page. A load still pending at the
    // deadline, a navigation error on it (DNS, TLS, connection) or a browser
    // the provider dropped says nothing about the candidate, which cannot
    // navigate the top page, and is never recorded as its verdict.
    if (load !== "loaded") return { kind: "refused", code: load };
    let mounted = false;
    while (
      recorder.failure === null &&
      Date.now() < target.deadlineAt - limits.pollMs
    ) {
      if (
        await candidateMounted(
          client,
          [page.cdpSessionId, ...children],
          pinned.candidatePrefix,
        )
      ) {
        mounted = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, limits.pollMs));
    }
    if (mounted && recorder.failure === null) return { kind: "mounted" };
    return {
      kind: "refused",
      code: "ui_mount_failed",
      diagnostics: recorder.diagnostics(
        recorder.failure ?? "candidate_not_mounted",
        await finalPath(page, pinned, recorder),
      ),
    };
  } finally {
    stop();
  }
}

/** The page's final URL path, or out-of-scope when it cannot be read. */
async function finalPath(
  page: Page,
  pinned: Pinned,
  recorder: Recorder,
): Promise<string> {
  try {
    return recorder.path((await pageLocation(page, pinned.parent.href)).url);
  } catch {
    return "out-of-scope";
  }
}

/** Whether the pinned page loaded, or why the check cannot judge it. */
async function loads(
  page: Page,
  url: URL,
  timeoutMs: number,
): Promise<"loaded" | "boot_timeout" | "boot_runner_unavailable"> {
  try {
    await navigatePage(page, url, timeoutMs);
    return "loaded";
  } catch (cause) {
    return cause instanceof CloudBrowserTimeout
      ? "boot_timeout"
      : "boot_runner_unavailable";
  }
}

async function beforeDeadline<Value>(
  work: Promise<Value>,
  deadlineAt: number,
): Promise<Value | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(
          () => {
            resolve(null);
          },
          Math.max(0, deadlineAt - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Delete the dedicated session and confirm it ended before the deadline. */
async function closed(
  sessions: BrowserSessions,
  sessionId: string,
  deadlineAt: number,
): Promise<boolean> {
  try {
    const acknowledged = await sessions.release(
      sessionId,
      AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
    );
    if (acknowledged === "closing")
      await sessions.confirmClosed(sessionId, deadlineAt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open one candidate's pinned boot page on a dedicated provider session,
 * wait for its UI to mount, and confirm the session closed. Cleanup
 * uncertainty outranks every other outcome.
 */
export async function checkBootPage(
  sessions: BrowserSessions,
  target: BootPageTarget,
): Promise<BootPageResult> {
  const pinned = pinnedBootUrl(target.origin, target.releaseId);
  let sessionId: string;
  try {
    sessionId = await sessions.create(
      {
        keepAliveMs: limits.keepAliveMs,
        allowedDomains: [pinned.parent.hostname],
      },
      AbortSignal.timeout(Math.max(1, target.deadlineAt - Date.now())),
    );
  } catch {
    return { kind: "refused", code: "boot_runner_unavailable" };
  }
  // The connect is part of the bounded check: a stalled upgrade times out
  // with everything else, and a socket that arrives late is closed undriven.
  const connecting = sessions.connect(
    sessionId,
    AbortSignal.timeout(Math.max(1, target.deadlineAt - Date.now())),
  );
  const lifetime = { expired: false };
  const running = (async (): Promise<BootPageResult | null> => {
    try {
      const client = await connecting;
      if (lifetime.expired) return null;
      return await inspect(client, pinned, target);
    } catch {
      return { kind: "refused", code: "boot_runner_unavailable" };
    }
  })();
  const outcome: BootPageResult = (await beforeDeadline(
    running,
    target.deadlineAt,
  )) ?? { kind: "refused", code: "boot_timeout" };
  lifetime.expired = true;
  connecting.then(
    (client) => {
      client.close();
    },
    () => undefined,
  );
  return (await closed(
    sessions,
    sessionId,
    target.deadlineAt + limits.cleanupGraceMs,
  ))
    ? outcome
    : { kind: "refused", code: "boot_cleanup_failed" };
}
