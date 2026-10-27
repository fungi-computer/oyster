import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Hono } from "hono";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { defaultTenant, tenantScope } from "@fungi.computer/oyster/tenant";

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
const { StandaloneTenants, standaloneTenancy } =
  await import("../../src/standalone/tenancy.ts");
const { standaloneComputerFleetRoutes } =
  await import("../../src/standalone/computer-fleet.ts");
const {
  StandaloneAgent,
  OysterRegistry: RootRegistry,
  OysterComputerEgress,
  default: standaloneWorker,
} = await import("../../src/standalone/worker.ts");
const { appsFrameMethods, dispatchAppsBuildsBinding } =
  await import("../../src/standalone/app-builds-binding.ts");
const { createInvocationGate, invocationFactsSchema } =
  await import("../../src/invocation.ts");
const { instanceIds } = await import("../../src/index.ts");
const Schema = await import("effect/Schema");
const { standaloneBuildRoutes } =
  await import("../../src/standalone/builds.ts");
const { normalizeAppPublisherRecipe } =
  await import("../../src/build-contract.ts");
const { createOysterAppBuilds } = await import("../../src/app-builds.ts");
hooks.deregister();

/** The standalone root's one composition at the default tenant, reached through a root door. */
class RootDoor extends StandaloneAgent {
  hostAt(scope) {
    return this.hostFor(scope);
  }
}
const rootHost = (env) =>
  new RootDoor({}, env).hostAt(tenantScope(defaultTenant, env.OYSTER_ORIGIN));

test("preview ingress routes the ticket's owned Computer, not the mutable selected Computer", async () => {
  const targets = [];
  const env = {
    OYSTER_ORIGIN: "https://fleet.test",
    OYSTER_PREVIEW_ORIGIN: "https://ports.test",
    OYSTER_COMPUTER_ID: "default-workspace",
    REGISTRY: {
      getByName: (name) => {
        assert.equal(name, "registry");
        return {
          ownsComputer: (id) => ["default-workspace", "A", "B"].includes(id),
        };
      },
    },
    COMPUTER: {
      getByName: (computerId) => {
        targets.push(computerId);
        return {
          portPreview: async (signature, port, request) => {
            assert.equal(signature, "a".repeat(20));
            assert.equal(port, 3000);
            assert.equal(request.url, "http://localhost/docs?q=1");
            assert.equal(request.headers.has("Authorization"), false);
            assert.equal(request.headers.has("Cookie"), false);
            return new globalThis.Response(computerId);
          },
        };
      },
    },
  };
  for (const id of ["default-workspace", "A", "B", "A"]) {
    const response = await standaloneWorker.fetch(
      new globalThis.Request(
        `https://ports.test/preview/${id}/3000/${"a".repeat(20)}/docs?q=1`,
        {
          headers: {
            Authorization: "Bearer must-not-forward",
            Cookie: "must-not-forward",
          },
        },
      ),
      env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), id);
  }
  const foreign = await standaloneWorker.fetch(
    new globalThis.Request(
      `https://ports.test/preview/foreign/3000/${"a".repeat(20)}/docs?q=1`,
    ),
    env,
    {},
  );
  assert.equal(foreign.status, 404);
  assert.deepEqual(targets, ["default-workspace", "A", "B", "A"]);
});

test("public egress reads the live Computer named by host props, never a guest's Computer hint", async (context) => {
  let enabled = true;
  const reads = [];
  const fetch = context.mock.method(
    globalThis,
    "fetch",
    async () => new globalThis.Response("package"),
  );
  const gateway = new OysterComputerEgress(
    { props: { computerObjectId: "attested-computer-object" } },
    {
      OYSTER_ORIGIN: "https://fleet.test",
      REGISTRY: { getByName: () => ({}) },
      COMPUTER: {
        idFromString: (id) => {
          assert.equal(id, "attested-computer-object");
          return id;
        },
        get: (id) => ({
          internetAccess: async () => {
            reads.push(id);
            return enabled;
          },
        }),
      },
    },
  );
  const request = () =>
    new globalThis.Request(
      "https://registry.npmjs.org/react?computerId=guest-chosen-computer",
    );
  assert.equal((await gateway.fetch(request())).status, 200);
  enabled = false;
  assert.equal((await gateway.fetch(request())).status, 403);
  assert.deepEqual(reads, [
    "attested-computer-object",
    "attested-computer-object",
  ]);
  assert.equal(fetch.mock.callCount(), 1);
});

// Exercise the named host hook used by OysterRegistry's Agent storage owner.
class RegistryProbe extends RootRegistry {
  ownerForCreator(memberId, tenantId) {
    return this.currentOwner(memberId, tenantId);
  }
}

