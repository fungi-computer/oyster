import {
  CapabilityFailed,
  Mycelium,
  type CapabilitySource,
  type ModuleDefinition,
} from "@fungi.computer/mycelium";
import { z } from "zod";
import {
  clickInputSchema,
  closeInputSchema,
  extractInputSchema,
  leaseAckSchema,
  markdownInputSchema,
  navigateInputSchema,
  openInputSchema,
  pressInputSchema,
  scrapeInputSchema,
  scrollInputSchema,
  snapshotInputSchema,
  typeInputSchema,
  urlInputSchema,
  markdownResultSchema,
  linksResultSchema,
  scrapeResultSchema,
  extractResultSchema,
  openResultSchema,
  navigateResultSchema,
  snapshotResultSchema,
  closeResultSchema,
  type CloudBrowserOperation,
  type CloudBrowserOperationResult,
} from "./operations.js";
import {
  CloudBrowserCapacityExceeded,
  CloudBrowserCreditDenied,
  CloudBrowserLeaseNotFound,
  CloudBrowserLeasePaused,
  CloudBrowserTimeout,
  CloudBrowserUnavailable,
  CloudBrowserUpstreamError,
  CloudBrowserUrlDenied,
  type CloudBrowserFailure,
} from "./errors.js";
import type { LeaseOwner } from "./lease-registry.js";

/**
 * The `cloudBrowser` Mycelium module: a work browser for reading and driving
 * public pages. To show the member something, use the Session browser
 * tools. Quick Reads (`markdown`/`links`/`scrape`/`extract`) need no open
 * session; `open`..`close` share one driven session by `leaseId`.
 * `screenshot`/`pdf` save to a named Computer path instead of returning
 * bytes, and `handoff` asks a Team member to drive the page for a login or
 * captcha, through the existing `handoff` card, never a CDP URL.
 */

/**
 * The one source of truth for every `cloudBrowser` description: the module
 * itself and each operation. `cloud-browser-descriptions.test.ts` imports
 * this and asserts every entry stays under 1000 characters (the acceptance
 * criterion in `issues/retained-features-v1/02-*.md`); the guard right below
 * repeats that check at import time so a regression fails fast either way.
 */
export const CLOUD_BROWSER_DESCRIPTIONS = Object.freeze({
  module:
    "A work browser for reading and driving public pages. markdown/links/scrape/extract " +
    "need no session. open/navigate/snapshot/click/type/press/scroll drive one session by " +
    "leaseId; screenshot/pdf save to a Computer path (bytes never enter this transcript). " +
    "handoff asks a Team member to take over for a login or captcha; close ends the lease. " +
    "To show the member something yourself, use the Session browser tools, not this.",
  markdown:
    "Render a JavaScript page and return it as markdown, truncated to maxChars (default 20000).",
  links: "Render a page and return up to 500 links found on it.",
  scrape:
    "Render a page and return matched elements for up to 10 CSS selectors, bounded to 64 KiB.",
  extract: "Render a page and extract structured data matching a prompt.",
  open: "Open a driven browser session, optionally navigating to a URL, and return its leaseId.",
  navigate: "Navigate an open session's page to a URL.",
  snapshot:
    "Read an open session's page as a bounded accessibility-tree text summary.",
  click: "Click at a viewport pixel coordinate in an open session.",
  type: "Insert text at the current focus in an open session.",
  press: 'Press one key (e.g. "Enter", "Tab") in an open session.',
  scroll: "Scroll an open session's page by a pixel delta.",
  screenshot:
    "Capture a PNG screenshot of an open session's page and save it to a Computer path; returns the saved byte count, never the bytes.",
  pdf: "Render an open session's page to PDF and save it to a Computer path; returns the saved byte count, never the bytes.",
  handoff:
    "Ask a Team member to take over an open session for a login or captcha; a card appears in the conversation and the run continues once they finish.",
  close: "End a driven session and release its lease.",
} as const);

for (const [name, text] of Object.entries(CLOUD_BROWSER_DESCRIPTIONS))
  if (text.length >= 1000)
    throw new Error(
      `cloudBrowser.${name} description must stay under 1000 characters`,
    );

