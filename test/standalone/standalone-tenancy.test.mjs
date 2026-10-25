import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "cloudflare:workers" ||
      specifier === "cloudflare:workflows"
    )
      return {
        url: import.meta
          .resolve("@fungi.computer/oyster/testing/workers-runtime"),
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { StandaloneTenants, standaloneTenancy, standaloneTenancyForRequest } =
  await import("../../src/standalone/tenancy.ts");
const { createOysterGitWorker } = await import("../../src/workers-git.ts");
const standaloneWorker = await import("../../src/standalone/worker.ts");
const { AgentDirectory } = await import("../../src/standalone/agents.ts");
const { admittedRegistry, durableObjectRegistry } =
  await import("@fungi.computer/oyster/tenancy/cloudflare");
hooks.deregister();

function fixture() {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  let pending = Promise.resolve();
  const failures = [];
  storage.sql.exec(
    "CREATE TABLE fixture_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const state = {
    storage: {
      ...storage,
      get: async (key) => {
        const row = storage.sql
          .exec("SELECT value FROM fixture_kv WHERE key=?", key)
          .toArray()[0];
        return row === undefined ? undefined : JSON.parse(row.value);
      },
      put: async (key, value) => {
        storage.sql.exec(
          "INSERT INTO fixture_kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          key,
          JSON.stringify(value),
        );
      },
    },
    blockConcurrencyWhile: (work) => {
      const result = pending.then(work);
      pending = result.catch((cause) => {
        failures.push(cause);
      });
      return result;
    },
  };
  return {
    owner: new StandaloneTenants(state),
    reopen: () => new StandaloneTenants(state),
    close: (expectedFailures = []) => {
      database.close();
      assert.equal(failures.length, expectedFailures.length);
      for (const [index, expected] of expectedFailures.entries()) {
        const cause = failures[index];
        assert.ok(cause instanceof Error);
        assert.match(cause.message, expected);
      }
    },
  };
}

function tenantStub(owner, onSeed) {
  return {
    seed: (seed) => {
      onSeed?.();
      return owner.seed(seed);
    },
    get: owner.get.bind(owner),
    byHandle: owner.byHandle.bind(owner),
    byDomain: owner.byDomain.bind(owner),
    status: owner.status.bind(owner),
    memberById: owner.memberById.bind(owner),
    membershipOf: owner.membershipOf.bind(owner),
    admission: owner.admission.bind(owner),
  };
}

const input = {
  origin: "https://bonsai.test",
  owner: { provider: "standalone-owner", subject: "configured-owner" },
};

test("a mismatched first request cannot seed, and the corrected origin can admit", async () => {
  const probe = fixture();
  let seedCalls = 0;
  const env = {
    OYSTER_ORIGIN: "https://oyster.shiit.app",
    OYSTER_OWNER_NAME: input.owner.subject,
    OYSTER_OWNER_KEY: "standalone-origin-owner-key-24-characters",
    TENANTS: {
      getByName: () =>
        tenantStub(probe.owner, () => {
          seedCalls += 1;
        }),
    },
    KEYS: { getByName: () => assert.fail("No credential lookup expected") },
  };
  const requestOrigin = "https://renamed-preview.levi-fe0.workers.dev";
  const request = new globalThis.Request(`${requestOrigin}/`);
  try {
    const worker = createOysterGitWorker({
      admit: async (_workerEnv, incoming) => {
        await standaloneTenancyForRequest(env, incoming);
        return null;
      },
      hostFor: () => assert.fail("A refused request must not select a host"),
    });
    const refused = await worker.fetch(request, env, {});
    assert.equal(refused.status, 404);
    assert.deepEqual(await refused.json(), {
      kind: "refused",
      code: "origin_mismatch",
      configuredOrigin: env.OYSTER_ORIGIN,
      requestOrigin,
      message: `Request origin ${requestOrigin} does not match configured OYSTER_ORIGIN ${env.OYSTER_ORIGIN}. Set OYSTER_ORIGIN to this Worker's URL.`,
    });
    assert.equal(seedCalls, 0);

    const corrected = {
      ...env,
      OYSTER_ORIGIN: requestOrigin,
    };
    const tenancy = await standaloneTenancyForRequest(corrected, request);
    assert.equal(seedCalls, 1);
    assert.ok(await tenancy.oyster.resolve(request));
  } finally {
    probe.close();
  }
});

test("a changed seed returns a typed refusal with the existing-data recovery", async () => {
  const probe = fixture();
  await probe.owner.seed(input);
  try {
    const configured = {
      ...input,
      origin: "https://renamed-preview.test",
    };
    const result = await probe.owner.seed(configured);
    assert.deepEqual(result, {
      kind: "refused",
      code: "seed_configuration_changed",
      seededOrigin: input.origin,
      configuredOrigin: configured.origin,
      recovery: "fresh_worker_name_or_reset_worker_data",
    });

    const changedEnv = {
      OYSTER_ORIGIN: configured.origin,
      OYSTER_OWNER_NAME: input.owner.subject,
      OYSTER_OWNER_KEY: "standalone-changed-owner-key-24-characters",
      TENANTS: { getByName: () => probe.owner },
      KEYS: { getByName: () => assert.fail("No credential lookup expected") },
    };
    const refused = await standaloneWorker.default.fetch(
      new globalThis.Request(`${configured.origin}/`),
      changedEnv,
      {},
    );
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), {
      kind: "refused",
      code: "seed_configuration_changed",
      seededOrigin: input.origin,
      configuredOrigin: configured.origin,
      recovery: "fresh_worker_name_or_reset_worker_data",
      message: `Standalone seed/origin mismatch: existing data was seeded for ${input.origin}, but OYSTER_ORIGIN is ${configured.origin}. Deploy under a fresh Worker name or reset this Worker's data.`,
    });
  } finally {
    probe.close();
  }
});

