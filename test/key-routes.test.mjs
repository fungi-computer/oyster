// The owner-only /api/keys routes: name grammar, visitor refusal, the
// never-reused id, and the owner-only guard, all over the real OysterKeys
// Durable Object class (no fake stub reimplementing its methods) -- a real
// node:sqlite database stands in for the DO's own SQLite.
/* global Request, setTimeout */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { createOyster } from "../dist/host.js";
import { fromNodeSqlite } from "@fungi.computer/ear-tag/keys/node";
import { oysterKeyVocabulary } from "../dist/keys.js";
import {
  keyComputer,
  keyAppAccess,
  reachesComputer,
} from "../dist/authorization.js";
import { computerHost } from "./computer-host.fixture.mjs";

// workers-git.js imports `cloudflare:workers` at module scope for its
// DurableObject base classes; this redirects it to the same plain-JS stand-in
// every other node:test file here uses, for the one import that needs it.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: new URL("../dist/testing/workers-runtime.js", import.meta.url)
          .href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { OysterKeys, gitAdminRoutes } = await import("../dist/workers-git.js");
const { tenantScope, defaultTenant } = await import("../dist/tenant.js");
const { standaloneComputerSelection } =
  await import("../dist/standalone/computer-fleet.js");
hooks.deregister();
const { ownerOrKeyAuth } = await import("../dist/auth.js");

/** A `KEYS` Durable Object namespace stand-in: one real `OysterKeys` instance per test, over real node:sqlite. */
function keysNamespace() {
  const database = new DatabaseSync(":memory:");
  let counter = 0;
  const ctx = {
    id: { name: "keys" },
    storage: {
      sql: fromNodeSqlite(database),
      // The real DO's own transactionSync is synchronous; OysterKeys wraps
      // it in Promise.resolve itself, so this must not return a Promise.
      transactionSync: (body) => {
        const name = `key_routes_test_${String(counter++)}`;
        database.exec(`SAVEPOINT ${name}`);
        try {
          const value = body();
          database.exec(`RELEASE ${name}`);
          return value;
        } catch (error) {
          database.exec(`ROLLBACK TO ${name}`);
          database.exec(`RELEASE ${name}`);
          throw error;
        }
      },
    },
  };
  const stub = new OysterKeys(ctx, {});
  return { getByName: () => stub, database };
}

function appFor(principal) {
  return async () => {
    const host = await computerHost(principal, "fixed-computer");
    const scope = tenantScope(defaultTenant, "https://oyster.example");
    const env = { KEYS: keysNamespace() };
    return createOyster({ ...host, ownerRoutes: gitAdminRoutes(env, scope) });
  };
}

const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
const ownerApp = appFor(owner);
const allAppsGrant = [{ capability: "apps.use", targets: { kind: "all" } }];

test("issues a key and lists it back", async () => {
  const app = await ownerApp();
  const issued = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "morel", grants: allAppsGrant }),
  });
  assert.equal(issued.status, 201);
  const body = await issued.json();
  assert.equal(body.key.name, "morel");
  assert.equal(body.key.keyId, "morel");
  assert.ok(body.plaintext.length > 0);
  const listed = await (await app.request("/api/keys")).json();
  assert.deepEqual(
    listed.keys.map((key) => key.name),
    ["morel"],
  );
});

test("an owner mints and verifies an enrollment-only Oyster key without App or Computer authority", async () => {
  const keys = keysNamespace();
  const scope = tenantScope(defaultTenant, "https://oyster.example");
  const app = createOyster({
    ...(await computerHost(owner, "fixed-computer")),
    ownerRoutes: gitAdminRoutes({ KEYS: keys }, scope),
  });
  const grants = [{ capability: "machine.enroll", targets: { kind: "all" } }];
  const issued = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "device-join", grants }),
  });
  assert.equal(issued.status, 201);
  const { plaintext, key } = await issued.json();
  assert.ok(plaintext.startsWith("oyk_"));
  assert.deepEqual(key.grants, grants);
  const store = keys.getByName(scope.durableName("keys"));
  const verified = await store.verify(plaintext);
  assert.equal(verified.kind, "ok");
  assert.deepEqual(verified.value.scope.grants, grants);
  assert.equal(
    oysterKeyVocabulary.grantsAllow(
      verified.value.scope.grants,
      "machine.enroll",
    ),
    true,
  );
  const live = await store.live(key.keyId);
  assert.ok(live);
  assert.equal(keyAppAccess(live, "notes"), null);
  assert.equal(keyComputer(live, "fixed-computer"), false);
});

test("refuses an agent_-shaped name at issuance: Bonsai's mayPush treats a key name and an Agent id as the same name, so they must stay disjoint", async () => {
  const app = await ownerApp();
  for (const name of ["agent_abc123", "agent_", "agent_morel"]) {
    const response = await app.request("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, grants: allAppsGrant }),
    });
    assert.equal(response.status, 400, name);
  }
});

