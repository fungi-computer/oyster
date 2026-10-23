import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createBrowser,
  CloudBrowserCapacityExceeded,
  CloudBrowserLeaseNotFound,
  CloudBrowserLeasePaused,
  CloudBrowserTimeout,
  CloudBrowserUnavailable,
  CloudBrowserUpstreamError,
  CloudBrowserUrlDenied,
  type BrowserEvent,
  type BrowserMemberAction,
  type BrowserMeter,
  type BrowserSessions,
  type LeaseOwner,
  type QuickReads,
} from "../../src/browser/index.js";
import {
  createCdpClient,
  type CdpSocket,
  type Json,
} from "../../src/browser/cdp-client.js";

const owner: LeaseOwner = {
  teamId: "team-a",
  agentId: "agent-a",
  sessionId: "agent-session-a",
};
const signal = new AbortController().signal;
const commandSchema = z.object({ id: z.number(), method: z.string() });

function fixture(
  options: Readonly<{
    holdError?: Error;
    acquireError?: Error;
    attachError?: string;
    startError?: Error;
    quickReads?: null;
  }> = {},
) {
  let clock = 0;
  let providerNumber = 0;
  const order: string[] = [];
  const methods: string[] = [];
  const held: Parameters<BrowserMeter["hold"]>[0][] = [];
  const started: string[] = [];
  const releasedHolds: string[] = [];
  const releasedSessions: string[] = [];
  const settled: Parameters<BrowserMeter["settle"]>[0][] = [];
  const reports: BrowserEvent[] = [];
  const meter: BrowserMeter = {
    hold: (input) => {
      order.push("hold");
      held.push(input);
      if (options.holdError !== undefined)
        return Promise.reject(options.holdError);
      return Promise.resolve();
    },
    start: ({ executionId }) => {
      order.push("start");
      started.push(executionId);
      if (options.startError !== undefined)
        return Promise.reject(options.startError);
      return Promise.resolve();
    },
    release: ({ executionId }) => {
      order.push("meter.release");
      releasedHolds.push(executionId);
      return Promise.resolve();
    },
    settle: (input) => {
      order.push("settle");
      settled.push(input);
      return Promise.resolve();
    },
  };
  const sessions: BrowserSessions = {
    create: () => {
      order.push("acquire");
      if (options.acquireError !== undefined)
        return Promise.reject(options.acquireError);
      providerNumber += 1;
      return Promise.resolve(`provider-${String(providerNumber)}`);
    },
    connect: () => {
      const events = new EventTarget();
      const responses = new Map<string, Json>([
        [
          "Target.getTargets",
          { targetInfos: [{ targetId: "page-1", type: "page" }] },
        ],
        ["Target.attachToTarget", { sessionId: "cdp-session-1" }],
        ["Page.enable", {}],
        ["Accessibility.enable", {}],
        ["Accessibility.getFullAXTree", { nodes: [] }],
        ["Input.insertText", {}],
        ["Page.navigate", { frameId: "frame-1" }],
        ["Page.getNavigationHistory", { currentIndex: 0, entries: [] }],
      ]);
      const socket: CdpSocket = {
        send: (data) => {
          const { id, method } = commandSchema.parse(JSON.parse(data));
          methods.push(method);
          const result = responses.get(method);
          if (result === undefined)
            throw new Error(`Unexpected CDP command: ${method}`);
          const response =
            method === "Target.attachToTarget" &&
            options.attachError !== undefined
              ? { id, error: { code: -1, message: options.attachError } }
              : { id, result };
          queueMicrotask(() => {
            events.dispatchEvent(
              new MessageEvent("message", { data: JSON.stringify(response) }),
            );
          });
        },
        close: () => {
          events.dispatchEvent(new Event("close"));
        },
        addEventListener: (type, listener) => {
          events.addEventListener(type, listener);
        },
      };
      return Promise.resolve(createCdpClient(socket));
    },
    release: (sessionId) => {
      order.push("session.release");
      releasedSessions.push(sessionId);
      return Promise.resolve("closed");
    },
    confirmClosed: () => {
      throw new Error("createBrowser must not poll the provider");
    },
  };
  const markdown = vi.fn<QuickReads["markdown"]>((url) =>
    Promise.resolve({
      result: { url: url.href, text: "page", truncated: false },
      browserMs: null,
    }),
  );
  const unusedRead = () => {
    throw new Error("unexpected Quick Read");
  };
  const quickReads: QuickReads = {
    markdown,
    links: unusedRead,
    scrape: unusedRead,
    extract: unusedRead,
  };
  const browser = createBrowser(
    {
      sessions,
      quickReads: options.quickReads === null ? null : quickReads,
      meter: () => meter,
      report: (event) => reports.push(event),
    },
    {
      maxConcurrentPerTeam: 1,
      idleTimeoutMs: 1_000,
      maxLifetimeMs: 3_000,
      now: () => clock,
    },
  );
  return {
    browser,
    order,
    methods,
    held,
    started,
    releasedHolds,
    releasedSessions,
    settled,
    reports,
    markdown,
    now: (value: number) => {
      clock = value;
    },
  };
}

