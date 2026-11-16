import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { URL } from "node:url";
import { decode, decodeMultiStream } from "@msgpack/msgpack";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { parse } from "jsonc-parser";
import { z } from "zod";

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
const bridges = await Promise.all([
  import("../src/upgrade/standalone-001.ts"),
  import("../src/upgrade/standalone-01.ts"),
  import("../src/upgrade/standalone-02.ts"),
]);
const tenants = await Promise.all([
  import("@fungi.computer/oyster-old-001/tenant"),
  import("@fungi.computer/oyster-old-01/tenant"),
  import("@fungi.computer/oyster-old-02/tenant"),
]);
const oldWorkers = await Promise.all([
  import("@fungi.computer/oyster-old-001/workers"),
  import("@fungi.computer/oyster-old-01/standalone"),
  import("@fungi.computer/oyster-old-02/standalone"),
]);
hooks.deregister();

const origin = "https://old.example";
const key = "old-oyster-owner-key-123456789";
const path = "/__upgrade/registry-sql";
const oldClasses = [
  "StandaloneTenants",
  "OysterMcp",
  "OysterRegistry",
  "StandaloneWorkflowRuns",
  "StandaloneInstance",
  "ComputerDO",
  "OysterKeys",
  "OysterWebhooks",
  "StandaloneAgent",
  "AgentDirectory",
  "MediaOperationDO",
];
const publishedMigrations = [
  [
    { tag: "v1", new_sqlite_classes: ["OysterRegistry", "OysterInstance"] },
    { tag: "mcp-session-owner-v1", new_sqlite_classes: ["OysterMcp"] },
  ],
  [{ tag: "oyster-v1", new_sqlite_classes: oldClasses }],
  [{ tag: "oyster-v1", new_sqlite_classes: oldClasses }],
];
const publishedConfigSchema = z.object({
  durable_objects: z.object({
    bindings: z.array(z.object({ class_name: z.string() })),
  }),
  migrations: z.array(
    z.object({ tag: z.string(), new_sqlite_classes: z.array(z.string()) }),
  ),
});
const entries = [
  ["@fungi.computer/oyster-old-001/workers", "../examples/standalone/"],
  ["@fungi.computer/oyster-old-01/standalone", "../../examples/standalone/"],
  ["@fungi.computer/oyster-old-02/standalone", "../../examples/standalone/"],
];

test("each bridge exports the published old standalone class and migration shape", () => {
  for (const [index, [entry, relative]] of entries.entries()) {
    const config = publishedConfigSchema.parse(
      parse(
        readFileSync(
          new URL(`${relative}wrangler.jsonc`, import.meta.resolve(entry)),
          "utf8",
        ),
      ),
    );
    assert.deepEqual(config.migrations, publishedMigrations[index]);
    const names = config.durable_objects.bindings.map(
      (item) => item.class_name,
    );
    assert.deepEqual(
      [...names].sort(),
      [
        ...new Set(
          config.migrations.flatMap(
            (migration) => migration.new_sqlite_classes,
          ),
        ),
      ].sort(),
    );
    for (const name of names) assert.ok(bridges[index][name]);
  }
});

test("each bridge keeps the published service entrypoint class its Worker binds", () => {
  for (const [index, bridge] of bridges.entries()) {
    assert.ok(Object.hasOwn(bridge, "OysterBinding"), `bridge ${index}`);
    assert.ok(Object.hasOwn(oldWorkers[index], "OysterBinding"));
  }
});

