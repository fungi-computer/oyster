import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import type { PostEnvelope } from "@fungi.computer/carrier/post";
import type { MachineLinkAuthority } from "../../src/machine-link/authority.js";
import {
  createMachineLink,
  type MachineLinkState,
} from "../../src/machine-link/workers.js";

const target = { teamId: "team", deviceId: "sender-device" };
const relay = { teamId: "team", deviceId: "relay-device" };
const original: PostEnvelope = {
  key: "original-key",
  kind: "agentMail",
  address: { scopeId: "team", agentId: "recipient" },
  event: {
    key: "original-key",
    from: { kind: "agent", agentId: "sender", sessionId: "sender-session" },
    to: {
      kind: "agent",
      agentId: "recipient",
      sessionId: "recipient-session",
    },
    replyTo: [],
    content: "work",
    createdAt: 1,
  },
};
const reply: PostEnvelope = {
  key: "original-key:reply:0",
  kind: "agentMail",
  address: { scopeId: "team", agentId: "sender" },
  event: {
    key: "original-key:reply:0",
    from: { kind: "system", systemId: "hub" },
    to: { kind: "agent", agentId: "sender", sessionId: "sender-session" },
    replyTo: [],
    content: "undeliverable",
    createdAt: 2,
    reply: { outcome: "undeliverable", reason: "recipient_offline" },
  },
};

function installAutoResponsePair(): void {
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

function link() {
  const database = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(database);
  // This route proof exercises staged-disposition authority and duplicate
  // refusal with an empty Durable Object key-value store.
  function get(key: string): Promise<undefined>;
  function get(keys: string[]): Promise<Map<string, never>>;
  function get(
    keyOrKeys: string | string[],
  ): Promise<undefined | Map<string, never>> {
    return Promise.resolve(
      Array.isArray(keyOrKeys) ? new Map<string, never>() : undefined,
    );
  }
  function put(): Promise<void> {
    return Promise.resolve();
  }
  const storage: MachineLinkState["storage"] = {
    ...owner,
    get,
    put,
    setAlarm: () => Promise.resolve(),
  };
  const authority: Omit<MachineLinkAuthority, "deliverControlFact"> = {
    admitDevice: (identity) =>
      Promise.resolve({
        ...identity,
        live: true,
        memberId: "member",
        publicKey: "device-key",
        fenceEpoch: 1,
      }),
    currentFence: (identity) =>
      Promise.resolve(
        identity.teamId === "team" &&
          ["relay-device", "forged-device"].includes(identity.deviceId)
          ? { ...identity, live: true, fenceEpoch: 1 }
          : null,
      ),
    directory: () => Promise.resolve([]),
    agentHome: (_identity, agentId) =>
      Promise.resolve(
        agentId === "sender"
          ? { kind: "machine", deviceId: target.deviceId }
          : null,
      ),
    resolveTarget: () => {
      throw new Error("relay disposition does not resolve ordinary targets");
    },
    deliverHome: () => Promise.resolve("accepted"),
    deliverUndeliverable: () => Promise.resolve("accepted"),
    verifyRelayDisposition: (identity, held, undeliverable) =>
      Promise.resolve(
        identity.teamId === relay.teamId &&
          identity.deviceId === relay.deviceId &&
          held.key === original.key &&
          undeliverable.key === reply.key,
      ),
    canErase: () => Promise.resolve(true),
  };
  const machineLink = createMachineLink(
    {
      storage,
      getWebSockets: () => [],
      acceptWebSocket: () => undefined,
      setWebSocketAutoResponse: () => undefined,
      waitUntil: () => undefined,
    },
    {
      authority,
      addressed: (identity) =>
        identity.teamId === target.teamId &&
        identity.deviceId === target.deviceId,
      erasure: {
        erased: () => Promise.resolve(false),
        erase: () => Promise.resolve(undefined),
        read: () => Promise.resolve(undefined),
      },
      report: () => undefined,
    },
  );
  return { database, machineLink };
}

await test("the receiver route accepts one staged reply and refuses its duplicate", async () => {
  installAutoResponsePair();
  const { database, machineLink } = link();
  try {
    assert.deepEqual(
      await machineLink.deliverRelayDisposition(target, relay, original, reply),
      {
        status: "accepted",
        receipt: {
          status: "held",
          reason: "recipient_offline",
          message: "waiting: recipient offline",
        },
      },
    );
    assert.equal(
      await machineLink.deliverRelayDisposition(target, relay, original, reply),
      "refused",
    );
  } finally {
    database.close();
  }
});

await test("the receiver route refuses forged live relays and malformed dispositions", async () => {
  installAutoResponsePair();
  const { database, machineLink } = link();
  try {
    assert.equal(
      await machineLink.deliverRelayDisposition(
        target,
        { ...relay, deviceId: "forged-device" },
        original,
        reply,
      ),
      "refused",
    );
    assert.equal(
      await machineLink.deliverRelayDisposition(
        target,
        { ...relay, teamId: "foreign-team" },
        original,
        reply,
      ),
      "refused",
    );
    assert.equal(
      await machineLink.deliverRelayDisposition(target, relay, original, {
        ...reply,
        key: "unknown-key:reply:0",
      }),
      "refused",
    );
    assert.equal(
      await machineLink.deliverRelayDisposition(target, relay, original, {
        ...reply,
        event: {
          key: reply.key,
          from: {
            kind: "agent",
            agentId: "forged-agent",
            sessionId: "recipient-session",
          },
          to: { kind: "agent", agentId: "sender", sessionId: "sender-session" },
          replyTo: [],
          content: "undeliverable",
          createdAt: 2,
          reply: { outcome: "undeliverable", reason: "recipient_offline" },
        },
      }),
      "refused",
    );
    assert.equal(
      await machineLink.deliverRelayDisposition(
        target,
        relay,
        {
          ...original,
          address: { scopeId: "foreign-team", agentId: "recipient" },
        },
        reply,
      ),
      "refused",
    );
    assert.equal(
      await machineLink.deliverRelayDisposition(target, relay, original, {
        ...reply,
        event: {
          key: reply.key,
          from: {
            kind: "agent",
            agentId: "recipient",
            sessionId: "recipient-session",
          },
          to: { kind: "agent", agentId: "sender", sessionId: "sender-session" },
          replyTo: [],
          content: "completed",
          createdAt: 2,
          reply: { outcome: "completed", commandId: "command" },
        },
      }),
      "refused",
    );
  } finally {
    database.close();
  }
});