function state(database) {
  let alarm = null;
  const storage = fromNodeSqlite(database);
  storage.sql.exec(
    "CREATE TABLE fixture_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  return {
    id: { name: "registry" },
    storage: {
      ...storage,
      getAlarm: async () => alarm,
      setAlarm: async (at) => {
        alarm = at;
      },
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
    blockConcurrencyWhile: (work) => work(),
  };
}

test("multiple Computers create list and start retain identities across standalone registry restart", async () => {
  const tenantsDatabase = new DatabaseSync(":memory:");
  const registryDatabase = new DatabaseSync(":memory:");
  const tenants = new StandaloneTenants(state(tenantsDatabase));
  const started = [];
  const internetAccess = new Map();
  const settingsCalls = [];
  const env = {
    OYSTER_ORIGIN: "https://fleet.test",
    OYSTER_OWNER_KEY: "fleet-fixture-owner-key-24-characters", //gitleaks:allow
    OYSTER_COMPUTER_ID: "default-workspace",
    OYSTER_OWNER_NAME: "owner",
    TENANTS: { getByName: () => tenants },
    COMPUTER: {
      getByName: (computerId) => ({
        internetAccess: async (enabled) => {
          settingsCalls.push({ computerId, enabled });
          if (enabled !== undefined) internetAccess.set(computerId, enabled);
          return internetAccess.get(computerId) ?? true;
        },
        initializeFleetBackings: async (backings) => {
          assert.deepEqual(backings, [{ kind: "platform-container" }]);
        },
        startHostedComputer: async (grant) => {
          assert.equal(grant.computerId, computerId);
          started.push(computerId);
          return { state: "running" };
        },
      }),
    },
  };
  try {
    const shared = await standaloneTenancy(env);
    const owner = await shared.owner();
    const registryState = state(registryDatabase);
    const registry = new RootRegistry(registryState, env);
    env.REGISTRY = { getByName: () => registry };
    const selectedInDirectory = async (query = "") => {
      const response = await standaloneWorker.fetch(
        new globalThis.Request(
          `https://fleet.test/api/workbench/directory${query}`,
          {
            headers: { Authorization: `Bearer ${env.OYSTER_OWNER_KEY}` },
          },
        ),
        env,
        {},
      );
      assert.equal(response.status, 200);
      return (await response.json()).computer.computerId;
    };
    let principal = owner;
    const routes = new Hono()
      .use("*", async (context, next) => {
        context.set("principal", principal);
        return next();
      })
      .route(
        "/",
        standaloneComputerFleetRoutes(() => registry),
      );
    const createA = {
      operation: "create",
      request: { name: "A", requestId: "A" },
    };
    const create = async (request) => {
      const response = await routes.request("/api/computers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const a = await create(createA.request);
    const b = await create({
      name: "B",
      requestId: "B",
    });
    assert.notEqual(a.computerId, b.computerId);
    const internetPath = (computerId) =>
      `/api/computers/${computerId}/internet-access`;
    const setInternetAccess = (computerId, enabled) =>
      routes.request(internetPath(computerId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    assert.deepEqual(
      await (await routes.request(internetPath(a.computerId))).json(),
      { enabled: true },
    );
    assert.deepEqual(
      await (await setInternetAccess(a.computerId, false)).json(),
      { enabled: false },
    );
    assert.deepEqual(
      await (await routes.request(internetPath(b.computerId))).json(),
      { enabled: true },
    );
    const beforeUnknown = settingsCalls.length;
    assert.equal((await setInternetAccess("foreign", false)).status, 404);
    assert.equal((await setInternetAccess(a.computerId, "false")).status, 400);
    assert.equal(settingsCalls.length, beforeUnknown);
    const choices = async (offset) => {
      const response = await routes.request(
        `/api/workbench/computers?limit=1&offset=${offset}`,
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await choices(0), {
      computers: [
        { computerId: env.OYSTER_COMPUTER_ID, name: env.OYSTER_COMPUTER_ID },
      ],
      nextOffset: 1,
    });
    const inventory = await (await routes.request("/api/computers")).json();
    assert.deepEqual(await choices(1), {
      computers: [inventory.computers[0]],
      nextOffset: 2,
    });
    assert.deepEqual(await choices(2), {
      computers: [inventory.computers[1]],
      nextOffset: null,
    });
    const reopened = new RootRegistry(registryState, env);
    assert.deepEqual(
      await reopened.computerFleet("foreign-owner", {
        operation: "resolve",
        computerId: env.OYSTER_COMPUTER_ID,
      }),
      { error: "owner_required" },
      "configured context still requires canonical owner admission",
    );
    assert.deepEqual(
      await reopened.computerFleet(owner.actor.memberId, {
        operation: "resolve",
        computerId: env.OYSTER_COMPUTER_ID,
      }),
      { computerId: env.OYSTER_COMPUTER_ID },
    );
    assert.deepEqual(
      await reopened.computerFleet(owner.actor.memberId, {
        operation: "read-internet-access",
        computerId: a.computerId,
      }),
      { enabled: false },
    );
    assert.deepEqual(
      await reopened.computerFleet("foreign-owner", {
        operation: "set-internet-access",
        computerId: a.computerId,
        enabled: true,
      }),
      { error: "owner_required" },
    );
    assert.equal(await reopened.selectedComputer(), "default-workspace");
    assert.equal(await selectedInDirectory(), "default-workspace");
    const select = async (computerId) =>
      routes.request("/api/computers/selected", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ computerId }),
      });
    assert.equal((await select(a.computerId)).status, 200);
    assert.equal(await reopened.selectedComputer(), a.computerId);
    assert.equal(await selectedInDirectory(), a.computerId);
    assert.equal((await select("foreign")).status, 404);
    assert.equal(await reopened.selectedComputer(), a.computerId);
    assert.equal((await select(b.computerId)).status, 200);
    assert.equal(await selectedInDirectory(), b.computerId);
    assert.equal(
      await selectedInDirectory(`?computerId=${a.computerId}`),
      b.computerId,
      "a window's routing hint does not replace the desktop default",
    );
    assert.equal(
      await selectedInDirectory(`?computerId=${env.OYSTER_COMPUTER_ID}`),
      b.computerId,
      "the configured build Computer is a valid window context, not a default mutation",
    );
    assert.equal(
      await reopened.selectedComputer(),
      b.computerId,
      "window choices do not change the durable default",
    );
    for (const [query, status] of [
      ["computerId=foreign", 404],
      ["computerId=", 400],
      [`computerId=${a.computerId}&computerId=${b.computerId}`, 400],
    ]) {
      const refused = await standaloneWorker.fetch(
        new globalThis.Request(
          `https://fleet.test/api/workbench/directory?${query}`,
          {
            headers: { Authorization: `Bearer ${env.OYSTER_OWNER_KEY}` },
          },
        ),
        env,
        {},
      );
      assert.equal(refused.status, status);
    }
    assert.equal(
      await new RootRegistry(registryState, env).selectedComputer(),
      b.computerId,
    );
    assert.equal(reopened.ownsComputer(a.computerId), true);
    assert.equal(reopened.ownsComputer("foreign"), false);
    assert.deepEqual(
      await reopened.computerFleet(owner.actor.memberId, createA),
      a,
    );
    const first = await reopened.computerFleet(owner.actor.memberId, {
      operation: "list",
      page: { limit: 1 },
    });
    const second = await reopened.computerFleet(owner.actor.memberId, {
      operation: "list",
      page: { limit: 1, offset: first.nextOffset },
    });
    assert.deepEqual(
      new Set(
        [...first.computers, ...second.computers].map((row) => row.computerId),
      ),
      new Set([a.computerId, b.computerId]),
    );
    for (const computerId of [a.computerId, b.computerId]) {
      assert.deepEqual(
        await reopened.computerFleet(owner.actor.memberId, {
          operation: "start",
          computerId,
        }),
        { state: "running" },
      );
    }
    assert.equal(
      await reopened.computerFleet(owner.actor.memberId, {
        operation: "start",
        computerId: "foreign",
      }),
      null,
    );
    assert.deepEqual(
      await reopened.computerFleet("foreign-owner", {
        operation: "start",
        computerId: a.computerId,
      }),
      { error: "owner_required" },
    );
    assert.deepEqual(started, [a.computerId, b.computerId]);
    const unknown = await routes.request("/api/computers/foreign/start", {
      method: "POST",
    });
    assert.equal(unknown.status, 404);
    const page = await routes.request("/api/computers?limit=1");
    assert.equal(page.status, 200);
    assert.equal((await page.json()).computers.length, 1);
    const malformed = await routes.request("/api/computers?limit=101");
    assert.equal(malformed.status, 400);
    const conflict = await routes.request("/api/computers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Changed", requestId: "A" }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "request_conflict" });
    principal = { ...owner, role: "member" };
    const beforeForbidden = settingsCalls.length;
    assert.equal((await setInternetAccess(a.computerId, true)).status, 403);
    assert.equal(
      (await routes.request(internetPath(a.computerId))).status,
      403,
    );
    assert.equal(settingsCalls.length, beforeForbidden);
    const forbidden = await routes.request(
      `/api/computers/${a.computerId}/start`,
      {
        method: "POST",
      },
    );
    assert.equal(forbidden.status, 403);
    assert.deepEqual(started, [a.computerId, b.computerId]);
  } finally {
    tenantsDatabase.close();
    registryDatabase.close();
  }
});

test("the root owner hook uses live canonical registry membership, never its configured label", async () => {
  const tenantsDatabase = new DatabaseSync(":memory:");
  const registryDatabase = new DatabaseSync(":memory:");
  const tenants = new StandaloneTenants(state(tenantsDatabase));
  const env = {
    OYSTER_ORIGIN: "https://registry-root.test",
    OYSTER_OWNER_NAME: "configured-owner",
    OYSTER_OWNER_KEY: "registry-proof-owner-key-24-characters",
    OYSTER_COMPUTER_ID: "workspace",
    TENANTS: {
      getByName: (name) => {
        assert.equal(name, "registry");
        return tenants;
      },
    },
    KEYS: { getByName: () => assert.fail("No credential lookup expected") },
  };
  try {
    const shared = await standaloneTenancy(env);
    const owner = await shared.owner();
    assert.ok(owner);
    assert.notEqual(owner.actor.memberId, env.OYSTER_OWNER_NAME);
    const registry = new RegistryProbe(state(registryDatabase), env);
    env.REGISTRY = { getByName: () => registry };
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      owner.actor.memberId,
    );
    assert.equal(
      await registry.ownerForCreator(env.OYSTER_OWNER_NAME, shared.tenantId),
      null,
    );
    assert.equal(
      await registry.ownerForCreator(
        owner.actor.memberId,
        tenantScope("other-tenant", "https://other.test").tenantId,
      ),
      null,
    );
    // Registry-owned create mints the second identity; fixture writes change
    // retained membership rows, which the real registry decodes and versions.
    const other = await tenants.create({
      handle: "other-owner",
      origin: "https://other-owner.test",
      domains: ["other-owner.test"],
      owner: { provider: "standalone-owner", subject: "second-owner" },
    });
    const otherOwner = await tenants.membershipOf(other.id, {
      provider: "standalone-owner",
      subject: "second-owner",
    });
    assert.ok(otherOwner);
    const sql = fromNodeSqlite(tenantsDatabase).sql;
    sql.exec(
      "INSERT INTO memberships (tenant_id,member_id,role) VALUES (?,?,?)",
      shared.tenantId,
      otherOwner.memberId,
      "owner",
    );
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      null,
    );
    sql.exec(
      "DELETE FROM memberships WHERE tenant_id=? AND member_id=?",
      shared.tenantId,
      otherOwner.memberId,
    );
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      owner.actor.memberId,
    );
    sql.exec(
      "UPDATE memberships SET role=? WHERE tenant_id=? AND member_id=?",
      "member",
      shared.tenantId,
      owner.actor.memberId,
    );
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      null,
    );
    sql.exec(
      "UPDATE memberships SET role=? WHERE tenant_id=? AND member_id=?",
      "owner",
      shared.tenantId,
      owner.actor.memberId,
    );
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      owner.actor.memberId,
    );
    const missing = new RegistryProbe(
      { id: { name: "registry" }, storage: fromNodeSqlite(registryDatabase) },
      { ...env, TENANTS: undefined },
    );
    await assert.rejects(
      missing.ownerForCreator(owner.actor.memberId, shared.tenantId),
    );
    const restoredOwner = await shared.owner();
    assert.ok(restoredOwner);
    const host = await rootHost(env);
    const principal = await host.auth.resolve(owner.actor);
    assert.equal(principal?.actor.memberId, owner.actor.memberId);
    assert.equal(principal?.membershipVersion, restoredOwner.membershipVersion);
    assert.equal(
      await host.auth.resolve({
        kind: "member",
        memberId: env.OYSTER_OWNER_NAME,
      }),
      null,
    );
    await tenants.setStatus(shared.tenantId, "suspended");
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      null,
    );
    assert.equal(await host.auth.resolve(owner.actor), null);
    const coldHost = await rootHost(env);
    assert.equal(await coldHost.auth.resolve(owner.actor), null);
  } finally {
    registryDatabase.close();
    tenantsDatabase.close();
  }
});

