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
import { keyAllowsComputerUse, keyAppAccess } from "../dist/authorization.js";
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
  return { getByName: () => stub };
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
  assert.equal(keyAllowsComputerUse(live), false);
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
