// MODELLED: native constructors and Loader/facet execution use the maintained
// Node fixture. Instance gates, release admission, SQLite and Git adapters are real.
// This is not a workerd/celld or hosted credential-transport proof.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { URL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import {
  applyInstallationCommand,
  deriveDeclaredOperations,
} from "../dist/apps/index.js";
import { defaultTenant, tenantIdSchema } from "../dist/tenant.js";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { approvedInstallation } from "../dist/testing/index.js";
import { selectionOf } from "../dist/index.js";
import { admittedCallerFacts } from "../dist/invocation.js";
import { instanceIds, appInstanceErrorCodeSchema } from "../dist/index.js";
import { createFrameBindingWire } from "../dist/frame-binding-wire.js";
import { sha256, verifyRelease } from "../dist/release.js";
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
const { OysterGitInstance, OysterBinding, createArtifactsGit } =
  await import("../dist/workers-git.js");
const guestWire = createFrameBindingWire(appInstanceErrorCodeSchema.literals);
hooks.deregister();

async function instanceFixture(t, artifacts, installationId = "notes") {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const objects = new Map();
  const persist = async (value) => {
    const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
    const digest = await sha256(bytes);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    objects.set(artifactRef, bytes);
    return { artifactRef, digest, byteLength: bytes.length, version: digest };
  };
  const method = {
    description: "Read this installation's Git refs",
    input: { type: "object" },
    output: { type: "object" },
    effect: "read",
    requires: ["git.repository"],
  };
  const methods = { read: method, write: { ...method, effect: "write" } };
  const backend = {
    ...(await persist({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "Guest",
      code: "export class Guest {}",
    })),
    mediaType: backendMediaType,
  };
  const root = await persist(
    createAppBuild(null, backend, {
      capabilities: ["git.repository"],
      handlers: [],
      roles: [],
      api: { methods },
      backend: {
        bindings: [{ name: "GIT", operations: ["read", "write", "exchange"] }],
      },
    }),
  );
  let release = {
    appId: "app_credentials",
    releaseId: "rel_credentials",
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
  const instanceId = instanceIds.instance.generate();
  let verified = await verifyRelease(
    { get: async (ref) => objects.get(ref) ?? null },
    release,
  );
  let installed = await approvedInstallation({
    installationId,
    instanceId,
    release,
    declaration: verified.declaration,
  });
  const keys = [];
  const tenant = { tenantId: defaultTenant, origin: "https://oyster.invalid" };
  let work;
  let lastFacts;
  let env;
  const context = {
    id: { name: instanceId },
    blockConcurrencyWhile: (initialize) => initialize(),
    storage: fromNodeSqlite(database),
    exports: {
      OysterBinding: ({ props }) => {
        if (props.binding === "GIT") keys.push(props.frameId);
        return new OysterBinding({ props }, env);
      },
    },
    facets: {
      // The Guest fixture has no App storage; its copy is empty.
      clone: (source, destination) => {
        assert.equal(source, "app");
        assert.equal(destination, "candidate");
      },
      get: (_name, prepare) => {
        prepare();
        return {
          // A generated App method answers with its typed reply.
          invoke: async (_method, _args, bindings) => ({
            kind: "ok",
            value: await work(guestWire.wrap(bindings)),
          }),
          http: async () => {
            throw new Error("App method unavailable");
          },
        };
      },
      abort: () => undefined,
      delete: () => undefined,
    },
  };
  const loaded = [];
  const construction = withBackendConstruction(context.facets, {
    get: (name, configure) => {
      const configured = configure();
      loaded.push({ name, limits: configured.limits });
      assert.equal(configured.globalOutbound, null);
      assert.deepEqual(configured.env, {});
      return { getDurableObjectClass: () => configured };
    },
  });
  t.after(() => {
    assert.ok(construction.probes.length > 0);
    assert.ok(loaded.length > construction.probes.length);
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
  const instance = new OysterGitInstance(
    { ...context, facets: construction.facets },
    (env = {
      OYSTER_OWNER_KEY: "fixture-owner-key-not-a-real-secret",
      OYSTER_ORIGIN: "https://oyster.invalid",
      ...(artifacts === undefined
        ? {
            ARTIFACTS_ACCOUNT_ID: "fixture-account",
            ARTIFACTS_NAMESPACE: "fixture-namespace",
            ARTIFACTS_API_TOKEN: "fixture-api-token",
          }
        : { ARTIFACTS: artifacts }),
      REGISTRY: { getByName: () => ({ get: async () => installed }) },
      INSTANCES: {
        getByName: (id) => {
          assert.equal(id, instanceId);
          return instance;
        },
      },
      RELEASES: {
        get: async (ref) => {
          const bytes = objects.get(ref);
          return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
        },
      },
      LOADER: construction.loader,
    }),
  );
  const applied = await instance.apply(
    { ...selectionOf(installed), status: "enabled" },
    release,
    undefined,
    tenant,
  );
  assert.equal(applied.ok, true, JSON.stringify(applied));
  return {
    keys,
    change: async (command) => {
      const nextRelease =
        command.kind === "select-release" ? command.release : release;
      const nextVerified = await verifyRelease(
        { get: async (ref) => objects.get(ref) ?? null },
        nextRelease,
      );
      const outcome = applyInstallationCommand(installed, command, {
        by: { kind: "member", memberId: "fixture-owner" },
        role: "owner",
        expectedVersion: installed.authority.authorityVersion,
        declaration: nextVerified.declaration,
        declaredOperations: await deriveDeclaredOperations(
          nextRelease,
          nextVerified.declaration,
          [],
        ),
        now: Date.now(),
        identity: { installationId, instanceId },
      });
      assert.equal(Result.isFailure(outcome), false);
      installed = outcome.success.next;
      release = nextRelease;
      verified = nextVerified;
      const result = await instance.apply(
        { ...selectionOf(installed), status: installed.status },
        release,
        undefined,
        tenant,
      );
      assert.equal(result.ok, true);
    },
    nextRelease: () => ({ ...release, releaseId: "rel_credentials2" }),
    retry: (observe) => {
      work = observe;
      assert.ok(
        lastFacts,
        "the fixture must first obtain actual admitted facts",
      );
      return instance.call(lastFacts, { methods }, "read", {});
    },
    call: (observe, name = "read", tenantId = defaultTenant) => {
      work = observe;
      const facts = admittedCallerFacts(
        installed,
        verified,
        {
          actor: { kind: "member", memberId: "fixture-owner" },
          role: "owner",
          computerId: null,
        },
        [
          {
            binding: "GIT",
            operations:
              name === "read"
                ? ["read", "exchange"]
                : ["read", "write", "exchange"],
          },
        ],
      );
      lastFacts = facts;
      return instance.call(facts, { methods }, name, {}, undefined, tenantId);
    },
  };
}

function providerFixture(
  expiresAt = () => new Date(Date.now() + 600_000).toISOString(),
) {
  const minted = [];
  const revoked = [];
  const deleted = [];
  return {
    minted,
    revoked,
    deleted,
    binding: {
      delete: (name) => {
        deleted.push(name);
        return Promise.resolve(true);
      },
      get: async (name) => ({
        info: async () => ({
          id: name,
          name,
          defaultBranch: "main",
          remote: `https://fixture.artifacts.cloudflare.net/git/default/${name}.git`,
        }),
        revokeToken: (token) => {
          revoked.push(token);
          return Promise.resolve(true);
        },
        createToken: async (scope, ttl) => {
          minted.push({ name, scope, ttl });
          return {
            id: `token-${minted.length}`,
            plaintext: `fixture-token-${minted.length}`,
            expiresAt: expiresAt(),
          };
        },
      }),
    },
  };
}

test("two admitted frames reuse one mint but retain distinct frame authority", async (t) => {
  const provider = providerFixture();
  const fixture = await instanceFixture(t, provider.binding);
  t.mock.method(
    globalThis,
    "fetch",
    async () => new globalThis.Response("0000"),
  );
  let retained;
  assert.deepEqual(
    await fixture.call(async ({ GIT }) => {
      retained = GIT;
      await GIT.refs("draft");
      return {};
    }),
    { ok: true, value: { kind: "ok", value: {} } },
  );
  assert.deepEqual(
    await fixture.call(async ({ GIT }) => {
      await assert.rejects(retained.refs("draft"), { code: "revoked" });
      await GIT.refs("draft");
      return {};
    }),
    { ok: true, value: { kind: "ok", value: {} } },
  );
  assert.equal(
    new Set(fixture.keys).size,
    2,
    "each call has its own binding authority",
  );
  assert.deepEqual(provider.minted, [
    { name: "notes--draft", scope: "read", ttl: 600 },
  ]);
});

for (const [name, validity, elapsed] of [
  ["provider expiry minus thirty-second margin", 60_000, 30_000],
  ["eight-minute reuse window", 600_000, 480_000],
]) {
  test(`cross-frame reuse ends at ${name}`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const provider = providerFixture(() =>
      new Date(now + validity).toISOString(),
    );
    const fixture = await instanceFixture(t, provider.binding);
    t.mock.method(
      globalThis,
      "fetch",
      async () => new globalThis.Response("0000"),
    );
    const read = async ({ GIT }) => {
      await GIT.refs("draft");
      return {};
    };
    assert.deepEqual(await fixture.call(read), {
      ok: true,
      value: { kind: "ok", value: {} },
    });
    now += elapsed - 1;
    assert.deepEqual(await fixture.call(read), {
      ok: true,
      value: { kind: "ok", value: {} },
    });
    assert.equal(provider.minted.length, 1);
    now += 1;
    assert.deepEqual(await fixture.call(read), {
      ok: true,
      value: { kind: "ok", value: {} },
    });
    assert.deepEqual(provider.minted, [
      { name: "notes--draft", scope: "read", ttl: 600 },
      { name: "notes--draft", scope: "read", ttl: 600 },
    ]);
  });
}

test("host REST namespace recreation still reuses the installation credential", async (t) => {
  const fixture = await instanceFixture(t, undefined);
  const requests = [];
  const base =
    "/client/v4/accounts/fixture-account/artifacts/namespaces/fixture-namespace";
  t.mock.method(globalThis, "fetch", (input, init) => {
    const path = new URL(input).pathname;
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path === `${base}/tokens`) {
      assert.deepEqual(JSON.parse(init.body), {
        repo: "notes--draft",
        scope: "read",
        ttl: 600,
      });
      return Promise.resolve(
        globalThis.Response.json({
          success: true,
          errors: [],
          result: {
            id: "fixture-token-id",
            plaintext: "fixture-reused-token",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
      );
    }
    if (path === `${base}/repos/notes--draft`) {
      return Promise.resolve(
        globalThis.Response.json({
          success: true,
          errors: [],
          result: {
            id: "fixture-repo",
            name: "notes--draft",
            default_branch: "main",
            remote:
              "https://fixture.artifacts.cloudflare.net/git/default/notes--draft.git",
          },
        }),
      );
    }
    assert.equal(path, "/git/default/notes--draft.git/git-upload-pack");
    return Promise.resolve(new globalThis.Response("0000"));
  });
  for (let frame = 0; frame < 2; frame++) {
    assert.deepEqual(
      await fixture.call(async ({ GIT }) => {
        await GIT.refs("draft");
        return {};
      }),
      { ok: true, value: { kind: "ok", value: {} } },
    );
  }
  assert.deepEqual(requests, [
    `GET ${base}/repos/notes--draft`,
    `POST ${base}/tokens`,
    "POST /git/default/notes--draft.git/git-upload-pack",
    "POST /git/default/notes--draft.git/git-upload-pack",
  ]);
});

test("credential eviction bounds retention without limiting repository work", async () => {
  const provider = providerFixture();
  const git = createArtifactsGit(provider.binding, "notes--", {
    operations: ["read"],
  });
  for (let index = 0; index < 257; index++)
    await git.credential(`repo${index}`, "read");
  await git.credential("repo256", "read");
  assert.equal(
    provider.minted.length,
    257,
    "a retained credential still reuses its mint",
  );
  await git.credential("repo0", "read");
  assert.equal(
    provider.minted.length,
    258,
    "eviction remints instead of refusing work",
  );
});

test("provider expiry is required and already-expired credentials cannot be used", async () => {
  for (const expiresAt of [undefined, "invalid-date", "2000-01-01T00:00:00Z"]) {
    const provider = providerFixture(() => expiresAt);
    const git = createArtifactsGit(provider.binding, "notes--", {
      operations: ["read"],
    });
    await assert.rejects(git.credential("draft", "read"));
    assert.equal(
      provider.minted.length,
      1,
      "invalid credentials are not minted again by retries",
    );
    assert.deepEqual(provider.revoked, ["fixture-token-1"]);
  }
});

test("different installations never reuse one another's provider credential", async (t) => {
  const provider = providerFixture();
  const notes = await instanceFixture(t, provider.binding, "notes");
  const other = await instanceFixture(t, provider.binding, "other");
  t.mock.method(
    globalThis,
    "fetch",
    async () => new globalThis.Response("0000"),
  );
  const read = async ({ GIT }) => {
    await GIT.refs("draft");
    return {};
  };
  for (const fixture of [notes, other, notes, other])
    assert.deepEqual(await fixture.call(read), {
      ok: true,
      value: { kind: "ok", value: {} },
    });
  assert.deepEqual(provider.minted, [
    { name: "notes--draft", scope: "read", ttl: 600 },
    { name: "other--draft", scope: "read", ttl: 600 },
  ]);
});

const readDraft = async ({ GIT }) => {
  await GIT.refs("draft");
  return {};
};

test("a warm cache refuses revoked admission and remints after canonical re-approval", async (t) => {
  const provider = providerFixture();
  const fixture = await instanceFixture(t, provider.binding);
  let exchanges = 0;
  t.mock.method(globalThis, "fetch", () => {
    exchanges++;
    return Promise.resolve(new globalThis.Response("0000"));
  });
  assert.deepEqual(await fixture.call(readDraft), {
    ok: true,
    value: { kind: "ok", value: {} },
  });
  await fixture.change({ kind: "set-status", status: "disabled" });
  // Facts admitted before the change meet the owner state the host applied to
  // the Instance; the Instance refuses without calling back up to the registry.
  assert.deepEqual(await fixture.retry(readDraft), {
    ok: false,
    causeClass: "Error",
    code: "instance_inactive",
  });
  assert.equal(
    exchanges,
    1,
    "disabled admission stops before cached credential/provider work",
  );
  await fixture.change({ kind: "set-status", status: "enabled" });
  assert.deepEqual(await fixture.call(readDraft), {
    ok: true,
    value: { kind: "ok", value: {} },
  });
  assert.equal(
    provider.minted.length,
    2,
    "a new authority version requires a new physical token",
  );
  await fixture.change({
    kind: "select-release",
    release: fixture.nextRelease(),
    releasePin: "pinned",
  });
  assert.deepEqual(await fixture.call(readDraft), {
    ok: true,
    value: { kind: "ok", value: {} },
  });
  assert.equal(provider.minted.length, 3);
});

test("one warm Instance refuses a different tenant before cache or provider access", async (t) => {
  const provider = providerFixture();
  const fixture = await instanceFixture(t, provider.binding);
  let exchanges = 0;
  t.mock.method(globalThis, "fetch", () => {
    exchanges++;
    return Promise.resolve(new globalThis.Response("0000"));
  });
  assert.deepEqual(await fixture.call(readDraft), {
    ok: true,
    value: { kind: "ok", value: {} },
  });
  const otherTenant = Schema.decodeUnknownSync(tenantIdSchema)("other");
  assert.deepEqual(await fixture.call(readDraft, "read", otherTenant), {
    ok: false,
    causeClass: "Error",
    code: "installation_tenant_mismatch",
  });
  assert.equal(exchanges, 1);
  assert.deepEqual(await fixture.call(readDraft), {
    ok: true,
    value: { kind: "ok", value: {} },
  });
  assert.deepEqual(provider.minted, [
    { name: "notes--draft", scope: "read", ttl: 600 },
  ]);
});

test("read and write tokens remain separate across frames in the same approval", async (t) => {
  const provider = providerFixture();
  const fixture = await instanceFixture(t, provider.binding);
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new globalThis.Response("0000")),
  );
  assert.deepEqual(await fixture.call(readDraft), {
    ok: true,
    value: { kind: "ok", value: {} },
  });
  assert.deepEqual(
    await fixture.call(async ({ GIT }) => {
      await GIT.exchange("draft", {
        service: "receive-pack",
        phase: "advertise",
        headers: {},
        body: null,
      });
      return {};
    }, "write"),
    { ok: true, value: { kind: "ok", value: {} } },
  );
  assert.deepEqual(await fixture.call(readDraft), {
    ok: true,
    value: { kind: "ok", value: {} },
  });
  assert.deepEqual(provider.minted, [
    { name: "notes--draft", scope: "read", ttl: 600 },
    { name: "notes--draft", scope: "write", ttl: 600 },
  ]);
});

test("delete clears the shared credential before a later frame reads the same name", async (t) => {
  const provider = providerFixture();
  const fixture = await instanceFixture(t, provider.binding);
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new globalThis.Response("0000")),
  );
  assert.deepEqual(await fixture.call(readDraft), {
    ok: true,
    value: { kind: "ok", value: {} },
  });
  assert.deepEqual(
    await fixture.call(async ({ GIT }) => {
      await GIT.delete("draft");
      return {};
    }, "write"),
    { ok: true, value: { kind: "ok", value: {} } },
  );
  assert.deepEqual(provider.deleted, ["notes--draft"]);
  assert.deepEqual(await fixture.call(readDraft), {
    ok: true,
    value: { kind: "ok", value: {} },
  });
  assert.equal(provider.minted.length, 2);
});

