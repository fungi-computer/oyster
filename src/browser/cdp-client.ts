import { z } from "zod";
import { CloudBrowserTimeout, CloudBrowserUpstreamError } from "./errors.js";

/**
 * A minimal Chrome DevTools Protocol client over one WebSocket to a browser
 * session (Browser Run REST or a Workers BROWSER binding; see `sessions.ts`).
 * This is the ONLY place in the browser module that speaks the CDP wire; it
 * exposes `call` (one request/response), `waitForEvent` (one named event)
 * and `on` (a bounded subscription for the host boot observer). It is
 * internal: no export path or agent tool exposes it, so the Agent never sees
 * a `send`/raw-method tool.
 */

/** CDP's own wire values are arbitrary JSON; every caller parses its own
 * expected shape with a schema (e.g. `getTargetsResultSchema.parse(...)`). */
export type Json = z.core.util.JSONType;

/**
 * The minimal WebSocket surface this client drives (a fake in tests). A real
 * `WebSocket`'s `addEventListener` structurally satisfies this: the listener
 * accepts any platform `Event` and `readCdpMessage` parses a message's `data`.
 */
export type CdpSocket = Readonly<{
  /** Send one JSON text frame. */
  send: (data: string) => void;
  /** Close the transport. */
  close: (code?: number, reason?: string) => void;
  /** Observe frames, closure and transport errors. */
  addEventListener: (
    type: "message" | "close" | "error",
    listener: (event: Event) => void,
  ) => void;
}>;

/** The one fetch shape the module calls: global `fetch` or a binding's. */
export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Workers/workerd outbound WebSocket: a `fetch` with an `upgrade` header
 * returns a `Response.webSocket` to `.accept()`. Browser Run's REST CDP
 * endpoint and a BROWSER binding's `/v1/devtools/browser/{id}` answer the
 * same upgrade (https://developers.cloudflare.com/browser-run/cdp/).
 */
export async function openCdpSocket(
  fetcher: HttpFetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<CdpSocket> {
  const response = await fetcher(url, {
    headers: { ...headers, upgrade: "websocket" },
    signal,
  });
  const socket = response.webSocket;
  if (socket === null)
    throw new CloudBrowserUpstreamError({
      op: "cdp.connect",
      status: response.status,
      message: "The browser did not upgrade the CDP connection",
    });
  socket.accept();
  return socket;
}

const cdpMessageSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.json().optional(),
  result: z.json().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  sessionId: z.string().optional(),
});
type CdpMessage = z.output<typeof cdpMessageSchema>;

/**
 * CDP frames are always a JSON text message. `cdpMessageSchema` is the one
 * place that decides what counts as a real CDP message; anything else
 * (binary, malformed JSON, the wrong shape) is silently dropped, same as a
 * CDP client ignoring a frame it does not understand.
 */
const textFrameSchema = z.object({ data: z.string() });

/** One read frame: a CDP message, or a frame this client does not understand. */
type ReadFrame =
  | Readonly<{ kind: "message"; message: CdpMessage }>
  | Readonly<{ kind: "unreadable" }>;

const unreadable: ReadFrame = { kind: "unreadable" };

function readCdpMessage(event: Event): ReadFrame {
  const text = textFrameSchema.safeParse(event);
  if (!text.success) return unreadable;
  let candidate: unknown;
  try {
    candidate = JSON.parse(text.data.data);
  } catch {
    return unreadable;
  }
  const parsed = cdpMessageSchema.safeParse(candidate);
  return parsed.success
    ? { kind: "message", message: parsed.data }
    : unreadable;
}

export type CdpClient = Readonly<{
  /** One command/response round trip, optionally flattened into `sessionId`. */
  call: (
    method: string,
    params: Readonly<Record<string, Json>>,
    options?: Readonly<{
      sessionId?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    }>,
  ) => Promise<Json>;
  /** Resolves on the next matching event, or times out. */
  waitForEvent: (
    method: string,
    options: Readonly<{ sessionId?: string; timeoutMs: number }>,
  ) => Promise<Json>;
  /**
   * Every matching event, with the flattened CDP session it came from,
   * until the returned function unsubscribes.
   */
  on: (
    method: string,
    listener: (params: Json, sessionId: string | undefined) => void,
  ) => () => void;
  close: () => void;
}>;

type PendingCall = Readonly<{
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
}>;
type EventWaiter = Readonly<{
  method: string;
  sessionId: string | undefined;
  resolve: (value: Json) => void;
}>;

/** Wrap one connected CDP socket with id-correlated calls and event waits. */
export function createCdpClient(socket: CdpSocket): CdpClient {
  const pending = new Map<number, PendingCall>();
  const waiters: EventWaiter[] = [];
  const subscribers = new Set<
    Readonly<{
      method: string;
      listener: (params: Json, sessionId: string | undefined) => void;
    }>
  >();
  let nextRequestNumber = 1;
  let closed = false;

  socket.addEventListener("message", (event) => {
    const frame = readCdpMessage(event);
    if (frame.kind === "unreadable") return;
    const { message } = frame;
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      if (waiting === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined)
        waiting.reject(
          new CloudBrowserUpstreamError({
            op: "cdp.call",
            status: null,
            message: message.error.message,
          }),
        );
      else waiting.resolve(message.result ?? null);
      return;
    }
    if (message.method === undefined) return;
    for (const subscriber of subscribers)
      if (subscriber.method === message.method)
        subscriber.listener(message.params ?? null, message.sessionId);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (
        waiter?.method === message.method &&
        (waiter.sessionId === undefined ||
          waiter.sessionId === message.sessionId)
      ) {
        waiters.splice(index, 1);
        waiter.resolve(message.params ?? null);
      }
    }
  });
  socket.addEventListener("close", () => {
    closed = true;
    for (const { reject } of pending.values())
      reject(
        new CloudBrowserUpstreamError({
          op: "cdp.socket",
          status: null,
          message: "browser CDP socket closed",
        }),
      );
    pending.clear();
  });
  socket.addEventListener("error", () => {
    closed = true;
  });

  return {
    call: (method, params, options) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(
            new CloudBrowserUpstreamError({
              op: method,
              status: null,
              message: "browser CDP socket is closed",
            }),
          );
          return;
        }
        const requestNumber = nextRequestNumber;
        nextRequestNumber += 1;
        const timeoutMs = options?.timeoutMs ?? 15_000;
        const timer = setTimeout(() => {
          pending.delete(requestNumber);
          reject(new CloudBrowserTimeout({ op: method, timeoutMs }));
        }, timeoutMs);
        const onAbort = () => {
          pending.delete(requestNumber);
          clearTimeout(timer);
          reject(new CloudBrowserTimeout({ op: method, timeoutMs: 0 }));
        };
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(requestNumber, {
          resolve: (value) => {
            clearTimeout(timer);
            options?.signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            options?.signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        });
        const frame = { id: requestNumber, method, params };
        socket.send(
          JSON.stringify(
            options?.sessionId === undefined
              ? frame
              : { ...frame, sessionId: options.sessionId },
          ),
        );
      }),
    waitForEvent: (method, options) =>
      new Promise((resolve, reject) => {
        const waiter: EventWaiter = {
          method,
          sessionId: options.sessionId,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new CloudBrowserTimeout({
              op: method,
              timeoutMs: options.timeoutMs,
            }),
          );
        }, options.timeoutMs);
        waiters.push(waiter);
      }),
    on: (method, listener) => {
      const subscriber = { method, listener };
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    close: () => {
      closed = true;
      subscribers.clear();
      socket.close();
    },
  };
}