test("never reuses a name, even one a revoked key held", async () => {
  const app = await ownerApp();
  const first = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "chanterelle", grants: allAppsGrant }),
  });
  assert.equal(first.status, 201);
  const duplicateWhileLive = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "chanterelle", grants: allAppsGrant }),
  });
  assert.equal(duplicateWhileLive.status, 409);
  const { key } = await first.json();
  const revoked = await app.request("/api/keys/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyId: key.keyId, requestId: "req-revoke-1" }),
  });
  assert.equal(revoked.status, 200);
  const duplicateAfterRevoke = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "chanterelle", grants: allAppsGrant }),
  });
  assert.equal(duplicateAfterRevoke.status, 409);
});

test("owner-only: a non-owner member is refused every /api/keys route", async () => {
  const member = {
    actor: { kind: "member", memberId: "not-the-owner" },
    role: "member",
  };
  const app = await appFor(member)();
  const issued = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "morel", grants: allAppsGrant }),
  });
  assert.equal(issued.status, 403);
  assert.equal((await app.request("/api/keys")).status, 403);
  const revoked = await app.request("/api/keys/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyId: "morel", requestId: "req-non-owner" }),
  });
  assert.equal(revoked.status, 403);
});

const ownerKeySecret = "fixture-owner-key-at-least-24-characters"; //gitleaks:allow

test("a revoked key is refused 401 on its very next authenticated request", async () => {
  const keys = keysNamespace();
  const scope = tenantScope(defaultTenant, "https://oyster.example");
  const routes = gitAdminRoutes({ KEYS: keys }, scope);
  const app = createOyster({
    ...(await computerHost(owner, "fixed-computer")),
    ownerRoutes: routes,
  });
  const issued = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "enoki", grants: allAppsGrant }),
  });
  assert.equal(issued.status, 201);
  const { plaintext } = await issued.json();
  const auth = ownerOrKeyAuth(ownerKeySecret, "owner", () =>
    keys.getByName(scope.durableName("keys")),
  );
  const request = () =>
    new Request("https://oyster.example/apps/notes/", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
  assert.deepEqual(await auth.authenticate(request()), {
    kind: "admitted",
    principal: { actor: { kind: "team-key", keyId: "enoki" } },
  });
  const revoke = await app.request("/api/keys/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyId: "enoki", requestId: "req-revoke-401" }),
  });
  assert.equal(revoke.status, 200);
  assert.deepEqual(await auth.authenticate(request()), {
    kind: "refused",
    status: 401,
  });
});

test("an admitted call stamps the key's last-used time; a refused one does not", async () => {
  const keys = keysNamespace();
  const scope = tenantScope(defaultTenant, "https://oyster.example");
  const app = createOyster({
    ...(await computerHost(owner, "fixed-computer")),
    ownerRoutes: gitAdminRoutes({ KEYS: keys }, scope),
  });
  const issued = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "porcini", grants: allAppsGrant }),
  });
  assert.equal(issued.status, 201);
  const { plaintext } = await issued.json();
  const store = keys.getByName(scope.durableName("keys"));
  const lastUsedAt = async () => {
    const listed = await store.list("owner");
    assert.equal(listed.kind, "ok");
    return listed.value.find((key) => key.keyId === "porcini").lastUsedAt;
  };
  const auth = ownerOrKeyAuth(ownerKeySecret, "owner", () => store);
  const call = (secret) =>
    auth.authenticate(
      new Request("https://oyster.example/apps/notes/", {
        headers: { Authorization: `Bearer ${secret}` },
      }),
    );
  assert.equal(await lastUsedAt(), null);
  assert.equal((await call("oyk_not-a-real-key-000000000000")).kind, "refused");
  assert.equal(await lastUsedAt(), null);
  const before = Date.now();
  assert.equal((await call(plaintext)).kind, "admitted");
  const stamped = await lastUsedAt();
  assert.ok(stamped >= before);
  // The owner key is not a named key: it never stamps one.
  assert.equal((await call(ownerKeySecret)).kind, "admitted");
  assert.equal(await lastUsedAt(), stamped);
});

test("a key stored before last-used tracking loads with no last use", async () => {
  const keys = keysNamespace();
  const scope = tenantScope(defaultTenant, "https://oyster.example");
  const app = createOyster({
    ...(await computerHost(owner, "fixed-computer")),
    ownerRoutes: gitAdminRoutes({ KEYS: keys }, scope),
  });
  const issued = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "shiitake", grants: allAppsGrant }),
  });
  assert.equal(issued.status, 201);
  // A row exactly as an earlier release stored it: last_used_at never set.
  keys.database
    .prepare(
      `INSERT INTO ear_tag_oyk_keys (key_id,owner,digest,name,grants,grant_version,expires_at,revoked_at,rate_limit,last_used_at,created_at,updated_at)
       SELECT 'old-key',owner,'old-digest','old-key',grants,grant_version,NULL,NULL,NULL,NULL,created_at,updated_at FROM ear_tag_oyk_keys WHERE key_id='shiitake'`,
    )
    .run();
  const listed = await keys.getByName(scope.durableName("keys")).list("owner");
  assert.equal(listed.kind, "ok");
  const old = listed.value.find((key) => key.keyId === "old-key");
  assert.equal(old.lastUsedAt, null);
  assert.equal(old.name, "old-key");
});