test("concurrent seed refusals give each real Worker request a readable response", async () => {
  const probe = fixture();
  await probe.owner.seed(input);
  const origin = "https://renamed-preview.test";
  const env = {
    OYSTER_ORIGIN: origin,
    OYSTER_OWNER_NAME: input.owner.subject,
    OYSTER_OWNER_KEY: "standalone-concurrent-owner-key-24-characters",
    TENANTS: { getByName: () => probe.owner },
    KEYS: { getByName: () => assert.fail("No credential lookup expected") },
  };
  try {
    const responses = await Promise.all(
      ["/", "/mcp"].map((path) =>
        standaloneWorker.default.fetch(
          new globalThis.Request(`${origin}${path}`),
          env,
          {},
        ),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status),
      [409, 409],
    );
    const [firstBody, secondBody] = await Promise.all(
      responses.map((response) => response.text()),
    );
    assert.equal(firstBody, secondBody);
    assert.deepEqual(JSON.parse(firstBody), {
      kind: "refused",
      code: "seed_configuration_changed",
      seededOrigin: input.origin,
      configuredOrigin: origin,
      recovery: "fresh_worker_name_or_reset_worker_data",
      message: `Standalone seed/origin mismatch: existing data was seeded for ${input.origin}, but OYSTER_ORIGIN is ${origin}. Deploy under a fresh Worker name or reset this Worker's data.`,
    });
  } finally {
    probe.close();
  }
});