for (const [index, { default: bridge, OysterRegistry }] of bridges.entries()) {
  const { defaultTenant, tenantScope } = tenants[index];
  const version = ["0.0.1", "0.1.0", "0.2.0"][index];
  test(`published ${version} bridge registry constructor cannot create or migrate SQLite`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      const storage = fromNodeSqlite(db);
      const statements = [];
      const ctx = {
        id: {
          name: tenantScope(defaultTenant, origin).durableName("registry"),
        },
        storage: {
          ...storage,
          sql: {
            exec(statement, ...args) {
              statements.push(statement);
              return storage.sql.exec(statement, ...args);
            },
          },
          getAlarm: async () => null,
        },
        exports: {},
        blockConcurrencyWhile: (work) => work(),
      };
      new OysterRegistry(ctx, { OYSTER_ORIGIN: origin });
      assert.deepEqual(statements, []);
    } finally {
      db.close();
    }
  });
  test(`published ${version} bridge DOs leave alarms untouched and read their pending time on export`, async () => {
    const names =
      index === 0
        ? ["OysterRegistry", "OysterInstance", "OysterMcp"]
        : oldClasses;
    for (const name of names) {
      const db = new DatabaseSync(":memory:");
      try {
        const storage = fromNodeSqlite(db);
        let pending = 1234;
        const statements = [];
        const object = new bridges[index][name](
          {
            id: { name: `${name}:old` },
            storage: {
              ...storage,
              sql: {
                exec(statement, ...args) {
                  statements.push(statement);
                  return storage.sql.exec(statement, ...args);
                },
              },
              getAlarm: async () => pending,
              setAlarm: async () => {
                throw new Error("bridge re-armed an alarm");
              },
              deleteAlarm: async () => {
                throw new Error("bridge deleted an alarm");
              },
            },
            exports: {},
            blockConcurrencyWhile: (work) => work(),
          },
          { OYSTER_ORIGIN: origin },
        );
        assert.deepEqual(statements, [], `${name} constructor changed SQLite`);
        await object.alarm();
        assert.equal(pending, 1234, `${name} alarm altered pending time`);
        assert.deepEqual(statements, [], `${name} alarm changed SQLite`);
        assert.equal(await object.readPendingAlarm(), 1234);
        pending = null;
        assert.equal(await object.readPendingAlarm(), null);
      } finally {
        db.close();
      }
    }
  });
  test(`published ${version} Worker bridge exports old rows only to the owner and leaves the store unchanged`, async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const storage = fromNodeSqlite(db);
      let pendingAlarm = 1234;
      let alarmReads = 0;
      const ctx = {
        id: {
          name: tenantScope(defaultTenant, origin).durableName("registry"),
        },
        storage: {
          ...storage,
          getAlarm: async () => {
            alarmReads += 1;
            return pendingAlarm;
          },
        },
        exports: {},
        blockConcurrencyWhile: (work) => work(),
      };
      const oldEnv = {
        OYSTER_ORIGIN: origin,
        OYSTER_COMPUTER_ID: "workspace",
        RELEASES: {},
        APP_ARTIFACTS: {},
      };
      // Let the published release create its own schema before replacing it
      // with the export-only bridge. Cross a SQL page boundary with old rows.
      const oldRegistry = new oldWorkers[index].OysterRegistry(ctx, oldEnv);
      const digest = `sha256:${"a".repeat(64)}`;
      for (let row = 0; row < 129; row += 1) {
        const installationId = `app-${String(row).padStart(3, "0")}`;
        await oldRegistry.put({
          installationId,
          instanceId: null,
          appId: "app_notes",
          release: {
            appId: "app_notes",
            releaseId: "rel_archivefixture",
            artifact: {
              artifactRef: "artifact:archive-fixture",
              artifactDigest: digest,
              provenance: {
                sourceRevision: `git:${"b".repeat(40)}`,
                sourceTreeDigest: digest,
                buildRecipeDigest: digest,
              },
            },
          },
          releasePin: "pinned",
          authorityVersion: 1,
          status: "enabled",
          visibility: "private",
          declaredOperationsDigest: digest,
          approvedGrants: [],
          approval: null,
          approvedAnonymousMethods: [],
          anonymousApproval: null,
        });
      }
      assert.equal(oldRegistry.list().length, 129);
      const before = db.prepare("SELECT * FROM installations").all();
      const schemaBefore = db.prepare("SELECT * FROM sqlite_master").all();
      const registry = new OysterRegistry(ctx, oldEnv);
      let calls = 0;
      const env = {
        OYSTER_ORIGIN: origin,
        OYSTER_OWNER_KEY: key,
        REGISTRY: {
          getByName(name) {
            calls += 1;
            assert.equal(
              name,
              tenantScope(defaultTenant, origin).durableName("registry"),
            );
            return registry;
          },
        },
      };
      for (const headers of [
        {},
        { authorization: "Bearer named-team-key" },
        { cookie: "oyster_session=any" },
      ]) {
        const response = await bridge.fetch(
          new globalThis.Request(`${origin}${path}`, { headers }),
          env,
        );
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
      assert.equal(calls, 0);
      assert.equal(alarmReads, 0);
      const beforeRead = Date.now();
      const response = await bridge.fetch(
        new globalThis.Request(`${origin}${path}`, {
          headers: { authorization: `Bearer ${key}` },
        }),
        env,
      );
      assert.equal(response.status, 200);
      const frames = [];
      for await (const frame of decodeMultiStream(response.body))
        frames.push(frame);
      assert.equal(frames.at(-1).kind, "complete");
      const installations = frames
        .filter(
          (frame) =>
            frame.kind === "part" &&
            frame.name.startsWith("sql/installations/"),
        )
        .map((frame) => decode(frame.bytes));
      assert.deepEqual(
        installations.map((packet) => packet.rows.length),
        [128, 1],
      );
      assert.deepEqual(
        installations.flatMap((packet) => packet.rows),
        before.map((row) => ({ ...row })),
      );
      const alarm = frames.find(
        (frame) => frame.kind === "part" && frame.name === "alarm",
      );
      assert.ok(
        alarm,
        "the old registry alarm must be represented, even when unset",
      );
      const observed = decode(alarm.bytes);
      assert.equal(observed.pendingAt, 1234);
      assert.ok(observed.observedAt >= beforeRead);
      assert.ok(observed.observedAt <= Date.now());
      assert.equal(frames.at(-1).partCount, frames.length - 1);
      assert.equal(alarmReads, 1);
      assert.equal(calls, 1);
      for (const [method, target, headers] of [
        ["GET", "/", {}],
        ["HEAD", "/version", {}],
        ["POST", "/api/installations", { authorization: `Bearer ${key}` }],
        ["PUT", "/git/bonsai/main", { authorization: `Bearer ${key}` }],
        ["DELETE", "/api/installations", {}],
        ["POST", path, { authorization: `Bearer ${key}` }],
        ["OPTIONS", path, {}],
      ]) {
        const denied = await bridge.fetch(
          new globalThis.Request(`${origin}${target}`, { method, headers }),
          env,
        );
        assert.equal(denied.status, 503, `${version} ${method} ${target}`);
        assert.equal(denied.headers.get("cache-control"), "no-store");
        assert.deepEqual(await denied.json(), {
          error: "oyster_archiving",
          message: "Oyster is archiving",
        });
        assert.equal(calls, 1, "ordinary requests cannot reach an old DO");
      }
      assert.equal(alarmReads, 1, "refused requests cannot read the alarm");
      pendingAlarm = null;
      const second = await bridge.fetch(
        new globalThis.Request(`${origin}${path}`, {
          headers: { authorization: `Bearer ${key}` },
        }),
        env,
      );
      const later = [];
      for await (const frame of decodeMultiStream(second.body))
        later.push(frame);
      const cleared = later.find(
        (frame) => frame.kind === "part" && frame.name === "alarm",
      );
      assert.ok(cleared);
      assert.equal(decode(cleared.bytes).pendingAt, null);
      assert.equal(alarmReads, 2);
      assert.deepEqual(db.prepare("SELECT * FROM installations").all(), before);
      assert.deepEqual(
        db.prepare("SELECT * FROM sqlite_master").all(),
        schemaBefore,
      );
    } finally {
      db.close();
    }
  });
}

for (const index of [1, 2]) {
  const version = ["0.0.1", "0.1.0", "0.2.0"][index];
  test(`published ${version} Workflow refuses to dispatch steps while archiving`, async () => {
    const Workflow = bridges[index].StandaloneGraphWorkflow;
    let steps = 0;
    const workflow = new Workflow(
      {},
      {
        WORKFLOW_RUNS: {
          getByName() {
            steps += 1;
            throw new Error("old Workflow run owner reached");
          },
        },
      },
    );
    await assert.rejects(
      workflow.run(
        { payload: {}, instanceId: "old-run" },
        {
          do() {
            steps += 1;
            throw new Error("old Workflow step reached");
          },
        },
      ),
      {
        name: "OysterArchivingError",
        code: "oyster_archiving",
        message: "Oyster is archiving",
      },
    );
    assert.equal(steps, 0);
  });
}