for (const status of [401, 403])
  test(`provider ${status} evicts the token before the next frame`, async (t) => {
    const provider = providerFixture();
    const fixture = await instanceFixture(t, provider.binding);
    let calls = 0;
    const tokens = [];
    t.mock.method(globalThis, "fetch", (_url, init) => {
      tokens.push(init.headers.get("Authorization"));
      calls++;
      return Promise.resolve(
        new globalThis.Response("0000", { status: calls === 2 ? status : 200 }),
      );
    });
    assert.deepEqual(await fixture.call(readDraft), {
      ok: true,
      value: { kind: "ok", value: {} },
    });
    assert.deepEqual(await fixture.call(readDraft), {
      ok: false,
      causeClass: "Error",
      code: "failed",
    });
    assert.deepEqual(await fixture.call(readDraft), {
      ok: true,
      value: { kind: "ok", value: {} },
    });
    assert.equal(provider.minted.length, 2);
    assert.deepEqual(tokens, [
      "Bearer fixture-token-1",
      "Bearer fixture-token-1",
      "Bearer fixture-token-2",
    ]);
  });

test("an accepted mint finishing after frame A closes cannot overwrite frame B's token", async (t) => {
  const provider = providerFixture();
  let notify = () => undefined;
  let release = () => undefined;
  const entered = new Promise((resolve) => {
    notify = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const get = provider.binding.get;
  provider.binding.get = async (name) => {
    const repo = await get(name);
    return {
      ...repo,
      createToken: async (...args) => {
        const issued = await repo.createToken(...args);
        if (issued.plaintext === "fixture-token-1") {
          notify();
          await held;
        }
        return issued;
      },
    };
  };
  const fixture = await instanceFixture(t, provider.binding);
  const used = [];
  t.mock.method(globalThis, "fetch", (_url, init) => {
    used.push(init.headers.get("Authorization"));
    return Promise.resolve(new globalThis.Response("0000"));
  });
  let late;
  try {
    assert.deepEqual(
      await fixture.call(async ({ GIT }) => {
        // A's host RPC is already accepted and minting. The guest returns; there is
        // no waitUntil authority. Only the provider reply is held by this MODELLED test.
        late = GIT.refs("draft").then(
          () => null,
          (cause) => cause,
        );
        await entered;
        return {};
      }),
      { ok: true, value: { kind: "ok", value: {} } },
    );
    assert.deepEqual(await fixture.call(readDraft), {
      ok: true,
      value: { kind: "ok", value: {} },
    });
    release();
    assert.equal((await late).code, "revoked");
    assert.deepEqual(await fixture.call(readDraft), {
      ok: true,
      value: { kind: "ok", value: {} },
    });
    assert.equal(provider.minted.length, 2);
    assert.deepEqual(used, [
      "Bearer fixture-token-2",
      "Bearer fixture-token-2",
    ]);
  } finally {
    release();
    await late;
  }
});

test("a provider credential inside the expiry margin is revoked once without retry", async () => {
  const provider = providerFixture(() =>
    new Date(Date.now() + 20_000).toISOString(),
  );
  const git = createArtifactsGit(provider.binding, "notes--", {
    operations: ["read"],
  });
  await assert.rejects(git.credential("draft", "read"), {
    message: "Artifacts credential rejected",
  });
  assert.equal(provider.minted.length, 1);
  assert.deepEqual(provider.revoked, ["fixture-token-1"]);
});

test("failed best-effort revocation preserves only safe cause classes and never retries the mint", async () => {
  const provider = providerFixture(() => "2000-01-01T00:00:00Z");
  const get = provider.binding.get;
  provider.binding.get = async (name) => ({
    ...(await get(name)),
    revokeToken: () =>
      Promise.reject(new Error("fixture-private-provider-detail")),
  });
  const git = createArtifactsGit(provider.binding, "notes--", {
    operations: ["read"],
  });
  await assert.rejects(git.credential("draft", "read"), (cause) => {
    assert.equal(cause.message, "Artifacts credential rejected");
    assert.deepEqual(cause.cause, { rejection: "Error", cleanup: "Error" });
    return true;
  });
  assert.equal(provider.minted.length, 1);
});

test("maintained REST token decode failure performs only one mint request", async (t) => {
  const { createArtifactsRestNamespace } =
    await import("@fungi.computer/burrow");
  let mints = 0;
  t.mock.method(globalThis, "fetch", (input) => {
    const path = new URL(input).pathname;
    if (path.endsWith("/tokens")) {
      mints++;
      return Promise.resolve(
        globalThis.Response.json({
          success: true,
          errors: [],
          result: { id: "fixture-id", plaintext: "fixture-token" },
        }),
      );
    }
    assert.equal(path.endsWith("/repos/notes--draft"), true);
    return Promise.resolve(
      globalThis.Response.json({
        success: true,
        errors: [],
        result: {
          id: "fixture-repo",
          name: "notes--draft",
          default_branch: "main",
          remote:
            "https://fixture.artifacts.cloudflare.net/git/default/notes--draft.git",
        },
      }),
    );
  });
  const binding = createArtifactsRestNamespace({
    accountId: "fixture-account",
    namespace: "fixture",
    apiToken: "fixture-api-token",
  });
  const git = createArtifactsGit(binding, "notes--", { operations: ["read"] });
  await assert.rejects(git.credential("draft", "read"), {
    code: "INVALID_RESPONSE",
  });
  assert.equal(mints, 1);
});

test("an old provider refusal cannot evict the replacement credential", async (t) => {
  const provider = providerFixture();
  const git = createArtifactsGit(provider.binding, "notes--", {
    operations: ["read", "write", "exchange"],
  });
  let notify = () => undefined;
  let release = () => undefined;
  const entered = new Promise((resolve) => {
    notify = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", async () => {
    notify();
    await held;
    return new globalThis.Response("0000", { status: 401 });
  });
  const pending = git.exchange("draft", {
    service: "upload-pack",
    phase: "advertise",
    headers: {},
    body: null,
  });
  try {
    await entered;
    await git.delete("draft");
    assert.equal(
      (await git.credential("draft", "read")).token,
      "fixture-token-2",
    );
    release();
    assert.equal((await pending).status, 401);
    assert.equal(
      (await git.credential("draft", "read")).token,
      "fixture-token-2",
    );
    assert.equal(provider.minted.length, 2);
  } finally {
    release();
    await pending;
  }
});