test("an expired key is refused 401 on its very next authenticated request", async () => {
  const keys = keysNamespace();
  const scope = tenantScope(defaultTenant, "https://oyster.example");
  const routes = gitAdminRoutes({ KEYS: keys }, scope);
  const app = createOyster({
    ...(await computerHost(owner, "fixed-computer")),
    ownerRoutes: routes,
  });
  const issued = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "sunchoke",
      grants: allAppsGrant,
      // Wide enough that the first request is admitted on a loaded gate host.
      expiresAt: Date.now() + 1_000,
    }),
  });
  assert.equal(issued.status, 201);
  const { plaintext } = await issued.json();
  const auth = ownerOrKeyAuth(ownerKeySecret, "owner", () =>
    keys.getByName(scope.durableName("keys")),
  );
  const request = () =>
    new Request("https://oyster.example/apps/notes/", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
  assert.deepEqual(await auth.authenticate(request()), {
    kind: "admitted",
    principal: { actor: { kind: "team-key", keyId: "sunchoke" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.deepEqual(await auth.authenticate(request()), {
    kind: "refused",
    status: 401,
  });
});

test("a key limited to one Computer stays on it after the owner switches Computers; all keys follow, revoke stops it", async () => {
  const keys = keysNamespace();
  const scope = tenantScope(defaultTenant, "https://oyster.example");
  const app = createOyster({
    ...(await computerHost(owner, "main")),
    ownerRoutes: gitAdminRoutes({ KEYS: keys }, scope),
  });
  const issue = async (name, computer) => {
    const response = await app.request("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        grants: [
          ...allAppsGrant,
          { capability: "computer.use", targets: computer },
        ],
      }),
    });
    assert.equal(response.status, 201);
    const { plaintext, key } = await response.json();
    assert.deepEqual(key.grants[1].targets, computer);
    return plaintext;
  };
  const spare = await issue("composer", { kind: "selected", ids: ["spare"] });
  const every = await issue("everywhere", { kind: "all" });
  const store = () => keys.getByName(scope.durableName("keys"));
  const auth = ownerOrKeyAuth(ownerKeySecret, "owner", store);
  const keysLive = (keyId) => store().live(keyId);
  // The owner's fleet: the canonical owner holds these three Computers.
  const owned = new Set(["main", "spare", "other"]);
  let selected = "main";
  const registry = {
    selectedComputer: async () => selected,
    computerFleet: async (memberId, request) =>
      memberId === "owner" && owned.has(request.computerId)
        ? { computerId: request.computerId }
        : null,
  };
  const select = (secret, query = "") =>
    standaloneComputerSelection(registry, keysLive, {
      auth,
      request: new Request(`https://oyster.example/apps/notes/${query}`, {
        headers: { Authorization: `Bearer ${secret}` },
      }),
    });
  assert.equal(await select(spare), "spare");
  assert.equal(await select(every), "main");
  assert.equal(await select(ownerKeySecret), "main");
  // The owner switches Computers in the UI: only the limited key stays put.
  selected = "other";
  assert.equal(await select(spare), "spare");
  assert.equal(await select(every), "other");
  assert.equal(await select(ownerKeySecret), "other");
  // Naming its own Computer is fine; naming another is refused, and an
  // all-Computers key still may not name one (only the owner does).
  assert.equal(await select(spare, "?computerId=spare"), "spare");
  await assert.rejects(select(spare, "?computerId=main"), { status: 403 });
  await assert.rejects(select(every, "?computerId=spare"), { status: 403 });
  assert.equal(await select(ownerKeySecret, "?computerId=spare"), "spare");
  // Its Computer leaves the fleet: the key is refused, never moved.
  owned.delete("spare");
  await assert.rejects(select(spare), { status: 404 });
  owned.add("spare");
  const live = await keysLive("composer");
  const authority = { kind: "key", key: live };
  assert.equal(reachesComputer(authority, "spare"), true);
  assert.equal(reachesComputer(authority, "other"), false);
  // Revoked: the next call authenticates as no one and reaches no Computer.
  const revoke = await app.request("/api/keys/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyId: "composer", requestId: "req-revoke-spare" }),
  });
  assert.equal(revoke.status, 200);
  assert.equal(await keysLive("composer"), null);
  assert.deepEqual(
    await auth.authenticate(
      new Request("https://oyster.example/apps/notes/", {
        headers: { Authorization: `Bearer ${spare}` },
      }),
    ),
    { kind: "refused", status: 401 },
  );
  assert.equal(reachesComputer({ kind: "key", key: null }, "spare"), false);
});
