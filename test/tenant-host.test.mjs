import { approvedInstallation } from "../dist/testing/index.js";
import {
  createAppBuild,
  emptyAppDeclaration,
} from "@fungi.computer/puffball/app";
import { approvedBindingGrants } from "../dist/apps/index.js";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { URL } from "node:url";
import * as Schema from "effect/Schema";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { fromNodeSqlite as fromNodeSqliteEarTag } from "@fungi.computer/ear-tag/keys/node";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { instanceIds } from "../dist/index.js";
import { BOOT_CAPABILITY_HEADER } from "../dist/boot-capability.js";
import { defaultTenant, tenantIdSchema, tenantScope } from "../dist/tenant.js";
import { withBackendConstruction } from "./boot-construction.fixture.ts";

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
const { OysterRegistry, OysterInstance, oysterWorkerHost, r2FileSource } =
  await import("../dist/workers.js");
const {
  createOysterGitWorker,
  oysterGitRoot,
  oysterGitWorkerHost,
  ownerOrKeyTenancy,
  OysterKeys,
} = await import("../src/workers-git.ts");
const { ownerOrKeyAuth } = await import("../dist/auth.js");
const { standaloneComputerSelection } =
  await import("../src/standalone/computer-fleet.ts");
hooks.deregister();