function isCloudBrowserFailure(cause: unknown): cause is CloudBrowserFailure {
  return (
    cause instanceof CloudBrowserUrlDenied ||
    cause instanceof CloudBrowserUpstreamError ||
    cause instanceof CloudBrowserTimeout ||
    cause instanceof CloudBrowserLeaseNotFound ||
    cause instanceof CloudBrowserLeasePaused ||
    cause instanceof CloudBrowserCapacityExceeded ||
    cause instanceof CloudBrowserCreditDenied ||
    cause instanceof CloudBrowserUnavailable
  );
}

/** Map the closed cloud-browser failure union onto Mycelium's admitted diagnostic. */
function cloudBrowserFailureMessage(error: CloudBrowserFailure): string {
  switch (error._tag) {
    case "CloudBrowserUrlDenied":
      return error.message;
    case "CloudBrowserUpstreamError":
      return `the cloud browser could not complete ${error.op}`;
    case "CloudBrowserTimeout":
      return `${error.op} did not answer in time`;
    case "CloudBrowserLeaseNotFound":
      return "that leaseId is not open for this session; call open first";
    case "CloudBrowserLeasePaused":
      return "a Team member is driving this lease; wait for them to finish";
    case "CloudBrowserCapacityExceeded":
      return "this Team has too many cloud browsers open at once; close one first";
    case "CloudBrowserCreditDenied":
      return "this Team has no credit for cloud browser time";
    case "CloudBrowserUnavailable":
      return error.reason === "paused"
        ? "the cloud browser is turned off for this deployment"
        : "the cloud browser is not configured";
  }
}

function toCapabilityFailed(
  operation: string,
  cause: unknown,
): CapabilityFailed {
  if (cause instanceof CapabilityFailed) return cause;
  if (isCloudBrowserFailure(cause))
    return new CapabilityFailed({
      namespace: "cloudBrowser",
      operation,
      cause: {
        kind:
          cause._tag === "CloudBrowserUrlDenied"
            ? "InvalidInput"
            : cause._tag === "CloudBrowserLeaseNotFound"
              ? "InvalidInput"
              : "Unavailable",
        message: cloudBrowserFailureMessage(cause),
      },
      rawCause: cause,
    });
  return new CapabilityFailed({
    namespace: "cloudBrowser",
    operation,
    cause: { kind: "Unavailable", message: "the cloud browser failed" },
    rawCause: cause,
  });
}

const destinationSchema = z.strictObject({
  leaseId: leaseAckSchema.shape.leaseId,
  computerId: z.string().min(1).max(256),
  path: z.string().min(1).max(1024),
});
const destinationResultSchema = z.strictObject({
  leaseId: z.string(),
  computerId: z.string(),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});
const handoffResultSchema = z.strictObject({
  status: z.literal("handed_off"),
});

/**
 * The host's door for screenshot/PDF bytes: a named path on a Computer the
 * Agent is attached to. The model only ever receives the saved byte count.
 */
export type SaveBrowserFile = (
  input: Readonly<{
    computerId: string;
    path: string;
    bytes: Uint8Array;
    contentType: string;
  }>,
) => Promise<Readonly<{ computerId: string; path: string; bytes: number }>>;

/** The agent-facing slice of `Browser`, possibly behind a host RPC hop. */
export type AgentBrowserDoor = Readonly<{
  /** One agent operation, bound to the Session's lease owner. */
  call: (
    owner: LeaseOwner,
    op: CloudBrowserOperation,
    signal: AbortSignal,
  ) => Promise<CloudBrowserOperationResult>;
  /** Pause the owner's lease for a Team member. */
  handoff: (owner: LeaseOwner, leaseId: string) => Promise<void>;
}>;

type SessionBrowser = Readonly<{
  call: (
    op: CloudBrowserOperation,
    signal: AbortSignal,
  ) => Promise<CloudBrowserOperationResult>;
  quickReads: boolean;
  saveFile: SaveBrowserFile | null;
  handoff: ((leaseId: string, reason: string) => Promise<void>) | null;
}>;

/** The registrations one host offers, in the shape `Mycelium.module` reads. */
type OfferedOperations = {
  -readonly [
    Name in keyof ModuleDefinition["operations"]
  ]: ModuleDefinition["operations"][Name];
};

