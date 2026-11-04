import { Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { describe, expect, it } from "vitest";
import {
  browserCapabilitySource,
  CloudBrowserLeaseNotFound,
  liveView,
  liveViewPaths,
  type BrowserMemberAction,
  type BrowserHandoffPorts,
} from "../../src/browser/index.js";

const signal = new AbortController().signal;
const paths = liveViewPaths("/agents/agent-a/cloud-browser/lease_1");

function recordingDoor(frame: Uint8Array | null = new Uint8Array([1, 2, 3])) {
  const actions: BrowserMemberAction[] = [];
  return {
    actions,
    door: (action: BrowserMemberAction) => {
      actions.push(action);
      return Promise.resolve(
        action.kind === "screenshot" && frame !== null
          ? { leaseId: "lease_1", bytes: frame, contentType: "image/png" }
          : null,
      );
    },
  };
}

const request = (body: string) =>
  new Request("https://oyster.test/input", { method: "POST", body });
const post = (body: Readonly<Record<string, string | number>>) =>
  request(JSON.stringify(body));

describe("the shared cloud-browser live view", () => {
  it("serves a page whose fetches are same-origin paths with no bearer or CDP URL", async () => {
    const { door } = recordingDoor();
    const response = liveView(door, paths, () => undefined).page();
    const html = await response.text();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain(paths.frame);
    expect(html).toContain(paths.input);
    expect(html).not.toMatch(/bearer|authorization|wss?:\/\//i);
  });

  it("serves a PNG frame and forwards click, type, scroll and resume", async () => {
    const { door, actions } = recordingDoor();
    const view = liveView(door, paths, () => undefined);
    const frame = await view.frame(signal);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await frame.arrayBuffer())]).toEqual([1, 2, 3]);
    const sent: readonly Readonly<Record<string, string | number>>[] = [
      { kind: "click", x: 10, y: 20 },
      { kind: "type", text: "hello" },
      { kind: "scroll", deltaY: 40 },
      { kind: "resume" },
    ];
    for (const action of sent)
      expect((await view.input(post(action), signal)).status).toBe(200);
    expect(actions).toEqual([
      { kind: "screenshot" },
      { kind: "click", x: 10, y: 20 },
      { kind: "type", text: "hello" },
      { kind: "scroll", deltaX: 0, deltaY: 40 },
      { kind: "resume" },
    ]);
  });

  it.each([
    ["an unknown action", '{"kind":"eval","code":"1"}'],
    ["an out-of-range click", '{"kind":"click","x":-1,"y":0}'],
    ["an extra field", '{"kind":"type","text":"a","url":"wss://x"}'],
    ["malformed JSON", "{"],
  ])("refuses %s without reaching the lease", async (_label, body) => {
    const { door, actions } = recordingDoor();
    const reports: unknown[] = [];
    const view = liveView(door, paths, (_event, cause) => reports.push(cause));
    expect((await view.input(request(body), signal)).status).toBe(400);
    expect(actions).toEqual([]);
    expect(reports).toHaveLength(body === "{" ? 1 : 0);
  });

  it("answers 404 for a lease that is not paused or not the viewer's", async () => {
    const view = liveView(
      () => Promise.reject(new CloudBrowserLeaseNotFound({ leaseId: "x" })),
      paths,
      () => undefined,
    );
    expect((await view.frame(signal)).status).toBe(404);
    expect(
      (await view.input(post({ kind: "click", x: 1, y: 1 }), signal)).status,
    ).toBe(404);
  });
});

describe("cloudBrowser.handoff", () => {
  async function handoff(ports: BrowserHandoffPorts) {
    const paused: string[] = [];
    const source = browserCapabilitySource({
      identity: () => ({ teamId: "team-a", agentId: "agent-a" }),
      browser: {
        call: () => Promise.reject(new Error("not driven in this test")),
        handoff: (_owner, leaseId) => {
          paused.push(leaseId);
          return Promise.resolve();
        },
      },
      quickReads: false,
      saveFile: null,
      handoff: ports,
    });
    const session = { sessionId: "session-a" };
    const acquired = await source.acquire({
      signal,
      invalidate: () => undefined,
      session,
    });
    let result: unknown;
    const runtime = await Mycelium.make({
      modules: acquired.snapshot.modules,
      session,
      sandbox: directSandbox(async (bindings) => {
        result = await bindings.cloudBrowser?.handoff?.({
          leaseId: "lease_1",
          reason: "log in",
        });
        return null;
      }),
    });
    const lease = await runtime.acquire();
    try {
      const { Effect, Stream } = await import("effect").then((effect) => ({
        Effect: effect.Effect,
        Stream: effect.Stream,
      }));
      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: "handoff",
          name: "execute",
          arguments: { code: "return null" },
        }),
      );
      await Effect.runPromise(Stream.runCollect(prepared.execute()));
    } finally {
      await lease.release();
      await runtime.close();
      await acquired.release();
    }
    return { result, paused };
  }

  it("pauses the lease and returns the host's view for a non-channel Session", async () => {
    const { result, paused } = await handoff({
      channel: () => false,
      viewPath: (owner, leaseId) =>
        liveViewPaths(`/agents/${owner.agentId}/cloud-browser/${leaseId}`).view,
    });
    expect(paused).toEqual(["lease_1"]);
    expect(result).toEqual({
      paused: true,
      view: "/agents/agent-a/cloud-browser/lease_1/view",
    });
  });

  it("pauses the lease and uses the conversation handoff for a channel Session", async () => {
    const asked: string[] = [];
    const { result, paused } = await handoff({
      channel: (sessionId, reason) => {
        asked.push(sessionId, reason);
        return true;
      },
      viewPath: () => "unused",
    });
    expect(paused).toEqual(["lease_1"]);
    expect(asked).toEqual(["session-a", "cloud browser: log in"]);
    expect(result).toEqual({ status: "handed_off" });
  });

  it("gives a host without a conversations owner the view", async () => {
    const { result } = await handoff({
      channel: null,
      viewPath: () => "/v",
    });
    expect(result).toEqual({ paused: true, view: "/v" });
  });
});
