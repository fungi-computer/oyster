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
  /** A Chromium context-scoped host supplies this; Browser Run leaves it absent. */
  browserContextId?: string;
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
  /** Resolves on the next matching event, or rejects on timeout or closure. */
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
  reject: (error: Error) => void;
}>;

/** Wrap one connected CDP socket with id-correlated calls and event waits. */
export function createCdpClient(socket: CdpSocket): CdpClient {
  const pending = new Map<number, PendingCall>();
  const waiters = new Set<EventWaiter>();
  const subscribers = new Set<
    Readonly<{
      method: string;
      listener: (params: Json, sessionId: string | undefined) => void;
    }>
  >();
  let nextRequestNumber = 1;
  let closed = false;

  const terminate = (message: string) => {
    if (closed) return;
    closed = true;
    const error = new CloudBrowserUpstreamError({
      op: "cdp.socket",
      status: null,
      message,
    });
    for (const call of pending.values()) call.reject(error);
    for (const waiter of waiters) waiter.reject(error);
    subscribers.clear();
  };

  socket.addEventListener("message", (event) => {
    if (closed) return;
    const frame = readCdpMessage(event);
    if (frame.kind === "unreadable") return;
    const { message } = frame;
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      if (waiting === undefined) return;
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
    for (const waiter of waiters) {
      if (
        waiter.method === message.method &&
        (waiter.sessionId === undefined ||
          waiter.sessionId === message.sessionId)
      ) {
        waiter.resolve(message.params ?? null);
      }
    }
  });
  socket.addEventListener("close", () => {
    terminate("browser CDP socket closed");
  });
  socket.addEventListener("error", () => {
    terminate("browser CDP socket failed");
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
        if (options?.signal?.aborted) {
          reject(new CloudBrowserTimeout({ op: method, timeoutMs: 0 }));
          return;
        }
        const requestNumber = nextRequestNumber;
        nextRequestNumber += 1;
        const timeoutMs = options?.timeoutMs ?? 15_000;
        const timer = setTimeout(() => {
          call.reject(new CloudBrowserTimeout({ op: method, timeoutMs }));
        }, timeoutMs);
        const onAbort = () => {
          call.reject(new CloudBrowserTimeout({ op: method, timeoutMs: 0 }));
        };
        const cleanup = () => {
          pending.delete(requestNumber);
          clearTimeout(timer);
          options?.signal?.removeEventListener("abort", onAbort);
        };
        const call: PendingCall = {
          resolve: (value) => {
            cleanup();
            resolve(value);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
        };
        pending.set(requestNumber, call);
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        const frame = { id: requestNumber, method, params };
        try {
          socket.send(
            JSON.stringify(
              options?.sessionId === undefined
                ? frame
                : { ...frame, sessionId: options.sessionId },
            ),
          );
        } catch (cause) {
          cleanup();
          throw new CloudBrowserUpstreamError({
            op: method,
            status: null,
            message: "Could not send the browser CDP command",
            cause,
          });
        }
      }),
    waitForEvent: (method, options) =>
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
        const cleanup = () => {
          waiters.delete(waiter);
          clearTimeout(timer);
        };
        const waiter: EventWaiter = {
          method,
          sessionId: options.sessionId,
          resolve: (value) => {
            cleanup();
            resolve(value);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          waiter.reject(
            new CloudBrowserTimeout({
              op: method,
              timeoutMs: options.timeoutMs,
            }),
          );
        }, options.timeoutMs);
        waiters.add(waiter);
      }),
    on: (method, listener) => {
      const subscriber = { method, listener };
      if (!closed) subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    close: () => {
      terminate("browser CDP socket closed");
      socket.close();
    },
  };
}
