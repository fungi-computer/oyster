import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkBootPage, type BootPageTarget } from "../../src/browser/boot.js";
import {
  createCdpClient,
  type CdpSocket,
  type Json,
} from "../../src/browser/cdp-client.js";
import type { BrowserSessions } from "../../src/browser/sessions.js";

const ORIGIN = "https://preview.example.test";
const RELEASE = "rel_boot01";
const PARENT = `${ORIGIN}/_boot/${RELEASE}/index.html`;
const CANDIDATE = `${ORIGIN}/_boot/${RELEASE}/candidate/index.html`;
const HEADER = "x-oyster-boot-token";
const TOKEN = "capability-token-not-for-pages";

const frameSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.json()).optional(),
  sessionId: z.string().optional(),
});
type Sent = z.output<typeof frameSchema>;

type Scenario = Readonly<{
  /** What the isolated-world mount probe answers. */
  mounted?: boolean;
  /** Events the page emits while it loads. */
  onLoad?: (emit: (method: string, params: Json) => void) => void;
  release?: "closed" | "closing";
  confirm?: "confirmed" | "unconfirmed";
  navigateError?: string;
  /** The page commits but its load event never fires (a stalled subframe). */
  neverLoads?: boolean;
  /** The provider drops the CDP socket instead of answering this command. */
  dropsAt?: string;
  /** The CDP upgrade never answers until the test lets it. */
  stallConnect?: boolean;
  /** An out-of-process frame at this URL auto-attaches while the page loads. */
  child?: string;
  /** Requests the child frame issues once it runs. */
  onChildRun?: (emit: (method: string, params: Json) => void) => void;
}>;

/** A faithful CDP peer: answers the commands the boot check sends, by method. */
function bootPeer(scenario: Scenario = {}) {
  const sent: Sent[] = [];
  const created: unknown[] = [];
  const released: string[] = [];
  const events = new EventTarget();
  const emit = (message: Json) => {
    queueMicrotask(() => {
      events.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(message) }),
      );
    });
  };
  const pageEvent = (method: string, params: Json) => {
    // Target discovery events arrive at browser level, not on the page.
    emit(
      method === "Target.targetCreated"
        ? { method, params }
        : { method, params, sessionId: "page-session" },
    );
  };
  const answer = (frame: Sent): Json => {
    switch (frame.method) {
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "page-1", type: "page" }] };
      case "Target.attachToTarget":
        // The browser reports its own explicit attach at browser level.
        emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId: "page-session",
            targetInfo: {
              targetId: "page-1",
              type: "page",
              url: "about:blank",
            },
            waitingForDebugger: false,
          },
        });
        return { sessionId: "page-session" };
      case "Target.setDiscoverTargets":
        // Discovery first reports the targets that already exist.
        emit({
          method: "Target.targetCreated",
          params: {
            targetInfo: {
              targetId: "page-1",
              type: "page",
              url: "about:blank",
            },
          },
        });
        return {};
      case "Page.navigate":
        if (scenario.navigateError !== undefined)
          return { frameId: "main", errorText: scenario.navigateError };
        scenario.onLoad?.(pageEvent);
        if (scenario.child !== undefined)
          pageEvent("Target.attachedToTarget", {
            sessionId: "child-session",
            targetInfo: {
              targetId: "frame-2",
              type: "iframe",
              url: scenario.child,
            },
            waitingForDebugger: true,
          });
        if (scenario.neverLoads !== true)
          pageEvent("Page.loadEventFired", { timestamp: 1 });
        return { frameId: "main" };
      case "Page.getFrameTree":
        if (frame.sessionId === "child-session")
          return { frameTree: { frame: { id: "child-main", url: CANDIDATE } } };
        return {
          frameTree: {
            frame: { id: "main", url: PARENT },
            childFrames: [{ frame: { id: "candidate", url: CANDIDATE } }],
          },
        };
      case "Page.createIsolatedWorld":
        return { executionContextId: 7 };
      case "Runtime.runIfWaitingForDebugger":
        scenario.onChildRun?.((method, params) => {
          emit({ method, params, sessionId: "child-session" });
        });
        return {};
      case "Runtime.evaluate":
        return { result: { type: "boolean", value: scenario.mounted ?? true } };
      case "Page.getNavigationHistory":
        return { currentIndex: 0, entries: [{ url: PARENT, title: "Boot" }] };
      default:
        return {};
    }
  };
  let socketClosed = false;
  const socket: CdpSocket = {
    send: (data) => {
      const frame = frameSchema.parse(JSON.parse(data));
      sent.push(frame);
      if (frame.method === scenario.dropsAt) {
        queueMicrotask(() => {
          socketClosed = true;
          events.dispatchEvent(new Event("close"));
        });
        return;
      }
      const result = answer(frame);
      emit(
        frame.sessionId === undefined
          ? { id: frame.id, result }
          : { id: frame.id, result, sessionId: frame.sessionId },
      );
    },
    close: () => {
      socketClosed = true;
      events.dispatchEvent(new Event("close"));
    },
    addEventListener: (type, listener) => {
      events.addEventListener(type, listener);
    },
  };
  const confirms: string[] = [];
  let finishConnect: () => void = () => undefined;
  const connected = new Promise<void>((resolve) => {
    finishConnect = resolve;
  });
  const sessions: BrowserSessions = {
    create: (options) => {
      created.push(options);
      return Promise.resolve("boot-provider-1");
    },
    connect: async () => {
      if (scenario.stallConnect === true) await connected;
      return createCdpClient(socket);
    },
    release: (sessionId) => {
      released.push(sessionId);
      return Promise.resolve(scenario.release ?? "closed");
    },
    confirmClosed: (sessionId) => {
      confirms.push(sessionId);
      return (scenario.confirm ?? "confirmed") === "confirmed"
        ? Promise.resolve()
        : Promise.reject(new Error("unconfirmed"));
    },
  };
  const calls = (method: string) =>
    sent.filter((frame) => frame.method === method);
  const order = (sessionId: string) =>
    sent
      .filter((frame) => frame.sessionId === sessionId)
      .map((frame) => frame.method);
  return {
    sessions,
    sent,
    created,
    released,
    confirms,
    calls,
    order,
    finishConnect: () => {
      finishConnect();
    },
    socketClosed: () => socketClosed,
  };
}

