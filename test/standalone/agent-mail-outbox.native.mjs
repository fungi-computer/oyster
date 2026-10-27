import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { Watchdog } from "@fungi.computer/watchdog";
import { agentMail } from "../../src/standalone/agent-mail.ts";

await test("the sender's standalone AgentMail outbox authors one local offline reply after twenty attempts", async () => {
  const database = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(database);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let execute = async () => {
    throw new Error("Agent Post runtime is not open");
  };
  const deliveredLocally = [];
  try {
    const watchdog = await Watchdog.make({
      owner,
      concurrentLane: "post",
      isAlive: () => Promise.resolve(false),
      execute: (job) => execute(job),
      wake: { recompute: async () => undefined },
    });
    const hostRuntime = {
      transactional: watchdog.transactional,
      readJob: watchdog.read,
      tickConcurrent: watchdog.tickConcurrent,
    };
    const mail = agentMail({
      storage: owner,
      identity: () => ({ scopeId: "team", agentId: "parent" }),
      replySettlement: async () => undefined,
      wake: async () => undefined,
      namespace: {
        getByName: (agentId) => ({
          deliver: async () => {
            if (agentId === "child")
              throw new Error("recipient transport unavailable");
            return "accepted";
          },
        }),
      },
      onUndeliverable: async (original, reply) => {
        if (deliveredLocally.some((entry) => entry.key === reply.key))
          return "refused";
        deliveredLocally.push({
          original: globalThis.structuredClone(original),
          key: reply.key,
          event: globalThis.structuredClone(reply),
        });
        return "accepted";
      },
    });
    const executor = mail.host.hostJobs.open(hostRuntime);
    execute = (job) => executor.execute(job);
    const sent = {
      key: "sender-outbox-request",
      from: {
        kind: "agent",
        agentId: "parent",
        sessionId: "parent-session",
      },
      to: { kind: "agent", agentId: "child" },
      replyTo: [
        {
          kind: "agent",
          agentId: "parent",
          sessionId: "parent-session",
        },
      ],
      content: "Work once",
      createdAt: now,
    };
    await assert.rejects(mail.deliver(sent));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      now += 300_001;
      await mail.host.hostWork[0].run();
    }

    const stored = owner.sql
      .exec(
        "SELECT value FROM carrier_post_rows WHERE key=?",
        "post:sender-outbox-request",
      )
      .one();
    const deadLetter = JSON.parse(stored.value);
    assert.equal(deadLetter.attempts, 20);
    assert.equal(deadLetter.state, "dead");
    assert.equal(deadLetter.reason, "exhausted");
    assert.equal(deliveredLocally.length, 1);
    assert.equal(deliveredLocally[0]?.key, `${sent.key}:reply:0`);
    assert.equal(deliveredLocally[0]?.event.from.kind, "system");
    assert.deepEqual(deliveredLocally[0]?.event.reply, {
      outcome: "undeliverable",
      reason: "recipient_offline",
    });
  } finally {
    Date.now = originalNow;
    database.close();
  }
});
