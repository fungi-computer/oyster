import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createBrowser,
  CloudBrowserCapacityExceeded,
  CloudBrowserLeaseNotFound,
  CloudBrowserUpstreamError,
  type BrowserMeter,
  type BrowserSessions,
  type LeaseOwner,
} from "../../src/browser/index.js";
import {
  createCdpClient,
  type CdpSocket,
  type Json,
} from "../../src/browser/cdp-client.js";

const owner: LeaseOwner = {
  teamId: "team-a",
  agentId: "agent-a",
  sessionId: "session-a",
};
const signal = new AbortController().signal;
const commandSchema = z.object({ id: z.number(), method: z.string() });
const closeSchema = z.object({
  leaseId: z.string(),
  closed: z.literal(true),
  provider: z.enum(["closed", "closing"]),
});
const openSchema = z.object({ leaseId: z.string() });

/** A provider whose DELETE outcomes and closure confirmations are scripted. */
function provider(
  script: Readonly<{
    releases?: readonly ("closed" | "closing" | "refused")[];
    confirms?: readonly ("confirmed" | "unconfirmed")[];
    acquireGate?: Promise<void>;
    connectFails?: boolean;
  }> = {},
) {
  const releases = [...(script.releases ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const acquired: string[] = [];
  const releaseCalls: string[] = [];
  const confirmCalls: string[] = [];
  const sessions: BrowserSessions = {
    create: async () => {
      await script.acquireGate;
      const sessionId = `provider-${String(acquired.length + 1)}`;
      acquired.push(sessionId);
      return sessionId;
    },
    connect: () => {
      if (script.connectFails === true)
        return Promise.reject(
          new CloudBrowserUpstreamError({
            op: "cdp.connect",
            status: 502,
            message: "The browser did not upgrade the CDP connection",
          }),
        );
      const events = new EventTarget();
      const responses = new Map<string, Json>([
        [
          "Target.getTargets",
          { targetInfos: [{ targetId: "page-1", type: "page" }] },
        ],
        ["Target.attachToTarget", { sessionId: "cdp-1" }],
        ["Page.enable", {}],
        ["Accessibility.enable", {}],
        ["Accessibility.getFullAXTree", { nodes: [] }],
      ]);
      const socket: CdpSocket = {
        send: (data) => {
          const { id, method } = commandSchema.parse(JSON.parse(data));
          const result = responses.get(method) ?? {};
          queueMicrotask(() => {
            events.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({ id, result }),
              }),
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
      releaseCalls.push(sessionId);
      const outcome = releases.shift() ?? "closed";
      return outcome === "refused"
        ? Promise.reject(
            new CloudBrowserUpstreamError({
              op: "close",
              status: 503,
              message: "The browser provider refused to close the session",
            }),
          )
        : Promise.resolve(outcome);
    },
    confirmClosed: (sessionId) => {
      confirmCalls.push(sessionId);
      return (confirms.shift() ?? "confirmed") === "confirmed"
        ? Promise.resolve()
        : Promise.reject(
            new CloudBrowserUpstreamError({
              op: "close.confirm",
              status: null,
              message:
                "The browser provider did not confirm the session closed",
            }),
          );
    },
  };
  return { sessions, acquired, releaseCalls, confirmCalls };
}

function settlingMeter() {
  const settled: string[] = [];
  const meter: BrowserMeter = {
    hold: () => Promise.resolve(),
    start: () => Promise.resolve(),
    release: () => Promise.resolve(),
    settle: ({ executionId }) => {
      settled.push(executionId);
      return Promise.resolve();
    },
  };
  return { meter, settled };
}

function browserOver(
  sessions: BrowserSessions,
  meter: BrowserMeter,
  maxConcurrentPerTeam = 2,
) {
  return createBrowser(
    { sessions, quickReads: null, meter: () => meter, report: () => undefined },
    { maxConcurrentPerTeam, maxLifetimeMs: 60_000, idleTimeoutMs: 30_000 },
  );
}

describe("provider teardown stays owned until the provider confirms it", () => {
  it("a refused DELETE ends the lease and its bill, and the next call retries the teardown", async () => {
    const fake = provider({ releases: ["refused", "closed"] });
    const { meter, settled } = settlingMeter();
    const browser = browserOver(fake.sessions, meter);
    const { leaseId } = openSchema.parse(
      await browser.call(owner, { kind: "open", url: null }, signal),
    );
    await expect(
      browser.call(owner, { kind: "close", leaseId }, signal),
    ).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    await expect(
      browser.call(owner, { kind: "snapshot", leaseId }, signal),
    ).rejects.toBeInstanceOf(CloudBrowserLeaseNotFound);
    expect(settled).toEqual([leaseId]);
    // The failed snapshot call retried the provider DELETE; it succeeded.
    expect(fake.releaseCalls).toEqual(["provider-1", "provider-1"]);
    await expect(
      browser.call(owner, { kind: "open", url: null }, signal),
    ).resolves.toBeDefined();
    expect(fake.releaseCalls).toEqual(["provider-1", "provider-1"]);
    expect(settled).toEqual([leaseId]);
  });

  it("a 'closing' acknowledgement is confirmed before the close reports the provider closed", async () => {
    const fake = provider({ releases: ["closing"], confirms: ["confirmed"] });
    const browser = browserOver(fake.sessions, settlingMeter().meter);
    const { leaseId } = openSchema.parse(
      await browser.call(owner, { kind: "open", url: null }, signal),
    );
    expect(
      closeSchema.parse(
        await browser.call(owner, { kind: "close", leaseId }, signal),
      ),
    ).toEqual({ leaseId, closed: true, provider: "closed" });
    expect(fake.confirmCalls).toEqual(["provider-1"]);
  });

  it("an unconfirmed 'closing' is reported as closing, never as closed, and retried later", async () => {
    const fake = provider({
      releases: ["closing", "closed"],
      confirms: ["unconfirmed"],
    });
    const browser = browserOver(fake.sessions, settlingMeter().meter);
    const { leaseId } = openSchema.parse(
      await browser.call(owner, { kind: "open", url: null }, signal),
    );
    expect(
      closeSchema.parse(
        await browser.call(owner, { kind: "close", leaseId }, signal),
      ),
    ).toEqual({ leaseId, closed: true, provider: "closing" });
    await browser.call(owner, { kind: "open", url: null }, signal);
    expect(fake.releaseCalls).toEqual(["provider-1", "provider-1"]);
  });
});

describe("the per-Team cap counts opens still in flight", () => {
  it("two concurrent opens at cap 1 create one provider session", async () => {
    let letAcquire: () => void = () => undefined;
    const acquireGate = new Promise<void>((resolve) => {
      letAcquire = resolve;
    });
    const fake = provider({ acquireGate });
    const browser = browserOver(fake.sessions, settlingMeter().meter, 1);
    const first = browser.call(owner, { kind: "open", url: null }, signal);
    const second = browser.call(owner, { kind: "open", url: null }, signal);
    letAcquire();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const refused = outcomes.find((outcome) => outcome.status === "rejected");
    expect(refused?.reason).toBeInstanceOf(CloudBrowserCapacityExceeded);
    expect(fake.acquired).toEqual(["provider-1"]);
  });

  it("a failed open frees its reserved slot", async () => {
    const fake = provider();
    const failing: BrowserMeter = {
      ...settlingMeter().meter,
      hold: () =>
        Promise.reject(
          new CloudBrowserUpstreamError({
            op: "billing.hold",
            status: null,
            message: "unavailable",
          }),
        ),
    };
    let meter = failing;
    const browser = createBrowser(
      {
        sessions: fake.sessions,
        quickReads: null,
        meter: () => meter,
        report: () => undefined,
      },
      { maxConcurrentPerTeam: 1, maxLifetimeMs: 60_000, idleTimeoutMs: 30_000 },
    );
    await expect(
      browser.call(owner, { kind: "open", url: null }, signal),
    ).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    meter = settlingMeter().meter;
    await expect(
      browser.call(owner, { kind: "open", url: null }, signal),
    ).resolves.toBeDefined();
  });
});

describe("a lease bills from the provider session request", () => {
  it("counts the time spent acquiring the session", async () => {
    let clock = 10_000;
    const fake = provider();
    const elapsed: number[] = [];
    const meter: BrowserMeter = {
      ...settlingMeter().meter,
      settle: ({ elapsedMs }) => {
        elapsed.push(elapsedMs);
        return Promise.resolve();
      },
    };
    const browser = createBrowser(
      {
        sessions: {
          ...fake.sessions,
          create: (options, createSignal) => {
            clock += 1_500;
            return fake.sessions.create(options, createSignal);
          },
        },
        quickReads: null,
        meter: () => meter,
        report: () => undefined,
      },
      {
        maxConcurrentPerTeam: 1,
        maxLifetimeMs: 60_000,
        idleTimeoutMs: 30_000,
        now: () => clock,
      },
    );
    const { leaseId } = openSchema.parse(
      await browser.call(owner, { kind: "open", url: null }, signal),
    );
    clock += 500;
    await browser.call(owner, { kind: "close", leaseId }, signal);
    expect(elapsed).toEqual([2_000]);
  });
});

describe("a provider session that never connected is still owned", () => {
  it("keeps its id for teardown when the CDP connect fails, and releases the hold", async () => {
    const fake = provider({
      connectFails: true,
      releases: ["refused", "closed"],
    });
    const released: string[] = [];
    const meter: BrowserMeter = {
      ...settlingMeter().meter,
      release: ({ executionId }) => {
        released.push(executionId);
        return Promise.resolve();
      },
    };
    const browser = browserOver(fake.sessions, meter);
    await expect(
      browser.call(owner, { kind: "open", url: null }, signal),
    ).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    expect(released).toHaveLength(1);
    expect(fake.releaseCalls).toEqual(["provider-1"]);
    // The refused DELETE is retried on the next call, until the provider takes it.
    await expect(
      browser.call(owner, { kind: "open", url: null }, signal),
    ).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    expect(fake.releaseCalls.slice(0, 2)).toEqual(["provider-1", "provider-1"]);
  });
});