function target(overrides: Partial<BootPageTarget> = {}): BootPageTarget {
  return {
    origin: ORIGIN,
    releaseId: RELEASE,
    capability: { header: HEADER, token: TOKEN },
    deadlineAt: Date.now() + 2_000,
    ...overrides,
  };
}

describe("the boot check opens only its own pinned candidate page", () => {
  it("builds the capability URL itself and pins the provider guardrail to that host", async () => {
    const peer = bootPeer();
    await expect(checkBootPage(peer.sessions, target())).resolves.toEqual({
      kind: "mounted",
    });
    expect(peer.created).toEqual([
      expect.objectContaining({ allowedDomains: ["preview.example.test"] }),
    ]);
    expect(peer.calls("Page.navigate").map((frame) => frame.params)).toEqual([
      { url: PARENT },
    ]);
  });

  it("adds the capability token only to exact-origin requests, in the request gate", async () => {
    const paused = (requestId: string, url: string) => ({
      requestId,
      request: { url, method: "GET", headers: { accept: "*/*" } },
    });
    const peer = bootPeer({
      onLoad: (emit) => {
        emit("Fetch.requestPaused", paused("same", CANDIDATE));
        emit(
          "Fetch.requestPaused",
          paused("other-port", "https://preview.example.test:8443/x"),
        );
        emit(
          "Fetch.requestPaused",
          paused("other-scheme", "http://preview.example.test/x"),
        );
        emit(
          "Fetch.requestPaused",
          paused("foreign", "https://elsewhere.example/x"),
        );
      },
    });
    await checkBootPage(peer.sessions, target());
    expect(peer.calls("Network.setExtraHTTPHeaders")).toEqual([]);
    expect(
      peer.calls("Fetch.continueRequest").map((frame) => frame.params),
    ).toEqual([
      {
        requestId: "same",
        headers: [
          { name: "accept", value: "*/*" },
          { name: HEADER, value: TOKEN },
        ],
      },
    ]);
    expect(
      peer.calls("Fetch.failRequest").map((frame) => frame.params?.requestId),
    ).toEqual(["other-port", "other-scheme", "foreign"]);
    const carriers = peer.sent.filter((frame) =>
      JSON.stringify(frame).includes(TOKEN),
    );
    expect(carriers.map((frame) => frame.params?.requestId)).toEqual(["same"]);
  });

  it("adds the token only under this release's /_boot/ path; other same-origin paths go without it", async () => {
    const peer = bootPeer({
      onLoad: (emit) => {
        emit("Fetch.requestPaused", {
          requestId: "api",
          request: { url: `${ORIGIN}/api/apps`, method: "GET", headers: {} },
        });
        emit("Fetch.requestPaused", {
          requestId: "other-release",
          request: {
            url: `${ORIGIN}/_boot/rel_other/index.html`,
            method: "GET",
            headers: {},
          },
        });
      },
    });
    await checkBootPage(peer.sessions, target());
    expect(
      peer.calls("Fetch.continueRequest").map((frame) => frame.params),
    ).toEqual([
      { requestId: "api", headers: [] },
      { requestId: "other-release", headers: [] },
    ]);
  });

  it("records a popup page the candidate opens as unexpected", async () => {
    const peer = bootPeer({
      onLoad: (emit) => {
        emit("Target.targetCreated", {
          targetInfo: {
            targetId: "popup-1",
            type: "page",
            url: "https://elsewhere.example/",
            openerId: "page-1",
          },
        });
      },
    });
    await expect(checkBootPage(peer.sessions, target())).resolves.toMatchObject(
      {
        kind: "refused",
        code: "ui_mount_failed",
        diagnostics: { failedPredicate: "unexpected_candidate_request" },
      },
    );
    expect(peer.calls("Target.setDiscoverTargets")).toEqual([
      expect.objectContaining({ params: { discover: true } }),
    ]);
  });

  it("records a noopener popup, which carries no opener id, as unexpected", async () => {
    const peer = bootPeer({
      onLoad: (emit) => {
        emit("Target.targetCreated", {
          targetInfo: {
            targetId: "popup-2",
            type: "page",
            url: "https://elsewhere.example/",
          },
        });
      },
    });
    await expect(checkBootPage(peer.sessions, target())).resolves.toMatchObject(
      {
        kind: "refused",
        code: "ui_mount_failed",
        diagnostics: { failedPredicate: "unexpected_candidate_request" },
      },
    );
  });

  it("bypasses service workers on the boot session", async () => {
    const peer = bootPeer();
    await checkBootPage(peer.sessions, target());
    expect(peer.calls("Network.setBypassServiceWorker")).toEqual([
      expect.objectContaining({
        params: { bypass: true },
        sessionId: "page-session",
      }),
    ]);
  });

  it("allows cleartext http only for a loopback origin", async () => {
    const remote = bootPeer();
    await expect(
      checkBootPage(
        remote.sessions,
        target({ origin: "http://preview.example.test" }),
      ),
    ).rejects.toThrow();
    expect(remote.created).toEqual([]);
    const loopback = bootPeer();
    await expect(
      checkBootPage(
        loopback.sessions,
        target({
          origin: "http://127.0.0.1:8787",
          deadlineAt: Date.now() + 200,
        }),
      ),
    ).resolves.toMatchObject({ kind: "refused" });
    expect(loopback.created).toEqual([
      expect.objectContaining({ allowedDomains: ["127.0.0.1"] }),
    ]);
  });

  it("refuses an origin that is not a bare http(s) origin, before any provider call", async () => {
    for (const origin of [
      "https://preview.example.test/other/",
      "file:///etc",
      "https://user:pw@preview.example.test",
    ]) {
      const peer = bootPeer();
      await expect(
        checkBootPage(peer.sessions, target({ origin })),
      ).rejects.toThrow();
      expect(peer.created).toEqual([]);
    }
  });

  it("lets same-origin requests through and fails every other origin in the browser", async () => {
    const peer = bootPeer({
      onLoad: (emit) => {
        emit("Fetch.requestPaused", {
          requestId: "same",
          request: { url: CANDIDATE, method: "GET", headers: {} },
        });
        emit("Fetch.requestPaused", {
          requestId: "foreign",
          request: {
            url: "https://elsewhere.example/beacon",
            method: "GET",
            headers: {},
          },
        });
      },
    });
    const result = await checkBootPage(peer.sessions, target());
    expect(
      peer
        .calls("Fetch.continueRequest")
        .map((frame) => frame.params?.requestId),
    ).toEqual(["same"]);
    expect(
      peer.calls("Fetch.failRequest").map((frame) => frame.params),
    ).toEqual([{ requestId: "foreign", errorReason: "BlockedByClient" }]);
    expect(result).toMatchObject({
      kind: "refused",
      code: "ui_mount_failed",
      diagnostics: {
        failedPredicate: "unexpected_candidate_request",
        failedRequests: [
          { path: "out-of-scope", failureKind: "unexpected_candidate_request" },
        ],
      },
    });
  });
});

