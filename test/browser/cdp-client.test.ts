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
