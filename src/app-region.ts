import { defineIdFamily } from "@fungi.computer/cairn/id";
import * as z from "zod";
import { AppInstanceError } from "./index.js";
import { appMethodCallerSchema } from "@fungi.computer/puffball/app-method-runtime";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import {
  appRegionReplySchema,
  maxAppRegionMessageBytes,
  type AppRegionEvent,
  type AppRegionReply,
} from "@fungi.computer/puffball/backend";

/** The socket operations a Region supervisor uses; App code never sees one. */
export type AppRegionSocket = Pick<
  WebSocket,
  | "send"
  | "close"
  | "serializeAttachment"
  | "deserializeAttachment"
  | "readyState"
>;
/** `WebSocket.OPEN`: a socket neither side has started to close. */
const openState = 1;
/**
 * The native Durable Object surface a Region supervisor uses: hibernating
 * WebSockets and the Instance's one shared alarm. App code never sees it.
 */
export type AppRegionNative<
  Socket extends AppRegionSocket = WebSocket,
  Client = WebSocket,
> = Readonly<{
  /** A fresh client/server socket pair for one admitted upgrade. */
  pair(): { client: Client; server: Socket };
  /** Accept the server socket for hibernation under the Region tag. */
  accept(server: Socket): void;
  /**
   * Every Region socket on this Instance, including one the server closed
   * whose client has not yet answered the close.
   */
  sockets(): readonly Socket[];
  /** The App's persisted next wake, or null. */
  readWake(): number | null;
  /** Persist or clear the App's next wake. */
  writeWake(at: number | null): void;
  /** Lower the shared native alarm; never postpones another owner's wake. */
  scheduleWake(at: number): Promise<void>;
  /** The 101 response that hands the client socket to the browser. */
  upgraded(client: Client): Response;
  /** The supervisor's clock, in epoch milliseconds. */
  now(): number;
}>;

/** Run one bounded event in the App, under the Instance's current authority. */
export type AppRegionDeliver = (
  event: AppRegionEvent,
) => Promise<AppRegionReply>;

/** One supervisor-minted id per accepted socket; never chosen by the browser. */
const regionIds = defineIdFamily({
  family: "app-region",
  version: 1,
  kinds: { connection: { prefix: "region_conn" } },
});

/** Text frames only, bounded before App code runs. */
const regionFrameSchema = z
  .string()
  .refine(
    (data) =>
      new TextEncoder().encode(data).byteLength <= maxAppRegionMessageBytes,
  );

/** Only the host stamps this at admission; it survives hibernation natively. */
const attachmentSchema = z.strictObject({
  connection: z.string().min(1).max(64),
  caller: z.unknown(),
});

const closeCodes = {
  normal: 1000,
  unsupported: 1003,
  policy: 1008,
  refused: 1011,
  /** The browser is not draining what the App sends. */
  slowConsumer: 1013,
  fenced: 4403,
  /** The browser sent more messages than its window admits. */
  tooManyMessages: 4429,
} as const;

/**
 * Supervisor-enforced bounds on one Instance's Region. App code cannot raise
 * them; each refusal ends only the socket that crossed it.
 */
export const appRegionLimits = {
  /**
   * Region sockets per Instance, counting ones still closing (each holds a
   * native socket until its client answers); the next connect gets 429.
   */
  socketsPerInstance: 256,
  /** One caller's share of those sockets; the next connect gets 429. */
  socketsPerCaller: 32,
  /** Connects one caller may make in each one-minute window; then 429. */
  connectsPerCallerPerMinute: 30,
  /** Inbound messages one socket may send per one-second window. */
  messagesPerSecond: 32,
  /**
   * Bytes the App may send to one socket per one-second window. Workers
   * sockets expose no bufferedAmount, so a consumer that cannot take this is
   * closed (1013) instead of buffered without limit.
   */
  sendBytesPerSecond: 524_288,
  /** The earliest App wake is this long after the event that asked for it. */
  minWakeDelayMs: 1_000,
} as const;
const windowMs = 1_000;
const connectWindowMs = 60_000;
/** One caller: the host-stamped scope and actor, never anything the browser sent. */
const callerKey = (caller: AppMethodCallContext) =>
  JSON.stringify([caller.scope, caller.actor]);
const utf8Bytes = (data: string) => new TextEncoder().encode(data).byteLength;

/** A close code a server may send back: never 1005, 1006 or 1015. */
const echoCloseCode = (code: number) =>
  code === 1000 ||
  (code >= 1001 &&
    code <= 1014 &&
    code !== 1004 &&
    code !== 1005 &&
    code !== 1006) ||
  (code >= 3000 && code <= 4999)
    ? code
    : closeCodes.normal;

/**
 * Supervisor-owned Region lifecycle: native sockets and alarms stay here; the
 * App receives only bounded Region events and answers with a bounded reply.
 */