test("repository App registration reads the committed root manifest and replays without running a Computer", async (t) => {
  const { workflowGitProvider } = await import("./workflow-git.fixture.mjs");
  const { createArtifactsRestNamespace } =
    await import("@fungi.computer/burrow");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const git = promisify(execFile);
  const provider = await workflowGitProvider();
  const work = await mkdtemp(join(tmpdir(), "app-registration-"));
  const tenantsDatabase = new DatabaseSync(":memory:");
  const registryDatabase = new DatabaseSync(":memory:");
  const tenants = new StandaloneTenants(state(tenantsDatabase));
  const artifacts = createArtifactsRestNamespace({
    accountId: "workflow-proof",
    namespace: "local",
    apiToken: "local-provider",
    fetch: (input, init) => {
      const request = new globalThis.Request(input, init);
      const url = new globalThis.URL(request.url);
      return globalThis.fetch(
        new globalThis.Request(
          new globalThis.URL(url.pathname + url.search, provider.origin),
          request,
        ),
      );
    },
  });
  const env = {
    OYSTER_ORIGIN: "https://registration.test",
    OYSTER_OWNER_KEY: "registration-fixture-owner-key-24-characters",
    OYSTER_COMPUTER_ID: "default-workspace",
    OYSTER_OWNER_NAME: "owner",
    TENANTS: { getByName: () => tenants },
    ARTIFACTS: artifacts,
    RELEASES: {},
    COMPUTER: {
      idFromName: () => ({ toString: () => "a".repeat(64) }),
      getByName: () => ({
        buildBackend: async () => ({ kind: "hosted" }),
        runBuild: async () => {
          throw new Error("Registration must not run a Computer");
        },
      }),
    },
  };
  try {
    const shared = await standaloneTenancy(env);
    const owner = await shared.owner();
    const scope = tenantScope(defaultTenant, env.OYSTER_ORIGIN);
    const created = await artifacts.create(
      scope.repositoryPrefix("bonsai") + "authoring",
      {
        readOnly: false,
        setDefaultBranch: "main",
      },
    );
    await git("git", ["clone", created.remote, work]);
    await writeFile(
      join(work, "package.json"),
      JSON.stringify({
        name: "registered-app",
        fungi: {
          appId: "app_committed",
          build: {
            entry: "index.html",
            backend: null,
            maxOutputBytes: 1048576,
          },
        },
      }),
    );
    await writeFile(
      join(work, "index.html"),
      "<!doctype html><h1>Committed App</h1>",
    );
    await git("git", ["-C", work, "add", "."]);
    await git("git", [
      "-C",
      work,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "App root metadata",
    ]);
    await git("git", ["-C", work, "push", "origin", "HEAD:main"]);
    const { stdout } = await git("git", ["-C", work, "rev-parse", "HEAD"]);
    // A mutable working copy is not registration authority.
    await writeFile(
      join(work, "package.json"),
      JSON.stringify({ fungi: { appId: "app_dirty" } }),
    );
    const registry = new RootRegistry(state(registryDatabase), env);
    const input = {
      memberId: owner.actor.memberId,
      installationId: "bonsai",
      repository: "authoring",
    };
    const registered = await registry.registerRepositoryApp(input);
    assert.deepEqual(registered, {
      kind: "registered",
      appId: "app_committed",
      sourceRevision: "git:" + stdout.trim(),
    });
    assert.deepEqual(await registry.registerRepositoryApp(input), registered);
    await t.test(
      "repository source lookup is captured-owner scoped and never builds or starts a Computer",
      async () => {
        assert.deepEqual(
          await registry.repositoryBuildSource("bonsai", "authoring"),
          { appId: registered.appId },
        );
        assert.equal(
          await registry.repositoryBuildSource("another", "authoring"),
          null,
        );
        assert.equal(
          await registry.repositoryBuildSource("bonsai", "not-registered"),
          null,
        );
        assert.equal(
          registryDatabase
            .prepare("SELECT count(*) AS n FROM oyster_build_jobs")
            .get().n,
          0,
        );
      },
    );
    assert.deepEqual(
      await registry.registerRepositoryApp({
        ...input,
        memberId: "member_not_owner",
        repository: "does-not-exist",
      }),
      { kind: "unauthorized" },
    );
    await t.test(
      "APPS register decodes repo-only input and dispatches the captured installation to the registry",
      async (bindingTest) => {
        const instanceId = instanceIds.instance.generate();
        const facts = Schema.decodeUnknownSync(invocationFactsSchema)({
          instanceId,
          selection: {
            instanceId,
            owner: { kind: "installation", id: "bonsai" },
            appId: "app_bonsai",
            releaseId: "rel_example",
            authorityVersion: 1,
          },
          artifactDigest: "sha256:" + "1".repeat(64),
          subject: {
            kind: "call",
            context: { actor: owner.actor, role: "owner", computerId: null },
            method: { name: "apps.register", effect: "write" },
          },
          grants: [{ binding: "APPS", operations: ["register"] }],
          deadlineAt: Date.now() + 60_000,
          ancestry: [],
        });
        const gate = createInvocationGate({
          // This dispatcher-only frame owns neither a guest nor host resources.
          abortGuest: () => Promise.resolve(),
          close: () => Promise.resolve(),
        });
        const descriptor = appsFrameMethods.APPS.register;
        for (const rejected of [
          [{ repo: "../authoring" }],
          [{ repo: ".." }],
          [{ repo: 1 }],
          [{ repo: "authoring", appId: "app_override" }],
          [{ repo: "authoring", installationId: "another" }],
          [{ repo: "authoring", recipe: {} }],
        ])
          assert.throws(() => descriptor.decodeArgs(rejected));
        const args = descriptor.decodeArgs([{ repo: "authoring" }]);
        assert.deepEqual(descriptor.requiredOperations(args), ["register"]);
        const reply = await gate.run(facts, {}, async (frame) =>
          dispatchAppsBuildsBinding(
            {
              ...env,
              REGISTRY: {
                getByName(name) {
                  assert.equal(name, scope.durableName("registry"));
                  return registry;
                },
              },
            },
            scope,
            frame,
            { instanceId, frameId: frame.frameId, binding: "APPS" },
            "register",
            args,
            async () => {
              throw new Error("Registration must not open a host");
            },
          ),
        );
        assert.deepEqual(reply, {
          status: 200,
          body: {
            appId: registered.appId,
            sourceRevision: registered.sourceRevision,
          },
        });
        await bindingTest.test(
          "APPS repository pins backend bytes and keeps live owner/lifecycle immutable lookup",
          async () => {
            const { createAppBuild } =
              await import("@fungi.computer/puffball/app");
            const { sha256: digestOf, parseRelease } =
              await import("@fungi.computer/oyster/host");
            const { backendMediaType } =
              await import("@fungi.computer/puffball/backend");
            const blobs = new Map();
            const encode = new globalThis.TextEncoder();
            async function persist(bytes) {
              const digest = await digestOf(bytes);
              const artifactRef = "artifact:sha256-" + digest.slice(7);
              blobs.set(artifactRef, bytes);
              return {
                artifactRef,
                digest,
                byteLength: bytes.length,
                version: digest,
              };
            }
            const ui = {
              ...(await persist(
                encode.encode("<!doctype html><title>Bonsai identity</title>"),
              )),
              mediaType: "text/html; charset=utf-8",
            };
            const backend = {
              ...(await persist(
                encode.encode(
                  JSON.stringify({
                    runtime: { kind: "durable-facet", stateSchema: 1 },
                    compatibilityDate: "2026-09-04",
                    exportName: "Bonsai",
                    code: "export class Bonsai {}",
                  }),
                ),
              )),
              mediaType: backendMediaType,
            };
            const artifact = await persist(
              encode.encode(JSON.stringify(createAppBuild(ui, backend))),
            );
            assert.notEqual(backend.digest, artifact.digest);
            const release = parseRelease({
              appId: "app_bonsai",
              releaseId: "rel_bonsai",
              artifact: {
                artifactRef: artifact.artifactRef,
                artifactDigest: artifact.digest,
                provenance: {
                  sourceRevision: "git:" + "a".repeat(40),
                  sourceTreeDigest: artifact.digest,
                  buildRecipeDigest: artifact.digest,
                },
              },
            });
            let version = 1;
            const liveHost = {
              installations: {
                get: (id) => {
                  assert.equal(id, "bonsai");
                  return Promise.resolve({
                    status: "enabled",
                    instanceId,
                    authority: { authorityVersion: version },
                    release,
                  });
                },
              },
              artifacts: {
                get: (ref) => Promise.resolve(blobs.get(ref) ?? null),
              },
            };
            const lifecycle = Schema.decodeUnknownSync(invocationFactsSchema)({
              ...facts,
              selection: { ...facts.selection, releaseId: release.releaseId },
              artifactDigest: backend.digest,
              subject: {
                kind: "lifecycle",
                name: "onGitPush",
                eventId: "accepted-main-source-lookup",
              },
              grants: [{ binding: "APPS", operations: ["repository"] }],
            });
            const descriptor = appsFrameMethods.APPS.repository;
            assert.throws(() =>
              descriptor.decodeArgs([
                { repo: "authoring", installationId: "another" },
              ]),
            );
            const query = descriptor.decodeArgs([{ repo: "authoring" }]);
            assert.deepEqual(descriptor.requiredOperations(query), [
              "repository",
            ]);
            const read = (frameFacts) =>
              gate.run(frameFacts, {}, (frame) =>
                dispatchAppsBuildsBinding(
                  { ...env, REGISTRY: { getByName: () => registry } },
                  scope,
                  frame,
                  { instanceId, frameId: frame.frameId, binding: "APPS" },
                  "repository",
                  query,
                  () => Promise.resolve(liveHost),
                ),
              );
            await assert.rejects(
              () => read({ ...lifecycle, artifactDigest: artifact.digest }),
              { code: "revoked" },
            );
            assert.deepEqual(await read(lifecycle), {
              appId: registered.appId,
              installationId: "bonsai",
              callerAppId: release.appId,
              callerSourceRevision: release.artifact.provenance.sourceRevision,
            });
            assert.deepEqual(
              await read({ ...lifecycle, subject: facts.subject }),
              await read(lifecycle),
            );
            await assert.rejects(
              () =>
                read({
                  ...lifecycle,
                  subject: {
                    ...facts.subject,
                    context: { ...facts.subject.context, role: "member" },
                  },
                }),
              { code: "revoked" },
            );
            version += 1;
            await assert.rejects(() => read(lifecycle), { code: "revoked" });
            assert.equal(
              registryDatabase
                .prepare("SELECT count(*) AS n FROM oyster_build_jobs")
                .get().n,
              0,
            );
          },
        );
        // The same captured Git owner can discover an automatic job without
        // receiving or persisting its job id in Bonsai's browser state.
        const statusDescriptor = appsFrameMethods.APPS.buildStatus;
        for (const rejected of [
          [{ repo: "../authoring" }],
          [{ repo: "authoring", installationId: "another" }],
          [{ repo: "authoring", jobId: "caller-picked-job" }],
        ])
          assert.throws(() => statusDescriptor.decodeArgs(rejected));
        const query = statusDescriptor.decodeArgs([{ repo: "authoring" }]);
        assert.deepEqual(statusDescriptor.requiredOperations(query), [
          "buildStatus",
        ]);
        const statusFacts = Schema.decodeUnknownSync(invocationFactsSchema)({
          ...facts,
          subject: {
            ...facts.subject,
            method: { name: "apps.buildStatus", effect: "read" },
          },
          grants: [{ binding: "APPS", operations: ["buildStatus"] }],
        });
        const statusReply = await gate.run(statusFacts, {}, async (frame) =>
          dispatchAppsBuildsBinding(
            {
              ...env,
              REGISTRY: {
                getByName(name) {
                  assert.equal(name, scope.durableName("registry"));
                  return registry;
                },
              },
            },
            scope,
            frame,
            { instanceId, frameId: frame.frameId, binding: "APPS" },
            "buildStatus",
            query,
            async () => {
              throw new Error(
                "An empty repository status must not open a host",
              );
            },
          ),
        );
        assert.deepEqual(statusReply, { status: 200, body: null });
      },
    );
    await t.test(
      "the superseded raw build-source PUT is not a registration API",
      async () => {
        const routes = new Hono();
        routes.use("*", async (context, next) => {
          context.set("principal", { actor: owner.actor, role: "owner" });
          await next();
        });
        routes.route(
          "/",
          standaloneBuildRoutes(() => registry),
        );
        const response = await routes.request(
          "/api/apps/app_committed/build-source",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        assert.equal(response.status, 404);
      },
    );
    await t.test(
      "refuses malformed committed package metadata as an invalid App",
      async () => {
        await writeFile(
          join(work, "package.json"),
          "{malformed package metadata",
        );
        await git("git", ["-C", work, "add", "package.json"]);
        await git("git", [
          "-C",
          work,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-m",
          "Invalid App metadata",
        ]);
        await git("git", ["-C", work, "push", "origin", "HEAD:main"]);
        assert.deepEqual(await registry.registerRepositoryApp(input), {
          kind: "invalid_app",
        });
      },
    );
  } finally {
    await provider.close();
    await rm(work, { recursive: true, force: true });
    registryDatabase.close();
    tenantsDatabase.close();
  }
});

test("build route preserves a template seed refusal instead of reporting missing source", async () => {
  const tenantsDatabase = new DatabaseSync(":memory:");
  const registryDatabase = new DatabaseSync(":memory:");
  const tenants = new StandaloneTenants(state(tenantsDatabase));
  const env = {
    OYSTER_ORIGIN: "https://build-refusal.test",
    OYSTER_OWNER_KEY: "build-refusal-fixture-owner-key-24-characters",
    OYSTER_OWNER_NAME: "owner",
    OYSTER_COMPUTER_ID: "workspace",
    TENANTS: { getByName: () => tenants },
    COMPUTER: {
      idFromName: () => ({ toString: () => "build-refusal-computer" }),
      getByName: () => {
        throw new Error("A refused build must not start the Computer");
      },
    },
    RELEASES: {},
  };
  try {
    const shared = await standaloneTenancy(env);
    const owner = await shared.owner();
    assert.ok(owner);
    const registryState = state(registryDatabase);
    registryState.waitUntil = () => {
      throw new Error("A refused build must not schedule a job");
    };
    const registry = new RootRegistry(registryState, env);
    const pinned = normalizeAppPublisherRecipe({
      appId: "app_refusal",
      recipe: {
        kind: "bundled-html",
        entry: "bundle/index.html",
        assetBase: "./",
        backend: null,
        assets: {
          maxManifestBytes: 65_536,
          maxObjects: 16,
          maxObjectBytes: 65_536,
          maxTotalBytes: 131_072,
        },
        maxOutputBytes: 131_072,
      },
    });
    const builds = createOysterAppBuilds({
      owner: fromNodeSqlite(registryDatabase),
      tenantId: shared.tenantId,
      computer: {
        name: "workspace",
        objectId: "build-refusal-computer",
        port: {
          buildBackend: async () => ({ kind: "hosted" }),
          runBuild: async () => {
            throw new Error("A refused build must not run");
          },
        },
      },
      artifacts: {},
      templates: { read: async () => null },
    });
    builds.registerSource({
      appId: "app_refusal",
      location: { kind: "template" },
      recipe: pinned.recipe,
      buildRecipeDigest: pinned.buildRecipeDigest,
    });
    const routes = new Hono();
    routes.use("*", (context, next) => {
      context.set("principal", { actor: owner.actor, role: "owner" });
      return next();
    });
    routes.route(
      "/",
      standaloneBuildRoutes(() => registry),
    );
    const response = await routes.request("/api/builds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "app_refusal",
        sourceRevision: "git:" + "b".repeat(40),
      }),
    });
    assert.equal(response.status, 409);
    assert.equal(
      (await response.json()).error,
      "Revision is not a seed of this App's template",
    );
    const instanceId = instanceIds.instance.generate();
    const scope = tenantScope(defaultTenant, env.OYSTER_ORIGIN);
    const facts = Schema.decodeUnknownSync(invocationFactsSchema)({
      instanceId,
      selection: {
        instanceId,
        owner: { kind: "installation", id: "bonsai" },
        appId: "app_bonsai",
        releaseId: "rel_example",
        authorityVersion: 1,
      },
      artifactDigest: "sha256:" + "1".repeat(64),
      subject: {
        kind: "call",
        context: { actor: owner.actor, role: "owner", computerId: null },
        method: { name: "apps.build", effect: "write" },
      },
      grants: [{ binding: "APPS", operations: ["build"] }],
      deadlineAt: Date.now() + 60_000,
      ancestry: [],
    });
    const gate = createInvocationGate({
      abortGuest: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
    const reply = await gate.run(facts, {}, (frame) =>
      dispatchAppsBuildsBinding(
        { ...env, REGISTRY: { getByName: () => registry } },
        scope,
        frame,
        { instanceId, frameId: frame.frameId, binding: "APPS" },
        "build",
        [{ appId: "app_refusal", sourceRevision: "git:" + "b".repeat(40) }],
        async () => {
          throw new Error("A refused build must not open a host");
        },
      ),
    );
    assert.deepEqual(reply, {
      status: 409,
      body: {
        code: "not_template_seed",
        error: "Revision is not a seed of this App's template",
      },
    });
  } finally {
    registryDatabase.close();
    tenantsDatabase.close();
  }
});

