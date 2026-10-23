import { describe, expect, it } from "vitest";
import {
  browserRunQuickReads,
  CloudBrowserCreditDenied,
  CloudBrowserUpstreamError,
  CloudBrowserUrlDenied,
  createBrowser,
  type BrowserMeter,
  type BrowserSessions,
  type QuickReads,
} from "../../src/browser/index.js";

/** Records every meter step in order; `refuseHold` makes the hold throw. */
function recordingMeter(refuseHold = false) {
  const steps: string[] = [];
  const calls: unknown[] = [];
  const ids: string[] = [];
  const meter: BrowserMeter = {
    hold: (input) => {
      steps.push("hold");
      calls.push(input);
      ids.push(input.executionId);
      return refuseHold
        ? Promise.reject(new CloudBrowserCreditDenied({ teamId: "team" }))
        : Promise.resolve();
    },
    start: (input) => {
      steps.push("start");
      calls.push(input);
      ids.push(input.executionId);
      return Promise.resolve();
    },
    settle: (input) => {
      steps.push("settle");
      calls.push(input);
      ids.push(input.executionId);
      return Promise.resolve();
    },
    release: (input) => {
      steps.push("release");
      calls.push(input);
      ids.push(input.executionId);
      return Promise.resolve();
    },
  };
  return { meter, steps, calls, ids };
}

const unusedSessions: BrowserSessions = {
  create: () => Promise.reject(new Error("quick reads open no session")),
  connect: () => Promise.reject(new Error("quick reads open no session")),
  release: () => Promise.reject(new Error("quick reads open no session")),
  confirmClosed: () => Promise.reject(new Error("quick reads open no session")),
};

function quickReadsFake(steps: string[], fail = false): QuickReads {
  const read = <T>(value: T) => {
    steps.push("provider");
    return fail
      ? Promise.reject(
          new CloudBrowserUpstreamError({
            op: "markdown",
            status: 502,
            message: "Browser Run markdown failed (HTTP 502)",
          }),
        )
      : Promise.resolve({ result: value, browserMs: 1_234 });
  };
  return {
    markdown: (url) =>
      read({ url: url.href, text: "# Page", truncated: false }),
    links: (url) => read({ url: url.href, links: [], truncated: false }),
    scrape: (url) => read({ url: url.href, result: [], truncated: false }),
    extract: (url) => read({ url: url.href, result: null }),
  };
}

const owner = { teamId: "team", agentId: "agent", sessionId: "session" };
const limits = {
  maxConcurrentPerTeam: 2,
  maxLifetimeMs: 30 * 60_000,
  idleTimeoutMs: 5 * 60_000,
  quickReadTimeoutMs: 30_000,
};

function browserWith(
  meter: BrowserMeter,
  quickReads: QuickReads,
): ReturnType<typeof createBrowser> {
  return createBrowser(
    {
      sessions: unusedSessions,
      quickReads,
      meter: () => meter,
      report: () => undefined,
    },
    limits,
  );
}

describe("quick reads are billed through the host's required meter", () => {
  it("holds before the provider, then starts and settles the reported browser time", async () => {
    const { meter, steps, calls, ids } = recordingMeter();
    const browser = browserWith(meter, quickReadsFake(steps));
    await expect(
      browser.call(
        owner,
        { kind: "markdown", input: { url: "https://1.1.1.1/", maxChars: 100 } },
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toEqual({
      url: "https://1.1.1.1/",
      text: "# Page",
      truncated: false,
    });
    expect(steps).toEqual(["hold", "provider", "start", "settle"]);
    const [executionId] = ids;
    expect(executionId).toMatch(/^read_/);
    expect(new Set(ids).size).toBe(1);
    expect(calls).toEqual([
      { executionId, maxMs: 30_000 },
      { executionId },
      { executionId, elapsedMs: 1_234, maxMs: 30_000 },
    ]);
  });

  it("releases the hold when the read fails, and never starts or settles it", async () => {
    const { meter, steps } = recordingMeter();
    const browser = browserWith(meter, quickReadsFake(steps, true));
    await expect(
      browser.call(
        owner,
        { kind: "links", url: "https://1.1.1.1/" },
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    expect(steps).toEqual(["hold", "provider", "release"]);
  });

  it("never reaches the provider when the hold is refused", async () => {
    const { meter, steps } = recordingMeter(true);
    const browser = browserWith(meter, quickReadsFake(steps));
    await expect(
      browser.call(
        owner,
        {
          kind: "extract",
          input: { url: "https://1.1.1.1/", prompt: "the title" },
        },
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toBeInstanceOf(CloudBrowserCreditDenied);
    expect(steps).toEqual(["hold"]);
  });

  it("refuses a non-public URL before any hold", async () => {
    const { meter, steps } = recordingMeter();
    const browser = browserWith(meter, quickReadsFake(steps));
    await expect(
      browser.call(
        owner,
        {
          kind: "scrape",
          input: { url: "http://127.0.0.1/", selectors: ["h1"] },
        },
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toBeInstanceOf(CloudBrowserUrlDenied);
    expect(steps).toEqual([]);
  });
});

describe("the provider's reported browser time is parsed strictly", () => {
  it.each([
    ["1234", 1_234],
    ["", null],
    [" ", null],
    ["12.5", null],
    ["-3", null],
  ])("x-browser-ms-used %j reads as %j", async (header, expected) => {
    const reads = browserRunQuickReads({
      accountId: "account",
      apiToken: "token",
      fetch: () =>
        Promise.resolve(
          Response.json(
            { success: true, result: "# Page" },
            { headers: { "x-browser-ms-used": header } },
          ),
        ),
    });
    await expect(
      reads.markdown(
        new URL("https://1.1.1.1/"),
        100,
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject({ browserMs: expected });
  });
});
