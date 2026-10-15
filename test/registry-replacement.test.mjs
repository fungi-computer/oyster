import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { URL } from "node:url";
import { TextEncoder } from "node:util";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { createOyster } from "../dist/host.js";
import { sha256, parseRelease, verifyRelease } from "../dist/release.js";
import { defaultTenant } from "../dist/tenant.js";
import { computerHost } from "./computer-host.fixture.mjs";

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
const {
  OysterRegistry,
  OysterInstance,
  OysterBinding,
  oysterWorkerHost,
  ownerKeyAuth,
} = await import("../dist/workers.js");
hooks.deregister();

function fixture(t, artifacts, guest) {
  const pending = [];
  const databases = [];
  const instances = new Map();
  const contexts = new Map();
  const env = {
    OYSTER_OWNER_KEY: "local-registry-owner-key-123456789",
    OYSTER_ORIGIN: "https://oyster.invalid",
    RELEASES: {
      async get(ref) {
        const bytes = await artifacts.get(ref);
        return bytes === null
          ? null
          : { arrayBuffer: async () => bytes.slice().buffer };
      },
    },
    INSTANCES: {
      getByName(name) {
        let instance = instances.get(name);
        if (instance === undefined) {
          instance = new OysterInstance(context(name), env);
          instances.set(name, instance);
        }
        return instance;
      },
    },
  };
  if (guest !== undefined)
    env.LOADER = {
      get: (_id, configure) => ({ getDurableObjectClass: () => configure() }),
    };
  function context(name) {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const storage = fromNodeSqlite(db);
    let alarm = null;
    const ctx = {
      id: { name },
      exports: {
        OysterBinding: ({ props }) => new OysterBinding({ props }, env),
      },
      storage: {
        ...storage,
        getAlarm: async () => alarm,
        setAlarm: async (at) => {
          alarm = at;
        },
        transaction: async (work) =>
          work({
            getAlarm: async () => alarm,
            setAlarm: async (at) => {
              alarm = at;
            },
          }),
      },
      blockConcurrencyWhile(work) {
        const result = work();
        pending.push(result);
        return result;
      },
      facets: {
        abort(name) {
          assert.equal(name, "app");
        },
        delete(name) {
          assert.equal(name, "app");
        },
        get(_name, prepare) {
          if (guest === undefined)
            throw new Error("Replacement must not execute a facet");
          prepare();
          // The Loader facade receives each method and its frame bindings;
          // a generated App method answers with its typed reply.
          return {
            invoke: async (method, args) => ({
              kind: "ok",
              value: await guest[method](...args),
            }),
            http: async () => {
              throw new Error("App method unavailable");
            },
          };
        },
      },
    };
    contexts.set(name, ctx);
    return ctx;
  }
  const registry = new OysterRegistry(context("registry"), env);
  env.REGISTRY = { getByName: () => registry };
  t.after(async () => {
    await Promise.all(pending);
    databases.forEach((db) => db.close());
  });
  return {
    registry,
    env,
    contexts,
    databases,
    app: createOyster(
      oysterWorkerHost(env, ownerKeyAuth(env.OYSTER_OWNER_KEY)),
    ),
  };
}

test("owner grant approval refreshes the backend Instance before the next method", async (t) => {
  const selected = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const previous = await selected.installations.get("context-probe");
  const { registry, env } = fixture(t, selected.artifacts, {
    fetch: async () => globalThis.Response.json({ accepted: true }),
    context: async () => ({ accepted: true }),
  });
  const app = createOyster(
    oysterWorkerHost(env, ownerKeyAuth(env.OYSTER_OWNER_KEY)),
  );
  const headers = {
    Authorization: `Bearer ${env.OYSTER_OWNER_KEY}`,
    "Content-Type": "application/json",
  };
  const installed = await app.request("/api/installations", {
    method: "POST",
    headers,
    body: JSON.stringify({
      installationId: previous.installationId,
      release: previous.release,
    }),
  });
  assert.equal(installed.status, 201);
  const current = await installed.json();
  const approved = await app.request(
    `/api/installations/${current.installationId}/grants`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        authorityVersion: current.authorityVersion,
        artifactDigest: current.release.artifact.artifactDigest,
        command: { kind: "set-grants", grants: "declared" },
      }),
    },
  );
  assert.equal(approved.status, 200);
  assert.equal(
    (await approved.json()).authorityVersion,
    current.authorityVersion + 1,
  );
  const called = await app.request(
    `/apps/${current.installationId}/methods/context`,
    {
      method: "POST",
      headers,
      body: "{}",
    },
  );
  assert.equal(called.status, 200, await called.text());
  assert.equal(
    registry.get(current.installationId).authorityVersion,
    current.authorityVersion + 1,
  );
});

