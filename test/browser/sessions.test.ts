import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserRunSessions,
  type CdpConnect,
} from "../../src/browser/sessions.js";
import type { CdpSocket, HttpFetch } from "../../src/browser/cdp-client.js";
import { CloudBrowserUpstreamError } from "../../src/browser/errors.js";

// Captured through the real workerd backend on 2026-10-03; only account and
// session identifiers were replaced. Connection URLs now come from the provider
// root plus sessionId, not the historical webSocketDebuggerUrl field.
const capturedResponse = {
  sessionId: "1909cef7-23e8-4394-bc31-27404bf4348f",
  webSocketDebuggerUrl:
    "wss://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/devtools/browser/1909cef7-23e8-4394-bc31-27404bf4348f",
};
const root =
  "https://api.cloudflare.com/client/v4/accounts/test-account/browser-run/devtools";
const sessionUrl = `${root}/browser/${capturedResponse.sessionId}`;
const signal = new AbortController().signal;

function fixture() {
  const events = new EventTarget();
  const close = vi.fn(() => {
    events.dispatchEvent(new Event("close"));
  });
  const socket: CdpSocket = {
    send: () => {
      throw new Error("session lifecycle tests must not send page commands");
    },
    close,
    addEventListener: (type, listener) => {
      events.addEventListener(type, listener);
    },
  };
  const fetcher = vi.fn<HttpFetch>((_url, init) =>
    Promise.resolve(
      Response.json(
        init?.method === "POST" ? capturedResponse : { status: "closed" },
      ),
    ),
  );
  const connect = vi.fn<CdpConnect>(() => Promise.resolve(socket));
  return {
    sessions: browserRunSessions({
      accountId: "test-account",
      apiToken: "test-token",
      fetch: fetcher,
      connect,
    }),
    fetcher,
    connect,
    close,
  };
}

describe("Browser Run provider sessions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates with Bearer authorization, parses the captured response and connects its id", async () => {
    const { sessions, fetcher, connect } = fixture();
    const sessionId = await sessions.create({ keepAliveMs: 10_000 }, signal);
    expect(sessionId).toBe(capturedResponse.sessionId);
    expect(fetcher).toHaveBeenCalledWith(`${root}/browser?keep_alive=10000`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      signal,
    });
    expect(connect).not.toHaveBeenCalled();
    await sessions.connect(sessionId, signal);
    expect(connect).toHaveBeenCalledWith(
      sessionUrl,
      { authorization: "Bearer test-token" },
      signal,
    );
  });

  it("sends allowedDomains in the create guardrails body", async () => {
    const { sessions, fetcher } = fixture();
    await sessions.create(
      { keepAliveMs: 10_000, allowedDomains: ["example.com"] },
      signal,
    );
    expect(fetcher).toHaveBeenCalledWith(
      `${root}/browser?keep_alive=10000`,
      expect.objectContaining({
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          guardrails: { allowedDomains: ["example.com"] },
        }),
      }),
    );
  });

  it("a failed connect surfaces to the caller without deleting the session", async () => {
    // createBrowser owns the created id and its teardown; the provider layer
    // must not silently discard it.
    const { sessions, fetcher, connect } = fixture();
    const failure = new Error("upgrade refused");
    connect.mockRejectedValueOnce(failure);
    const sessionId = await sessions.create({ keepAliveMs: 10_000 }, signal);
    await expect(sessions.connect(sessionId, signal)).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("release deletes the provider session by id", async () => {
    const { sessions, fetcher } = fixture();
    const sessionId = await sessions.create({ keepAliveMs: 10_000 }, signal);
    await expect(sessions.release(sessionId, signal)).resolves.toBe("closed");
    expect(fetcher).toHaveBeenLastCalledWith(sessionUrl, {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
      signal,
    });
  });

  it("release treats a provider 404 as already closed", async () => {
    const { sessions, fetcher } = fixture();
    const sessionId = await sessions.create({ keepAliveMs: 10_000 }, signal);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(sessions.release(sessionId, signal)).resolves.toBe("closed");
  });

  it("release reports a 'closing' acknowledgement as closing", async () => {
    const { sessions, fetcher } = fixture();
    const sessionId = await sessions.create({ keepAliveMs: 10_000 }, signal);
    fetcher.mockResolvedValueOnce(Response.json({ status: "closing" }));
    await expect(sessions.release(sessionId, signal)).resolves.toBe("closing");
  });

  it("release exposes a non-ok delete as a typed upstream error", async () => {
    const { sessions, fetcher } = fixture();
    const sessionId = await sessions.create({ keepAliveMs: 10_000 }, signal);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(sessions.release(sessionId, signal)).rejects.toBeInstanceOf(
      CloudBrowserUpstreamError,
    );
  });

  it("confirmClosed accepts a provider endTime greater than zero", async () => {
    const { sessions, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(
      Response.json({ sessionId: capturedResponse.sessionId, endTime: 123 }),
    );
    await expect(
      sessions.confirmClosed(capturedResponse.sessionId, Date.now() + 1_000),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      `${root}/session/${capturedResponse.sessionId}`,
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer test-token" },
      }),
    );
  });

  it("confirmClosed throws when closure stays unconfirmed at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { sessions, fetcher } = fixture();
    fetcher.mockImplementation(() =>
      Promise.resolve(
        Response.json({ sessionId: capturedResponse.sessionId, endTime: 0 }),
      ),
    );
    const assertion = expect(
      sessions.confirmClosed(capturedResponse.sessionId, 1_100),
    ).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it.each([
    { id: capturedResponse.sessionId },
    { result: { sessionId: capturedResponse.sessionId } },
    { sessionId: "" },
  ])(
    "refuses an unreadable create response before connecting: %j",
    async (body) => {
      const { sessions, fetcher, connect } = fixture();
      fetcher.mockResolvedValueOnce(Response.json(body));
      await expect(
        sessions.create({ keepAliveMs: 10_000 }, signal),
      ).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
      expect(connect).not.toHaveBeenCalled();
    },
  );
});
