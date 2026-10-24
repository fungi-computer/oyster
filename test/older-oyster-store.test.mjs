import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { URL } from "node:url";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { defaultTenant, tenantScope } from "../src/tenant.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: new URL("../src/testing/workers-runtime.ts", import.meta.url).href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { OysterRegistry, createOysterWorker } =
  await import("../src/workers.ts");
const { StandaloneRegistry } = await import("../src/standalone/registry.ts");
const { createOysterAppBuilds, migrateOysterAppBuilds } =
  await import("../src/app-builds.ts");
const { OlderOysterStoreError, olderOysterStoreCode } =
  await import("../src/older-oyster-store.ts");
hooks.deregister();

const origin = "https://oyster.invalid";
const ownerKey = "older-store-owner-key-123456789012";

const flatInstallation = JSON.stringify({
  installationId: "bonsai",
  status: "enabled",
  authorityVersion: 1,
  declaredOperationsDigest: "sha256:0",
  approvedGrants: [],
  approval: null,
});

function registryOver(db, Registry = OysterRegistry) {
  const storage = fromNodeSqlite(db);
  const ctx = {
    id: { name: tenantScope(defaultTenant, origin).durableName("registry") },
    exports: {},
    storage: { ...storage, getAlarm: async () => null },
    blockConcurrencyWhile: (work) => work(),
  };
  return new Registry(ctx, { OYSTER_ORIGIN: origin });
}

const installationRows = (db) =>
  db.prepare("SELECT * FROM installations").all();

/** A 0.2 registry: the installations table holding a flat row. */
function olderRegistryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE installations (installation_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT",
  );
  db.prepare("INSERT INTO installations VALUES (?, ?)").run(
    "bonsai",
    flatInstallation,
  );
  return db;
}

const workerEnv = (registry) => ({
  OYSTER_ORIGIN: origin,
  OYSTER_OWNER_KEY: ownerKey,
  REGISTRY: { getByName: () => registry },
});

test("a flat installation row is refused with 409 store_from_older_oyster, never a parse error", async () => {
  const registry = registryOver(olderRegistryDb());
  assert.equal(registry.storeFromOlderOyster(), true);
  const api = await createOysterWorker().fetch(
    new globalThis.Request(`${origin}/api/installations`, {
      headers: { authorization: `Bearer ${ownerKey}` },
    }),
    workerEnv(registry),
  );
  assert.equal(api.status, 409);
  const body = await api.json();
  assert.equal(body.error, olderOysterStoreCode);
  assert.match(body.message, /Oyster 0\.2 or earlier/);
  assert.match(body.message, /Reset it/);
  const page = await createOysterWorker().fetch(
    new globalThis.Request(`${origin}/`, { headers: { accept: "text/html" } }),
    workerEnv(registry),
  );
  assert.equal(page.status, 409);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /Oyster 0\.2 or earlier/);
});

test("refusal leaves the older registry and build rows and schemas unchanged", async () => {
  const db = olderRegistryDb();
  db.exec(olderBuildJobs);
  db.exec(
    "INSERT INTO oyster_build_jobs VALUES ('job_1','app_a','rel_1','rev','{}','{}','d','owner','cred','g','running',NULL,NULL,NULL,1,2,3)",
  );
  const dump = () => ({
    installations: installationRows(db),
    jobs: db.prepare("SELECT * FROM oyster_build_jobs").all(),
    schema: db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE name IN ('installations','oyster_build_jobs') OR tbl_name='oyster_build_jobs' ORDER BY name",
      )
      .all(),
  });
  const before = dump();
  const registry = registryOver(db, StandaloneRegistry);
  const response = await createOysterWorker().fetch(
    new globalThis.Request(`${origin}/`),
    workerEnv(registry),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(dump(), before);
  assert.equal(before.installations[0].record, flatInstallation);
  assert.equal(before.jobs.length, 1);
  assert.ok(!before.schema.some((entry) => /request_id/.test(entry.sql ?? "")));
  // The check can fail: a conversion would change the dump.
  db.exec("ALTER TABLE oyster_build_jobs ADD COLUMN request_id TEXT");
  assert.notDeepEqual(dump(), before);
});

