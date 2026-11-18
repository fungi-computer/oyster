import { describe, expect, it } from "vitest";
import * as z from "zod";
import { appRegionLimits, createAppRegion } from "../src/app-region.js";
import { AppInstanceError } from "../src/index.js";
import {
  maxAppRegionMessageBytes,
  type AppRegionEvent,
  type AppRegionReply,
} from "@fungi.computer/puffball/backend";

/**
 * A model of the native hibernation surface the supervisor uses. Like workerd,
 * a socket the server closed stays listed (CLOSING) until the client's close
 * frame arrives (`finish`), and a send after close throws.
 */
class FakeSocket {
  #attachment: string | null = null;
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  readyState = 1;
  finish() {
    this.readyState = 3;
  }
  serializeAttachment(value: Parameters<WebSocket["serializeAttachment"]>[0]) {
    this.#attachment = JSON.stringify(value);
  }
  deserializeAttachment(): object | null {
    // Native attachments are structured clones; JSON models the round trip.
    return this.#attachment === null
      ? null
      : z.record(z.string(), z.unknown()).parse(JSON.parse(this.#attachment));
  }
  send(data: string) {
    if (this.readyState !== 1)
      throw new TypeError("Can't call WebSocket send() after close().");
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    if (this.readyState === 1) this.closed = { code, reason };
    if (this.readyState < 2) this.readyState = 2;
  }
}

function nativeFixture() {
  const sockets: FakeSocket[] = [];
  let wake: number | null = null;
  let clock = 0;
  const scheduled: number[] = [];
  const native = {
    now: () => clock,
    pair: () => {
      const server = new FakeSocket();
      return { client: server, server };
    },
    accept: (socket: FakeSocket) => {
      sockets.push(socket);
    },
    sockets: () => sockets.filter((socket) => socket.readyState < 3),
    readWake: () => wake,
    writeWake: (at: number | null) => {
      wake = at;
    },
    scheduleWake: (at: number) => {
      scheduled.push(at);
      return Promise.resolve();
    },
    upgraded: () => new Response(null, { status: 200 }),
  };
  return {
    native,
    sockets,
    scheduled,
    wake: () => wake,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const caller = (teamId: string, memberId = "member_one") => ({
  scope: { kind: "team" as const, teamId },
  actor: { kind: "member" as const, memberId },
  computerId: null,
});

function recorder(answer: (event: AppRegionEvent) => AppRegionReply) {
  const events: AppRegionEvent[] = [];
  return {
    events,
    deliver: (event: AppRegionEvent) => {
      events.push(event);
      return Promise.resolve(answer(event));
    },
  };
}

describe("App Region supervisor", () => {
  it("stamps the admitted caller on the socket and survives hibernation", async () => {
    const fixture = nativeFixture();
    const first = recorder((event) =>
      event.kind === "connect"
        ? { send: [{ connection: event.connection, data: "hello" }] }
        : {},
    );
    await createAppRegion(fixture.native, first.deliver).connect(
      caller("team_one"),
    );
    const [socket] = fixture.sockets;
    if (socket === undefined) throw new Error("No socket accepted");
    expect(socket.sent).toEqual(["hello"]);
    const connected = first.events[0];
    if (connected?.kind !== "connect") throw new Error("Expected connect");
    expect(connected.caller).toEqual(caller("team_one"));
    // Hibernation: a new supervisor reads only the native attachment.
    const after = recorder(() => ({ wakeAt: 5_000 }));
    await createAppRegion(fixture.native, after.deliver).message(
      socket,
      "move",
    );
    expect(after.events).toEqual([
      { kind: "message", connection: connected.connection, data: "move" },
    ]);
    expect(fixture.wake()).toBe(5_000);
    expect(fixture.scheduled).toEqual([5_000]);
  });

  it("delivers an alarm only once it is due and with no caller", async () => {
    const fixture = nativeFixture();
    const app = recorder((event) =>
      event.kind === "alarm" ? { wakeAt: null } : { wakeAt: 2_000 },
    );
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    fixture.advance(1_999);
    await region.alarm();
    expect(app.events).toHaveLength(1);
    fixture.advance(1);
    await region.alarm();
    expect(app.events[1]).toEqual({ kind: "alarm" });
    expect(fixture.wake()).toBeNull();
    fixture.advance(7_999);
    await region.alarm();
    expect(app.events).toHaveLength(2);
  });

  it("refuses binary or oversized frames before App code runs", async () => {
    const fixture = nativeFixture();
    const app = recorder(() => ({}));
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    const [socket] = fixture.sockets;
    if (socket === undefined) throw new Error("No socket accepted");
    await region.message(socket, new ArrayBuffer(4));
    expect(socket.closed?.code).toBe(1003);
    expect(app.events).toHaveLength(1);
  });

  it("sends only to sockets of this Region and fences everything on disable", async () => {
    const fixture = nativeFixture();
    const app = recorder((event) =>
      event.kind === "message"
        ? {
            send: [
              { connection: "not-a-connection", data: "x" },
              { connection: event.connection, data: "echo:" + event.data },
            ],
            wakeAt: 9_000,
          }
        : {},
    );
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    await region.connect(caller("team_one"));
    const [first, second] = fixture.sockets;
    if (first === undefined || second === undefined)
      throw new Error("Expected two sockets");
    await region.message(first, "hi");
    expect(first.sent).toEqual(["echo:hi"]);
    expect(second.sent).toEqual([]);
    region.fence("Installation disabled");
    expect(first.closed?.code).toBe(4403);
    expect(second.closed?.code).toBe(4403);
    expect(fixture.wake()).toBeNull();
  });

  it("closes a socket whose attachment is not a host stamp", async () => {
    const fixture = nativeFixture();
    const app = recorder(() => ({}));
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    const [socket] = fixture.sockets;
    if (socket === undefined) throw new Error("No socket accepted");
    socket.serializeAttachment({
      connection: "c",
      caller: { scope: "forged" },
    });
    await region.message(socket, "hi");
    expect(socket.closed?.code).toBe(1008);
    expect(app.events).toHaveLength(1);
  });
});

describe("App Region refusals", () => {
  it("ends only the socket whose event the Instance refuses", async () => {
    const fixture = nativeFixture();
    let refuse = false;
    const region = createAppRegion(fixture.native, (event) =>
      refuse && event.kind !== "connect"
        ? Promise.reject(new AppInstanceError("disabled"))
        : Promise.resolve({}),
    );
    await region.connect(caller("team_one"));
    const [socket] = fixture.sockets;
    if (socket === undefined) throw new Error("No socket accepted");
    refuse = true;
    await region.message(socket, "after disable");
    expect(socket.closed?.code).toBe(1011);
    await expect(region.close(socket, 1000, "bye")).resolves.toBeUndefined();
  });

  it("closes a socket whose App connect fails before answering the upgrade", async () => {
    const fixture = nativeFixture();
    const region = createAppRegion(fixture.native, () =>
      Promise.reject(new Error("App connect failed")),
    );
    await expect(region.connect(caller("team_one"))).rejects.toThrow(
      "App connect failed",
    );
    expect(fixture.sockets[0]?.closed?.code).toBe(1011);
  });
});

describe("App Region bounds", () => {
  const onlySocket = (fixture: ReturnType<typeof nativeFixture>) => {
    const [socket] = fixture.sockets;
    if (socket === undefined) throw new Error("No socket accepted");
    return socket;
  };

  it("refuses a connect past the per-Instance socket cap with 429", async () => {
    const fixture = nativeFixture();
    const app = recorder(() => ({}));
    const region = createAppRegion(fixture.native, app.deliver);
    const member = (index: number) =>
      caller("team_one", `member_${String(index)}`);
    // Fill the Region as hibernation finds it: sockets already accepted and
    // stamped. Filling through connect re-parses every held attachment on each
    // of the 256 connects (about 33k parses: 3.3 s idle, past the 5 s limit
    // under load); the cap is decided by the one connect below.
    for (
      let index = 0;
      index < appRegionLimits.socketsPerInstance;
      index += 1
    ) {
      const socket = new FakeSocket();
      socket.serializeAttachment({
        connection: `conn_${String(index)}`,
        caller: member(index),
      });
      fixture.native.accept(socket);
    }
    const refused = await region.connect(member(9_999));
    expect(refused.status).toBe(429);
    // No socket was accepted and the App never saw the refused connect.
    expect(fixture.sockets).toHaveLength(appRegionLimits.socketsPerInstance);
    expect(app.events).toHaveLength(0);
    // A server-closed socket still holds its slot until the client's close
    // frame arrives; then the slot is free.
    fixture.sockets[0]?.close(1000, "gone");
    expect((await region.connect(member(9_999))).status).toBe(429);
    fixture.sockets[0]?.finish();
    expect((await region.connect(member(9_999))).status).toBe(200);
  });

  it("closes a socket that floods inbound messages before App code runs", async () => {
    const fixture = nativeFixture();
    const app = recorder(() => ({}));
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    const socket = onlySocket(fixture);
    for (let index = 0; index < appRegionLimits.messagesPerSecond; index += 1)
      await region.message(socket, "tick");
    expect(socket.closed).toBeNull();
    await region.message(socket, "one too many");
    expect(socket.closed?.code).toBe(4429);
    expect(app.events).toHaveLength(1 + appRegionLimits.messagesPerSecond);
  });

  it("admits a steady rate across windows", async () => {
    const fixture = nativeFixture();
    const app = recorder(() => ({}));
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    const socket = onlySocket(fixture);
    for (let second = 0; second < 3; second += 1) {
      for (let index = 0; index < appRegionLimits.messagesPerSecond; index += 1)
        await region.message(socket, "tick");
      fixture.advance(1_000);
    }
    expect(socket.closed).toBeNull();
  });

  it("closes a slow consumer whose outbound bytes exceed its budget", async () => {
    const fixture = nativeFixture();
    const frame = "x".repeat(maxAppRegionMessageBytes);
    const perSecond =
      appRegionLimits.sendBytesPerSecond / maxAppRegionMessageBytes;
    const app = recorder((event) =>
      event.kind === "message"
        ? {
            send: Array.from({ length: perSecond + 1 }, () => ({
              connection: event.connection,
              data: frame,
            })),
          }
        : {},
    );
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    await region.connect(caller("team_one"));
    const [slow, other] = fixture.sockets;
    if (slow === undefined || other === undefined)
      throw new Error("Expected two sockets");
    await region.message(slow, "flood me");
    expect(slow.sent).toHaveLength(perSecond);
    expect(slow.closed?.code).toBe(1013);
    expect(other.closed).toBeNull();
  });

  it("clamps an App wake to the minimum delay so an alarm cannot spin", async () => {
    const fixture = nativeFixture();
    fixture.advance(10_000);
    const app = recorder(() => ({ wakeAt: 1 }));
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    const floor = 10_000 + appRegionLimits.minWakeDelayMs;
    expect(fixture.wake()).toBe(floor);
    expect(fixture.scheduled).toEqual([floor]);
    // The alarm's own "wake me now" reply is pushed out by the floor too.
    fixture.advance(appRegionLimits.minWakeDelayMs);
    await region.alarm();
    expect(app.events.at(-1)).toEqual({ kind: "alarm" });
    expect(fixture.wake()).toBe(floor + appRegionLimits.minWakeDelayMs);
    await region.alarm();
    expect(app.events.filter((event) => event.kind === "alarm")).toHaveLength(
      1,
    );
  });

  it("answers the browser's close with the server half before telling the App", async () => {
    const fixture = nativeFixture();
    const app = recorder(() => ({}));
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    await region.connect(caller("team_one"));
    const [first, second] = fixture.sockets;
    if (first === undefined || second === undefined)
      throw new Error("Expected two sockets");
    await region.close(first, 1001, "page left");
    expect(first.closed).toEqual({ code: 1001, reason: "page left" });
    // A close without a status (1005) or an abnormal one (1006) cannot be sent.
    await region.close(second, 1005, "");
    expect(second.closed?.code).toBe(1000);
    expect(app.events.filter((event) => event.kind === "close")).toHaveLength(
      2,
    );
  });
});

describe("App Region closing sockets", () => {
  it("keeps a rate-refused socket refused until its client close arrives", async () => {
    const fixture = nativeFixture();
    const app = recorder(() => ({}));
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    const [socket] = fixture.sockets;
    if (socket === undefined) throw new Error("No socket accepted");
    for (let index = 0; index <= appRegionLimits.messagesPerSecond; index += 1)
      await region.message(socket, "tick");
    expect(socket.closed?.code).toBe(4429);
    const delivered = app.events.length;
    // workerd keeps delivering until the peer answers the close; none of it
    // reaches App code, even in a later window.
    for (let index = 0; index < 64; index += 1)
      await region.message(socket, "still here");
    fixture.advance(5_000);
    await region.message(socket, "later window");
    expect(app.events).toHaveLength(delivered);
  });

  it("sends nothing more to a slow consumer it closed, in any later window", async () => {
    const fixture = nativeFixture();
    const frame = "x".repeat(maxAppRegionMessageBytes);
    const perSecond =
      appRegionLimits.sendBytesPerSecond / maxAppRegionMessageBytes;
    let target = "";
    const app = recorder((event) => {
      if (event.kind === "connect" && target === "") target = event.connection;
      return event.kind === "message"
        ? {
            send: Array.from({ length: perSecond + 1 }, () => ({
              connection: target,
              data: frame,
            })),
          }
        : {};
    });
    const region = createAppRegion(fixture.native, app.deliver);
    await region.connect(caller("team_one"));
    await region.connect(caller("team_one"));
    const [slow, other] = fixture.sockets;
    if (slow === undefined || other === undefined)
      throw new Error("Expected two sockets");
    await region.message(other, "flood the first");
    expect(slow.closed?.code).toBe(1013);
    fixture.advance(5_000);
    await region.message(other, "flood it again");
    expect(slow.sent).toHaveLength(perSecond);
    expect(other.closed).toBeNull();
  });

  it("never lets one closing socket break the rest of a reply", async () => {
    const fixture = nativeFixture();
    const connections: string[] = [];
    const app = recorder((event) => {
      if (event.kind === "connect") connections.push(event.connection);
      if (event.kind !== "message") return {};
      if (event.data === "close the first")
        return { close: [connections[0] ?? ""] };
      return {
        send: connections.map((connection) => ({ connection, data: "tick" })),
        close: [connections[2] ?? ""],
        wakeAt: 50_000,
      };
    });
    const region = createAppRegion(fixture.native, app.deliver);
    for (let index = 0; index < 3; index += 1)
      await region.connect(caller("team_one"));
    const [first, second, third] = fixture.sockets;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error("Expected three sockets");
    await region.message(second, "close the first");
    expect(first.closed?.code).toBe(1000);
    // The first socket is CLOSING: still listed, and a send to it would throw.
    await region.message(second, "fan out");
    expect(second.sent).toEqual(["tick"]);
    expect(second.closed).toBeNull();
    expect(third.sent).toEqual(["tick"]);
    expect(third.closed?.code).toBe(1000);
    expect(fixture.wake()).toBe(50_000);
  });

  it("gives each caller a share of the Instance's sockets", async () => {
    const fixture = nativeFixture();
    const region = createAppRegion(
      fixture.native,
      recorder(() => ({})).deliver,
    );
    // Spread out, so the connect-rate bound is not what refuses.
    for (let index = 0; index < appRegionLimits.socketsPerCaller; index += 1) {
      expect((await region.connect(caller("team_one"))).status).toBe(200);
      fixture.advance(2_001);
    }
    expect((await region.connect(caller("team_one"))).status).toBe(429);
    expect(
      (await region.connect(caller("team_one", "member_two"))).status,
    ).toBe(200);
  });

  it("bounds how fast one caller may reconnect", async () => {
    const fixture = nativeFixture();
    const region = createAppRegion(
      fixture.native,
      recorder(() => ({})).deliver,
    );
    for (
      let index = 0;
      index < appRegionLimits.connectsPerCallerPerMinute;
      index += 1
    ) {
      expect((await region.connect(caller("team_one"))).status).toBe(200);
      const socket = fixture.sockets.at(-1);
      socket?.close(1000, "gone");
      socket?.finish();
    }
    expect((await region.connect(caller("team_one"))).status).toBe(429);
    expect(
      (await region.connect(caller("team_one", "member_two"))).status,
    ).toBe(200);
    fixture.advance(60_000);
    expect((await region.connect(caller("team_one"))).status).toBe(200);
  });
});