export function createAppRegion<Socket extends AppRegionSocket, Client>(
  native: AppRegionNative<Socket, Client>,
  deliver: AppRegionDeliver,
) {
  // Per-connection windows live in memory: a socket busy enough to cross a
  // bound keeps its Durable Object awake, so hibernation never resets one.
  const windows = new Map<
    string,
    { start: number; messages: number; sentBytes: number }
  >();
  const windowOf = (connection: string) => {
    const now = native.now();
    const current = windows.get(connection);
    if (current !== undefined && now - current.start < windowMs) return current;
    const fresh = { start: now, messages: 0, sentBytes: 0 };
    windows.set(connection, fresh);
    return fresh;
  };
  const connects = new Map<string, { start: number; count: number }>();
  const regionFull = (reason: string) =>
    Response.json({ error: "region_full", reason }, { status: 429 });
  const attachment = (socket: Socket) => {
    const parsed = attachmentSchema.safeParse(socket.deserializeAttachment());
    if (!parsed.success) return null;
    const caller = appMethodCallerSchema.safeParse(parsed.data.caller);
    return caller.success
      ? { connection: parsed.data.connection, caller: caller.data }
      : null;
  };
  const apply = async (raw: AppRegionReply) => {
    const reply = appRegionReplySchema.parse(raw);
    // A socket already closing (by the App, a bound or a fence) stays listed
    // until its client answers; it receives nothing more.
    const open = new Map<string, Socket>();
    for (const socket of native.sockets()) {
      if (socket.readyState !== openState) continue;
      const stamp = attachment(socket);
      if (stamp !== null) open.set(stamp.connection, socket);
    }
    for (const { connection, data } of reply.send ?? []) {
      const socket = open.get(connection);
      if (socket === undefined) continue;
      const window = windowOf(connection);
      window.sentBytes += utf8Bytes(data);
      if (window.sentBytes > appRegionLimits.sendBytesPerSecond) {
        // Drop instead of buffering: this consumer is not keeping up. Its
        // window stays until the client's close, so nothing resets it.
        open.delete(connection);
        socket.close(closeCodes.slowConsumer, "Region consumer too slow");
        continue;
      }
      // Only an open socket is sent to: a send after close throws, and one
      // socket must never abort the rest of the reply.
      if (socket.readyState === openState) socket.send(data);
    }
    for (const connection of reply.close ?? []) {
      open.get(connection)?.close(closeCodes.normal, "Closed by App");
      open.delete(connection);
    }
    if (reply.wakeAt === null) native.writeWake(null);
    else if (reply.wakeAt !== undefined) {
      // A wake at or before now would re-enter the App at once, forever.
      const at = Math.max(
        reply.wakeAt,
        native.now() + appRegionLimits.minWakeDelayMs,
      );
      native.writeWake(at);
      await native.scheduleWake(at);
    }
  };
  return {
    /**
     * Accept an already-admitted connection; the caller comes from the host.
     * Its connect runs in the admitting frame, later events in fresh ones.
     */
    async connect(
      caller: AppMethodCallContext,
      deliverConnect: AppRegionDeliver = deliver,
    ): Promise<Response> {
      const stamped = appMethodCallerSchema.parse(caller);
      const sockets = native.sockets();
      if (sockets.length >= appRegionLimits.socketsPerInstance)
        return regionFull("Region socket limit reached");
      const key = callerKey(stamped);
      const held = sockets.filter((socket) => {
        const stamp = attachment(socket);
        return stamp !== null && callerKey(stamp.caller) === key;
      }).length;
      if (held >= appRegionLimits.socketsPerCaller)
        return regionFull("Region socket share reached");
      const now = native.now();
      const recent = connects.get(key);
      const window =
        recent !== undefined && now - recent.start < connectWindowMs
          ? recent
          : { start: now, count: 0 };
      if (window.count >= appRegionLimits.connectsPerCallerPerMinute)
        return regionFull("Region connect rate reached");
      window.count += 1;
      connects.set(key, window);
      for (const [other, { start }] of connects)
        if (now - start >= connectWindowMs) connects.delete(other);
      const { client, server } = native.pair();
      const connection = regionIds.connection.generate();
      native.accept(server);
      server.serializeAttachment({ connection, caller: stamped });
      try {
        await apply(
          await deliverConnect({
            kind: "connect",
            connection,
            caller: stamped,
          }),
        );
      } catch (cause) {
        // A refused connect leaves no accepted socket behind.
        server.close(closeCodes.refused, "Region connect refused");
        throw cause;
      }
      return native.upgraded(client);
    },
    /** Deliver one bounded text frame from an attested socket. */
    async message(socket: Socket, data: string | ArrayBuffer): Promise<void> {
      // workerd keeps delivering until the peer answers a close; a socket the
      // server already closed never reaches App code again.
      if (socket.readyState !== openState) return;
      const stamp = attachment(socket);
      if (stamp === null) {
        socket.close(closeCodes.policy, "Region connection unattested");
        return;
      }
      const window = windowOf(stamp.connection);
      window.messages += 1;
      if (window.messages > appRegionLimits.messagesPerSecond) {
        socket.close(
          closeCodes.tooManyMessages,
          "Region message rate exceeded",
        );
        return;
      }
      const frame = regionFrameSchema.safeParse(data);
      if (!frame.success) {
        socket.close(closeCodes.unsupported, "Region frames are bounded text");
        return;
      }
      try {
        await apply(
          await deliver({
            kind: "message",
            connection: stamp.connection,
            data: frame.data,
          }),
        );
      } catch (cause) {
        // A refused event (disabled, revoked, changed) ends only this socket.
        socket.close(closeCodes.refused, "Region event refused");
        if (!(cause instanceof AppInstanceError)) throw cause;
      }
    },
    /**
     * The browser closed: send the server's half of the close, then tell the
     * App if the socket was attested.
     */
    async close(socket: Socket, code: number, reason: string): Promise<void> {
      socket.close(echoCloseCode(code), reason.slice(0, 120));
      const stamp = attachment(socket);
      if (stamp === null) return;
      windows.delete(stamp.connection);
      try {
        await apply(
          await deliver({ kind: "close", connection: stamp.connection }),
        );
      } catch (cause) {
        // A fenced Region's sockets close without an App to tell.
        if (!(cause instanceof AppInstanceError)) throw cause;
      }
    },
    /** Deliver the App's wake when due; the shared alarm may fire for others. */
    async alarm(): Promise<void> {
      const at = native.readWake();
      if (at === null) return;
      if (at > native.now()) {
        await native.scheduleWake(at);
        return;
      }
      native.writeWake(null);
      await apply(await deliver({ kind: "alarm" }));
    },
    /** Disable or removal: close every socket and drop the App's wake; data stays. */
    fence(reason: string): void {
      native.writeWake(null);
      for (const socket of native.sockets())
        if (socket.readyState === openState)
          socket.close(closeCodes.fenced, reason.slice(0, 120));
    },
  };
}
/** One Instance's Region supervisor. */
export type AppRegion = ReturnType<typeof createAppRegion>;