async function open(
  f: ReturnType<typeof fixture>,
  who: LeaseOwner = owner,
): Promise<string> {
  return z
    .object({ leaseId: z.string().min(1) })
    .parse(await f.browser.call(who, { kind: "open", url: null }, signal))
    .leaseId;
}

describe("the one agent browser", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds before acquisition, starts after attachment, and returns a module id", async () => {
    const f = fixture();
    const leaseId = await open(f);
    expect(f.order).toEqual(["hold", "acquire", "start"]);
    expect(f.held).toEqual([{ executionId: leaseId, maxMs: 3_000 }]);
    expect(f.started).toEqual([leaseId]);
    expect(leaseId).not.toBe("provider-1");
    f.now(250);
    await f.browser.call(owner, { kind: "close", leaseId }, signal);
    expect(f.order).toEqual([
      "hold",
      "acquire",
      "start",
      "session.release",
      "settle",
    ]);
    expect(f.releasedSessions).toEqual(["provider-1"]);
    expect(f.settled).toEqual([
      { executionId: leaseId, elapsedMs: 250, maxMs: 3_000 },
    ]);
    expect(f.releasedHolds).toEqual([]);
    expect(f.reports).toEqual([]);
  });

  it("does not acquire a session when the hold is refused", async () => {
    const failure = new Error("hold refused");
    const f = fixture({ holdError: failure });
    await expect(open(f)).rejects.toBe(failure);
    expect(f.order).toEqual(["hold"]);
  });

  it("releases the hold without starting when acquisition fails", async () => {
    const failure = new Error("provider unavailable");
    const f = fixture({ acquireError: failure });
    await expect(open(f)).rejects.toBe(failure);
    expect(f.order).toEqual(["hold", "acquire", "meter.release"]);
    expect(f.releasedHolds).toEqual(
      f.held.map(({ executionId }) => executionId),
    );
    expect(f.started).toEqual([]);
  });

  it("releases the session and hold when page attachment fails", async () => {
    const f = fixture({ attachError: "attachment refused" });
    await expect(open(f)).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    expect(f.order).toEqual([
      "hold",
      "acquire",
      "session.release",
      "meter.release",
    ]);
    expect(f.releasedSessions).toEqual(["provider-1"]);
    expect(f.releasedHolds).toEqual(
      f.held.map(({ executionId }) => executionId),
    );
    expect(f.started).toEqual([]);
  });

  it("releases the provider session when the meter cannot start", async () => {
    const failure = new Error("start refused");
    const f = fixture({ startError: failure });
    await expect(open(f)).rejects.toBe(failure);
    expect(f.order).toEqual(["hold", "acquire", "start", "session.release"]);
    expect(f.releasedSessions).toEqual(["provider-1"]);
  });

  it.each([
    { reason: "idle", at: 1_001, touches: [] },
    { reason: "lifetime", at: 3_001, touches: [900, 1_800, 2_700] },
  ])(
    "reaps an $reason-expired lease and settles its elapsed time",
    async ({ at, touches }) => {
      const f = fixture();
      const leaseId = await open(f);
      for (const time of touches) {
        f.now(time);
        await f.browser.call(owner, { kind: "snapshot", leaseId }, signal);
      }
      f.now(at);
      await expect(
        f.browser.call(owner, { kind: "snapshot", leaseId }, signal),
      ).rejects.toBeInstanceOf(CloudBrowserLeaseNotFound);
      expect(f.order.slice(-2)).toEqual(["session.release", "settle"]);
      expect(f.releasedSessions).toEqual(["provider-1"]);
      expect(f.settled).toEqual([
        { executionId: leaseId, elapsedMs: at, maxMs: 3_000 },
      ]);
    },
  );

  describe.each([
    "http://127.0.0.1/",
    "file:///etc/passwd",
    "https://u:p@example.com",
  ])("egress refuses %s", (url) => {
    it("refuses open before credit or provider acquisition", async () => {
      const f = fixture();
      await expect(
        f.browser.call(owner, { kind: "open", url }, signal),
      ).rejects.toBeInstanceOf(CloudBrowserUrlDenied);
      expect(f.order).toEqual([]);
      expect(f.markdown).not.toHaveBeenCalled();
    });

    it("refuses navigate before sending a page command", async () => {
      const f = fixture();
      const leaseId = await open(f);
      const attachedMethods = [...f.methods];
      await expect(
        f.browser.call(owner, { kind: "navigate", leaseId, url }, signal),
      ).rejects.toBeInstanceOf(CloudBrowserUrlDenied);
      expect(f.order).toEqual(["hold", "acquire", "start"]);
      expect(f.methods).toEqual(attachedMethods);
      expect(f.markdown).not.toHaveBeenCalled();
    });

    it("refuses markdown before calling Quick Reads", async () => {
      const f = fixture();
      await expect(
        f.browser.call(
          owner,
          { kind: "markdown", input: { url, maxChars: 100 } },
          signal,
        ),
      ).rejects.toBeInstanceOf(CloudBrowserUrlDenied);
      expect(f.markdown).not.toHaveBeenCalled();
      expect(f.order).toEqual([]);
    });
  });

  it.each([
    { ...owner, teamId: "other-team" },
    { ...owner, agentId: "other-agent" },
    { ...owner, sessionId: "other-session" },
  ])("refuses another owner: %j", async (other) => {
    const f = fixture();
    const leaseId = await open(f);
    await expect(
      f.browser.call(other, { kind: "snapshot", leaseId }, signal),
    ).rejects.toBeInstanceOf(CloudBrowserLeaseNotFound);
    expect(f.settled).toEqual([]);
    expect(f.releasedSessions).toEqual([]);
  });

  it("caps concurrent leases per Team, not across Teams", async () => {
    const f = fixture();
    await open(f);
    await expect(
      open(f, { ...owner, agentId: "second-agent" }),
    ).rejects.toBeInstanceOf(CloudBrowserCapacityExceeded);
    expect(f.order).toEqual(["hold", "acquire", "start"]);
    await open(f, { ...owner, teamId: "other-team" });
    expect(f.held).toHaveLength(2);
  });

  it("pauses agent calls for handoff and allows only that Team's member to resume", async () => {
    const f = fixture();
    const leaseId = await open(f);
    f.browser.handoff(owner, leaseId);
    await expect(
      f.browser.call(owner, { kind: "snapshot", leaseId }, signal),
    ).rejects.toBeInstanceOf(CloudBrowserLeasePaused);
    await expect(
      f.browser.member("other-team", leaseId, { kind: "resume" }, signal),
    ).rejects.toBeInstanceOf(CloudBrowserLeaseNotFound);
    await expect(
      f.browser.member(
        owner.teamId,
        leaseId,
        { kind: "type", text: "member input" },
        signal,
      ),
    ).resolves.toBeNull();
    await f.browser.member(owner.teamId, leaseId, { kind: "resume" }, signal);
    await expect(
      f.browser.call(owner, { kind: "snapshot", leaseId }, signal),
    ).resolves.toMatchObject({ leaseId, tree: "" });
  });

  it("same-Team resume is an idempotent no-op on an unpaused lease", async () => {
    const f = fixture();
    const leaseId = await open(f);
    await expect(
      f.browser.member(owner.teamId, leaseId, { kind: "resume" }, signal),
    ).resolves.toBeNull();
    await expect(
      f.browser.member(owner.teamId, leaseId, { kind: "resume" }, signal),
    ).resolves.toBeNull();
    await expect(
      f.browser.call(owner, { kind: "snapshot", leaseId }, signal),
    ).resolves.toMatchObject({ leaseId, tree: "" });
  });

  it("refuses another Team's resume on an unpaused lease", async () => {
    const f = fixture();
    const leaseId = await open(f);
    await expect(
      f.browser.member("other-team", leaseId, { kind: "resume" }, signal),
    ).rejects.toBeInstanceOf(CloudBrowserLeaseNotFound);
  });

  const memberActions: readonly BrowserMemberAction[] = [
    { kind: "screenshot" },
    { kind: "click", x: 1, y: 2 },
    { kind: "type", text: "member input" },
    { kind: "scroll", deltaX: 0, deltaY: 1 },
  ];
  it.each(memberActions)(
    "refuses member $kind on an unpaused lease",
    async (action) => {
      const f = fixture();
      const leaseId = await open(f);
      await expect(
        f.browser.member(owner.teamId, leaseId, action, signal),
      ).rejects.toBeInstanceOf(CloudBrowserLeaseNotFound);
    },
  );

  it("has no Quick Reads on a host that supplies none", async () => {
    const f = fixture({ quickReads: null });
    expect(f.browser.quickReads).toBe(false);
    await expect(
      f.browser.call(
        owner,
        {
          kind: "markdown",
          input: { url: "https://1.1.1.1/", maxChars: 100 },
        },
        signal,
      ),
    ).rejects.toBeInstanceOf(CloudBrowserUnavailable);
    expect(f.order).toEqual([]);
  });

  it("retains the typed load deadline failure rather than returning navigation success", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const leaseId = await open(f);
    const navigation = f.browser.call(
      owner,
      {
        kind: "navigate",
        leaseId,
        url: "https://1.1.1.1/",
      },
      signal,
    );
    const assertion =
      expect(navigation).rejects.toBeInstanceOf(CloudBrowserTimeout);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(f.methods).not.toContain("Page.getNavigationHistory");
    await f.browser.call(owner, { kind: "close", leaseId }, signal);
  });
});