test("mesh connect preserves the typed seed refusal as readable recovery JSON", async () => {
  const probe = fixture();
  await probe.owner.seed(input);
  const origin = "https://renamed-preview.test";
  const env = {
    OYSTER_ORIGIN: origin,
    OYSTER_OWNER_NAME: input.owner.subject,
    OYSTER_OWNER_KEY: "standalone-mesh-owner-key-24-characters",
    TENANTS: { getByName: () => probe.owner },
  };
  try {
    const response = await standaloneWorker.default.fetch(
      new globalThis.Request(
        `${origin}/api/teams/agents/local/mesh/example/connect`,
      ),
      env,
      {},
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      kind: "refused",
      code: "seed_configuration_changed",
      seededOrigin: input.origin,
      configuredOrigin: origin,
      recovery: "fresh_worker_name_or_reset_worker_data",
      message: `Standalone seed/origin mismatch: existing data was seeded for ${input.origin}, but OYSTER_ORIGIN is ${origin}. Deploy under a fresh Worker name or reset this Worker's data.`,
    });
  } finally {
    probe.close();
  }
});

test("preview-only requests reach the fence before invalid owner scope construction", async () => {
  const previewOrigin = "https://oyster-preview.test";
  const response = await standaloneWorker.default.fetch(
    new globalThis.Request(`${previewOrigin}/login`),
    {
      OYSTER_ORIGIN: "not an origin",
      OYSTER_PREVIEW_ORIGIN: previewOrigin,
    },
    {},
  );
  assert.equal(response.status, 404);
});

test("preview-only requests fence webhook paths before tenancy seeding", async () => {
  const probe = fixture();
  await probe.owner.seed(input);
  let seedCalls = 0;
  const origin = "https://oyster-preview.test";
  const env = {
    OYSTER_ORIGIN: origin,
    OYSTER_PREVIEW_ORIGIN: origin,
    OYSTER_OWNER_NAME: input.owner.subject,
    OYSTER_OWNER_KEY: "standalone-webhook-owner-key-24-characters",
    TENANTS: {
      getByName: () =>
        tenantStub(probe.owner, () => {
          seedCalls += 1;
        }),
    },
  };
  try {
    const response = await standaloneWorker.default.fetch(
      new globalThis.Request(
        `${origin}/api/installations/example/workflows/webhooks/binding`,
      ),
      env,
      {},
    );
    assert.equal(response.status, 404);
    assert.equal(seedCalls, 0);
  } finally {
    probe.close();
  }
});

test("a configured custom domain and local-dev origin both admit their own requests", async () => {
  for (const origin of ["https://oyster.shiit.app", "https://localhost:8797"]) {
    const probe = fixture();
    const env = {
      OYSTER_ORIGIN: origin,
      OYSTER_OWNER_NAME: input.owner.subject,
      OYSTER_OWNER_KEY: "standalone-legit-origin-owner-key",
      TENANTS: { getByName: () => probe.owner },
      KEYS: { getByName: () => assert.fail("No credential lookup expected") },
    };
    try {
      const request = new globalThis.Request(`${origin}/`);
      const tenancy = await standaloneTenancyForRequest(env, request);
      assert.ok(await tenancy.oyster.resolve(request));
    } finally {
      probe.close();
    }
  }
});

test("a transient seed RPC failure can retry the same environment against the real registry", async () => {
  const probe = fixture();
  const failure = new Error("Transient registry transport failure");
  let interrupted = true;
  const env = {
    OYSTER_ORIGIN: input.origin,
    OYSTER_OWNER_NAME: input.owner.subject,
    OYSTER_OWNER_KEY: "standalone-retry-owner-key-24-characters",
    TENANTS: {
      getByName: () => {
        if (interrupted) {
          interrupted = false;
          return { seed: () => Promise.reject(failure) };
        }
        return probe.owner;
      },
    },
    KEYS: { getByName: () => assert.fail("No credential lookup expected") },
  };
  try {
    await assert.rejects(standaloneTenancy(env), (cause) => cause === failure);
    const composed = await standaloneTenancy(env);
    const owner = await composed.owner();
    assert.ok(owner);
    assert.notEqual(owner.actor.memberId, input.owner.subject);
    assert.ok(owner.membershipVersion > 0);
    assert.equal(await standaloneTenancy(env), composed);
  } finally {
    probe.close();
  }
});

