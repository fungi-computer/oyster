import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import {
  createMachineLinkPostChannel,
  machineLinkAudience,
  machineLinkDialUrl,
} from "@fungi.computer/seam/machine-link-protocol";
import {
  seamHeader,
  signSeamRequest,
  unsignedPayload,
} from "@fungi.computer/seam";
import type {
  PostDeliveryResult,
  PostEnvelope,
} from "@fungi.computer/carrier/post";
import { PostRowSchema } from "@fungi.computer/carrier/post";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { createLocalBackendReplayStore } from "../../../computer/src/local-backend-replay.js";
import {
  MachineLinkHost,
  type MachineLinkDevice,
} from "../../src/machine-link/host.js";

const device: MachineLinkDevice = {
  deviceId: "device",
  memberId: "member",
  publicKey: "key",
  fenceEpoch: 1,
};
const held = {
  status: "accepted",
  receipt: {
    status: "held",
    reason: "recipient_offline",
    message: "waiting: recipient offline",
  },
};

const envelope = (key: string, agentId: string): PostEnvelope => ({
  key,
  kind: "agentMail",
  address: { scopeId: "team", agentId },
  event: {
    key,
    from: { kind: "agent", agentId: "sender", sessionId: "creator" },
    to: { kind: "agent", agentId, sessionId: "local-session" },
    replyTo: [],
    content: key,
    createdAt: 1,
  },
});

function context(
  sockets: FakeWebSocket[] = [],
  waitUntil: (promise: Promise<unknown>) => void = (promise) => {
    void promise;
  },
) {
  return {
    getWebSockets: (tag?: string) =>
      tag === undefined || tag === `machine-link:${device.deviceId}`
        ? sockets
        : [],
    acceptWebSocket: (socket: WebSocket) => {
      if (socket instanceof FakeWebSocket && !sockets.includes(socket))
        sockets.push(socket);
      socket.accept();
    },
    setWebSocketAutoResponse: () => undefined,
    waitUntil,
  };
}

function host(
  owner: ReturnType<typeof fromNodeSqlite>,
  sockets: FakeWebSocket[] = [],
) {
  return new MachineLinkHost(context(sockets), owner, {
    teamId: "team",
    directory: () => Promise.resolve([]),
    authorize: () => Promise.resolve(device),
    receive: () => Promise.resolve("accepted"),
    replay: () => Promise.resolve(createLocalBackendReplayStore(owner)),
    scheduleWake: () => Promise.resolve(),
    report: (operation, cause) => {
      throw new Error(operation, { cause });
    },
  });
}

type FakeSocketAttachment = Readonly<{
  deviceId: string;
  fenceEpoch: number;
}>;

