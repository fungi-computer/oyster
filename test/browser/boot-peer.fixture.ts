import { z } from "zod";
import {
  createCdpClient,
  type CdpSocket,
  type Json,
} from "../../src/browser/cdp-client.js";
import type { BrowserSessions } from "../../src/browser/sessions.js";

const frameSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.json()).optional(),
  sessionId: z.string().optional(),
});
export type Sent = z.output<typeof frameSchema>;

export type Scenario = Readonly<{
  origin?: string;
  releaseId?: string;
  /** Chromium context only; Browser Run supplies no context id. */
  contextId?: string;
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

type PageTargetInfo = {
  targetId: string;
  type: "page";
  url: string;
  browserContextId?: string;
};

/** A faithful CDP peer: answers the commands the boot check sends, by method. */
export function bootPeer(scenario: Scenario = {}) {
  const base = `${scenario.origin ?? "https://preview.example.test"}/_boot/${scenario.releaseId ?? "rel_boot01"}`;
  const PARENT = `${base}/index.html`;
  const CANDIDATE = `${base}/candidate/index.html`;
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
        return {
          targetInfos:
            scenario.contextId === undefined
              ? [{ targetId: "page-1", type: "page" }]
              : [
                  {
                    targetId: "foreign",
                    type: "page",
                    browserContextId: "other",
                  },
                  {
                    targetId: "page-1",
                    type: "page",
                    browserContextId: scenario.contextId,
                  },
                ],
        };
      case "Target.attachToTarget": {
        // The browser reports its own explicit attach at browser level.
        const targetInfo: PageTargetInfo = {
          targetId: "page-1",
          type: "page",
          url: "about:blank",
        };
        if (scenario.contextId !== undefined)
          targetInfo.browserContextId = scenario.contextId;
        emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId: "page-session",
            targetInfo,
            waitingForDebugger: false,
          },
        });
        return { sessionId: "page-session" };
      }
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
      const client = createCdpClient(socket);
      return scenario.contextId === undefined
        ? client
        : { ...client, browserContextId: scenario.contextId };
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
    socket,
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