test("a Workflow build starts its exact head once and failed builds never select a Release", async (t) => {
  const { appGitPushFactSchema } = await import("@fungi.computer/agar/git");
  const tenantsDatabase = new DatabaseSync(":memory:");
  const registryDatabase = new DatabaseSync(":memory:");
  const tenants = new StandaloneTenants(state(tenantsDatabase));
  const executions = [];
  const pending = [];
  const env = {
    OYSTER_ORIGIN: "https://accepted-push.test",
    OYSTER_OWNER_KEY: "accepted-push-fixture-owner-key-24-characters",
    OYSTER_OWNER_NAME: "owner",
    OYSTER_COMPUTER_ID: "workspace",
    TENANTS: { getByName: () => tenants },
    COMPUTER: {
      idFromName: () => ({ toString: () => "build-computer" }),
      getByName: () => ({
        buildBackend: async () => ({ kind: "hosted" }),
        runBuild: async (input) => {
          executions.push(input);
          return { output: { exitCode: 1, stderr: "Fixture build failed" } };
        },
      }),
    },
    RELEASES: {},
  };
  try {
    const shared = await standaloneTenancy(env);
    const registryState = state(registryDatabase);
    registryState.waitUntil = (work) => pending.push(work);
    const registry = new RootRegistry(registryState, env);
    const builds = createOysterAppBuilds({
      owner: fromNodeSqlite(registryDatabase),
      tenantId: shared.tenantId,
      computer: {
        name: "workspace",
        objectId: "build-computer",
        port: env.COMPUTER.getByName(),
      },
      artifacts: {},
      templates: { read: async () => null },
    });
    const pinned = normalizeAppPublisherRecipe({
      appId: "app_auto",
      recipe: {
        kind: "bundled-html",
        entry: "bundle/index.html",
        assetBase: "./",
        backend: null,
        assets: {
          maxManifestBytes: 65536,
          maxObjects: 16,
          maxObjectBytes: 65536,
          maxTotalBytes: 131072,
        },
        maxOutputBytes: 131072,
      },
    });
    builds.registerSource({
      appId: "app_auto",
      location: {
        kind: "installation",
        installationId: "bonsai",
        repository: "my-app",
      },
      recipe: pinned.recipe,
      buildRecipeDigest: pinned.buildRecipeDigest,
    });
    const fact = appGitPushFactSchema.parse({
      repository: "my-app",
      eventId: "push_auto",
      writer: {
        kind: "installation",
        installationId: "bonsai",
        onBehalfOf: { kind: "member", memberId: "owner" },
      },
      updates: [
        {
          ref: "refs/heads/main",
          before: "0".repeat(40),
          after: "a".repeat(40),
        },
      ],
    });
    // A Workflow of another installation cannot build this repository's App.
    assert.deepEqual(
      await registry.startBuild({
        appId: "app_auto",
        sourceRevision: "git:" + fact.updates[0].after,
        requestedBy: "owner",
        workflow: {
          requestId: "push_foreign",
          callerInstallationId: "other-installation",
          installationId: "my-app",
        },
      }),
      { kind: "refused", reason: "no_source" },
    );
    const started = await registry.startBuild({
      appId: "app_auto",
      sourceRevision: "git:" + fact.updates[0].after,
      requestedBy: "owner",
      workflow: {
        requestId: fact.eventId,
        callerInstallationId: "bonsai",
        installationId: "my-app",
      },
    });
    assert.equal(started.kind, "started");
    assert.equal(started.build.sourceRevision, "git:" + "a".repeat(40));
    assert.deepEqual(started.build.installation, {
      kind: "pending",
      installationId: "my-app",
    });
    await Promise.all(pending.splice(0));
    const settled = await registry.readBuild(started.build.jobId);
    assert.equal(settled.status, "failed");
    assert.equal(settled.installation.kind, "failed");
    assert.equal(await registry.get("my-app"), null);
    await t.test(
      "APPS job status hides another installation's job like an unknown job",
      async () => {
        const instanceId = instanceIds.instance.generate();
        const owner = await shared.owner();
        const scope = tenantScope(defaultTenant, env.OYSTER_ORIGIN);
        const gate = createInvocationGate({
          abortGuest: () => Promise.resolve(),
          close: () => Promise.resolve(),
        });
        const status = (installationId, jobId) => {
          const facts = Schema.decodeUnknownSync(invocationFactsSchema)({
            instanceId,
            selection: {
              instanceId,
              owner: { kind: "installation", id: installationId },
              appId: "app_bonsai",
              releaseId: "rel_example",
              authorityVersion: 1,
            },
            artifactDigest: "sha256:" + "1".repeat(64),
            subject: {
              kind: "call",
              context: { actor: owner.actor, role: "owner", computerId: null },
              method: { name: "apps.buildStatus", effect: "read" },
            },
            grants: [{ binding: "APPS", operations: ["buildStatus"] }],
            deadlineAt: Date.now() + 60_000,
            ancestry: [],
          });
          return gate.run(facts, {}, (frame) =>
            dispatchAppsBuildsBinding(
              { ...env, REGISTRY: { getByName: () => registry } },
              scope,
              frame,
              { instanceId, frameId: frame.frameId, binding: "APPS" },
              "buildStatus",
              appsFrameMethods.APPS.buildStatus.decodeArgs([{ jobId }]),
              async () => {
                throw new Error("Job status must not open a host");
              },
            ),
          );
        };
        assert.deepEqual(await status("bonsai", started.build.jobId), {
          status: 200,
          body: settled,
        });
        const unknown = await status("other-installation", "unknown-job");
        assert.deepEqual(unknown, {
          status: 404,
          body: { error: "Not found" },
        });
        assert.deepEqual(
          await status("other-installation", started.build.jobId),
          unknown,
        );
      },
    );
    const reopened = new RootRegistry(registryState, env);
    const replay = await reopened.startBuild({
      appId: "app_auto",
      sourceRevision: "git:" + fact.updates[0].after,
      requestedBy: "owner",
      workflow: {
        requestId: fact.eventId,
        callerInstallationId: "bonsai",
        installationId: "my-app",
      },
    });
    assert.equal(replay.kind, "started");
    assert.equal(replay.build.jobId, started.build.jobId);
    await Promise.all(pending.splice(0));
    assert.equal(executions.length, 1);
    assert.equal(await reopened.get("my-app"), null);
  } finally {
    registryDatabase.close();
    tenantsDatabase.close();
  }
});