test("the standalone registry refuses a pre-0.3 build table even with current installations", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(olderBuildJobs);
  const registry = registryOver(db, StandaloneRegistry);
  assert.equal(registry.storeFromOlderOyster(), true);
  const response = await createOysterWorker().fetch(
    new globalThis.Request(`${origin}/api/builds`, {
      headers: { authorization: `Bearer ${ownerKey}` },
    }),
    workerEnv(registry),
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, olderOysterStoreCode);
  assert.equal(
    registryOver(
      new DatabaseSync(":memory:"),
      StandaloneRegistry,
    ).storeFromOlderOyster(),
    false,
  );
});

test("a registry that answered fresh is not asked again by later requests", async () => {
  const registry = registryOver(new DatabaseSync(":memory:"));
  let asked = 0;
  const answer = registry.storeFromOlderOyster.bind(registry);
  registry.storeFromOlderOyster = () => {
    asked += 1;
    return answer();
  };
  const env = workerEnv(registry);
  const worker = createOysterWorker();
  await worker.fetch(new globalThis.Request(`${origin}/`), env);
  await worker.fetch(new globalThis.Request(`${origin}/`), env);
  assert.equal(asked, 1);
});

test("a refusal is never cached", async () => {
  const registry = registryOver(olderRegistryDb());
  let asked = 0;
  const answer = registry.storeFromOlderOyster.bind(registry);
  registry.storeFromOlderOyster = () => {
    asked += 1;
    return answer();
  };
  const env = workerEnv(registry);
  const worker = createOysterWorker();
  await worker.fetch(new globalThis.Request(`${origin}/`), env);
  await worker.fetch(new globalThis.Request(`${origin}/`), env);
  assert.equal(asked, 2);
});

test("a fresh registry and a 0.3 installations row are not refused", () => {
  assert.equal(
    registryOver(new DatabaseSync(":memory:")).storeFromOlderOyster(),
    false,
  );
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE installations (installation_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT",
  );
  db.prepare("INSERT INTO installations VALUES (?, ?)").run(
    "bonsai",
    JSON.stringify({
      installationId: "bonsai",
      authority: { authorityVersion: 1 },
    }),
  );
  assert.equal(registryOver(db).storeFromOlderOyster(), false);
});

const ownerOf = (db) => {
  const storage = fromNodeSqlite(db);
  return {
    sql: storage.sql,
    transactionSync: (work) => storage.transactionSync(work),
  };
};

const olderBuildJobs = `CREATE TABLE oyster_build_jobs (
  job_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, release_id TEXT NOT NULL UNIQUE,
  source_revision TEXT NOT NULL, location TEXT NOT NULL,
  recipe TEXT NOT NULL, recipe_digest TEXT NOT NULL, requested_by TEXT NOT NULL,
  credential_id TEXT NOT NULL, upload_grant_digest TEXT NOT NULL,
  status TEXT NOT NULL, artifact_digest TEXT, artifact_bytes INTEGER, detail TEXT,
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, executable_until INTEGER NOT NULL) STRICT`;

test("a pre-0.3 oyster_build_jobs table is refused, not a missing-column error, and stays untouched", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(olderBuildJobs);
  const schema = () =>
    db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  const before = schema();
  assert.throws(
    () => migrateOysterAppBuilds(ownerOf(db)),
    OlderOysterStoreError,
  );
  assert.throws(
    () => createOysterAppBuilds({ owner: ownerOf(db) }),
    OlderOysterStoreError,
  );
  assert.deepEqual(schema(), before);
});

test("a fresh store migrates its build tables, twice", () => {
  const db = new DatabaseSync(":memory:");
  migrateOysterAppBuilds(ownerOf(db));
  migrateOysterAppBuilds(ownerOf(db));
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('oyster_build_jobs')")
    .all();
  assert.ok(columns.some((column) => column.name === "request_id"));
});