test("Agent approval retries a failed seed composition without caching its rejection", async () => {
  const probe = fixture();
  const database = new DatabaseSync(":memory:");
  const failure = new Error("Transient Agent registry transport failure");
  let interrupted = true;
  try {
    await probe.owner.seed(input);
    const stored = await probe.owner.membershipOf("default", input.owner);
    assert.ok(stored);
    const principal = {
      actor: { kind: "member", memberId: stored.memberId },
      role: "owner",
    };
    const env = {
      OYSTER_ORIGIN: input.origin,
      OYSTER_OWNER_NAME: input.owner.subject,
      OYSTER_OWNER_KEY: "agent-retry-owner-key-24-characters",
      TENANTS: {
        getByName: () => {
          if (interrupted) {
            interrupted = false;
            return { seed: () => Promise.reject(failure) };
          }
          return probe.owner;
        },
      },
      KEYS: { getByName: () => assert.fail("No credential lookup expected") },
    };
    const directory = new AgentDirectory(
      { storage: fromNodeSqlite(database) },
      env,
    );
    const created = directory.create(
      "Seed retry",
      "request_seed_retry",
      principal,
      "owner-direct",
    );
    const approve = () =>
      directory.approveAppToolPolicy(
        created.agentId,
        principal,
        "read",
        created.policyRevision,
        "owner-direct",
        "default",
      );
    await assert.rejects(approve(), (cause) => cause === failure);
    const policy = await approve();
    assert.equal(policy.grantedBy, stored.memberId);
    assert.deepEqual(
      await directory.appToolPolicy(
        { kind: "agent", agentId: created.agentId },
        "default",
      ),
      policy,
    );
  } finally {
    database.close();
    probe.close();
  }
});

test("cold seeding refuses a deleted tenant instead of reviving its owner", async () => {
  const probe = fixture();
  try {
    const tenant = await probe.owner.seed(input);
    const membership = await probe.owner.membershipOf(tenant.id, input.owner);
    assert.ok(membership);
    assert.notEqual(membership.memberId, input.owner.subject);
    assert.ok(membership.membershipVersion > 0);
    assert.deepEqual(await probe.owner.seed(input), tenant);
    assert.deepEqual(
      await probe.owner.memberById(tenant.id, membership.memberId),
      membership,
    );
    await probe.owner.delete(tenant.id);
    const cold = probe.reopen();
    await assert.rejects(cold.seed(input), /missing|removed|deleted/u);
    assert.equal(await cold.get(tenant.id), null);
    assert.equal(await cold.memberById(tenant.id, membership.memberId), null);
  } finally {
    probe.close([/missing/u]);
  }
});

test("cold seed refuses missing authority after interrupted registry creation", async () => {
  const probe = fixture();
  try {
    const conflict = await probe.owner.create({
      handle: "conflicting",
      origin: input.origin,
      domains: ["bonsai.test"],
      owner: { provider: "other-owner", subject: "domain-owner" },
    });
    await assert.rejects(probe.owner.seed(input), /UNIQUE constraint/u);
    assert.equal(await probe.owner.get("default"), null);
    assert.equal(await probe.owner.membershipOf("default", input.owner), null);
    await probe.owner.delete(conflict.id);
    const cold = probe.reopen();
    await assert.rejects(cold.seed(input), /missing/u);
    assert.equal(await cold.get("default"), null);
    assert.equal(await cold.membershipOf("default", input.owner), null);
  } finally {
    probe.close([/UNIQUE constraint/u, /missing/u]);
  }
});