test("UI-only release replacement succeeds without creating a backend Instance", async (t) => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-app-v1",
      ui: {
        artifactRef: "artifact:ui",
        digest: await sha256(new TextEncoder().encode("<p>Home</p>")),
        mediaType: "text/html; charset=utf-8",
        byteLength: new TextEncoder().encode("<p>Home</p>").length,
        version: await sha256(new TextEncoder().encode("<p>Home</p>")),
      },
    }),
  );
  const objects = new Map([
    ["artifact:root", bytes],
    ["artifact:ui", new TextEncoder().encode("<p>Home</p>")],
  ]);
  const { app, registry, env } = fixture(t, {
    get: async (ref) => objects.get(ref) ?? null,
  });
  let addressedInstances = 0;
  const lookup = env.INSTANCES.getByName;
  env.INSTANCES.getByName = (name) => {
    addressedInstances++;
    return lookup(name);
  };
  const digest = await sha256(bytes);
  const release = {
    appId: "app_tourtois",
    releaseId: "rel_home",
    artifact: {
      artifactRef: "artifact:root",
      artifactDigest: digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: digest,
        buildRecipeDigest: digest,
      },
    },
  };
  const headers = {
    Authorization: `Bearer ${env.OYSTER_OWNER_KEY}`,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await app.request("/api/installations", {
        method: "POST",
        headers,
        body: JSON.stringify({ installationId: "tourtois", release }),
      })
    ).status,
    201,
  );
  const replaced = await app.request("/api/installations/tourtois/release", {
    method: "PUT",
    headers,
    body: JSON.stringify(release),
  });
  assert.equal(replaced.status, 200);
  assert.equal(registry.get("tourtois").authorityVersion, 2);
  assert.equal(addressedInstances, 0);
  const current = registry.get("tourtois");
  const approvals = await Promise.all(
    ["declared", "none"].map((grants) =>
      app.request("/api/installations/tourtois/grants", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          authorityVersion: current.authorityVersion,
          artifactDigest: current.release.artifact.artifactDigest,
          command: { kind: "set-grants", grants },
        }),
      }),
    ),
  );
  assert.deepEqual(
    approvals.map((response) => response.status).sort(),
    [200, 409],
  );
  assert.equal(
    registry.get("tourtois").authorityVersion,
    current.authorityVersion + 1,
  );
  assert.equal(addressedInstances, 0);
});

test("a foreign backend owner refuses replacement before changing the registry selection", async (t) => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const previous = await host.installations.get("context-probe");
  const { registry, env } = fixture(t, host.artifacts);
  await registry.put(previous);
  const instance = env.INSTANCES.getByName(previous.instanceId);
  const applied = await instance.apply(
    {
      instanceId: previous.instanceId,
      owner: { kind: "installation", id: "foreign" },
      appId: previous.release.appId,
      releaseId: previous.release.releaseId,
      authorityVersion: 1,
      status: "enabled",
    },
    previous.release,
    undefined,
    { tenantId: defaultTenant, origin: env.OYSTER_ORIGIN },
  );
  assert.equal(applied.ok, true);
  const next = { ...previous, authorityVersion: 2 };
  await assert.rejects(registry.put(next), { code: "instance_owner_mismatch" });
  assert.deepEqual(registry.get(previous.installationId), previous);
});