describe("the boot check reports what the page did", () => {
  it("captures console errors, page errors, failed requests and the final URL path", async () => {
    const peer = bootPeer({
      onLoad: (emit) => {
        emit("Runtime.consoleAPICalled", {
          type: "error",
          args: [{ type: "string", value: "Candidate failed to load" }],
        });
        emit("Runtime.consoleAPICalled", {
          type: "log",
          args: [{ type: "string", value: "just a log" }],
        });
        emit("Runtime.exceptionThrown", {
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "Error: Candidate module threw" },
          },
        });
        emit("Network.requestWillBeSent", {
          requestId: "asset",
          request: {
            url: `${ORIGIN}/_boot/${RELEASE}/candidate/assets/main.js`,
          },
        });
        emit("Network.responseReceived", {
          requestId: "asset",
          response: {
            url: `${ORIGIN}/_boot/${RELEASE}/candidate/assets/main.js`,
            status: 404,
          },
        });
      },
    });
    await expect(checkBootPage(peer.sessions, target())).resolves.toEqual({
      kind: "refused",
      code: "ui_mount_failed",
      diagnostics: {
        failedPredicate: "page_error",
        finalUrlPath: `/_boot/${RELEASE}/index.html`,
        consoleErrors: ["Candidate failed to load"],
        pageErrors: ["Error: Candidate module threw"],
        failedRequests: [
          {
            path: `/_boot/${RELEASE}/candidate/assets/main.js`,
            status: 404,
            failureKind: "response_status",
          },
        ],
        droppedCount: 0,
      },
    });
  });

  it("reports candidate_not_mounted when the probe never sees content by the deadline", async () => {
    const peer = bootPeer({ mounted: false });
    await expect(
      checkBootPage(peer.sessions, target({ deadlineAt: Date.now() + 300 })),
    ).resolves.toMatchObject({
      kind: "refused",
      code: "ui_mount_failed",
      diagnostics: { failedPredicate: "candidate_not_mounted" },
    });
  });

  it("probes the candidate frame in an isolated world", async () => {
    const peer = bootPeer();
    await checkBootPage(peer.sessions, target());
    expect(
      peer.calls("Page.createIsolatedWorld").map((frame) => frame.params),
    ).toEqual([expect.objectContaining({ frameId: "candidate" })]);
    expect(peer.calls("Runtime.evaluate")[0]?.params).toMatchObject({
      contextId: 7,
      returnByValue: true,
    });
  });

  it("reports the host's own boot page failing to load as unavailable, never as the candidate's failure", async () => {
    // The pinned parent page is the host's: a DNS, TLS or connection failure
    // on it says nothing about the candidate, which cannot navigate the top
    // page, and must not become the Release's recorded verdict.
    const peer = bootPeer({ navigateError: "net::ERR_NAME_NOT_RESOLVED" });
    await expect(checkBootPage(peer.sessions, target())).resolves.toEqual({
      kind: "refused",
      code: "boot_runner_unavailable",
    });
    expect(peer.released).toEqual(["boot-provider-1"]);
  });

  it("reports a page still loading at the deadline as not checked, never as a mount failure", async () => {
    // A slow provider can leave too little of the deadline for the page to
    // finish loading: that is inconclusive, and must not be recorded as the
    // Release's verdict.
    const peer = bootPeer({ neverLoads: true });
    await expect(
      checkBootPage(peer.sessions, target({ deadlineAt: Date.now() + 300 })),
    ).resolves.toEqual({ kind: "refused", code: "boot_timeout" });
    expect(peer.released).toEqual(["boot-provider-1"]);
  });

  it.each(["Page.navigate", "Page.getNavigationHistory"])(
    "reports a provider that drops the browser during %s as unavailable, never as a mount failure",
    async (dropsAt) => {
      // Losing the CDP connection says nothing about the candidate: it is
      // inconclusive, so it must never become the Release's recorded verdict.
      const peer = bootPeer({ dropsAt });
      await expect(checkBootPage(peer.sessions, target())).resolves.toEqual({
        kind: "refused",
        code: "boot_runner_unavailable",
      });
      expect(peer.released).toEqual(["boot-provider-1"]);
    },
  );
});

