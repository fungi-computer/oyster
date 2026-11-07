import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createCdpClient,
  type CdpSocket,
  type Json,
} from "../../src/browser/cdp-client.js";
import {
  CloudBrowserTimeout,
  CloudBrowserUpstreamError,
} from "../../src/browser/errors.js";

const wireMessageSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.json().optional(),
  result: z.json().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  sessionId: z.string().optional(),
});
type WireMessage = z.output<typeof wireMessageSchema>;

/** A CDP peer sending real platform events across the socket seam. */
function fakePeer() {
  const events = new EventTarget();
  const sent: WireMessage[] = [];
  const socket: CdpSocket = {
    send: (data) => {
      sent.push(wireMessageSchema.parse(JSON.parse(data)));
    },
    close: () => {
      events.dispatchEvent(new Event("close"));
    },
    addEventListener: (type, listener) => {
      events.addEventListener(type, listener);
    },
  };
  const lastId = (): number => {
    const id = sent.at(-1)?.id;
    if (id === undefined) throw new Error("fakePeer: no call was sent");
    return id;
  };
  const message = (data: Json) =>
    events.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  return {
    socket,
    sent,
    answer: (result: Json) => message({ id: lastId(), result }),
    answerError: (text: string) =>
      message({ id: lastId(), error: { code: -1, message: text } }),
    emitEvent: (method: string, params: Json, sessionId?: string) => {
      if (sessionId === undefined) message({ method, params });
      else message({ method, params, sessionId });
    },
    failSocket: () => {
      events.dispatchEvent(new Event("error"));
    },
    closeSocket: () => {
      socket.close();
    },
  };
}

