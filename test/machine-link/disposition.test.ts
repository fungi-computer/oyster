import assert from "node:assert/strict";
import { test } from "node:test";
import type { PostEnvelope } from "@fungi.computer/carrier/post";
import { machineLinkDisposition } from "../../src/machine-link/disposition.js";

const relay = { teamId: "team", deviceId: "relay-device" };
const originalEvent = {
  key: "mail-key",
  from: { kind: "agent", agentId: "sender", sessionId: "sender-session" },
  to: { kind: "agent", agentId: "local-agent", sessionId: "local-session" },
  replyTo: [],
  content: "work",
  createdAt: 1,
};
const original: PostEnvelope = {
  key: "mail-key",
  kind: "agentMail",
  address: { scopeId: "team", agentId: "local-agent" },
  event: originalEvent,
};
const replyEvent = {
  key: "mail-key:reply:0",
  from: { kind: "system", systemId: "hub" },
  to: { kind: "agent", agentId: "sender", sessionId: "sender-session" },
  replyTo: [],
  content: "undeliverable",
  createdAt: 2,
  reply: { outcome: "undeliverable", reason: "recipient_offline" },
};
const reply: PostEnvelope = {
  key: "mail-key:reply:0",
  kind: "agentMail",
  address: { scopeId: "team", agentId: "sender" },
  event: replyEvent,
};

await test("authenticates the one undeliverable reply against its frozen mail", () => {
  assert.deepEqual(machineLinkDisposition(relay, original, reply), {
    original,
    reply,
  });
});

await test("refuses foreign relay scope, unknown keys, forged authors, and ordinary outcomes", () => {
  assert.equal(
    machineLinkDisposition(
      { ...relay, teamId: "foreign-team" },
      original,
      reply,
    ),
    undefined,
  );
  assert.equal(
    machineLinkDisposition(
      relay,
      {
        ...original,
        address: { scopeId: "foreign-team", agentId: "local-agent" },
      },
      reply,
    ),
    undefined,
  );
  assert.equal(
    machineLinkDisposition(
      relay,
      {
        ...original,
        address: { scopeId: "team", agentId: "another-agent" },
      },
      reply,
    ),
    undefined,
  );
  assert.equal(
    machineLinkDisposition(relay, original, {
      ...reply,
      key: "unknown-mail:reply:0",
      event: {
        ...replyEvent,
        key: "unknown-mail:reply:0",
      },
    }),
    undefined,
  );
  assert.equal(
    machineLinkDisposition(relay, original, {
      ...reply,
      event: {
        ...replyEvent,
        from: {
          kind: "agent",
          agentId: "forged-agent",
          sessionId: "local-session",
        },
      },
    }),
    undefined,
  );
  assert.equal(
    machineLinkDisposition(relay, original, {
      ...reply,
      event: {
        ...replyEvent,
        reply: { outcome: "completed", commandId: "command" },
      },
    }),
    undefined,
  );
  assert.equal(
    machineLinkDisposition(relay, original, {
      ...reply,
      event: {
        ...replyEvent,
        reply: { outcome: "undeliverable", reason: "recipient_left" },
      },
    }),
    undefined,
  );
});

await test("refuses to derive a disposition from a reply or a mismatched original key", () => {
  assert.equal(
    machineLinkDisposition(
      relay,
      {
        ...original,
        event: {
          ...originalEvent,
          reply: { outcome: "accepted", commandId: "already-replied" },
        },
      },
      reply,
    ),
    undefined,
  );
  assert.equal(
    machineLinkDisposition(
      relay,
      {
        ...original,
        key: "other-key",
      },
      reply,
    ),
    undefined,
  );
});