/** Build the `cloudBrowser` module once a Session identity is known. */
function buildCloudBrowserModule(options: SessionBrowser) {
  /** Run one call, mapping any thrown failure and parsing the result through `schema`. */
  async function run<T, I>(
    operation: string,
    schema: z.ZodType<T>,
    action: () => Promise<I>,
  ): Promise<T> {
    try {
      return schema.parse(await action());
    } catch (error) {
      throw toCapabilityFailed(operation, error);
    }
  }

  const binaryResultSchema = z.strictObject({
    leaseId: z.string(),
    bytes: z.instanceof(Uint8Array),
    contentType: z.string(),
  });

  function saveBinary(saveFile: SaveBrowserFile) {
    return async (
      operation: "screenshot" | "pdf",
      leaseId: string,
      computerId: string,
      path: string,
      defaultContentType: string,
      signal: AbortSignal,
    ) => {
      const raw = await run(operation, binaryResultSchema, () =>
        options.call({ kind: operation, leaseId }, signal),
      );
      try {
        const saved = await saveFile({
          computerId,
          path,
          bytes: raw.bytes,
          contentType: raw.contentType || defaultContentType,
        });
        return destinationResultSchema.parse({ leaseId, ...saved });
      } catch (error) {
        throw toCapabilityFailed(operation, error);
      }
    };
  }

  function saveOperations(saveFile: SaveBrowserFile) {
    const save = saveBinary(saveFile);
    return {
      screenshot: Mycelium.operation({
        replay: "unsafe",
        description: CLOUD_BROWSER_DESCRIPTIONS.screenshot,
        input: destinationSchema,
        output: destinationResultSchema,
        execute: (input, context) =>
          save(
            "screenshot",
            input.leaseId,
            input.computerId,
            input.path,
            "image/png",
            context.signal,
          ),
      }),
      pdf: Mycelium.operation({
        replay: "unsafe",
        description: CLOUD_BROWSER_DESCRIPTIONS.pdf,
        input: destinationSchema,
        output: destinationResultSchema,
        execute: (input, context) =>
          save(
            "pdf",
            input.leaseId,
            input.computerId,
            input.path,
            "application/pdf",
            context.signal,
          ),
      }),
    };
  }

  function handoffOperation(
    handoff: (leaseId: string, reason: string) => Promise<void>,
  ) {
    return {
      handoff: Mycelium.operation({
        replay: "unsafe",
        description: CLOUD_BROWSER_DESCRIPTIONS.handoff,
        input: z.strictObject({
          leaseId: leaseAckSchema.shape.leaseId,
          reason: z.string().min(1).max(500),
        }),
        output: handoffResultSchema,
        execute: (input) =>
          run("handoff", handoffResultSchema, async () => {
            await handoff(input.leaseId, input.reason);
            return { status: "handed_off" };
          }),
      }),
    };
  }

  const quickReads = {
    markdown: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.markdown,
      input: markdownInputSchema,
      output: markdownResultSchema,
      execute: (input, context) =>
        run("markdown", markdownResultSchema, () =>
          options.call({ kind: "markdown", input }, context.signal),
        ),
    }),
    links: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.links,
      input: urlInputSchema,
      output: linksResultSchema,
      execute: (input, context) =>
        run("links", linksResultSchema, () =>
          options.call({ kind: "links", url: input.url }, context.signal),
        ),
    }),
    scrape: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.scrape,
      input: scrapeInputSchema,
      output: scrapeResultSchema,
      execute: (input, context) =>
        run("scrape", scrapeResultSchema, () =>
          options.call({ kind: "scrape", input }, context.signal),
        ),
    }),
    extract: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.extract,
      input: extractInputSchema,
      output: extractResultSchema,
      execute: (input, context) =>
        run("extract", extractResultSchema, () =>
          options.call({ kind: "extract", input }, context.signal),
        ),
    }),
  };
  const driven = {
    open: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.open,
      input: openInputSchema,
      output: openResultSchema,
      execute: (input, context) =>
        run("open", openResultSchema, () =>
          options.call({ kind: "open", url: input.url }, context.signal),
        ),
    }),
    navigate: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.navigate,
      input: navigateInputSchema,
      output: navigateResultSchema,
      execute: (input, context) =>
        run("navigate", navigateResultSchema, () =>
          options.call(
            { kind: "navigate", leaseId: input.leaseId, url: input.url },
            context.signal,
          ),
        ),
    }),
    snapshot: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.snapshot,
      input: snapshotInputSchema,
      output: snapshotResultSchema,
      execute: (input, context) =>
        run("snapshot", snapshotResultSchema, () =>
          options.call(
            { kind: "snapshot", leaseId: input.leaseId },
            context.signal,
          ),
        ),
    }),
    click: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.click,
      input: clickInputSchema,
      output: leaseAckSchema,
      execute: (input, context) =>
        run("click", leaseAckSchema, () =>
          options.call(
            { kind: "click", leaseId: input.leaseId, x: input.x, y: input.y },
            context.signal,
          ),
        ),
    }),
    type: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.type,
      input: typeInputSchema,
      output: leaseAckSchema,
      execute: (input, context) =>
        run("type", leaseAckSchema, () =>
          options.call(
            { kind: "type", leaseId: input.leaseId, text: input.text },
            context.signal,
          ),
        ),
    }),
    press: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.press,
      input: pressInputSchema,
      output: leaseAckSchema,
      execute: (input, context) =>
        run("press", leaseAckSchema, () =>
          options.call(
            { kind: "press", leaseId: input.leaseId, key: input.key },
            context.signal,
          ),
        ),
    }),
    scroll: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.scroll,
      input: scrollInputSchema,
      output: leaseAckSchema,
      execute: (input, context) =>
        run("scroll", leaseAckSchema, () =>
          options.call(
            {
              kind: "scroll",
              leaseId: input.leaseId,
              deltaX: input.deltaX,
              deltaY: input.deltaY,
            },
            context.signal,
          ),
        ),
    }),
    close: Mycelium.operation({
      replay: "unsafe",
      description: CLOUD_BROWSER_DESCRIPTIONS.close,
      input: closeInputSchema,
      output: closeResultSchema,
      execute: (input, context) =>
        run("close", closeResultSchema, () =>
          options.call(
            { kind: "close", leaseId: input.leaseId },
            context.signal,
          ),
        ),
    }),
  };

  // The host offers only what it has: Quick Reads, a Computer to save to and
  // a member to hand off to are each optional; driven sessions never are.
  const operations: OfferedOperations = { ...driven };
  if (options.quickReads) Object.assign(operations, quickReads);
  if (options.saveFile !== null)
    Object.assign(operations, saveOperations(options.saveFile));
  if (options.handoff !== null)
    Object.assign(operations, handoffOperation(options.handoff));
  return Mycelium.module({
    id: "cloud-browser",
    name: "cloudBrowser",
    description: CLOUD_BROWSER_DESCRIPTIONS.module,
    operations,
  });
}

