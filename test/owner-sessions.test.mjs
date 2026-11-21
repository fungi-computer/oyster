import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const { ownerSessionStore } = await import("../src/owner-sessions.ts");
hooks.deregister();

const { Request, URLSearchParams } = globalThis;
const origin = "https://oyster.invalid";
const ownerKey = "owner-session-owner-key-1234567890";

/**
 * A registry as the last release left it: every table its constructor made,
 * one stored boot capability, and no owner session table.
 */
function releasedRegistryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE oyster_approval_home (id INTEGER PRIMARY KEY CHECK (id = 1), tenant_id TEXT NOT NULL, origin TEXT NOT NULL) STRICT;
    CREATE TABLE installations (installation_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
    CREATE TABLE boot_capabilities (id TEXT PRIMARY KEY, token_digest TEXT NOT NULL, expires_at INTEGER NOT NULL, record TEXT NOT NULL) STRICT;
    CREATE TABLE oyster_boot_results (origin TEXT NOT NULL, release_id TEXT NOT NULL, artifact_digest TEXT NOT NULL, check_version TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (origin, release_id, artifact_digest, check_version)) STRICT;
  `);
  db.prepare("INSERT INTO boot_capabilities VALUES (?, ?, ?, ?)").run(
    "boot_1",
    "0".repeat(64),
    4_102_444_800_000,
    "{}",
  );
  return db;
}

function registryOver(db) {
  const storage = fromNodeSqlite(db);
  return new OysterRegistry(
    {
      id: { name: tenantScope(defaultTenant, origin).durableName("registry") },
      exports: {},
      storage: { ...storage, getAlarm: async () => null },
      blockConcurrencyWhile: (work) => work(),
    },
    { OYSTER_ORIGIN: origin },
  );
}

function worker(registry) {
  const env = {
    OYSTER_ORIGIN: origin,
    OYSTER_OWNER_KEY: ownerKey,
    REGISTRY: { getByName: () => registry },
  };
  const app = createOysterWorker();
  return (path, init = {}) =>
    app.fetch(new Request(`${origin}${path}`, init), env);
}

const page = (cookie) => ({
  headers: { accept: "text/html", Cookie: cookie },
});

test("an existing registry gains sessions; its old cookie sends the owner to sign-in", async () => {
  const db = releasedRegistryDb();
  const before = db.prepare("SELECT * FROM boot_capabilities").all();
  const fetch = worker(registryOver(db));
  const oldCookie = `oyster_session=sha256:${createHash("sha256").update(`oyster:${ownerKey}`).digest("hex")}`;

  const refused = await fetch("/", page(oldCookie));
  assert.equal(refused.status, 302);
  assert.equal(refused.headers.get("Location"), "/login");

  const signedIn = await fetch("/login", {
    method: "POST",
    body: new URLSearchParams({ key: ownerKey }),
  });
  assert.equal(signedIn.status, 303);
  const cookie = signedIn.headers
    .getSetCookie()
    .find((value) => value.startsWith("oyster_session="))
    .split(";")[0];
  assert.notEqual(cookie, oldCookie);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM oyster_owner_sessions").get().n,
    1,
  );
  assert.notEqual((await fetch("/", page(cookie))).status, 302);

  const loggedOut = await fetch("/logout", {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin },
  });
  assert.equal(loggedOut.status, 303);
  assert.equal(loggedOut.headers.get("Location"), "/login");
  assert.equal((await fetch("/", page(cookie))).status, 302);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM oyster_owner_sessions").get().n,
    0,
  );
  // The stored data the release left is untouched.
  assert.deepEqual(db.prepare("SELECT * FROM boot_capabilities").all(), before);
});

test("the session store keeps only digests and drops an expired session", async () => {
  const db = new DatabaseSync(":memory:");
  const sessions = ownerSessionStore(fromNodeSqlite(db).sql);
  const { ownerSessionLifetimeMs } = await import("../src/owner-sessions.ts");
  await sessions.open("owner", "sha256:old", 0);
  await sessions.open("owner", "sha256:live", 1_000);
  const live = 1_000 + ownerSessionLifetimeMs - 1;
  assert.equal(await sessions.owner("sha256:live", live), "owner");
  assert.equal(await sessions.owner("sha256:live", live + 1), null);
  assert.equal(
    await sessions.owner("sha256:old", ownerSessionLifetimeMs),
    null,
  );
  assert.equal(await sessions.owner("sha256:unknown", 1_500), null);
  // An expired session's row is gone once it is read.
  assert.deepEqual(
    db
      .prepare("SELECT session_digest FROM oyster_owner_sessions")
      .all()
      .map((row) => row.session_digest),
    [],
  );
  await sessions.open("owner", "sha256:live", 2_000);
  assert.equal(await sessions.owner("sha256:live", 3_000), "owner");
  await sessions.revoke("sha256:live");
  assert.equal(await sessions.owner("sha256:live", 1_500), null);
});