for (const expected of ["installed", "needs_consent"]) {
  test(
    "only an explicit Workflow operation selects a published build as " +
      expected +
      " without self RPC",
    async () => {
      const { OysterRegistry: RootRegistry, OysterInstallationExecutor } =
        await import("../../src/standalone/worker.ts");
      const { setImmediate: nextTurn } = await import("node:timers/promises");
      const { createAppBuild } = await import("@fungi.computer/puffball/app");
      const { parseRelease, sha256 } = await import("../../src/release.ts");
      const { installOrSelect } = await import("../../src/host.ts");
      const { Buffer } = await import("node:buffer");
      const tenantsDatabase = new DatabaseSync(":memory:");
      const registryDatabase = new DatabaseSync(":memory:");
      const tenants = new StandaloneTenants(state(tenantsDatabase));
      const objects = new Map();
      let selfRpcForbidden = false;
      let registry;
      const env = {
        OYSTER_ORIGIN: "https://resume-install.test",
        OYSTER_OWNER_KEY: "resume-install-fixture-owner-key-24-characters",
        OYSTER_OWNER_NAME: "owner",
        OYSTER_COMPUTER_ID: "workspace",
        OYSTER_HOME_INSTALLATION: "home",
        TENANTS: { getByName: () => tenants },
        KEYS: { getByName: () => assert.fail("No key lookup expected") },
        REGISTRY: {
          getByName: () => {
            if (!selfRpcForbidden) return registry;
            const forbidden = () =>
              assert.fail(
                "The registry must not RPC itself to resume an installation",
              );
            return {
              selectedComputer: forbidden,
              get: forbidden,
              generation: forbidden,
              compareAndPut: forbidden,
            };
          },
        },
        COMPUTER: {
          idFromName: () => ({ toString: () => "build-computer" }),
          getByName: () => ({
            buildBackend: async () => ({ kind: "hosted" }),
            runBuild: async () =>
              assert.fail("A published build must not run again"),
          }),
        },
        RELEASES: {
          get: async (ref) => {
            const bytes = objects.get(ref);
            return bytes === undefined
              ? null
              : { arrayBuffer: async () => bytes.slice().buffer };
          },
          head: async (ref) => {
            const bytes = objects.get(ref);
            return bytes === undefined
              ? null
              : {
                  size: bytes.length,
                  checksums: {
                    sha256: Uint8Array.from(
                      Buffer.from((await sha256(bytes)).slice(7), "hex"),
                    ).buffer,
                  },
                };
          },
          put: async (ref, body) => {
            objects.set(
              ref,
              new Uint8Array(await new globalThis.Response(body).arrayBuffer()),
            );
          },
        },
      };
      try {
        const shared = await standaloneTenancy(env);
        const owner = await shared.owner();
        const registryState = state(registryDatabase);
        let alarm = null;
        registryState.storage.setAlarm = async (at) => {
          alarm = at;
        };
        registryState.storage.getAlarm = async () => alarm;
        registryState.storage.transaction = async (work) =>
          work({
            getAlarm: () => registryState.storage.getAlarm(),
            setAlarm: (at) => registryState.storage.setAlarm(at),
          });
        // The durable owner's executor is another Worker context; it reaches
        // the registry over REGISTRY. The registry itself never RPCs itself.
        const executorEnv = { ...env, REGISTRY: { getByName: () => registry } };
        registryState.exports = {
          OysterInstallationExecutor: ({ props }) =>
            new OysterInstallationExecutor({ props }, executorEnv),
        };
        const scope = { tenantId: shared.tenantId, origin: env.OYSTER_ORIGIN };
        /** Run the owner's alarm once the retained command is admitted. */
        const settle = async (requestId, running) => {
          while (
            (
              await registry.installationOperation({
                action: "load",
                scope,
                requestId,
              })
            ).command === null
          )
            await nextTurn();
          await registry.alarm();
          return running;
        };
        /** A refusal answers before the owner ever admits a command. */
        const refusedBeforeAdmission = (requestId, running) =>
          Promise.race([
            running,
            (async () => {
              while (
                (
                  await registry.installationOperation({
                    action: "load",
                    scope,
                    requestId,
                  })
                ).command === null
              )
                await nextTurn();
              return { admitted: requestId };
            })(),
          ]);
        registryState.waitUntil = () =>
          assert.fail("The stored build is already published");
        registry = new RootRegistry(registryState, env);
        const pinned = normalizeAppPublisherRecipe({
          appId: "app_auto",
          recipe: {
            kind: "bundled-html",
            entry: "bundle/index.html",
            assetBase: "./",
            backend: null,
            assets: {
              maxManifestBytes: 65536,
              maxObjects: 16,
              maxObjectBytes: 65536,
              maxTotalBytes: 131072,
            },
            maxOutputBytes: 131072,
          },
        });
        const builds = createOysterAppBuilds({
          owner: fromNodeSqlite(registryDatabase),
          tenantId: shared.tenantId,
          computer: {
            name: "workspace",
            objectId: "build-computer",
            port: env.COMPUTER.getByName(),
          },
          artifacts: {},
          templates: { read: async () => null },
        });
        builds.registerSource({
          appId: "app_auto",
          location: {
            kind: "installation",
            installationId: "bonsai",
            repository: "my-app",
          },
          recipe: pinned.recipe,
          buildRecipeDigest: pinned.buildRecipeDigest,
        });
        const sourceRevision = "git:" + "a".repeat(40);
        const { build } = await builds.start({
          appId: "app_auto",
          sourceRevision,
          requestedBy: owner.actor.memberId,
          installAt: "my-app",
        });
        const ui = new globalThis.TextEncoder().encode(
          "<!doctype html><title>Resumed App</title>",
        );
        objects.set("artifact:ui", ui);
        const releaseFor = async (releaseId, capabilities) => {
          const bytes = new globalThis.TextEncoder().encode(
            JSON.stringify(
              createAppBuild(
                {
                  artifactRef: "artifact:ui",
                  digest: await sha256(ui),
                  mediaType: "text/html; charset=utf-8",
                  byteLength: ui.length,
                  version: await sha256(ui),
                },
                null,
                { capabilities, handlers: [], roles: [] },
              ),
            ),
          );
          const ref = "artifact:" + releaseId;
          objects.set(ref, bytes);
          return parseRelease({
            appId: "app_auto",
            releaseId,
            artifact: {
              artifactRef: ref,
              artifactDigest: await sha256(bytes),
              provenance: {
                sourceRevision,
                sourceTreeDigest: "sha256:" + "b".repeat(64),
                buildRecipeDigest: pinned.buildRecipeDigest,
              },
            },
          });
        };
        const previous = await releaseFor("rel_previous", []);
        const candidate = await releaseFor(
          build.releaseId,
          expected === "needs_consent" ? ["computer.readFile"] : [],
        );
        const installed = await settle(
          "previous-install",
          installOrSelect(
            await rootHost(env),
            "my-app",
            previous,
            { actor: owner.actor, role: "owner" },
            "install-or-select",
            "owner-direct",
            "previous-install",
          ),
        );
        assert.equal(installed.status, 201, await installed.text());
        const before = registry.get("my-app");
        const unpublished = await registry.readBuild(build.jobId);
        assert.equal(unpublished.release, null);
        assert.equal(await registry.readBuild("unknown-job"), null);
        for (const jobId of [build.jobId, "unknown-job"]) {
          const refused = await registry.installWorkflowBuild(
            jobId,
            "my-app",
            candidate,
            owner.actor.memberId,
            "bonsai",
          );
          assert.equal(refused.status, 409, jobId);
          assert.deepEqual(registry.get("my-app"), before);
          assert.deepEqual(
            (await registry.readBuild(build.jobId)).installation,
            unpublished.installation,
          );
        }
        // A current-format persisted snapshot at the crash point after publication,
        // before installation. Candidate publication is exercised by app-builds.test.ts.
        const sql = fromNodeSqlite(registryDatabase).sql;
        sql.exec(
          "UPDATE oyster_build_jobs SET status='succeeded' WHERE job_id=?",
          build.jobId,
        );
        sql.exec(
          "INSERT INTO oyster_build_releases(release_id,job_id,release) VALUES(?,?,?)",
          build.releaseId,
          build.jobId,
          JSON.stringify(candidate),
        );
        registry = new RootRegistry(registryState, env);
        selfRpcForbidden = true;
        const observed = await registry.readBuild(build.jobId);
        assert.equal(observed.installation.kind, "pending");
        assert.deepEqual(
          registry.get("my-app"),
          before,
          "status reads cannot select a Release",
        );
        for (const selection of [
          {
            target: "other-app",
            release: candidate,
            reason: "wrong installation target",
          },
          {
            target: "my-app",
            release: candidate,
            caller: "other-installation",
            reason: "another installation's Workflow",
          },
          {
            target: "my-app",
            release: parseRelease({
              ...candidate,
              artifact: previous.artifact,
            }),
            reason: "different Release artifact with the same Release identity",
          },
        ]) {
          const targetBefore = registry.get(selection.target);
          const refused = await refusedBeforeAdmission(
            "workflow-build:" + build.jobId,
            registry.installWorkflowBuild(
              build.jobId,
              selection.target,
              selection.release,
              owner.actor.memberId,
              selection.caller ?? "bonsai",
            ),
          );
          assert.equal(refused.status, 409, selection.reason);
          assert.deepEqual(registry.get("my-app"), before, selection.reason);
          assert.deepEqual(
            registry.get(selection.target),
            targetBefore,
            selection.reason,
          );
          assert.deepEqual(
            (await registry.readBuild(build.jobId)).installation,
            observed.installation,
            selection.reason,
          );
        }
        // A second call while the first installer is in flight (a duplicate
        // node retry, or another build) waits; it is not a terminal refusal.
        const [, concurrent] = await settle(
          "workflow-build:" + build.jobId,
          Promise.all([
            registry.installWorkflowBuild(
              build.jobId,
              "my-app",
              candidate,
              owner.actor.memberId,
              "bonsai",
            ),
            registry.installWorkflowBuild(
              build.jobId,
              "my-app",
              candidate,
              owner.actor.memberId,
              "bonsai",
            ),
          ]),
        );
        assert.deepEqual(concurrent, { status: 202, body: { pending: true } });
        const done = await registry.readBuild(build.jobId);
        assert.deepEqual(done.installation, {
          kind: expected,
          installationId: "my-app",
        });
        assert.deepEqual(
          await registry.readRepositoryBuild("bonsai", "my-app"),
          done,
        );
        assert.equal(
          await registry.readRepositoryBuild("other-installation", "my-app"),
          null,
        );
        if (expected === "needs_consent")
          assert.deepEqual(registry.get("my-app"), before);
        else
          assert.equal(
            registry.get("my-app").release.releaseId,
            candidate.releaseId,
          );
        const terminal = registry.get("my-app");
        registry = new RootRegistry(registryState, env);
        await registry.readBuild(build.jobId);
        assert.deepEqual(
          registry.get("my-app"),
          terminal,
          "A terminal decision does not select the Release again on reopen",
        );
      } finally {
        registryDatabase.close();
        tenantsDatabase.close();
      }
    },
  );
}