/**
 * Compose the `cloudBrowser` source for one Session, on either host. `browser`
 * is the module's lease door (in-process, or the Hub's egress RPC); `saveFile`
 * is the host's Computer bytes writer and `requestHandoff` its "needs you"
 * card. A host without one passes `null` and the matching operations are not
 * offered. A lease needs a Session identity, so a session-free host (e.g. the
 * MCP execute path) gets no module at all.
 */
export function browserCapabilitySource(
  deps: Readonly<{
    identity: () => Readonly<{ teamId: string; agentId: string }> | null;
    browser: AgentBrowserDoor;
    quickReads: boolean;
    saveFile: SaveBrowserFile | null;
    requestHandoff: ((sessionId: string, reason: string) => void) | null;
  }>,
): CapabilitySource {
  return {
    id: "cloud-browser",
    acquire: ({ signal, session }) => {
      signal.throwIfAborted();
      const sessionId = session?.sessionId;
      const identity = deps.identity();
      if (sessionId === undefined || identity === null)
        return Promise.resolve({
          snapshot: { version: "0", modules: [] },
          release: () => Promise.resolve(),
        });
      const owner: LeaseOwner = {
        teamId: identity.teamId,
        agentId: identity.agentId,
        sessionId,
      };
      const requestHandoff = deps.requestHandoff;
      const registration = buildCloudBrowserModule({
        call: (op, opSignal) => deps.browser.call(owner, op, opSignal),
        quickReads: deps.quickReads,
        saveFile: deps.saveFile,
        handoff:
          requestHandoff === null
            ? null
            : async (leaseId, reason) => {
                await deps.browser.handoff(owner, leaseId);
                requestHandoff(sessionId, `cloud browser: ${reason}`);
              },
      });
      return Promise.resolve({
        snapshot: { version: "cloud-browser-v1", modules: [registration] },
        release: () => Promise.resolve(),
      });
    },
  };
}