class FakeWebSocket extends EventTarget implements WebSocket {
  binaryType: WebSocket["binaryType"] = "arraybuffer";
  bufferedAmount = 0;
  extensions = "";
  onclose: ((this: WebSocket, ev: CloseEvent) => void) | null = null;
  onerror: ((this: WebSocket, ev: Event) => void) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => void) | null = null;
  onopen: ((this: WebSocket, ev: Event) => void) | null = null;
  protocol = "";
  readyState = WebSocket.OPEN;
  url = "wss://device.test";
  #attachment: FakeSocketAttachment = {
    deviceId: device.deviceId,
    fenceEpoch: device.fenceEpoch,
  };
  #sendFrame: ((frame: string) => void) | undefined;
  #accepted = false;
  #upgradeAccepted = true;
  #pendingFrames: string[] = [];

  accept(): void {
    this.#accepted = true;
  }
  get wasAccepted(): boolean {
    return this.#accepted;
  }
  holdUntilUpgrade(): void {
    this.#upgradeAccepted = false;
  }
  acceptUpgrade(): void {
    this.#upgradeAccepted = true;
    for (const frame of this.#pendingFrames.splice(0)) this.#sendFrame?.(frame);
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const frame = Schema.decodeUnknownSync(Schema.String)(data);
    if (!this.#upgradeAccepted) {
      this.#pendingFrames.push(frame);
      return;
    }
    this.#sendFrame?.(frame);
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
  serializeAttachment(value: FakeSocketAttachment): void {
    this.#attachment = value;
  }
  deserializeAttachment(): FakeSocketAttachment {
    return this.#attachment;
  }
  sendFrameWith(send: (frame: string) => void): void {
    this.#sendFrame = send;
  }
}

function installAutoResponsePair() {
  Object.defineProperty(globalThis, "WebSocketRequestResponsePair", {
    configurable: true,
    value: class {
      constructor(
        readonly request: string,
        readonly response: string,
      ) {}
    },
  });
}

const limits = {
  maxInFlight: 32,
  maxFrameBytes: 512 * 1024,
  acknowledgmentMs: 10_000,
};

await test("offline custody uses the DO key/value Post table, survives reopen beside replay data, deduplicates, and exposes expiry", async () => {
  installAutoResponsePair();
  const directory = await mkdtemp(join(tmpdir(), "machine-link-custody-"));
  const path = join(directory, "machine.sqlite");
  let database = new DatabaseSync(path);
  let owner = fromNodeSqlite(database);
  const replay = createLocalBackendReplayStore(owner);
  assert.equal(
    replay.admit({ nonce: "before-post", now: 1, expiresAt: 10_000 }),
    "admitted",
  );
  const firstHost = host(owner);
  try {
    assert.equal(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='carrier_post_rows'",
        )
        .get(),
      undefined,
      "existing replay-only DOs have no Carrier table until first Post use",
    );
    const before = Date.now();
    const admitted = await firstHost.deliver(
      device.deviceId,
      envelope("one", "agent-a"),
    );
    const after = Date.now();
    assert.deepEqual(admitted, held);
    assert.equal(
      database
        .prepare("SELECT value FROM carrier_post_rows WHERE key=?")
        .get("post:one")?.value !== undefined,
      true,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM computer_local_dial_replay")
        .get()?.count,
      1,
      "creating the Post table preserves the DO's existing replay-store data",
    );
    assert.deepEqual(
      await firstHost.deliver(device.deviceId, envelope("one", "agent-a")),
      held,
    );
    await assert.rejects(
      firstHost.deliver(device.deviceId, envelope("one", "other-agent")),
      /conflicting post key/,
    );
    const persisted = Schema.decodeUnknownSync(PostRowSchema)(
      database
        .prepare("SELECT value FROM carrier_post_rows WHERE key=?")
        .get("post:one")?.value,
    );
    assert.equal(persisted.state, "pending");
    assert.ok(persisted.deadlineAt !== undefined);
    const sevenDays = 7 * 24 * 60 * 60 * 1_000;
    assert.ok(persisted.deadlineAt >= before + sevenDays);
    assert.ok(persisted.deadlineAt <= after + sevenDays);

    database.close();
    database = new DatabaseSync(path);
    owner = fromNodeSqlite(database);
    assert.equal(
      createLocalBackendReplayStore(owner).admit({
        nonce: "before-post",
        now: 1,
        expiresAt: 10_000,
      }),
      "replayed",
      "Carrier initialization leaves prior replay-store rows intact across a physical reopen",
    );
    const reopened = host(owner);
    const originalNow = Date.now;
    Date.now = () => originalNow() + 7 * 24 * 60 * 60 * 1_000 + 1;
    try {
      await reopened.alarm();
      const dead = await reopened.deadLetters();
      assert.equal(
        dead.letters.some(
          (letter) => letter.key === "post:one" && letter.reason === "expired",
        ),
        true,
      );
    } finally {
      Date.now = originalNow;
    }
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("fresh dial drains durable held mail in FIFO order independently for each Agent", async () => {
  installAutoResponsePair();
  const database = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(database);
  const firstHost = host(owner);
  const first = envelope("agent-a-1", "agent-a");
  const second = envelope("agent-b-1", "agent-b");
  const third = envelope("agent-a-2", "agent-a");
  assert.deepEqual(await firstHost.deliver(device.deviceId, first), held);
  assert.deepEqual(await firstHost.deliver(device.deviceId, second), held);
  assert.deepEqual(await firstHost.deliver(device.deviceId, third), held);

  const socket = new FakeWebSocket();
  const sockets = [socket];
  const reopened = host(owner, sockets);
  const received: PostEnvelope[] = [];
  const machineToRelay = (frame: string) => {
    void reopened.message(socket, frame);
  };
  const machine = createMachineLinkPostChannel({
    limits,
    send: machineToRelay,
    receive: (message) => {
      if (message.kind === "agentMail" || message.kind === "machineAgent")
        received.push(message);
      return Promise.resolve("accepted");
    },
  });
  socket.sendFrameWith((frame) => {
    void machine.receive(frame);
  });
  try {
    await reopened.connected(socket, device.deviceId);
    assert.equal(await reopened.deliver(device.deviceId, first), "accepted");
    const fromA = received
      .filter((message) => {
        const address = Schema.decodeUnknownSync(
          Schema.Struct({ scopeId: Schema.String, agentId: Schema.String }),
        )(message.address);
        return address.agentId === "agent-a";
      })
      .map((message) => message.key);
    const fromB = received
      .filter((message) => {
        const address = Schema.decodeUnknownSync(
          Schema.Struct({ scopeId: Schema.String, agentId: Schema.String }),
        )(message.address);
        return address.agentId === "agent-b";
      })
      .map((message) => message.key);
    assert.deepEqual(fromA, ["agent-a-1", "agent-a-2"]);
    assert.deepEqual(fromB, ["agent-b-1"]);
  } finally {
    machine.close();
    database.close();
  }
});

await test("fresh dial releases a settled offline retry after a physical reopen", async () => {
  installAutoResponsePair();
  const directory = await mkdtemp(join(tmpdir(), "machine-link-retry-"));
  const path = join(directory, "machine.sqlite");
  let database = new DatabaseSync(path);
  try {
    let owner = fromNodeSqlite(database);
    const firstHost = host(owner);
    const message = envelope("offline-then-redial", "agent-a");
    assert.deepEqual(await firstHost.deliver(device.deviceId, message), held);
    const retryStartedAt = Date.now();
    await firstHost.alarm();
    const attempted = Schema.decodeUnknownSync(PostRowSchema)(
      database
        .prepare("SELECT value FROM carrier_post_rows WHERE key=?")
        .get("post:offline-then-redial")?.value,
    );
    assert.equal(attempted.state, "pending");
    assert.ok(attempted.attempts > 0);
    assert.ok(attempted.nextAttemptAt > retryStartedAt);

    database.close();
    database = new DatabaseSync(path);
    owner = fromNodeSqlite(database);
    const socket = new FakeWebSocket();
    socket.accept();
    const reopened = host(owner, [socket]);
    const received: PostEnvelope[] = [];
    const machine = createMachineLinkPostChannel({
      limits,
      send: (frame) => {
        void reopened.message(socket, frame);
      },
      receive: (incoming) => {
        if (incoming.kind === "agentMail") received.push(incoming);
        return Promise.resolve("accepted");
      },
    });
    socket.sendFrameWith((frame) => {
      void machine.receive(frame);
    });
    try {
      await reopened.connected(socket, device.deviceId);
      assert.deepEqual(
        received.map(({ key }) => key),
        ["offline-then-redial"],
      );
    } finally {
      machine.close();
    }
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("identical live machine-agent operations keep their application receipt", async () => {
  installAutoResponsePair();
  const database = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(database);
  const socket = new FakeWebSocket();
  const reopened = host(owner, [socket]);
  const receipt: PostDeliveryResult = {
    status: "accepted",
    receipt: { status: "accepted", commandId: "command" },
  };
  const machine = createMachineLinkPostChannel({
    limits,
    send: (frame) => {
      void reopened.message(socket, frame);
    },
    receive: () => Promise.resolve(receipt),
  });
  socket.sendFrameWith((frame) => {
    void machine.receive(frame);
  });
  const operation: PostEnvelope = {
    key: "settlement:command",
    kind: "machineAgent",
    address: { scopeId: "team", agentId: "agent-a" },
    event: {
      actorAgentId: "agent-a",
      operation: {
        type: "settlement",
        requesterAgentId: "agent-a",
        sessionId: "session",
        commandId: "command",
      },
    },
  };
  try {
    assert.deepEqual(
      await reopened.deliver(device.deviceId, operation),
      receipt,
    );
    assert.deepEqual(
      await reopened.deliver(device.deviceId, operation),
      receipt,
    );
  } finally {
    machine.close();
    database.close();
  }
});

await test("accepted duplicate mail after host reconstruction returns the original application receipt", async () => {
  installAutoResponsePair();
  const directory = await mkdtemp(join(tmpdir(), "machine-link-receipt-"));
  const path = join(directory, "machine.sqlite");
  let database = new DatabaseSync(path);
  try {
    const owner = fromNodeSqlite(database);
    const socket = new FakeWebSocket();
    socket.accept();
    const firstHost = host(owner, [socket]);
    const originalReceipt: PostDeliveryResult = {
      status: "accepted",
      receipt: { status: "accepted", commandId: "original-command" },
    };
    const machine = createMachineLinkPostChannel({
      limits,
      send: (frame) => {
        void firstHost.message(socket, frame);
      },
      receive: () => Promise.resolve(originalReceipt),
    });
    socket.sendFrameWith((frame) => {
      void machine.receive(frame);
    });
    const message = envelope("mail-with-application-receipt", "agent-a");
    try {
      await firstHost.connected(socket, device.deviceId);
      assert.deepEqual(
        await firstHost.deliver(device.deviceId, message),
        originalReceipt,
      );
    } finally {
      machine.close();
    }

    database.close();
    database = new DatabaseSync(path);
    const reconstructedHost = host(fromNodeSqlite(database));
    assert.deepEqual(
      await reconstructedHost.deliver(device.deviceId, message),
      originalReceipt,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("expired custody exposes every row through 64-key dead-letter pages", async () => {
  installAutoResponsePair();
  const database = new DatabaseSync(":memory:");
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const owner = fromNodeSqlite(database);
    const firstHost = host(owner);
    const keys = Array.from(
      { length: 65 },
      (_, index) => `expired-${String(index).padStart(3, "0")}`,
    );
    for (const [index, key] of keys.entries())
      assert.deepEqual(
        await firstHost.deliver(
          device.deviceId,
          envelope(key, `agent-${String(index).padStart(3, "0")}`),
        ),
        held,
      );

    now += 7 * 24 * 60 * 60 * 1_000 + 1;
    await firstHost.alarm();
    await firstHost.alarm();
    const first = await firstHost.deadLetters();
    assert.equal(first.letters.length, 64);
    assert.ok(first.nextCursor);
    const second = await firstHost.deadLetters(first.nextCursor);
    assert.equal(second.letters.length, 1);
    assert.equal(second.nextCursor, undefined);
    assert.deepEqual(
      [...first.letters, ...second.letters].map(({ key }) =>
        key.slice("post:".length),
      ),
      keys,
    );
  } finally {
    Date.now = originalNow;
    database.close();
  }
});

await test(
  "websocket upgrade completes before durable delivery waits for the client's acknowledgment",
  { timeout: 1_000 },
  async () => {
    installAutoResponsePair();
    const database = new DatabaseSync(":memory:");
    const owner = fromNodeSqlite(database);
    const firstHost = host(owner);
    assert.deepEqual(
      await firstHost.deliver(
        device.deviceId,
        envelope("after-upgrade", "agent-a"),
      ),
      held,
    );

    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    if (!("privateKey" in keys)) throw new Error("Expected a device key pair");
    const exported = await crypto.subtle.exportKey("raw", keys.publicKey);
    if (!(exported instanceof ArrayBuffer))
      throw new Error("Expected raw Ed25519 bytes");
    const authorizedDevice = {
      ...device,
      publicKey: btoa(String.fromCharCode(...new Uint8Array(exported))),
    };
    const sockets: FakeWebSocket[] = [];
    const background: Promise<unknown>[] = [];
    let pair:
      | {
          client: FakeWebSocket;
          server: FakeWebSocket;
        }
      | undefined;
    let dialHost: MachineLinkHost | undefined;
    const received: PostEnvelope[] = [];
    const machine = createMachineLinkPostChannel({
      limits,
      send: (frame) => {
        if (pair === undefined || dialHost === undefined)
          throw new Error("The WebSocket pair is not ready");
        void dialHost.message(pair.server, frame);
      },
      receive: (message) => {
        if (message.kind === "agentMail") received.push(message);
        return Promise.resolve("accepted");
      },
    });

    const responseDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "Response",
    );
    const pairDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "WebSocketPair",
    );
    class TestWebSocketPair {
      readonly 0: FakeWebSocket;
      readonly 1: FakeWebSocket;
      constructor() {
        const client = new FakeWebSocket();
        client.holdUntilUpgrade();
        const server = new FakeWebSocket();
        server.sendFrameWith((frame) => {
          void machine.receive(frame);
        });
        client.sendFrameWith((frame) => {
          if (dialHost === undefined) throw new Error("The host is not ready");
          void dialHost.message(server, frame);
        });
        pair = { client, server };
        this[0] = client;
        this[1] = server;
      }
    }
    class TestUpgradeResponse {
      readonly headers = new Headers();
      readonly status: number;
      readonly webSocket: WebSocket;
      constructor(_body: null, init: { status: number; webSocket: WebSocket }) {
        if (pair === undefined)
          throw new Error("The response preceded WebSocket construction");
        assert.equal(pair.server.wasAccepted, true);
        this.status = init.status;
        this.webSocket = init.webSocket;
        pair.client.acceptUpgrade();
      }
    }
    Object.defineProperty(globalThis, "Response", {
      configurable: true,
      value: TestUpgradeResponse,
    });
    Object.defineProperty(globalThis, "WebSocketPair", {
      configurable: true,
      value: TestWebSocketPair,
    });
    try {
      dialHost = new MachineLinkHost(
        context(sockets, (promise) => background.push(promise)),
        owner,
        {
          teamId: "team",
          directory: () => Promise.resolve([]),
          authorize: () => Promise.resolve(authorizedDevice),
          replay: () => Promise.resolve(createLocalBackendReplayStore(owner)),
          receive: () => Promise.resolve("refused"),
          scheduleWake: () => Promise.resolve(),
          report: (operation, cause) => {
            throw new Error(operation, { cause });
          },
        },
      );
      const url = machineLinkDialUrl(
        "https://hub.test",
        "team",
        device.deviceId,
      );
      const signature = await signSeamRequest(
        { keyId: device.deviceId, key: keys.privateKey },
        machineLinkAudience("team", device.deviceId),
        "GET",
        url.href,
        unsignedPayload,
      );
      const response = await dialHost.fetch(
        new Request(url, {
          headers: { [seamHeader]: signature, Upgrade: "websocket" },
        }),
      );
      assert.equal(response.status, 101);
      assert.ok(pair !== undefined);
      assert.ok(sockets.includes(pair.server));
      for (const promise of background) await promise;
      assert.deepEqual(
        received.map(({ key }) => key),
        ["after-upgrade"],
      );
    } finally {
      machine.close();
      if (responseDescriptor !== undefined)
        Object.defineProperty(globalThis, "Response", responseDescriptor);
      else Reflect.deleteProperty(globalThis, "Response");
      if (pairDescriptor !== undefined)
        Object.defineProperty(globalThis, "WebSocketPair", pairDescriptor);
      else Reflect.deleteProperty(globalThis, "WebSocketPair");
      database.close();
    }
  },
);