test("concurrent and cold seed reuse preserves the registry-owned membership revision", async () => {
  const probe = fixture();
  try {
    const [first, second] = await Promise.all([
      probe.owner.seed(input),
      probe.owner.seed(input),
    ]);
    assert.deepEqual(first, second);
    const original = await probe.owner.membershipOf(first.id, input.owner);
    const cold = probe.reopen();
    assert.deepEqual(await cold.seed(input), first);
    assert.deepEqual(await cold.membershipOf(first.id, input.owner), original);
    assert.deepEqual(
      await cold.seed({
        ...input,
        owner: { ...input.owner, subject: "different-owner" },
      }),
      {
        kind: "refused",
        code: "seed_configuration_changed",
        seededOrigin: input.origin,
        configuredOrigin: input.origin,
        recovery: "fresh_worker_name_or_reset_worker_data",
      },
    );
    assert.deepEqual(
      await cold.seed({ ...input, origin: "https://different.test" }),
      {
        kind: "refused",
        code: "seed_configuration_changed",
        seededOrigin: input.origin,
        configuredOrigin: "https://different.test",
        recovery: "fresh_worker_name_or_reset_worker_data",
      },
    );
    assert.deepEqual(await cold.membershipOf(first.id, input.owner), original);
  } finally {
    probe.close();
  }
});

test("cold seed refuses suspended or deleting authority without repairing it", async () => {
  for (const status of ["suspended", "deleting"]) {
    const probe = fixture();
    try {
      const tenant = await probe.owner.seed(input);
      await probe.owner.setStatus(tenant.id, status);
      const cold = probe.reopen();
      await assert.rejects(cold.seed(input), /configured owner/u);
      assert.equal(await cold.status(tenant.id), status);
    } finally {
      probe.close([/configured owner/u]);
    }
  }
});