/** A real `OysterKeys` instance over real node:sqlite, for the owner-recheck proof below. */
function keysNamespace() {
  const database = new DatabaseSync(":memory:");
  let counter = 0;
  const ctx = {
    id: { name: "keys" },
    storage: {
      sql: fromNodeSqliteEarTag(database),
      // The real DO's own transactionSync is synchronous; OysterKeys wraps
      // it in Promise.resolve itself, so this must not return a Promise.
      transactionSync: (body) => {
        const name = `tenant_host_test_${String(counter++)}`;
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

test("two tenant hosts independently retain the same installation name", async (t) => {
  // Only the platform namespace is substituted: each named object uses the real
  // registry owner and real SQLite. No tenant routing is implemented by the test.
  const registries = new Map();
  const env = {
    RELEASES: {},
    INSTANCES: { getByName: () => ({ revoke: () => Promise.resolve() }) },
    REGISTRY: {
      getByName(name) {
        if (!registries.has(name)) {
          const database = new DatabaseSync(":memory:");
          t.after(() => database.close());
          registries.set(
            name,
            new OysterRegistry(
              { id: { name }, storage: fromNodeSqlite(database) },
              env,
            ),
          );
        }
        return registries.get(name);
      },
    },
  };
  const host = (id) =>
    oysterWorkerHost(
      env,
      {
        authenticate: async () => ({
          kind: "admitted",
          principal: {
            actor: { kind: "member", memberId: `owner-${id}` },
            role: "owner",
          },
        }),
      },
      {
        scope: tenantScope(
          Schema.decodeUnknownSync(tenantIdSchema)(id),
          `https://${id}.oyster.test`,
        ),
      },
    );
  const release = Schema.decodeUnknownSync(releaseSchema)({
    appId: "app_notes",
    releaseId: "rel_notes",
    artifact: {
      artifactRef: "artifact:notes",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      provenance: {
        sourceRevision: `git:${"b".repeat(40)}`,
        sourceTreeDigest: `sha256:${"c".repeat(64)}`,
        buildRecipeDigest: `sha256:${"d".repeat(64)}`,
      },
    },
  });
  const installation = () =>
    approvedInstallation({
      installationId: "notes",
      instanceId: instanceIds.instance.generate(),
      release,
      declaration: emptyAppDeclaration,
    });
  const alice = host("aa");
  const bob = host("bb");
  const aliceNotes = await installation();
  const bobNotes = await installation();
  assert.deepEqual(
    await alice.installations.compareAndPut(
      aliceNotes,
      0,
      await alice.installations.generation(),
    ),
    {
      ok: true,
    },
  );
  assert.deepEqual(await alice.installations.get("notes"), aliceNotes);
  assert.deepEqual(
    await bob.installations.compareAndPut(
      bobNotes,
      0,
      await bob.installations.generation(),
    ),
    {
      ok: true,
    },
  );
  assert.deepEqual(await bob.installations.get("notes"), bobNotes);
  assert.deepEqual(await alice.installations.get("notes"), aliceNotes);
  assert.deepEqual(await alice.installations.list(), [aliceNotes]);
  assert.deepEqual(await bob.installations.list(), [bobNotes]);
});

const auth = {
  authenticate: async () => ({
    kind: "admitted",
    principal: { actor: { kind: "member", memberId: "owner" }, role: "owner" },
  }),
};
const scopeOf = (id) =>
  tenantScope(
    Schema.decodeUnknownSync(tenantIdSchema)(id),
    `https://${id}.oyster.test`,
  );

test("per-boot tenant scope selects the exact origin and registry for backend-plus-UI prepare", async (t) => {
  const uiBytes = new globalThis.TextEncoder().encode(
    "<!doctype html><body>tenant UI</body>",
  );
  const backendBytes = new globalThis.TextEncoder().encode(
    JSON.stringify({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "Notes",
      code: "export class Notes {}",
    }),
  );
  const digestOf = (bytes) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const rootBytes = new globalThis.TextEncoder().encode(
    JSON.stringify(
      createAppBuild(
        {
          artifactRef: "artifact:tenant-boot-ui",
          digest: digestOf(uiBytes),
          byteLength: uiBytes.byteLength,
          version: "tenant-ui",
          mediaType: "text/html; charset=utf-8",
        },
        {
          artifactRef: "artifact:tenant-boot-backend",
          digest: digestOf(backendBytes),
          byteLength: backendBytes.byteLength,
          version: "tenant-backend",
          mediaType: backendMediaType,
        },
        emptyAppDeclaration,
      ),
    ),
  );
  const rootDigest = digestOf(rootBytes);
  const artifacts = new Map([
    ["artifact:tenant-boot-root", rootBytes],
    ["artifact:tenant-boot-ui", uiBytes],
    ["artifact:tenant-boot-backend", backendBytes],
  ]);
  const objectFor = (reference) => {
    const bytes = artifacts.get(reference);
    if (bytes === undefined) return null;
    return {
      size: bytes.byteLength,
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      body: new globalThis.ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };
  const release = Schema.decodeUnknownSync(releaseSchema)({
    appId: "app_notes",
    releaseId: "rel_notes",
    artifact: {
      artifactRef: "artifact:tenant-boot-root",
      artifactDigest: rootDigest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: rootDigest,
        buildRecipeDigest: rootDigest,
      },
    },
  });
  const registryDatabases = new Map();
  const registryDatabaseHandles = [];
  const registryCalls = [];
  const observations = {
    domains: [],
    closed: [],
    heads: [],
  };
  const env = {
    OYSTER_ORIGIN: "https://default.oyster.test",
    RELEASES: {
      get: async (reference) => objectFor(reference),
      head: async (reference) => {
        observations.heads.push(reference);
        const object = objectFor(reference);
        return object === null ? null : { size: object.size };
      },
    },
    REGISTRY: {
      getByName(name) {
        if (!registryDatabases.has(name)) {
          const database = new DatabaseSync(":memory:");
          registryDatabaseHandles.push(database);
          registryDatabases.set(
            name,
            new OysterRegistry(
              { id: { name }, storage: fromNodeSqlite(database) },
              env,
            ),
          );
        }
        const registry = registryDatabases.get(name);
        return {
          bootCapability(input) {
            registryCalls.push({
              name,
              kind: input.kind,
              releaseId: input.grant?.lease.identity.releaseId,
              tokenDigest: input.grant?.tokenDigest,
            });
            return registry.bootCapability(input);
          },
        };
      },
    },
    BROWSER: {
      async fetch(url, init = {}) {
        const path = new URL(url).pathname;
        const method = init.method ?? "GET";
        if (method === "POST" && path.endsWith("/browser")) {
          observations.domains.push(
            JSON.parse(init.body).guardrails.allowedDomains,
          );
          return globalThis.Response.json({
            sessionId: `session-${observations.domains.length}`,
          });
        }
        const id = path.split("/").at(-1);
        if (method === "DELETE") {
          observations.closed.push(id);
          return globalThis.Response.json({ status: "closed" });
        }
        if (path.includes("/session/"))
          return globalThis.Response.json({ sessionId: id, endTime: 1 });
        // The CDP upgrade: no page is driven in this tenant-scope test.
        return new globalThis.Response(null, { status: 502 });
      },
    },
  };
  t.after(() => {
    for (const database of registryDatabaseHandles) database.close();
  });

  const preparations = [];
  const constructions = [];
  for (const id of ["aa", "bb"]) {
    const database = new DatabaseSync(":memory:");
    t.after(() => database.close());
    const ctx = {
      id: { name: instanceIds.instance.generate() },
      storage: fromNodeSqlite(database),
      blockConcurrencyWhile: (run) => run(),
      facets: {
        clone: () => undefined,
        abort: () => undefined,
        delete: () => undefined,
        get: () => {
          throw new Error("No running candidate facet is expected");
        },
      },
    };
    const construction = withBackendConstruction(ctx.facets, {
      get: (name, configure) => {
        const configured = configure();
        return { getDurableObjectClass: () => configured };
      },
    });
    ctx.facets = construction.facets;
    constructions.push(construction);
    const instance = new OysterInstance(ctx, {
      ...env,
      LOADER: construction.loader,
    });
    const state = {
      instanceId: ctx.id.name,
      appId: release.appId,
      releaseId: release.releaseId,
      owner: { kind: "installation", id: "installation_notes" },
      status: "enabled",
      authorityVersion: 1,
    };
    preparations.push(
      await instance.prepare(state, release, undefined, {
        tenantId: scopeOf(id).tenantId,
        origin: scopeOf(id).origin,
      }),
    );
  }

  // The UI check ran on each tenant's own browser session; with no page
  // driven here it reports the runner unavailable, never a refusal.
  const unavailable = {
    ok: true,
    value: { kind: "not_checked", code: "boot_runner_unavailable" },
  };
  assert.deepEqual(
    preparations.map(({ ok, value }) => ({ ok, value })),
    [unavailable, unavailable],
    JSON.stringify({ preparations, observations, registryCalls }),
  );
  assert.deepEqual(observations.domains, [
    ["aa.oyster.test"],
    ["bb.oyster.test"],
  ]);
  assert.deepEqual(
    registryCalls
      .filter(({ kind }) => kind === "issue")
      .map(({ name, releaseId }) => ({
        name,
        releaseId,
      })),
    [
      { name: "t.aa.registry", releaseId: "rel_notes" },
      { name: "t.bb.registry", releaseId: "rel_notes" },
    ],
  );
  assert.deepEqual(
    registryCalls
      .filter(({ kind }) => kind === "revoke")
      .map(({ name }) => name),
    ["t.aa.registry", "t.bb.registry"],
  );
  assert.deepEqual(observations.closed, ["session-1", "session-2"]);
  for (const construction of constructions) {
    assert.equal(construction.probes.length, 1);
    assert.equal(construction.probes[0].completed, true);
  }
});

test("workbench directory and every storage operation use the host-selected registry", async () => {
  const calls = [];
  const env = {
    OYSTER_ORIGIN: "https://oyster.test",
    RELEASES: {},
    REGISTRY: {
      getByName(name) {
        const record = (operation, ...args) => {
          calls.push({ name, operation, args });
          return Promise.resolve(null);
        };
        return {
          list: () => {
            calls.push({ name, operation: "list", args: [] });
            return Promise.resolve([]);
          },
          directory: () => record("directory"),
          storageRead: (...args) => record("read", ...args),
          storageWrite: (...args) => record("write", ...args),
          storageReset: (...args) => record("reset", ...args),
          storageEvents: (...args) => record("events", ...args),
        };
      },
    },
  };
  for (const [scope, name] of [
    [scopeOf("aa"), "t.aa.registry"],
    [scopeOf("bb"), "t.bb.registry"],
    [scopeOf("default"), "registry"],
    [undefined, "registry"],
  ]) {
    const host = oysterWorkerHost(env, auth, { scope });
    const storage = host.workbench.storage("notes", "owner");
    const write = { key: "desktop", scope: "member", basedOn: null, value: {} };
    const reset = { key: "desktop", scope: "member", basedOn: null };
    await host.workbench.directory();
    await storage.read("desktop");
    await storage.write(write);
    await storage.reset(reset);
    await storage.events("desktop");
    assert.deepEqual(calls.splice(0), [
      { name, operation: "list", args: [] },
      { name, operation: "directory", args: [] },
      { name, operation: "read", args: ["notes", "owner", "desktop"] },
      { name, operation: "write", args: ["notes", "owner", write] },
      { name, operation: "reset", args: ["notes", "owner", reset] },
      { name, operation: "events", args: ["notes", "owner", "desktop"] },
    ]);
  }
});

test("tenant workspace files do not overwrite one another and default names stay unchanged", async () => {
  const objects = new Map();
  const bucket = {
    put: async (key, value) => {
      objects.set(key, value);
    },
    get: async (key) => {
      const bytes = objects.get(key);
      return bytes === undefined
        ? null
        : { arrayBuffer: async () => bytes.buffer };
    },
  };
  const files = (scope) =>
    oysterWorkerHost(
      { OYSTER_ORIGIN: "https://oyster.test", RELEASES: bucket },
      auth,
      { scope },
    ).capabilities[0].routes;
  const alice = files(scopeOf("aa"));
  const bob = files(scopeOf("bb"));
  const legacy = files(undefined);
  const defaultFiles = files(scopeOf("default"));
  const write = (routes, body) =>
    routes.request("/content?path=/notes.txt", { method: "PUT", body });
  assert.equal((await write(alice, "Alice")).status, 204);
  assert.equal((await bob.request("/content?path=/notes.txt")).status, 404);
  assert.equal((await write(bob, "Bob")).status, 204);
  assert.equal(
    await (await alice.request("/content?path=/notes.txt")).text(),
    "Alice",
  );
  assert.equal(
    await (await bob.request("/content?path=/notes.txt")).text(),
    "Bob",
  );
  assert.equal((await write(legacy, "Default")).status, 204);
  assert.equal(
    await (await defaultFiles.request("/content?path=/notes.txt")).text(),
    "Default",
  );
  assert.deepEqual([...objects.keys()].sort(), [
    "tenants/aa/workspace/notes.txt",
    "tenants/bb/workspace/notes.txt",
    "workspace/notes.txt",
  ]);
});

test("an explicit workspace source and globally unique Instance lookup keep their host contracts", async () => {
  const calls = [];
  const env = {
    RELEASES: {
      get: () => {
        throw new Error("Explicit workspace must win");
      },
    },
    INSTANCES: {
      getByName(name) {
        return {
          call: (...args) => {
            calls.push({ name, args });
            return Promise.resolve("result");
          },
        };
      },
    },
  };
  const host = oysterWorkerHost(env, auth, {
    scope: scopeOf("aa"),
    workspace: {
      computerId: "selected-workspace",
      files: {
        read: async () => new globalThis.TextEncoder().encode("Custom"),
      },
    },
  });
  assert.equal(host.computerId, "selected-workspace");
  assert.equal(
    await (
      await host.capabilities[0].routes.request("/content?path=/notes.txt")
    ).text(),
    "Custom",
  );
  const instanceId = instanceIds.instance.generate();
  // Facts are opaque here: the released helper forwards them; Instance admission
  // and its pending tenant pin belong to the S3 owner, not this routing proof.
  const facts = Object.freeze({});
  const input = { text: "hello" };
  assert.equal(
    await host.instances.get(instanceId).call(facts, "Notes", "read", input),
    "result",
  );
  assert.equal(calls[0].name, instanceId);
  assert.equal(calls[0].args[0], facts);
  assert.deepEqual(calls[0].args.slice(1, 4), ["Notes", "read", input]);
});

test("a verified named key is a Team-key writer and canonical members retain their role", async () => {
  const env = {
    OYSTER_ORIGIN: "https://oyster.example",
    OYSTER_OWNER_KEY: "host-owner-key-fixture-123456789",
    KEYS: {
      getByName: () => ({
        verify: async () => ({
          kind: "ok",
          value: {
            keyId: "named-key",
            owner: "owner",
            name: "named-key",
            scope: { grants: [] },
            grantVersion: 1,
            expiresAt: null,
          },
        }),
      }),
    },
    RELEASES: {},
  };
  const host = await oysterGitRoot({ tenancy: ownerOrKeyTenancy }).hostFor(
    env,
    tenantScope(defaultTenant, env.OYSTER_ORIGIN),
  );
  const admitted = await host.auth.authenticate(
    new globalThis.Request("https://oyster.example/git/notes/draft.git", {
      headers: { Authorization: "Bearer named-key-fixture-123456789" },
    }),
  );
  assert.equal(admitted.kind, "admitted");
  assert.deepEqual(host.git.writerOf(admitted.principal), {
    kind: "actor",
    actor: { kind: "team-key", keyId: "named-key" },
  });
  for (const role of ["owner", "member"]) {
    assert.deepEqual(
      host.git.writerOf({
        actor: { kind: "member", memberId: "stored-member" },
        role,
      }),
      {
        kind: "actor",
        actor: { kind: "member", memberId: "stored-member" },
        role,
      },
    );
  }
});

test("an Instance retains its tenant pin across reopen and refuses a foreign tenant before lifecycle work", async (t) => {
  const { computerHost } = await import("./computer-host.fixture.mjs");
  const host = await computerHost(
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    null,
  );
  const installation = await host.installations.get("context-probe");
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  let aborts = 0;
  const ctx = {
    id: { name: installation.instanceId },
    storage: fromNodeSqlite(database),
    blockConcurrencyWhile: (run) => run(),
    facets: {
      // No live guest is invoked in this context probe; App storage is empty.
      clone: (source, destination) => {
        assert.equal(source, "app");
        assert.equal(destination, "candidate");
      },
      abort: () => {
        aborts += 1;
      },
      delete: () => {
        throw new Error("Unexpected facet deletion");
      },
      get: () => {
        throw new Error("No guest invocation");
      },
    },
  };
  const loaded = [];
  const construction = withBackendConstruction(ctx.facets, {
    get: (name, configure) => {
      const configured = configure();
      assert.deepEqual(configured.env, {});
      assert.equal(configured.globalOutbound, null);
      loaded.push({ name, limits: configured.limits });
      return { getDurableObjectClass: () => configured };
    },
  });
  ctx.facets = construction.facets;
  t.after(() => {
    assert.ok(construction.probes.length > 0);
    for (const probe of construction.probes) {
      assert.equal(probe.completed, true);
      assert.equal(probe.aborted, true);
      assert.equal(probe.deleted, true);
      assert.equal(probe.name, "candidate");
      assert.match(probe.loaderId, /^boot:/);
      assert.ok(loaded.some((load) => load.name === probe.loaderId));
    }
    for (const load of loaded)
      assert.deepEqual(load.limits, { cpuMs: 1000, subRequests: 50 });
  });
  const env = {
    LOADER: construction.loader,
    REGISTRY: {
      getByName: (name) => {
        assert.equal(name, scopeOf("aa").durableName("registry"));
        return host.installations;
      },
    },
    RELEASES: {
      get: async (ref) => {
        const bytes = await host.artifacts.get(ref);
        return bytes === null
          ? null
          : { arrayBuffer: async () => bytes.buffer };
      },
    },
  };
  const state = {
    instanceId: installation.instanceId,
    appId: installation.release.appId,
    releaseId: installation.release.releaseId,
    owner: { kind: "installation", id: installation.installationId },
    status: "enabled",
    authorityVersion: 1,
  };
  const pin = (id) => ({
    tenantId: scopeOf(id).tenantId,
    origin: scopeOf(id).origin,
  });
  const instance = new OysterInstance(ctx, env);
  assert.equal(
    (await instance.apply(state, installation.release, undefined, pin("aa")))
      .ok,
    true,
  );
  const baselineAborts = aborts;
  const baselineProbes = construction.probes.length;
  const baselineLoads = loaded.length;
  const { verifyRelease } = await import("../dist/host.js");
  const { admittedCallerFacts } = await import("../dist/invocation.js");
  const verified = await verifyRelease(host.artifacts, installation.release);
  const facts = admittedCallerFacts(
    installation,
    verified,
    {
      actor: { kind: "member", memberId: "owner" },
      role: "owner",
      computerId: null,
    },
    approvedBindingGrants(
      installation,
      verified.declaration ?? emptyAppDeclaration,
    ),
  );
  const foreignResponse = await instance.backend(
    facts,
    new globalThis.Request("https://guest.internal"),
    undefined,
    scopeOf("bb").tenantId,
  );
  assert.equal(
    foreignResponse.status,
    403,
    "foreign tenant cannot invoke the retained Instance",
  );
  await assert.rejects(
    instance.apply(state, installation.release, undefined, pin("bb")),
    /tenant mismatch/,
  );
  assert.equal(
    aborts,
    baselineAborts,
    "foreign tenant must not revoke the retained frame",
  );
  assert.equal(construction.probes.length, baselineProbes);
  assert.equal(loaded.length, baselineLoads);
  const reopened = new OysterInstance(ctx, env);
  await assert.rejects(
    reopened.apply(state, installation.release, undefined, pin("bb")),
    /tenant mismatch/,
  );
  assert.equal(construction.probes.length, baselineProbes);
  assert.equal(loaded.length, baselineLoads);
  assert.equal(
    (await reopened.apply(state, installation.release, undefined, pin("aa")))
      .ok,
    true,
  );
});

test("the production worker resolves tenancy before authentication and uses the selected registry", async () => {
  const seen = [];
  let authentications = 0;
  const env = {
    OYSTER_ORIGIN: "https://default.oyster.test",
    OYSTER_OWNER_KEY: "default-host-owner-fixture-123456789",
    RELEASES: {},
    REGISTRY: {
      getByName: (name) => ({
        list: async () => {
          seen.push(name);
          return [];
        },
      }),
    },
  };
  let role = "owner";
  const worker = createOysterGitWorker(
    oysterGitRoot({
      tenancy: () => ({
        resolve: async (request) => {
          const id = new globalThis.URL(request.url).hostname.split(".")[0];
          if (id !== "aa" && id !== "bb") return null;
          return {
            scope: scopeOf(id),
            auth: {
              authenticate: async () => {
                authentications += 1;
                return {
                  kind: "admitted",
                  principal: {
                    actor: { kind: "member", memberId: "stored-member" },
                    role,
                  },
                };
              },
            },
          };
        },
      }),
    }),
  );
  const fetch = (id) =>
    worker.fetch(
      new globalThis.Request(`https://${id}.oyster.test/api/installations`),
      env,
      {},
    );
  assert.equal((await fetch("unknown")).status, 404);
  assert.equal(
    authentications,
    0,
    "unknown origin refuses before authentication",
  );
  assert.equal((await fetch("aa")).status, 200);
  assert.equal((await fetch("bb")).status, 200);
  assert.deepEqual(seen, ["t.aa.registry", "t.bb.registry"]);
  role = "member";
  assert.equal(
    (await fetch("aa")).status,
    403,
    "cached hosts recheck current identity/role",
  );
});

test("the production Git Worker serves an anonymous capability only from its admitted tenant registry", async (t) => {
  const bytes = new globalThis.TextEncoder().encode("<p>tenant candidate</p>");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const token = randomBytes(32).toString("base64url");
  const tokenDigest = createHash("sha256").update(token).digest("hex");
  const databases = new Map();
  const registries = new Map();
  let authentications = 0;
  let assetReads = 0;
  const env = {
    OYSTER_ORIGIN: "https://aa.oyster.test",
    OYSTER_OWNER_KEY: "owner-key-that-is-not-sent-to-the-capability-route",
    RELEASES: {
      get: async (ref) => {
        if (ref !== "artifact:tenant-boot") return null;
        assetReads += 1;
        return {
          size: bytes.byteLength,
          body: new globalThis.ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        };
      },
    },
    REGISTRY: {
      getByName(name) {
        if (!registries.has(name)) {
          const database = new DatabaseSync(":memory:");
          databases.set(name, database);
          const registry = new OysterRegistry(
            { id: { name }, storage: fromNodeSqlite(database) },
            env,
          );
          registries.set(name, registry);
        }
        return registries.get(name);
      },
    },
  };
  t.after(() => {
    for (const database of databases.values()) database.close();
  });
  const tenancy = {
    async resolve(request) {
      const hostname = new URL(request.url).hostname;
      const id = hostname.split(".")[0];
      if (id !== "aa" && id !== "bb") return null;
      return {
        scope: scopeOf(id),
        auth: {
          authenticate: async () => {
            authentications += 1;
            return { kind: "refused", status: 401 };
          },
        },
      };
    },
  };
  const worker = createOysterGitWorker(
    oysterGitRoot({ tenancy: () => tenancy }),
  );
  const aaRegistry = env.REGISTRY.getByName("t.aa.registry");
  aaRegistry.bootCapability({
    kind: "issue",
    grant: {
      lease: {
        id: "lease-tenant-host",
        identity: {
          appId: "app_notes",
          releaseId: "rel_notes",
          surfaceId: "host-boot",
        },
        base: "./",
        expiresAt: Date.now() + 5000,
        assets: [
          {
            path: "/index.html",
            contentType: "text/html; charset=utf-8",
            artifactRef: "artifact:tenant-boot",
            digest,
            byteLength: bytes.byteLength,
          },
        ],
      },
      tokenDigest,
    },
  });

  const response = await worker.fetch(
    new globalThis.Request(
      "https://aa.oyster.test/_boot/rel_notes/candidate/index.html",
      {
        headers: {
          Host: "bb.oyster.test",
          [BOOT_CAPABILITY_HEADER]: token,
        },
      },
    ),
    env,
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(await response.text(), "<p>tenant candidate</p>");
  assert.equal(
    authentications,
    0,
    "capability access does not require owner auth",
  );
  assert.equal(assetReads, 1);

  const otherTenant = await worker.fetch(
    new globalThis.Request(
      "https://bb.oyster.test/_boot/rel_notes/candidate/index.html",
      { headers: { [BOOT_CAPABILITY_HEADER]: token } },
    ),
    env,
    {},
  );
  assert.equal(otherTenant.status, 404);
  assert.equal(assetReads, 1, "another tenant cannot stream the issued asset");
  const unknownOrigin = await worker.fetch(
    new globalThis.Request(
      "https://unknown.oyster.test/_boot/rel_notes/candidate/index.html",
      { headers: { [BOOT_CAPABILITY_HEADER]: token } },
    ),
    env,
    {},
  );
  assert.equal(unknownOrigin.status, 404);
  assert.equal(authentications, 0);

  const ordinaryApi = await worker.fetch(
    new globalThis.Request("https://aa.oyster.test/api/installations"),
    env,
    {},
  );
  assert.equal(ordinaryApi.status, 401);
  assert.equal(authentications, 1, "ordinary host API still authenticates");
});

test("window selection and cached HTTP hosts share authentication only within one request", async () => {
  let authentications = 0;
  let role = "owner";
  let liveOwner = true;
  const reads = [];
  const selections = [];
  const registry = {
    list: async () => [],
    selectedComputer: async () => {
      throw new Error(
        "An explicit window selection must not consult or mutate the default",
      );
    },
    computerFleet: async (memberId, input) => {
      assert.equal(memberId, "stored-member");
      assert.equal(input.operation, "resolve");
      reads.push(input.computerId);
      if (!liveOwner) return { error: "owner_required" };
      return input.computerId === "unknown"
        ? null
        : {
            computerId: input.computerId,
          };
    },
  };
  const env = { RELEASES: {}, REGISTRY: { getByName: () => registry } };
  const root = oysterGitRoot({
    tenancy: () => ({
      resolve: async () => ({
        scope: scopeOf("aa"),
        auth: {
          authenticate: async () => {
            authentications += 1;
            return {
              kind: "admitted",
              principal: {
                actor: { kind: "member", memberId: "stored-member" },
                role,
              },
            };
          },
        },
      }),
    }),
    workspace: async (currentEnv, _keysLive, scope, incoming) => {
      const computerId = await standaloneComputerSelection(registry, incoming);
      selections.push(computerId);
      return {
        computerId,
        files: r2FileSource(currentEnv.RELEASES, scope.workspacePrefix),
      };
    },
  });
  const worker = createOysterGitWorker(root);
  const fetch = (computerId) =>
    worker.fetch(
      new globalThis.Request(
        `https://aa.oyster.test/api/installations?computerId=${computerId}`,
      ),
      env,
      {},
    );
  assert.equal((await fetch("a")).status, 200);
  assert.equal((await fetch("b")).status, 200);
  assert.equal(
    authentications,
    2,
    "workspace and middleware share each request's authentication",
  );
  assert.deepEqual(selections, ["a", "b"]);
  role = "member";
  assert.equal(
    (await fetch("a")).status,
    403,
    "a cached host must not retain yesterday's owner",
  );
  assert.equal(authentications, 3);
  assert.deepEqual(reads, ["a", "b"], "non-owners never reach the fleet read");
  role = "owner";
  liveOwner = false;
  assert.equal(
    (await fetch("b")).status,
    403,
    "the fleet must still admit the current owner",
  );
  liveOwner = true;
  assert.equal(
    (await fetch("unknown")).status,
    404,
    "a refused hint never falls back to default",
  );
  assert.equal(authentications, 5);
  assert.deepEqual(selections, ["a", "b"]);
});

test("each request admits its tenant once; a removed tenant refuses the next request without a visitor fallback", async () => {
  let resolutions = 0;
  let removed = false;
  const worker = createOysterGitWorker(
    oysterGitRoot({
      tenancy: () => ({
        resolve: async () => {
          resolutions += 1;
          return removed ? null : { scope: scopeOf("aa"), auth };
        },
      }),
    }),
  );
  const env = {
    OYSTER_ORIGIN: "https://default.oyster.test",
    OYSTER_OWNER_KEY: "default-host-owner-fixture-123456789",
    RELEASES: {},
    REGISTRY: { getByName: () => ({ list: async () => [] }) },
  };
  const request = () =>
    new globalThis.Request("https://aa.oyster.test/api/installations", {
      headers: { Accept: "text/html" },
    });
  assert.equal((await worker.fetch(request(), env, {})).status, 200);
  assert.equal(resolutions, 1, "authentication consumes the top admission");
  removed = true;
  const response = await worker.fetch(request(), env, {});
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Location"), null);
  assert.equal(resolutions, 2);
});

test("named-key auth resolves only the exact configured member owner", async () => {
  const ownerId = "member-owner";
  const auth = ownerOrKeyAuth("owner-key-fixture-1234567890", ownerId, () => {
    throw new Error("resolution must not inspect bearer keys");
  });
  assert.deepEqual(await auth.resolve({ kind: "member", memberId: ownerId }), {
    actor: { kind: "member", memberId: ownerId },
    role: "owner",
  });
  for (const actor of [
    { kind: "team-key", keyId: ownerId },
    { kind: "agent", agentId: ownerId },
    { kind: "member", memberId: "another-member" },
  ])
    assert.equal(await auth.resolve(actor), null);
});

test("cached tenant host resolution refuses changed domain ownership and suspended tenants", async () => {
  let selected = "aa";
  let suspended = false;
  const member = { kind: "member", memberId: "member-owner" };
  const root = oysterGitRoot({
    tenancy: () => ({
      resolve: async () =>
        selected === null || suspended
          ? null
          : {
              scope: scopeOf(selected),
              auth: {
                resolve: async () => ({ actor: member, role: "owner" }),
                authenticate: async () => ({
                  kind: "admitted",
                  principal: { actor: member, role: "owner" },
                }),
              },
            },
    }),
  });
  const env = {
    OYSTER_ORIGIN: "https://default.oyster.test",
    OYSTER_OWNER_KEY: "default-host-owner-fixture-123456789",
    RELEASES: {},
    REGISTRY: { getByName: () => ({ list: async () => [] }) },
  };
  const response = await createOysterGitWorker(root).fetch(
    new globalThis.Request("https://aa.oyster.test/api/installations"),
    env,
    {},
  );
  assert.equal(response.status, 200);
  const cachedAuth = (await root.hostFor(env, scopeOf("aa"))).auth;
  assert.deepEqual(await cachedAuth.resolve(member), {
    actor: member,
    role: "owner",
  });
  selected = "bb";
  assert.equal(await cachedAuth.resolve(member), null);
  selected = null;
  assert.equal(await cachedAuth.resolve(member), null);
  selected = "aa";
  suspended = true;
  assert.equal(await cachedAuth.resolve(member), null);
});

test("the keys.live port rechecks the live, current owner on every read: a former owner's key, from a since reassigned tenant, is never live again", async () => {
  const keys = keysNamespace();
  const scope = scopeOf("aa");
  let currentOwnerId = "owner";
  const env = {
    OYSTER_ORIGIN: scope.origin,
    OYSTER_OWNER_KEY: "default-host-owner-fixture-123456789",
    RELEASES: {},
    REGISTRY: { getByName: () => ({ list: async () => [] }) },
    INSTANCES: { getByName: () => ({}) },
    MCP: {},
    KEYS: keys,
    WEBHOOKS: {},
  };
  const selected = {
    scope,
    auth: {
      authenticate: async () => ({
        kind: "admitted",
        principal: {
          actor: { kind: "member", memberId: currentOwnerId },
          role: "owner",
        },
      }),
      // The current, live owner -- not whatever owned the tenant when the
      // key was issued. A reassigned tenant's former owner stops resolving
      // here the moment reassignment lands, with no key-side bookkeeping.
      resolve: async (actor) =>
        actor.kind === "member" && actor.memberId === currentOwnerId
          ? { actor, role: "owner" }
          : null,
    },
  };
  const host = await oysterGitWorkerHost(env, {}, selected);
  const issued = await keys
    .getByName(scope.durableName("keys"))
    .issue("owner", {
      name: "reassign-proof",
      grants: [{ capability: "apps.use", targets: { kind: "all" } }],
    });
  assert.equal(issued.kind, "ok");
  assert.notEqual(await host.keys?.live("reassign-proof"), null);
  currentOwnerId = "new-owner-after-reassignment";
  assert.equal(
    await host.keys?.live("reassign-proof"),
    null,
    "a former owner's key, from a since reassigned tenant, is never live again",
  );
});

test("the keys.live port rechecks the live owner's role, not merely that the member still resolves: a demoted owner's key is never live again", async () => {
  const keys = keysNamespace();
  const scope = scopeOf("aa");
  // Unlike the reassignment proof above, this member id keeps resolving --
  // auth.resolve never returns null -- it is only ever demoted from
  // "owner" to "member". Dropping the oysterPrincipalIsOwner(current)
  // clause and keeping just the `current !== null` check would still
  // treat this key as live.
  let currentRole = "owner";
  const env = {
    OYSTER_ORIGIN: scope.origin,
    OYSTER_OWNER_KEY: "default-host-owner-fixture-123456789",
    RELEASES: {},
    REGISTRY: { getByName: () => ({ list: async () => [] }) },
    INSTANCES: { getByName: () => ({}) },
    MCP: {},
    KEYS: keys,
    WEBHOOKS: {},
  };
  const selected = {
    scope,
    auth: {
      authenticate: async () => ({
        kind: "admitted",
        principal: {
          actor: { kind: "member", memberId: "owner" },
          role: currentRole,
        },
      }),
      resolve: async (actor) =>
        actor.kind === "member" && actor.memberId === "owner"
          ? { actor, role: currentRole }
          : null,
    },
  };
  const host = await oysterGitWorkerHost(env, {}, selected);
  const issued = await keys
    .getByName(scope.durableName("keys"))
    .issue("owner", {
      name: "demotion-proof",
      grants: [{ capability: "apps.use", targets: { kind: "all" } }],
    });
  assert.equal(issued.kind, "ok");
  assert.notEqual(await host.keys?.live("demotion-proof"), null);
  currentRole = "member";
  assert.equal(
    await host.keys?.live("demotion-proof"),
    null,
    "a demoted owner's key is never live again, even though the member id still resolves",
  );
});