/** The Durable Object surface a Region needs: hibernating sockets and SQLite. */
export type AppRegionDurableState = Pick<
  DurableObjectState,
  "acceptWebSocket" | "getWebSockets" | "getTags"
> &
  Readonly<{ storage: Pick<DurableObjectStorage, "sql"> }>;

/** Only sockets this tag marks belong to the Region; others are never touched. */
const regionSocketTag = "app-region";
const wakeRowSchema = z.strictObject({ wake_at: z.number().int().nullable() });

/**
 * Native hibernating sockets and a persisted wake in the supervisor's own
 * SQLite. The supervisor's shared alarm is lowered through `scheduleWake`.
 */
export function durableAppRegionNative(
  ctx: AppRegionDurableState,
  scheduleWake: (at: number) => Promise<void>,
): AppRegionNative {
  // Created when the first Region socket is accepted, so an Instance that
  // never served one keeps no Region state and has no Region sockets to close.
  const hasWakeTable = () =>
    ctx.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='app_region_wake'",
      )
      .toArray().length > 0;
  const createRegionTable = () => {
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS app_region_wake (id INTEGER PRIMARY KEY CHECK (id = 1), wake_at INTEGER) STRICT",
    );
  };
  return {
    pair: () => {
      const pair = new WebSocketPair();
      return { client: pair[0], server: pair[1] };
    },
    accept: (server) => {
      createRegionTable();
      ctx.acceptWebSocket(server, [regionSocketTag]);
    },
    sockets: () => (hasWakeTable() ? ctx.getWebSockets(regionSocketTag) : []),
    readWake: () => {
      if (!hasWakeTable()) return null;
      const row = ctx.storage.sql
        .exec("SELECT wake_at FROM app_region_wake WHERE id = 1")
        .toArray()[0];
      return row === undefined ? null : wakeRowSchema.parse(row).wake_at;
    },
    writeWake: (at) => {
      if (at === null && !hasWakeTable()) return;
      createRegionTable();
      ctx.storage.sql.exec(
        "INSERT INTO app_region_wake (id, wake_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET wake_at = excluded.wake_at",
        at,
      );
    },
    scheduleWake,
    upgraded: (client) =>
      new Response(null, { status: 101, webSocket: client }),
    now: () => Date.now(),
  };
}

/** Whether a hibernated socket a Durable Object woke for is a Region socket. */
export function isAppRegionSocket(
  ctx: Pick<DurableObjectState, "getTags">,
  socket: WebSocket,
): boolean {
  return ctx.getTags(socket).includes(regionSocketTag);
}