test("HTTP and root readers share the stored canonical owner and live membership version", async () => {
  const probe = fixture();
  const credential = "standalone-test-owner-key-24-characters";
  // ownerOrKeyAuth requires a verified key's own stored owner to match the
  // live canonical registry member id (stored.memberId below), not the
  // configured OYSTER_OWNER_NAME label; set once that id is known.
  let keyOwner;
  const env = {
    OYSTER_ORIGIN: input.origin,
    OYSTER_OWNER_NAME: input.owner.subject,
    OYSTER_OWNER_KEY: credential,
    TENANTS: {
      getByName: (name) => {
        assert.equal(name, "registry");
        return probe.owner;
      },
    },
    KEYS: {
      getByName: () => ({
        verify: async () => ({
          kind: "ok",
          value: {
            keyId: "named-key",
            owner: keyOwner,
            name: "named-key",
            scope: { grants: [] },
            grantVersion: 1,
            expiresAt: null,
          },
        }),
      }),
    },
  };
  try {
    const shared = await standaloneTenancy(env);
    const stored = await probe.owner.membershipOf(shared.tenantId, input.owner);
    keyOwner = stored.memberId;
    const owner = await shared.owner();
    assert.deepEqual(owner, {
      actor: { kind: "member", memberId: stored.memberId },
      role: "owner",
      membershipVersion: stored.membershipVersion,
    });
    assert.equal(
      await shared.tenancy.memberById(shared.tenantId, input.owner.subject),
      null,
    );
    const request = new globalThis.Request(`${input.origin}/api/apps`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    const selected = await shared.oyster.resolve(request);
    assert.ok(selected);
    assert.deepEqual(await selected.auth.authenticate(request), {
      kind: "admitted",
      principal: { actor: owner.actor, role: "owner", soleMember: true },
    });
    // The registry holds only the creation-time owner, so the host attests
    // that owner as the tenant's only member on every admission path.
    assert.deepEqual(await selected.auth.resolve(owner.actor), {
      ...owner,
      soleMember: true,
    });
    assert.equal(
      await shared.oyster.resolve(
        new globalThis.Request("https://different.test"),
      ),
      null,
    );
    const login = await selected.auth.login(
      new globalThis.Request(`${input.origin}/login`, {
        method: "POST",
        body: new globalThis.URLSearchParams({ key: credential }),
      }),
    );
    assert.equal(login.status, 303);
    const namedKey = new globalThis.Request(`${input.origin}/api/apps`, {
      headers: { Authorization: "Bearer named-key-fixture" },
    });
    // A named key is never a member, so it never carries the sole-member fact.
    assert.deepEqual(await selected.auth.authenticate(namedKey), {
      kind: "admitted",
      principal: { actor: { kind: "team-key", keyId: "named-key" } },
    });
    await probe.owner.setStatus(shared.tenantId, "suspended");
    assert.equal(await shared.owner(), null);
    assert.equal(await selected.auth.resolve(owner.actor), null);
    // Each request is its own entry and reads current authority once.
    const next = new globalThis.Request(`${input.origin}/api/apps`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    assert.deepEqual(await selected.auth.authenticate(next), {
      kind: "refused",
      status: 403,
    });
    await probe.owner.delete(shared.tenantId);
    assert.equal(await shared.owner(), null);
    assert.equal(
      await shared.tenancy.memberById(shared.tenantId, stored.memberId),
      null,
    );
    await assert.rejects(
      standaloneTenancy({
        ...env,
        TENANTS: { getByName: () => probe.reopen() },
      }),
      /missing/u,
    );
  } finally {
    probe.close([/missing/u]);
  }
});

/** Record each registry RPC an entry makes, against the real registry owner. */
function counted(owner, calls) {
  const record =
    (name, run) =>
    (...args) => {
      calls.push(name);
      return run(...args);
    };
  return {
    seed: record("seed", (input) => owner.seed(input)),
    admission: record("admission", (host, identity) =>
      owner.admission(host, identity),
    ),
    get: record("get", (id) => owner.get(id)),
    byHandle: record("byHandle", (handle) => owner.byHandle(handle)),
    byDomain: record("byDomain", (host) => owner.byDomain(host)),
    status: record("status", (id) => owner.status(id)),
    membershipOf: record("membershipOf", (id, identity) =>
      owner.membershipOf(id, identity),
    ),
    memberById: record("memberById", (id, memberId) =>
      owner.memberById(id, memberId),
    ),
  };
}

function countedEnv(probe, calls, credential) {
  return {
    OYSTER_ORIGIN: input.origin,
    OYSTER_OWNER_NAME: input.owner.subject,
    OYSTER_OWNER_KEY: credential,
    TENANTS: { getByName: () => counted(probe.owner, calls) },
    KEYS: { getByName: () => assert.fail("No named-key lookup expected") },
  };
}

test("one request admits with exactly one TENANTS read, reused by its authentication", async () => {
  const probe = fixture();
  const calls = [];
  const credential = "standalone-count-owner-key-24-characters";
  try {
    const shared = await standaloneTenancy(
      countedEnv(probe, calls, credential),
    );
    const owner = await shared.owner();
    assert.ok(owner);
    calls.length = 0;
    const request = new globalThis.Request(`${input.origin}/api/apps`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    const selected = await shared.oyster.resolve(request);
    assert.ok(selected);
    assert.deepEqual(await selected.auth.authenticate(request), {
      kind: "admitted",
      principal: { actor: owner.actor, role: "owner", soleMember: true },
    });
    assert.deepEqual(await selected.auth.authenticate(request), {
      kind: "admitted",
      principal: { actor: owner.actor, role: "owner", soleMember: true },
    });
    assert.deepEqual(calls, ["admission"]);
    calls.length = 0;
    assert.deepEqual(await shared.owner(), owner);
    assert.deepEqual(calls, ["admission"]);
    calls.length = 0;
    assert.deepEqual(
      await shared.tenancy.memberById(shared.tenantId, owner.actor.memberId),
      owner,
    );
    assert.deepEqual(calls, ["admission"]);
    calls.length = 0;
    assert.equal(
      await shared.oyster.resolve(new globalThis.Request("https://other.test")),
      null,
    );
    assert.deepEqual(calls, []);
  } finally {
    probe.close();
  }
});

test("revoked membership refuses the next request though an earlier one was admitted", async () => {
  const probe = fixture();
  const calls = [];
  const credential = "standalone-revoke-owner-key-24-characters";
  try {
    const shared = await standaloneTenancy(
      countedEnv(probe, calls, credential),
    );
    const owner = await shared.owner();
    assert.ok(owner);
    const admit = () =>
      new globalThis.Request(`${input.origin}/api/apps`, {
        headers: { Authorization: `Bearer ${credential}` },
      });
    const first = admit();
    const selected = await shared.oyster.resolve(first);
    assert.ok(selected);
    assert.equal((await selected.auth.authenticate(first)).kind, "admitted");
    await probe.owner.delete(shared.tenantId);
    const next = admit();
    assert.equal(await shared.oyster.resolve(next), null);
    assert.deepEqual(await selected.auth.authenticate(next), {
      kind: "refused",
      status: 404,
    });
    assert.equal(await selected.auth.resolve(owner.actor), null);
    assert.equal(await shared.owner(), null);
    assert.equal(
      await shared.tenancy.memberById(shared.tenantId, owner.actor.memberId),
      null,
    );
  } finally {
    probe.close();
  }
});

test("a stale membership version never survives into a later entry", async () => {
  const probe = fixture();
  const calls = [];
  const credential = "standalone-stale-owner-key-24-characters";
  try {
    const shared = await standaloneTenancy(
      countedEnv(probe, calls, credential),
    );
    const before = await shared.owner();
    assert.ok(before);
    await probe.owner.setStatus(shared.tenantId, "suspended");
    const suspended = new globalThis.Request(`${input.origin}/api/apps`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    const selected = await shared.oyster.resolve(suspended);
    assert.ok(selected);
    assert.deepEqual(await selected.auth.authenticate(suspended), {
      kind: "refused",
      status: 403,
    });
    await probe.owner.setStatus(shared.tenantId, "active");
    const after = await shared.owner();
    assert.ok(after);
    assert.equal(after.actor.memberId, before.actor.memberId);
    assert.ok(after.membershipVersion > before.membershipVersion);
    assert.deepEqual(
      await shared.tenancy.memberById(shared.tenantId, after.actor.memberId),
      after,
    );
  } finally {
    probe.close();
  }
});

test("one atomic admission answers only its own tenant, identity and member", async () => {
  const probe = fixture();
  try {
    const tenant = await probe.owner.seed(input);
    const registry = durableObjectRegistry(
      { getByName: () => probe.owner },
      { readonly: true },
    );
    assert.equal(await registry.admission("other.test", input.owner), null);
    const stranger = await registry.admission("bonsai.test", {
      provider: "standalone-owner",
      subject: "someone-else",
    });
    assert.ok(stranger);
    assert.equal(stranger.membership, null);
    const admission = await registry.admission("bonsai.test", input.owner);
    assert.ok(admission?.membership);
    assert.deepEqual(admission.tenant, tenant);
    const view = admittedRegistry(admission);
    const { memberId } = admission.membership;
    assert.deepEqual(await view.byDomain("bonsai.test"), tenant);
    assert.equal(await view.byDomain("other.test"), null);
    assert.equal(await view.get("other"), null);
    assert.equal(await view.status("other"), null);
    assert.equal(
      await view.membershipOf(tenant.id, { ...input.owner, subject: "other" }),
      null,
    );
    assert.equal(await view.memberById(tenant.id, "tenant_member_other"), null);
    assert.equal(await view.memberById("other", memberId), null);
    assert.deepEqual(
      await view.memberById(tenant.id, memberId),
      admission.membership,
    );
    // The admitted view never reads again: later changes reach the next entry.
    await probe.owner.setStatus(tenant.id, "suspended");
    assert.equal(await view.status(tenant.id), "active");
    assert.equal(
      (await registry.admission("bonsai.test", input.owner))?.tenant.status,
      "suspended",
    );
  } finally {
    probe.close();
  }
});
