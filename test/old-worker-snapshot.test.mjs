import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { decode } from "@msgpack/msgpack";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { snapshotOldSql } from "../src/upgrade/old-worker-sql.ts";

// These are the actual published Workers, pinned through pnpm's npm integrity
// entries. Their own constructors establish the SQLite we are exporting.
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
  import("@fungi.computer/oyster-old-001/workers"),
  import("@fungi.computer/oyster-old-01/standalone"),
  import("@fungi.computer/oyster-old-02/standalone"),
]);
hooks.deregister();

const versions = ["0.0.1", "0.1.0", "0.2.0"];
for (const [index, { OysterRegistry }] of oldWorkers.entries()) {
  const version = versions[index];
  test(`${version} standalone registry SQLite exports its real rows without changing them`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      const storage = fromNodeSqlite(db);
      const ctx = {
        id: { name: "old-registry" },
        storage: { ...storage, getAlarm: async () => null },
        exports: {},
        blockConcurrencyWhile: (work) => work(),
      };
      new OysterRegistry(ctx, {
        OYSTER_ORIGIN: "https://old.example",
        OYSTER_COMPUTER_ID: "workspace",
        RELEASES: {},
        APP_ARTIFACTS: {},
      });
      const record = JSON.stringify({
        installationId: "bonsai",
        status: "enabled",
        authorityVersion: 1,
      });
      db.prepare("INSERT INTO installations VALUES (?, ?)").run(
        "bonsai",
        record,
      );
      const before = db.prepare("SELECT * FROM installations").all();
      const packets = [...snapshotOldSql(ctx.storage.sql)];
      const installation = packets
        .map(({ bytes }) => decode(bytes))
        .find((packet) => packet.table === "installations" && "rows" in packet);
      assert.deepEqual(installation.rows, [
        { installation_id: "bonsai", record },
      ]);
      assert.deepEqual(db.prepare("SELECT * FROM installations").all(), before);
      const schema = packets
        .map(({ bytes }) => decode(bytes))
        .find((packet) => Array.isArray(packet.schema));
      assert.ok(
        schema.schema.some((item) => item.name === "oyster_app_sources"),
      );
    } finally {
      db.close();
    }
  });
}