describe("the boot check confirms its own teardown", () => {
  it("releases its dedicated session and confirms a 'closing' acknowledgement", async () => {
    const peer = bootPeer({ release: "closing", confirm: "confirmed" });
    await expect(checkBootPage(peer.sessions, target())).resolves.toEqual({
      kind: "mounted",
    });
    expect(peer.released).toEqual(["boot-provider-1"]);
    expect(peer.confirms).toEqual(["boot-provider-1"]);
  });

  it("refuses with boot_cleanup_failed when closure is not confirmed, even if it mounted", async () => {
    const peer = bootPeer({ release: "closing", confirm: "unconfirmed" });
    await expect(checkBootPage(peer.sessions, target())).resolves.toEqual({
      kind: "refused",
      code: "boot_cleanup_failed",
    });
  });
});

describe("the boot check bounds and gates every phase", () => {
  it("bounds a stalled CDP connect by the boot deadline and still releases the created session", async () => {
    const peer = bootPeer({ stallConnect: true });
    await expect(
      checkBootPage(peer.sessions, target({ deadlineAt: Date.now() + 200 })),
    ).resolves.toEqual({ kind: "refused", code: "boot_timeout" });
    expect(peer.released).toEqual(["boot-provider-1"]);
    // A socket that arrives after the deadline is closed, never driven.
    peer.finishConnect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peer.socketClosed()).toBe(true);
    expect(peer.sent).toEqual([]);
  });

  it("enables its request gate before the page navigates", async () => {
    const peer = bootPeer();
    await checkBootPage(peer.sessions, target());
    const page = peer.order("page-session");
    expect(page.indexOf("Fetch.enable")).toBeGreaterThanOrEqual(0);
    expect(page.indexOf("Fetch.enable")).toBeLessThan(
      page.indexOf("Page.navigate"),
    );
  });

  it("holds an in-scope child frame paused until its gate is in place, then gates its requests", async () => {
    // Not mounted: the check keeps observing while the child frame runs.
    const peer = bootPeer({
      mounted: false,
      child: CANDIDATE,
      onChildRun: (emit) => {
        emit("Fetch.requestPaused", {
          requestId: "child-same",
          request: {
            url: `${ORIGIN}/_boot/${RELEASE}/candidate/app.js`,
            method: "GET",
            headers: {},
          },
        });
        emit("Fetch.requestPaused", {
          requestId: "child-foreign",
          request: {
            url: "https://elsewhere.example/leak",
            method: "GET",
            headers: {},
          },
        });
      },
    });
    await checkBootPage(
      peer.sessions,
      target({ deadlineAt: Date.now() + 300 }),
    );
    expect(peer.calls("Target.setAutoAttach")[0]?.params).toMatchObject({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    const child = peer.order("child-session");
    expect(child.indexOf("Fetch.enable")).toBeGreaterThanOrEqual(0);
    expect(child.indexOf("Fetch.enable")).toBeLessThan(
      child.indexOf("Network.setBypassServiceWorker"),
    );
    expect(child.indexOf("Network.setBypassServiceWorker")).toBeLessThan(
      child.indexOf("Runtime.runIfWaitingForDebugger"),
    );
    expect(child).not.toContain("Network.setExtraHTTPHeaders");
    const childFrames = peer.sent.filter(
      (frame) => frame.sessionId === "child-session",
    );
    const tokenCarriers = childFrames.filter((frame) =>
      JSON.stringify(frame).includes(TOKEN),
    );
    expect(tokenCarriers.map((frame) => frame.params?.requestId)).toEqual([
      "child-same",
    ]);
    expect(
      childFrames
        .filter((frame) => frame.method === "Fetch.failRequest")
        .map((frame) => frame.params?.requestId),
    ).toEqual(["child-foreign"]);
  });

  it("never resumes a child target from another origin, and reports it", async () => {
    const peer = bootPeer({ child: "https://elsewhere.example/frame.html" });
    await expect(checkBootPage(peer.sessions, target())).resolves.toMatchObject(
      {
        kind: "refused",
        code: "ui_mount_failed",
        diagnostics: { failedPredicate: "unexpected_candidate_request" },
      },
    );
    expect(peer.order("child-session")).not.toContain(
      "Runtime.runIfWaitingForDebugger",
    );
  });
});