describe("cdp-client wire protocol", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("correlates a call to its response by id", async () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const pending = client.call("Page.navigate", {
      url: "https://example.com",
    });
    peer.answer({ frameId: "f1" });
    await expect(pending).resolves.toEqual({ frameId: "f1" });
    client.close();
  });

  it("flattens sessionId onto the sent frame", async () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const pending = client.call(
      "Page.enable",
      {},
      { sessionId: "cdp-session-1" },
    );
    peer.answer({});
    await pending;
    expect(peer.sent.at(-1)).toMatchObject({ sessionId: "cdp-session-1" });
    client.close();
  });

  it("rejects with a typed error on a CDP error response", async () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const pending = client.call("Page.navigate", { url: "bad" });
    peer.answerError("Invalid URL");
    await expect(pending).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    client.close();
  });

  it("times out a call that never answers", async () => {
    vi.useFakeTimers();
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const pending = client.call("Page.navigate", {}, { timeoutMs: 10 });
    const assertion =
      expect(pending).rejects.toBeInstanceOf(CloudBrowserTimeout);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    client.close();
  });

  it("does not send a call whose signal is already aborted", async () => {
    vi.useFakeTimers();
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const controller = new AbortController();
    controller.abort();
    const result = client
      .call(
        "Input.insertText",
        { text: "cancelled" },
        {
          signal: controller.signal,
          timeoutMs: 10,
        },
      )
      .catch((error: unknown) => error);
    const timersAfterCall = vi.getTimerCount();
    await vi.runAllTimersAsync();
    expect(peer.sent).toEqual([]);
    expect(timersAfterCall).toBe(0);
    expect(await result).toMatchObject({
      _tag: "CloudBrowserTimeout",
      timeoutMs: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an outstanding call without waiting for its deadline", async () => {
    vi.useFakeTimers();
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const controller = new AbortController();
    const pending = client.call(
      "Page.enable",
      {},
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      _tag: "CloudBrowserTimeout",
      timeoutMs: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
    peer.answer({});
    client.close();
  });

  it("removes the abort listener when a call times out", async () => {
    vi.useFakeTimers();
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = client
      .call(
        "Page.enable",
        {},
        {
          signal: controller.signal,
          timeoutMs: 10,
        },
      )
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBeInstanceOf(CloudBrowserTimeout);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["remote close", "socket error", "client close"])(
    "%s rejects calls and event waits immediately and stops subscriptions",
    async (termination) => {
      vi.useFakeTimers();
      const peer = fakePeer();
      // A local close must settle work without waiting for the peer's close event.
      const client = createCdpClient({ ...peer.socket, close: vi.fn() });
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const received = vi.fn();
      client.on("Page.loadEventFired", received);
      const call = client
        .call("Page.enable", {}, { signal: controller.signal })
        .catch((error: unknown) => error);
      const event = client
        .waitForEvent("Page.loadEventFired", { timeoutMs: 1000 })
        .catch((error: unknown) => error);
      if (termination === "remote close") peer.closeSocket();
      else if (termination === "socket error") peer.failSocket();
      else client.close();
      const timersAfterTermination = vi.getTimerCount();
      // Flush outstanding deadlines so a failing regression never hangs the suite.
      await vi.runAllTimersAsync();
      expect(await call).toBeInstanceOf(CloudBrowserUpstreamError);
      expect(await event).toBeInstanceOf(CloudBrowserUpstreamError);
      expect(timersAfterTermination).toBe(0);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      client.on("Page.loadEventFired", received);
      peer.emitEvent("Page.loadEventFired", {});
      expect(received).not.toHaveBeenCalled();
      const laterEvent = client
        .waitForEvent("Page.loadEventFired", { timeoutMs: 1000 })
        .catch((error: unknown) => error);
      const laterCall = client
        .call("Page.enable", {})
        .catch((error: unknown) => error);
      const timersAfterNewWork = vi.getTimerCount();
      await vi.runAllTimersAsync();
      expect(await laterEvent).toBeInstanceOf(CloudBrowserUpstreamError);
      expect(await laterCall).toBeInstanceOf(CloudBrowserUpstreamError);
      expect(timersAfterNewWork).toBe(0);
      expect(peer.sent).toHaveLength(1);
    },
  );

  it("releases call resources when sending throws", async () => {
    vi.useFakeTimers();
    const peer = fakePeer();
    const cause = new Error("socket unavailable");
    const client = createCdpClient({
      ...peer.socket,
      send: () => {
        throw cause;
      },
    });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = client.call(
      "Page.enable",
      {},
      { signal: controller.signal },
    );
    await expect(result).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    await expect(result).rejects.toHaveProperty("cause", cause);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("resolves waitForEvent only for the matching method and session", async () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const pending = client.waitForEvent("Page.loadEventFired", {
      sessionId: "cdp-session-1",
      timeoutMs: 1_000,
    });
    peer.emitEvent("Page.loadEventFired", { timestamp: 0 }, "other-session");
    peer.emitEvent("Page.otherEvent", { timestamp: 0 }, "cdp-session-1");
    peer.emitEvent("Page.loadEventFired", { timestamp: 1 }, "cdp-session-1");
    await expect(pending).resolves.toEqual({ timestamp: 1 });
    client.close();
  });

  it("times out an event wait that never matches", async () => {
    vi.useFakeTimers();
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const pending = client.waitForEvent("Page.loadEventFired", {
      timeoutMs: 10,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      _tag: "CloudBrowserTimeout",
      op: "Page.loadEventFired",
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it("rejects every pending call when the socket closes", async () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const first = client.call("Page.navigate", {});
    const second = client.call("Page.enable", {});
    peer.closeSocket();
    await expect(first).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    await expect(second).rejects.toBeInstanceOf(CloudBrowserUpstreamError);
    await expect(client.call("Page.enable", {})).rejects.toBeInstanceOf(
      CloudBrowserUpstreamError,
    );
  });

  it("on delivers every matching event until unsubscribed", () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.socket);
    const received: Json[] = [];
    const unsubscribe = client.on("Page.loadEventFired", (params) => {
      received.push(params);
    });
    peer.emitEvent("Page.otherEvent", { timestamp: 0 });
    peer.emitEvent("Page.loadEventFired", { timestamp: 1 });
    peer.emitEvent("Page.loadEventFired", { timestamp: 2 }, "cdp-session-1");
    expect(received).toEqual([{ timestamp: 1 }, { timestamp: 2 }]);
    unsubscribe();
    peer.emitEvent("Page.loadEventFired", { timestamp: 3 });
    expect(received).toEqual([{ timestamp: 1 }, { timestamp: 2 }]);
    client.close();
  });
});
