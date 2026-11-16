import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { decodeMultiStream } from "@msgpack/msgpack";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { streamOldSql } from "../src/upgrade/old-worker-stream.ts";

const runtime = import.meta
  .resolve("@fungi.computer/oyster-old-01/testing/workers-runtime");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "cloudflare:workers" ||
      specifier === "cloudflare:workflows"
    )
      return { url: runtime, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const oldWorkers = await Promise.all([
  import("@fungi.computer/oyster-old-01/standalone"),
  import("@fungi.computer/oyster-old-02/standalone"),
]);
hooks.deregister();

for (const [index, { OysterRegistry }] of oldWorkers.entries()) {
  const version = index === 0 ? "0.1.0" : "0.2.0";
  test(`${version} old Worker registry streams SQLite with an explicit completion frame`, async () => {
    class ArchiveRegistry extends OysterRegistry {
      exportSnapshot() {
        return streamOldSql(this.ctx.storage.sql, {
          pendingAt: null,
          observedAt: Date.now(),
        });
      }
    }
    const db = new DatabaseSync(":memory:");
    try {
      const storage = fromNodeSqlite(db);
      const registry = new ArchiveRegistry(
        {
          id: { name: "registry" },
          storage: { ...storage, getAlarm: async () => null },
          exports: {},
          blockConcurrencyWhile: (work) => work(),
        },
        {
          OYSTER_ORIGIN: "https://old.example",
          OYSTER_COMPUTER_ID: "workspace",
          RELEASES: {},
          APP_ARTIFACTS: {},
        },
      );
      db.prepare("INSERT INTO installations VALUES (?, ?)").run(
        "bonsai",
        '{"installationId":"bonsai"}',
      );
      const before = db.prepare("SELECT * FROM installations").all();
      const response = registry.exportSnapshot();
      assert.equal(response.headers.get("cache-control"), "no-store");
      const frames = [];
      for await (const frame of decodeMultiStream(response.body))
        frames.push(frame);
      assert.ok(
        frames.some(
          (frame) =>
            frame.kind === "part" && frame.name === "sql/installations/0",
        ),
      );
      assert.deepEqual(frames.at(-1), {
        kind: "complete",
        partCount: frames.length - 1,
      });
      assert.deepEqual(db.prepare("SELECT * FROM installations").all(), before);
    } finally {
      db.close();
    }
  });
}

test("a failed old Worker SQL page cannot emit a completion frame", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const storage = fromNodeSqlite(db);
    new oldWorkers[0].OysterRegistry(
      {
        id: { name: "registry" },
        storage: { ...storage, getAlarm: async () => null },
        exports: {},
        blockConcurrencyWhile: (work) => work(),
      },
      {
        OYSTER_ORIGIN: "https://old.example",
        OYSTER_COMPUTER_ID: "workspace",
        RELEASES: {},
        APP_ARTIFACTS: {},
      },
    );
    db.prepare("INSERT INTO installations VALUES (?, ?)").run(
      "bonsai",
      '{"installationId":"bonsai"}',
    );
    const seen = [];
    const response = streamOldSql(
      {
        exec(query, ...bindings) {
          if (query.startsWith('SELECT * FROM "installations"'))
            throw new Error("old registry SQL read failed");
          return storage.sql.exec(query, ...bindings);
        },
      },
      { pendingAt: null, observedAt: Date.now() },
    );
    await assert.rejects(async () => {
      for await (const frame of decodeMultiStream(response.body))
        seen.push(frame);
    }, /old registry SQL read failed/);
    assert.ok(seen.every((frame) => frame.kind !== "complete"));
  } finally {
    db.close();
  }
});