test("a replacement awaiting revocation cannot overwrite a newer selection", async (t) => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const previous = await host.installations.get("context-probe");
  const { registry, env } = fixture(t, host.artifacts);
  await registry.put(previous);
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let finish;
  const waiting = new Promise((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  env.INSTANCES.getByName = () => ({
    async revoke() {
      calls++;
      if (calls === 1) {
        enter();
        await waiting;
      }
    },
  });
  const stale = registry.put({ ...previous, authorityVersion: 2 });
  await entered;
  const current = { ...previous, authorityVersion: 3 };
  await registry.put(current);
  finish();
  await assert.rejects(stale, { code: "stale_authority" });
  assert.deepEqual(registry.get(previous.installationId), current);
});

test("the default root arms one durable wake after a burst and replays the member only on alarm", async (t) => {
  const objects = new Map();
  const persist = async (name, value, mediaType) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = await sha256(bytes);
    const artifactRef = `artifact:${name}`;
    objects.set(artifactRef, bytes);
    return {
      artifactRef,
      digest,
      version: "1",
      byteLength: bytes.length,
      mediaType,
    };
  };
  const backend = await persist(
    "background-backend",
    {
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "Guest",
      code: "export class Guest {}",
    },
    backendMediaType,
  );
  const method = {
    description: "Write queued rows",
    effect: "write",
    requires: [],
    input: { type: "object" },
    output: { type: "object" },
  };
  const build = createAppBuild(null, backend, {
    capabilities: [],
    handlers: [],
    roles: [],
    commands: [],
    gills: [],
    backend: { bindings: [], sync: { method: "continueWrites" } },
    api: { methods: { saveDraft: method, continueWrites: method } },
  });
  const root = await persist("background-root", build, "application/json");
  const release = {
    appId: "app_background",
    releaseId: "rel_background",
    artifact: {
      artifactRef: root.artifactRef,
      artifactDigest: root.digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: root.digest,
        buildRecipeDigest: root.digest,
      },
    },
  };
  await verifyRelease(
    { get: (ref) => Promise.resolve(objects.get(ref) ?? null) },
    parseRelease(release),
  );
  const clicks = [];
  const replays = [];
  const { app, registry, env, contexts } = fixture(
    t,
    { get: async (ref) => objects.get(ref) ?? null },
    {
      saveDraft: async (_input, context) => {
        clicks.push(context);
        return { queued: true };
      },
      continueWrites: async (_input, context) => {
        replays.push(context);
        return { more: false };
      },
    },
  );
  const headers = {
    Authorization: `Bearer ${env.OYSTER_OWNER_KEY}`,
    "Content-Type": "application/json",
  };
  const installationResponse = await app.request("/api/installations", {
    method: "POST",
    headers,
    body: JSON.stringify({ installationId: "background", release }),
  });
  assert.equal(
    installationResponse.status,
    201,
    await installationResponse.text(),
  );
  for (let click = 0; click < 5; click += 1)
    assert.equal(
      (
        await app.request("/apps/background/methods/saveDraft", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
  assert.equal(clicks.length, 5);
  assert.equal(clicks[0].backgroundLane, "member:owner");
  assert.deepEqual(replays, []);
  const selected = registry.get("background");
  const instance = env.INSTANCES.getByName(selected.instanceId);
  assert.notEqual(
    await contexts.get(selected.instanceId).storage.getAlarm(),
    null,
  );
  await instance.alarm();
  assert.equal(replays.length, 1);
  assert.deepEqual(replays[0].actor, { kind: "member", memberId: "owner" });
  assert.equal(replays[0].role, "owner");
  assert.equal(replays[0].backgroundLane, undefined);
  assert.match(replays[0].idempotencyKey, /^appsync:[a-f0-9]{64}$/u);
  await instance.alarm();
  assert.equal(replays.length, 1);
  assert.equal(
    (
      await app.request("/apps/background/methods/saveDraft", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    200,
  );
  await instance.alarm();
  assert.equal(replays.length, 2);
  assert.notEqual(replays[0].idempotencyKey, replays[1].idempotencyKey);
});

test("a durable approval rejects a competing update with the same expected version", async (t) => {
  const { registry } = fixture(t, { get: async () => null });
  const installed = {
    ...(await (
      await computerHost(
        { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
        null,
      )
    ).installations.get("context-probe")),
  };
  // No attached backend Instance: exercise the durable commit without a revoke await.
  installed.instanceId = null;
  await registry.put(installed);
  const first = {
    ...installed,
    authorityVersion: installed.authorityVersion + 1,
    approvedGrants: [],
    approval: null,
  };
  assert.deepEqual(
    await registry.compareAndPut(first, installed.authorityVersion),
    { ok: true },
  );
  assert.deepEqual(
    await registry.compareAndPut(
      { ...first, visibility: "public" },
      installed.authorityVersion,
    ),
    { ok: false, code: "stale_authority" },
  );
  assert.deepEqual(registry.get(installed.installationId), first);
});

test("an approval losing during Release resolution refuses before revoking an Instance", async (t) => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const previous = await host.installations.get("context-probe");
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const { registry, env } = fixture(t, {
    get: async (ref) => {
      if (++reads === 1) {
        enter();
        await blocked;
      }
      return host.artifacts.get(ref);
    },
  });
  await registry.put(previous);
  let revoked = 0;
  env.INSTANCES.getByName = () => ({
    revoke: async () => {
      revoked++;
    },
  });
  const stale = registry.compareAndPut(
    { ...previous, authorityVersion: 2 },
    previous.authorityVersion,
  );
  await entered;
  const winner = { ...previous, authorityVersion: 3 };
  await registry.put(winner);
  assert.equal(revoked, 1);
  release();
  assert.deepEqual(await stale, { ok: false, code: "stale_authority" });
  assert.equal(revoked, 1);
  assert.deepEqual(registry.get(previous.installationId), winner);
});

for (const variant of [
  "missing capability approval",
  "e3dc row missing anonymous approval fields",
]) {
  test(`a stored installation row that fails the current contract is a hard decode failure (${variant})`, async (t) => {
    const host = await computerHost();
    const { registry, databases, app, env } = fixture(t, host.artifacts);
    const installed = await host.installations.get("context-probe");
    assert.notEqual(installed, null);
    const corrupt = { ...installed };
    if (variant === "e3dc row missing anonymous approval fields") {
      delete corrupt.approvedAnonymousMethods;
      delete corrupt.anonymousApproval;
    } else {
      corrupt.approvedGrants = [
        {
          capability: "git.repository",
          operations: ["binding:GIT:read"],
          resources: "tenant-scope",
        },
      ];
    }
    databases[0]
      .prepare("INSERT INTO installations VALUES(?,?)")
      .run(installed.installationId, JSON.stringify(corrupt));
    // An undecodable row is corruption, never a silently tolerated shape.
    assert.throws(() => registry.get(installed.installationId));
    assert.throws(() => registry.list());
    const headers = { Authorization: `Bearer ${env.OYSTER_OWNER_KEY}` };
    const home = await app.request("/", { headers });
    assert.equal(home.status, 500);
    const list = await app.request("/api/installations", { headers });
    assert.equal(list.status, 500);
  });
}
