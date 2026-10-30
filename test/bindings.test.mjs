import { approvedInstallation } from "../dist/testing/index.js";
import { approvedBindingGrants, scopedBindings } from "../dist/apps/index.js";
import {
  appBackendBindingKinds,
  appBackendBindingOperation,
} from "@fungi.computer/puffball/app";
import { pktLine } from "@fungi.computer/agar/git-wire";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { URL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { instanceIds, appInstanceErrorCodeSchema } from "../dist/index.js";
import { createFrameBindingWire } from "../dist/frame-binding-wire.js";
import {
  admitClaimedOrigin,
  backgroundOriginKey,
  sealBackgroundOrigin,
} from "@fungi.computer/puffball/background-replay";
import { sha256 } from "../dist/release.js";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { createOyster } from "../dist/host.js";
import { admittedCallerFacts } from "../dist/invocation.js";
import { verifyRelease } from "../dist/release.js";
import * as Schema from "effect/Schema";
import { withBackendConstruction } from "./boot-construction.fixture.ts";
import { serveHost } from "../dist/authorization.js";

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
  createArtifactsGit,
  createOysterGitWorker,
  oysterGitRoot,
  ownerOrKeyTenancy,
  OysterBinding,
  OysterGitInstance,
  gitBindings,
} = await import("../dist/workers-git.js");
const { defaultTenant, tenantScope } = await import("../dist/tenant.js");
const { oysterWorkerHost } = await import("../dist/workers.js");
const { frameBindingPropsSchema, backgroundFrameMethods } =
  await import("../dist/cloudflare.js");
const guestWire = createFrameBindingWire(appInstanceErrorCodeSchema.literals);
hooks.deregister();

for (const target of [
  { kind: "object", value: {} },
  { kind: "callable", value: () => undefined },
]) {
  test(
    "the wire selects methods from an opaque RPC " +
      target.kind +
      " namespace without reflected presence",
    async () => {
      const origin = await sealBackgroundOrigin(
        await backgroundOriginKey("fixture-host-secret"),
        { instanceId: "instance", lane: "member:owner", method: "files.save" },
      );
      // A native RPC method is selectable, not a reflected field on a plain record.
      const stub = new Proxy(target.value, {
        get(_target, method) {
          if (method !== "admit") return undefined;
          return async function (input) {
            assert.equal(this, stub);
            assert.deepEqual(input, origin);
            return { kind: "result", value: { kind: "admitted" } };
          };
        },
      });
      assert.equal("admit" in stub, false);
      const bindings = guestWire.wrap({ BACKGROUND: stub });
      assert.deepEqual(await bindings.BACKGROUND.admit(origin), {
        kind: "admitted",
      });
    },
  );
}

test("a read-only Git grant refuses repository creation before contacting Artifacts", async () => {
  let calls = 0;
  const git = createArtifactsGit(
    {
      create: async (name) => {
        calls += 1;
        return {
          name,
          defaultBranch: "main",
          remote: "https://git.invalid",
          token: "fixture-initial-token",
        };
      },
    },
    "notes--",
    { operations: ["read"] },
  );
  await assert.rejects(
    git.create("draft", { description: "Draft", defaultBranch: "main" }),
    /Git operation denied: create/u,
  );
  assert.equal(calls, 0);
});

async function instanceFixture(
  t,
  providers = {},
  tenant,
  observeHostMethod,
  beforeBindingCall = () => Promise.resolve(),
) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const artifacts = new Map();
  const persist = async (value) => {
    const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
    const digest = await sha256(bytes);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    artifacts.set(artifactRef, bytes);
    return { artifactRef, digest, byteLength: bytes.length, version: digest };
  };
  const backend = {
    ...(await persist({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "Guest",
      code: "export class Guest {}",
    })),
    mediaType: backendMediaType,
  };
  const instanceId = instanceIds.instance.generate();
  const cache = new Map();
  let facet;
  let work;
  let facetReply;
  let guestFailure;
  let installed;
  let env;
  let registryReads = 0;
  const gitRoot = oysterGitRoot({ tenancy: ownerOrKeyTenancy });
  // Fixture rows observe the captured method label, then serve as production.
  const observed = Object.fromEntries(
    Object.entries(gitBindings).map(([name, row]) => [
      name,
      {
        ...row,
        dispatch: (context, frame, ...request) => {
          observeHostMethod?.(frame.host.method);
          return row.dispatch(context, frame, ...request);
        },
      },
    ]),
  );
  class FixtureInstance extends OysterGitInstance {
    bindings =
      providers.sendFromApp === undefined
        ? observed
        : {
            ...observed,
            // An Agent send row that would reach its provider once admitted.
            AGENTS: {
              methods: {
                send: {
                  decodeArgs: (raw) => raw,
                  decodeResult: (value) => value,
                  requiredOperations: () => ["send"],
                },
              },
              dispatch: (_context, _frame, props, _method, args) =>
                providers.sendFromApp(props, args),
            },
          };
    hostFor(scope) {
      return gitRoot.hostFor(this.env, scope);
    }
    async backgroundHost() {
      if (providers.noBackgroundHost) return null;
      const host = await super.backgroundHost();
      return host === null || providers.backgroundOriginKey === undefined
        ? host
        : { ...host, backgroundOriginKey: providers.backgroundOriginKey };
    }
  }
  const context = {
    id: { name: instanceId },
    blockConcurrencyWhile: (initialize) => initialize(),
    storage: fromNodeSqlite(database),
    // Every binding, Agent sends included, is the one frame-gated entrypoint.
    exports: providers.withoutBindingEntrypoint
      ? {}
      : {
          OysterBinding: ({ props }) =>
            work ? new OysterBinding({ props }, env) : { props },
        },
    facets: {
      // This binding fake has no guest storage: copying its App facet is empty.
      // Native recovery-copy tests, not this provider fake, qualify SQLite copy.
      clone: (source, destination) => {
        assert.equal(source, "app");
        assert.equal(destination, "candidate");
      },
      get: (_name, prepare) => {
        facet ??= prepare().class;
        return {
          invoke: async (name, _args, bindings) => {
            if (name === "fetch") throw new Error("App method unavailable");
            try {
              const value = work
                ? await work(guestWire.wrap(bindings))
                : bindings;
              if (name === "authorizeGitPush") return { allowed: true };
              if (name === "onGitPush") return undefined;
              // A generated App method answers with its typed reply.
              return name === "gill" ? value : { kind: "ok", value };
            } catch (cause) {
              guestFailure = cause;
              throw cause;
            }
          },
          http: async (input, bindings) => {
            if (facetReply !== undefined) return facetReply([input]);
            try {
              const value = work
                ? await work(guestWire.wrap(bindings))
                : bindings;
              return {
                status: 200,
                statusText: "OK",
                headers: [],
                body: globalThis.Response.json(value).body,
              };
            } catch (cause) {
              guestFailure = cause;
              throw cause;
            }
          },
        };
      },
      abort: () => {
        facet = undefined;
      },
      delete: () => {
        facet = undefined;
      },
    },
  };
  const construction = withBackendConstruction(context.facets, {
    get: (id, configure) => {
      if (!cache.has(id)) cache.set(id, configure());
      return { getDurableObjectClass: () => cache.get(id) };
    },
  });
  const instance = new FixtureInstance(
    { ...context, facets: construction.facets },
    (env = {
      ...providers,
      OYSTER_OWNER_KEY:
        providers.ownerKey ?? "fixture-owner-key-not-a-real-secret",
      REGISTRY: {
        getByName: () => ({
          get: async () => {
            registryReads += 1;
            return installed;
          },
        }),
      },
      INSTANCES: {
        getByName: (requestedInstanceId) => {
          assert.equal(requestedInstanceId, instanceId);
          return instance;
        },
      },
      OYSTER_ORIGIN: "https://oyster.invalid",
      // No test here issues a real named key; the fixture's own
      // backendPrincipal/backendToolPolicy override admission directly.
      KEYS: { getByName: () => ({ live: async () => null }) },
      RELEASES: {
        get: async (ref) => {
          const bytes = artifacts.get(ref);
          return bytes === undefined
            ? null
            : { arrayBuffer: async () => bytes.buffer };
        },
      },
      LOADER: construction.loader,
    }),
  );
  const dispatchBinding = instance.bindingCall.bind(instance);
  t.mock.method(instance, "bindingCall", async (...args) => {
    await beforeBindingCall(...args);
    return dispatchBinding(...args);
  });
  let version = 0;
  const run = async (bindings, observe, method, repeatSelection = false) => {
    work = observe;
    facetReply = method?.facetReply;
    guestFailure = undefined;
    if (!repeatSelection && !method?.reuseSelection) version += 1;
    const methods = {
      read: {
        description: "Fixture read",
        input: { type: "object" },
        output: { type: "object" },
        effect: method?.effect ?? "read",
        requires: method?.requires ?? [],
      },
    };
    if (method?.pairedMethods) {
      methods.write = {
        description: "Fixture write",
        input: { type: "object" },
        output: { type: "object" },
        effect: "write",
        requires: method.requires,
      };
    }
    const root = await persist(
      createAppBuild(null, backend, {
        capabilities: [
          ...new Set(
            bindings.flatMap((binding) =>
              binding.operations.flatMap(
                (name) =>
                  appBackendBindingOperation(binding.name, name)?.requires ??
                  [],
              ),
            ),
          ),
        ],
        handlers: [],
        roles: [],
        api: { methods },
        backend: { bindings },
      }),
    );
    const release = {
      appId: "app_bindings",
      releaseId: `rel_bindings${version}`,
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
    const selected = {
      instanceId,
      appId: release.appId,
      releaseId: release.releaseId,
      authorityVersion: version,
      owner: { kind: "installation", id: "notes" },
    };
    const verified = await verifyRelease(
      { get: async (ref) => artifacts.get(ref) ?? null },
      release,
    );
    if (verified.declaration === null)
      throw new Error("Fixture declaration missing");
    installed = await approvedInstallation({
      installationId: "notes",
      instanceId,
      release,
      declaration: verified.declaration,
    });
    installed = {
      ...installed,
      authority: {
        ...installed.authority,
        authorityVersion: version,
      },
    };
    const applied = await instance.apply(
      { ...selected, status: "enabled" },
      release,
      undefined,
      tenant ?? tenantScope(defaultTenant, env.OYSTER_ORIGIN),
    );
    assert.equal(applied.ok, true);
    let facts = admittedCallerFacts(
      installed,
      verified,
      {
        actor: { kind: "member", memberId: "owner" },
        computerId: null,
        role: "owner",
      },
      approvedBindingGrants(installed, verified.declaration),
    );
    if (method?.replay) {
      facts = {
        ...facts,
        grants: [
          ...facts.grants,
          { binding: "BACKGROUND", operations: ["admit"] },
        ],
        subject: {
          ...facts.subject,
          method: { name: "read", effect: "write" },
          replay: {
            lane: "member:owner",
            epoch: 1,
            admitted: method.admittedOrigins ?? ["read"],
          },
        },
      };
    }
    if (method?.backendPrincipal !== undefined) {
      const host = await gitRoot.hostFor(
        env,
        tenantScope(defaultTenant, env.OYSTER_ORIGIN),
      );
      const app = createOyster({
        ...host,
        auth: {
          authenticate: async () => ({
            kind: "admitted",
            principal: method.backendPrincipal,
          }),
        },
        appToolPolicy: () => method.backendToolPolicy ?? null,
        // A key's App access is its own Ear Tag grants, not this fixture's
        // appToolPolicy; mirror the same backendToolPolicy into one key's
        // live grants so both actor kinds exercise the same cases here.
        keys: {
          live: async (keyId) =>
            method.backendToolPolicy === undefined
              ? null
              : {
                  keyId,
                  owner: method.backendToolPolicy.grantedBy,
                  grantVersion: 1,
                  grants: [
                    {
                      capability:
                        method.backendToolPolicy.level === "write"
                          ? "apps.use"
                          : "apps.read",
                      targets: { kind: "all" },
                    },
                  ],
                },
        },
      });
      const response = await app.request("/apps/notes/backend", {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      });
      return { status: response.status, body: await response.json() };
    }
    if (method?.gill) {
      const source = method.name ?? "read";
      return instance.gill(
        method.foreignInstallation
          ? {
              ...facts,
              selection: {
                ...facts.selection,
                owner: { kind: "installation", id: "foreign" },
              },
            }
          : facts,
        { methods: { [source]: { ...methods.read, effect: "read" } } },
        source,
        { id: "fixture" },
        undefined,
        method.foreignTenant ?? tenant?.tenantId,
      );
    }
    if (method?.lifecycle !== undefined) {
      const question = {
        repository: "draft",
        writer: {
          kind: "actor",
          actor: { kind: "member", memberId: "owner" },
          role: "owner",
        },
        updates: [
          {
            ref: "refs/heads/main",
            before: "0".repeat(40),
            after: "a".repeat(40),
          },
        ],
      };
      if (method.lifecycle === "onGitPush") {
        const fact = { ...question, eventId: "push-method-label-fixture" };
        await instance.onGitPush(
          {
            ...facts,
            subject: {
              kind: "lifecycle",
              name: "onGitPush",
              eventId: fact.eventId,
            },
          },
          fact,
          undefined,
          tenant?.tenantId,
        );
        return { ok: true };
      }
      return {
        ok: true,
        value: await instance.authorizeGitPush(
          facts,
          question,
          undefined,
          tenant?.tenantId,
        ),
      };
    }
    if (method !== undefined && !method.rawBackend) {
      const name = method.name ?? "read";
      return instance.call(
        method.capturedGrants === undefined
          ? facts
          : { ...facts, grants: method.capturedGrants },
        {
          methods: {
            [name]: {
              description: "Fixture read",
              input: { type: "object" },
              output: { type: "object" },
              effect: method.presentedEffect ?? method.effect,
              requires: method.requires ?? [],
            },
          },
        },
        name,
        {},
        undefined,
        tenant?.tenantId,
      );
    }
    const response = await instance.backend(
      facts,
      method?.request ?? new globalThis.Request("https://guest.invalid/"),
      undefined,
      tenant?.tenantId,
    );
    if (guestFailure !== undefined) throw guestFailure;
    if (method?.responseOnly) return response;
    assert.equal(response.status, 200);
    return response.json();
  };
  return Object.assign(run, {
    instanceId,
    loaderIds: () => [...cache.keys()],
    liveLoaderId: `${instanceId}:${backend.digest}:1000:50`,
    probes: construction.probes,
    registryReads: () => registryReads,
    revokeFrame: () => instance.revoke("notes"),
    replaceGrants: (approvedGrants) => {
      installed = {
        ...installed,
        authority: { ...installed.authority, approvedGrants },
      };
    },
    revoke: () => {
      version += 1;
      installed = {
        ...installed,
        status: "disabled",
        authorityVersion: version,
      };
    },
  });
}

test("an RPC sent by frame A cannot borrow frame B authority when it arrives late", async (t) => {
  let providerCalls = 0;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let delay = true;
  const run = await instanceFixture(
    t,
    {
      ARTIFACTS: {
        delete: async () => {
          providerCalls += 1;
          return true;
        },
      },
    },
    undefined,
    undefined,
    async () => {
      if (delay) {
        delay = false;
        entered.resolve();
        await release.promise;
      }
    },
  );
  let outcome;
  await run([{ name: "GIT", operations: ["read"] }], async ({ GIT }) => {
    outcome = GIT.delete("draft").then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    return null;
  });
  await run([{ name: "GIT", operations: ["read", "write"] }], async () => {
    release.resolve();
    const result = await outcome;
    assert.equal(result.error?.code, "revoked");
    assert.equal(providerCalls, 0, "A never runs with B's write grant");
    return null;
  });
  assert.equal(providerCalls, 0);
});

test("an entered frame loses narrowed approval before the next provider operation", async (t) => {
  let creates = 0;
  const run = await instanceFixture(t, {
    ARTIFACTS: {
      create: async (name) => {
        creates += 1;
        return {
          name,
          defaultBranch: "main",
          remote: "https://git.invalid",
          token: "fixture-initial",
        };
      },
      get: async () => ({ revokeToken: async () => true }),
    },
  });
  await run([{ name: "GIT", operations: ["create"] }], async ({ GIT }) => {
    await GIT.create("first");
    // Keep the selection/version pinned: this exercises the approval subset check.
    run.replaceGrants([]);
    await assert.rejects(GIT.create("second"), { code: "revoked" });
    return null;
  });
  assert.equal(creates, 1);
});

test("revoking event capability approval closes an entered frame before another delivery", async (t) => {
  const deliveries = [];
  const run = await instanceFixture(t, {
    WEBHOOKS: {
      getByName: () => ({
        enqueue: async (...args) => {
          deliveries.push(args);
        },
      }),
    },
  });
  const payload = {
    type: "note.saved",
    timestamp: "2026-10-13T00:00:00.000Z",
    data: { title: "Draft" },
  };
  await run([{ name: "EVENTS", operations: ["emit"] }], async ({ EVENTS }) => {
    await EVENTS.emit("note.saved", payload, "approved");
    run.replaceGrants([]);
    await assert.rejects(EVENTS.emit("note.saved", payload, "revoked"), {
      code: "revoked",
    });
    return null;
  });
  assert.deepEqual(
    deliveries.map(([source, ...rest]) => [
      source.installationId,
      source.appId,
      ...rest,
    ]),
    [["notes", "app_bindings", payload, "approved", []]],
  );
});

test("a Release with no backend bindings receives no Git or Events authority", async (t) => {
  const run = await instanceFixture(t);
  await run([], async ({ GIT, EVENTS }) => {
    await assert.rejects(GIT.info("draft"), { code: "binding_not_granted" });
    await assert.rejects(
      EVENTS.emit(
        "note.saved",
        { type: "note.saved", timestamp: "2026-10-13T00:00:00.000Z", data: {} },
        "ungranted",
      ),
      { code: "binding_not_granted" },
    );
    return null;
  });
});

async function assertBindings(run, bindings) {
  const environment = await run(bindings);
  assert.deepEqual(
    Object.keys(environment).sort(),
    Object.keys(appBackendBindingKinds).sort(),
  );
  for (const [name, value] of Object.entries(environment)) {
    const decoded = Schema.decodeUnknownSync(frameBindingPropsSchema, {
      onExcessProperty: "error",
    })(value.props);
    assert.equal(decoded.instanceId, run.instanceId);
    assert.equal(decoded.binding, name);
    assert.notEqual(decoded.frameId, "");
    assert.equal(decoded.frameId, environment.GIT.props.frameId);
    assert.deepEqual(globalThis.structuredClone(value.props), value.props);
  }
  return environment;
}

function assertLoaderCache(run, { probes, live }) {
  assert.equal(run.probes.length, probes);
  for (const probe of run.probes) {
    assert.equal(probe.name, "candidate");
    assert.match(probe.loaderId, /^boot:/);
    assert.equal(probe.completed, true);
    assert.equal(probe.aborted, true);
    assert.equal(probe.deleted, true);
    assert.deepEqual(probe.limits, { cpuMs: 1000, subRequests: 50 });
  }
  assert.deepEqual(
    new Set(run.loaderIds()),
    new Set([
      ...run.probes.map(({ loaderId }) => loaderId),
      ...(live ? [run.liveLoaderId] : []),
    ]),
  );
}

test("declaration changes mint fresh frame stubs without retaining grants", async (t) => {
  const run = await instanceFixture(t);
  const frames = new Set();
  for (const bindings of [
    [{ name: "GIT", operations: ["read", "write"] }],
    [{ name: "GIT", operations: ["read"] }],
    [{ name: "EVENTS", operations: ["emit"] }],
    [],
  ]) {
    const env = await assertBindings(run, bindings);
    frames.add(env.GIT.props.frameId);
  }
  assert.equal(frames.size, 4);
  assertLoaderCache(run, { probes: 4, live: true });
});

test("every Git method refuses an undeclared operation before provider access", async () => {
  const git = createArtifactsGit({}, "notes--", { operations: [] });
  const calls = [
    ["fork", () => git.fork("source", "target", { description: "Fork" })],
    ["read", () => git.info("draft")],
    ["write", () => git.delete("draft")],
    ["read", () => git.log("draft", { ref: "main", limit: 1, offset: 0 })],
    ["read", () => git.readCommit("draft", "a".repeat(40))],
    ["read", () => git.readTree("draft", "a".repeat(40))],
    ["read", () => git.readBlob("draft", "a".repeat(40))],
    ["read", () => git.refs("draft")],
    [
      "exchange",
      () =>
        git.exchange("draft", {
          service: "receive-pack",
          phase: "exchange",
          headers: {},
          body: null,
        }),
    ],
    ["read", () => git.credential("draft", "read")],
    ["write", () => git.credential("draft", "write")],
  ];
  for (const [operation, call] of calls)
    await assert.rejects(Promise.resolve().then(call), {
      message: `Git operation denied: ${operation}`,
    });
});

test("Worker entrypoints enforce their declared operations and retain installation scope", async (t) => {
  const seen = [];
  const deliveries = [];
  const artifacts = {
    create: async (name) => {
      seen.push(name);
      return {
        name,
        defaultBranch: "main",
        remote: "https://git.invalid",
        token: "fixture-initial-token",
      };
    },
    get: async (name) => ({
      revokeToken: async (token) => {
        assert.equal(name, "notes--draft");
        assert.equal(token, "fixture-initial-token");
        return true;
      },
    }),
  };
  const run = await instanceFixture(t, {
    ARTIFACTS: artifacts,
    WEBHOOKS: {
      getByName: () => ({
        enqueue: async (...args) => {
          deliveries.push(args);
        },
      }),
    },
  });
  const payload = {
    type: "note.saved",
    timestamp: "2026-10-12T00:00:00.000Z",
    data: { title: "Draft" },
  };
  const result = await run(
    [{ name: "GIT", operations: ["create"] }],
    async ({ GIT }) => {
      const created = await GIT.create("draft", {
        description: "Draft",
        defaultBranch: "main",
      });
      await assert.rejects(GIT.info("draft"), { code: "binding_not_granted" });
      return created;
    },
  );
  assert.deepEqual(result, {
    name: "draft",
    defaultBranch: "main",
    lastPushAt: null,
    source: null,
  });
  assert.deepEqual(seen, ["notes--draft"]);
  await run([], async ({ EVENTS }) => {
    await assert.rejects(EVENTS.emit("note.saved", payload, "event-one"), {
      code: "binding_not_granted",
    });
    assert.deepEqual(deliveries, []);
    return null;
  });
  await run([{ name: "EVENTS", operations: ["emit"] }], async ({ EVENTS }) => {
    await EVENTS.emit("note.saved", payload, "event-one");
    return null;
  });
  assert.deepEqual(
    deliveries.map(([source, ...rest]) => [
      source.installationId,
      source.appId,
      ...rest,
    ]),
    [["notes", "app_bindings", payload, "event-one", []]],
  );
});

test("Git packets in one frame mint one token per repository and reopen admission", async (t) => {
  const minted = [];
  const fetched = [];
  let retained;
  const run = await instanceFixture(t, {
    ARTIFACTS: {
      get: async (name) => ({
        info: async () => ({
          id: name,
          name,
          defaultBranch: "main",
          remote: `https://fixture.artifacts.cloudflare.net/git/default/${name}.git`,
        }),
        createToken: async (scope) => {
          minted.push({ name, scope });
          return {
            id: `token-${minted.length}`,
            plaintext: `private-token-${minted.length}`,
            expiresAt: "2099-01-01T00:00:00Z",
          };
        },
      }),
    },
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    fetched.push(url);
    return new globalThis.Response("0000");
  });
  const bindings = [{ name: "GIT", operations: ["read", "exchange"] }];
  await run(bindings, async ({ GIT }) => {
    retained = GIT;
    await Promise.all([GIT.refs("draft"), GIT.refs("draft")]);
    await GIT.refs("other");
    run.revoke();
    await assert.rejects(GIT.refs("draft"), /revoked/u);
    assert.equal(
      fetched.length,
      3,
      "revocation refuses before provider access",
    );
    return null;
  });
  assert.deepEqual(minted, [
    { name: "notes--draft", scope: "read" },
    { name: "notes--other", scope: "read" },
  ]);
  assert.equal(fetched.length, 3, "each packet still reaches the provider");
  await assert.rejects(retained.refs("draft"), /revoked/u);
  assert.equal(fetched.length, 3, "a closed frame cannot reuse its token");
  await run(
    bindings,
    async ({ GIT }) => {
      await GIT.refs("draft");
      return null;
    },
    undefined,
    true,
  );
  assert.equal(
    minted.length,
    3,
    "re-approval opens fresh authority and requires a new physical credential",
  );
});

test("clone URLs use the installation's host door without provider credentials", async (t) => {
  const run = await instanceFixture(t, { ARTIFACTS: {} });
  await run([{ name: "GIT", operations: ["read"] }], async ({ GIT }) => {
    assert.equal(
      await GIT.cloneUrl("draft"),
      "https://oyster.invalid/git/notes/draft.git",
    );
    await assert.rejects(GIT.cloneUrl("../other"));
    await assert.rejects(GIT.cloneUrl(".."));
    return null;
  });
  await run([{ name: "GIT", operations: ["create"] }], async ({ GIT }) => {
    await assert.rejects(GIT.cloneUrl("draft"), {
      code: "binding_not_granted",
    });
    return null;
  });
});

test("a Worker resolves one workspace per request for its base host and capability adapters", async () => {
  const files = {
    list: async () => ({ path: "/", entries: [], nextOffset: null }),
    read: async () => new globalThis.TextEncoder().encode("native workspace"),
    write: async () => {
      assert.fail("reading the workspace must not write a file");
    },
    mkdir: async () => {
      assert.fail("reading the workspace must not create a directory");
    },
    replace: async () => ({ kind: "conflict" }),
  };
  const workspace = { computerId: "host-selected-computer", files };
  const env = {
    OYSTER_OWNER_KEY: "fixture-owner-key-not-a-real-secret",
    OYSTER_ORIGIN: "https://oyster.test",
    RELEASES: { get: () => assert.fail("workspace files must not read R2") },
    REGISTRY: {
      getByName: () => ({
        get: async () => null,
        storeFromOlderOyster: async () => false,
      }),
    },
  };
  const auth = {
    authenticate: async () => ({
      kind: "admitted",
      principal: {
        actor: { kind: "member", memberId: "owner" },
        role: "owner",
      },
    }),
  };
  const base = oysterWorkerHost(env, auth, { workspace });
  assert.equal(base.computerId, workspace.computerId);
  const file = await serveHost(
    base.capabilities[1].routes,
    () => auth.authenticate(),
    { liveKey: async () => null, appToolPolicy: () => null },
  ).request("/content?path=/proof.txt");
  assert.equal(await file.text(), "native workspace");
  let resolutions = 0;
  let captured;
  const worker = createOysterGitWorker(
    oysterGitRoot({
      tenancy: ownerOrKeyTenancy,
      workspace: () => {
        resolutions += 1;
        return workspace;
      },
      capabilities: (_env, selected) => {
        captured = selected;
        return [];
      },
    }),
  );
  for (let request = 0; request < 2; request += 1) {
    const response = await worker.fetch(
      new globalThis.Request("https://oyster.test/apps/missing/", {
        headers: { Authorization: `Bearer ${env.OYSTER_OWNER_KEY}` },
      }),
      env,
      {},
    );
    assert.equal(response.status, 404);
  }
  assert.equal(resolutions, 2);
  assert.equal(captured, workspace);
});

test("Instance method failures retain only their closed cause class", async (t) => {
  const run = await instanceFixture(t);
  const result = await run(
    [],
    async () => {
      throw new RangeError("private guest message must not escape");
    },
    { effect: "read", requires: [] },
  );
  assert.deepEqual(result, {
    ok: false,
    code: "failed",
    causeClass: "RangeError",
  });
});

test("a nondefault Instance's native GIT uses its retained tenant repository prefix", async (t) => {
  const { tenantIdSchema } = await import("../dist/tenant.js");
  const scope = tenantScope(
    Schema.decodeUnknownSync(tenantIdSchema)("aa"),
    "https://aa.oyster.test",
  );
  const names = [];
  const run = await instanceFixture(
    t,
    {
      ARTIFACTS: {
        create: async (name) => {
          names.push(name);
          return {
            name,
            defaultBranch: "main",
            remote: "https://git.invalid",
            token: "fixture-initial",
          };
        },
        get: async () => ({ revokeToken: async () => true }),
      },
    },
    scope,
  );
  await run([{ name: "GIT", operations: ["create"] }], async ({ GIT }) =>
    GIT.create("draft"),
  );
  assert.deepEqual(names, ["t.aa--notes--draft"]);
});

test("a nondefault Instance's native EVENTS uses its retained tenant webhook namespace", async (t) => {
  const { tenantIdSchema } = await import("../dist/tenant.js");
  const scope = tenantScope(
    Schema.decodeUnknownSync(tenantIdSchema)("aa"),
    "https://aa.oyster.test",
  );
  const names = [];
  const run = await instanceFixture(
    t,
    {
      WEBHOOKS: {
        getByName: (name) => {
          names.push(name);
          return { enqueue: async () => undefined };
        },
      },
    },
    scope,
  );
  await run([{ name: "EVENTS", operations: ["emit"] }], async ({ EVENTS }) => {
    await EVENTS.emit(
      "fixture.saved",
      { type: "fixture.saved", timestamp: "2026-10-12T00:00:00Z", data: {} },
      "event-one",
    );
    return null;
  });
  assert.deepEqual(names, ["t.aa.webhooks"]);
});
for (const { operation, presentedEffect } of [
  { operation: "delete" },
  { operation: "receive-pack" },
  { operation: "delete", presentedEffect: "write" },
]) {
  test(`a verified read method cannot use Git ${operation} before provider dispatch${presentedEffect === undefined ? "" : " despite a supplied write API"}`, async (t) => {
    let providerCalls = 0;
    const run = await instanceFixture(t, {
      ARTIFACTS: {
        delete: async () => {
          providerCalls += 1;
          return true;
        },
        get: async () => {
          providerCalls += 1;
          return {
            name: "notes--draft",
            defaultBranch: "main",
            lastPushAt: null,
            source: null,
            delete: async () => true,
            exchange: async () => ({
              status: 200,
              headers: {},
              body: new Uint8Array(),
            }),
          };
        },
      },
    });
    const result = await run(
      [{ name: "GIT", operations: ["read", "write", "exchange"] }],
      async ({ GIT }) => {
        assert.match(await GIT.cloneUrl("draft"), /draft\.git$/u);
        const call =
          operation === "delete"
            ? GIT.delete("draft")
            : GIT.exchange("draft", {
                service: "receive-pack",
                phase: "exchange",
                body: new Uint8Array(),
                headers: {},
              });
        try {
          await call;
          return { refused: false };
        } catch (cause) {
          assert.equal(cause.code, "binding_not_granted");
          return { refused: true };
        }
      },
      { effect: "read", requires: ["git.repository"], presentedEffect },
    );
    assert.equal(providerCalls, 0);
    assert.deepEqual(result, {
      ok: true,
      value: { kind: "ok", value: { refused: true } },
    });
  });
}

test("verified read then write calls retain their scopes through the reused Loader", async (t) => {
  let providerCalls = 0;
  const run = await instanceFixture(t, {
    ARTIFACTS: {
      delete: async () => {
        providerCalls += 1;
        return true;
      },
    },
  });
  const bindings = [{ name: "GIT", operations: ["read", "write", "exchange"] }];
  const observe = async ({ GIT }) => {
    try {
      await GIT.delete("draft");
      return { refused: false };
    } catch (cause) {
      assert.equal(cause.code, "binding_not_granted");
      return { refused: true };
    }
  };
  const read = await run(bindings, observe, {
    pairedMethods: true,
    effect: "read",
    requires: ["git.repository"],
  });
  assert.deepEqual(read, {
    ok: true,
    value: { kind: "ok", value: { refused: true } },
  });
  assert.equal(providerCalls, 0);
  const write = await run(bindings, observe, {
    pairedMethods: true,
    name: "write",
    reuseSelection: true,
    effect: "read",
    requires: ["git.repository"],
  });
  assert.deepEqual(write, {
    ok: true,
    value: { kind: "ok", value: { refused: false } },
  });
  assert.equal(providerCalls, 1);
  const readAgain = await run(bindings, observe, {
    pairedMethods: true,
    reuseSelection: true,
    effect: "read",
    requires: ["git.repository"],
  });
  assert.deepEqual(readAgain, {
    ok: true,
    value: { kind: "ok", value: { refused: true } },
  });
  assert.equal(providerCalls, 1);
  // The static Loader is reused while each call retains its verified method scope.
  assertLoaderCache(run, { probes: 1, live: true });
});

test("native bindings receive the verified method label only for declared calls", async (t) => {
  const methods = [];
  const run = await instanceFixture(t, { ARTIFACTS: {} }, undefined, (method) =>
    methods.push(method),
  );
  const bindings = [{ name: "GIT", operations: ["read"] }];
  const observe = async ({ GIT }) => ({ url: await GIT.cloneUrl("draft") });
  const read = await run(bindings, observe, {
    pairedMethods: true,
    effect: "read",
    presentedEffect: "write",
    requires: ["git.repository"],
  });
  assert.equal(read.ok, true);
  assert.equal(Object.isFrozen(methods[0]), true);
  assert.throws(() => {
    methods[0].name = "forged";
  }, TypeError);
  assert.deepEqual(methods.splice(0), [{ name: "read" }]);
  await run(bindings, observe, {
    pairedMethods: true,
    effect: "read",
    requires: ["git.repository"],
    reuseSelection: true,
    rawBackend: true,
  });
  assert.deepEqual(methods.splice(0), [undefined]);
  const write = await run(bindings, observe, {
    pairedMethods: true,
    name: "write",
    reuseSelection: true,
    effect: "read",
    requires: ["git.repository"],
  });
  assert.equal(write.ok, true);
  assert.deepEqual(methods.splice(0), [{ name: "write" }]);
  const gill = await run(
    bindings,
    async ({ GIT }) => {
      await GIT.cloneUrl("draft");
      return { viewId: "fixture", title: "Fixture", state: "empty", rows: [] };
    },
    { gill: true, requires: ["git.repository"] },
  );
  assert.equal(gill.ok, true);
  assert.deepEqual(methods, [{ name: "read" }]);
});

for (const lifecycle of ["onGitPush", "authorizeGitPush"]) {
  test(`${lifecycle} has no declared method label after a named call`, async (t) => {
    const methods = [];
    const run = await instanceFixture(
      t,
      { ARTIFACTS: {} },
      undefined,
      (method) => methods.push(method),
    );
    const bindings = [{ name: "GIT", operations: ["read"] }];
    const observe = async ({ GIT }) => ({ url: await GIT.cloneUrl("draft") });
    assert.equal(
      (
        await run(bindings, observe, {
          effect: "read",
          requires: ["git.repository"],
        })
      ).ok,
      true,
    );
    assert.deepEqual(methods.splice(0), [{ name: "read" }]);
    const result = await run(bindings, observe, {
      effect: "read",
      requires: ["git.repository"],
      reuseSelection: true,
      lifecycle,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(methods, [undefined]);
  });
}

for (const name of ["__proto__", "constructor", "READ", "re%61d"]) {
  test(`the unverified method ${name} never dispatches or labels the next raw call`, async (t) => {
    const methods = [];
    let entries = 0;
    const run = await instanceFixture(
      t,
      { ARTIFACTS: {} },
      undefined,
      (method) => methods.push(method),
    );
    const bindings = [{ name: "GIT", operations: ["read"] }];
    const observe = async ({ GIT }) => {
      entries += 1;
      return { url: await GIT.cloneUrl("draft") };
    };
    const refused = await run(bindings, observe, {
      name,
      effect: "read",
      requires: ["git.repository"],
    });
    assert.deepEqual(refused, {
      ok: false,
      code: "invalid_invocation_facts",
      causeClass: "Error",
    });
    assert.equal(entries, 0);
    assertLoaderCache(run, { probes: 1, live: false });
    assert.deepEqual(methods, []);
    await run(bindings, observe, {
      effect: "read",
      requires: ["git.repository"],
      reuseSelection: true,
      rawBackend: true,
    });
    assert.equal(entries, 1);
    assert.deepEqual(methods, [undefined]);
  });
}

test("a read frame refuses ungranted operations through static bindings", async (t) => {
  const run = await instanceFixture(t);
  const result = await run(
    [{ name: "AGENTS", operations: ["send"] }],
    async (env) => {
      await assert.rejects(env.GIT.cloneUrl("draft"), {
        code: "binding_not_granted",
      });
      return { refused: true };
    },
    { effect: "read", requires: [] },
  );
  assert.deepEqual(result, {
    ok: true,
    value: { kind: "ok", value: { refused: true } },
  });
});

test("a caller API cannot introduce an undeclared method before invocation loading or guest entry", async (t) => {
  let guestEntries = 0;
  const run = await instanceFixture(t);
  const result = await run(
    [{ name: "GIT", operations: ["read"] }],
    async () => {
      guestEntries += 1;
      return {};
    },
    { effect: "read", requires: ["git.repository"], name: "undeclared" },
  );
  assert.deepEqual(result, {
    ok: false,
    code: "invalid_invocation_facts",
    causeClass: "Error",
  });
  assertLoaderCache(run, { probes: 1, live: false });
  assert.equal(guestEntries, 0);
});

test("a write method cannot widen the captured read-only Git grant", async (t) => {
  let providerCalls = 0;
  const run = await instanceFixture(t, {
    ARTIFACTS: {
      delete: async () => {
        providerCalls += 1;
        return true;
      },
    },
  });
  const result = await run(
    [{ name: "GIT", operations: ["read", "write", "exchange"] }],
    async ({ GIT }) => {
      await assert.rejects(GIT.delete("draft"), {
        code: "binding_not_granted",
      });
      return {};
    },
    {
      effect: "write",
      requires: ["git.repository"],
      capturedGrants: [{ binding: "GIT", operations: ["read"] }],
    },
  );
  assert.deepEqual(result, { ok: true, value: { kind: "ok", value: {} } });
  assert.equal(providerCalls, 0);
});

test("the shared method scope refuses an unknown operation with the closed facts error", () => {
  assert.throws(
    () =>
      scopedBindings([{ binding: "GIT", operations: ["unknown"] }], {
        description: "Verified method",
        input: { type: "object" },
        output: { type: "object" },
        effect: "read",
        requires: ["git.repository"],
      }),
    { code: "invalid_invocation_facts" },
  );
});

async function rawBackendFixture(t) {
  const effects = { guestEntries: 0, pushes: 0, emissions: 0 };
  const run = await instanceFixture(t, {
    ARTIFACTS: {
      get: async (name) => ({
        info: async () => ({
          id: name,
          name,
          defaultBranch: "main",
          remote: `https://fixture.artifacts.cloudflare.net/git/default/${name}.git`,
        }),
        createToken: async () => ({
          id: "fixture-token",
          plaintext: "fixture-private-token",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      }),
    },
    WEBHOOKS: {
      getByName: () => ({
        enqueue: async () => {
          effects.emissions += 1;
        },
      }),
    },
  });
  t.mock.method(globalThis, "fetch", async () => {
    effects.pushes += 1;
    return new globalThis.Response("0000");
  });
  return {
    effects,
    call: (backendPrincipal, backendToolPolicy) =>
      run(
        [
          { name: "GIT", operations: ["read", "write", "exchange"] },
          { name: "EVENTS", operations: ["emit"] },
        ],
        async ({ GIT, EVENTS }) => {
          effects.guestEntries += 1;
          await EVENTS.emit(
            "note.saved",
            {
              type: "note.saved",
              timestamp: "2026-10-13T00:00:00.000Z",
              data: {},
            },
            "event-one",
          );
          await GIT.exchange("draft", {
            service: "receive-pack",
            phase: "exchange",
            body: new globalThis.TextEncoder().encode(
              pktLine(
                `${"a".repeat(40)} ${"0".repeat(40)} refs/heads/draft\0report-status\n`,
              ) + "0000",
            ),
            headers: {},
          });
          return { changed: true };
        },
        { backendPrincipal, backendToolPolicy },
      ),
  };
}

for (const principal of [
  { actor: { kind: "team-key", keyId: "no-policy-key" } },
  { actor: { kind: "agent", agentId: "no-policy-agent" } },
]) {
  test(`an unapproved ${principal.actor.kind} cannot emit or push through the raw HTTP backend`, async (t) => {
    const f = await rawBackendFixture(t);
    const response = await f.call(principal);
    assert.deepEqual(
      { response, ...f.effects },
      {
        response: { status: 403, body: { error: "not_approved" } },
        guestEntries: 0,
        emissions: 0,
        pushes: 0,
      },
    );
  });
}

test("opaque backend requests require a write policy while human and approved write calls retain their grants", async (t) => {
  const f = await rawBackendFixture(t);
  assert.deepEqual(
    await f.call({
      actor: { kind: "member", memberId: "owner" },
      role: "owner",
    }),
    {
      status: 200,
      body: { changed: true },
    },
  );
  assert.deepEqual(f.effects, { guestEntries: 1, emissions: 1, pushes: 1 });
  const key = { actor: { kind: "team-key", keyId: "approved-key" } };
  assert.deepEqual(
    await f.call(key, {
      level: "read",
      revision: "read-one",
      grantedBy: "fixture-owner",
    }),
    {
      status: 403,
      body: { error: "level_too_low" },
    },
  );
  assert.deepEqual(f.effects, { guestEntries: 1, emissions: 1, pushes: 1 });
  assert.deepEqual(
    await f.call(key, {
      level: "write",
      revision: "write-one",
      grantedBy: "fixture-owner",
    }),
    { status: 200, body: { changed: true } },
  );
  assert.deepEqual(f.effects, { guestEntries: 2, emissions: 2, pushes: 2 });
});

test("Gill uses the Instance verified API and refuses a caller-only source", async (t) => {
  let entries = 0;
  const run = await instanceFixture(t);
  const reply = await run(
    [],
    async () => {
      entries += 1;
      return { viewId: "fixture", title: "Fixture", state: "empty", rows: [] };
    },
    { gill: true, name: "undeclared" },
  );
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "invalid_invocation_facts");
  assert.equal(entries, 0);
  assertLoaderCache(run, { probes: 1, live: false });
});

test("Gill scopes captured grants to its verified read source and pins the method", async (t) => {
  let providerCalls = 0;
  const run = await instanceFixture(t, {
    ARTIFACTS: {
      get: async () => {
        providerCalls += 1;
        throw new Error("Provider must not be reached");
      },
    },
  });
  const reply = await run(
    [{ name: "GIT", operations: ["read"] }],
    async ({ GIT }) => {
      await assert.rejects(GIT.info("draft"), { code: "binding_not_granted" });
      return { viewId: "fixture", title: "Fixture", state: "empty", rows: [] };
    },
    { gill: true, requires: [] },
  );
  assert.equal(reply.ok, true);
  assert.equal(providerCalls, 0);
});

test("Gill refuses a foreign tenant or installation before guest entry", async (t) => {
  for (const selection of [
    { foreignTenant: "foreign" },
    { foreignInstallation: true },
  ]) {
    const run = await instanceFixture(t);
    let entries = 0;
    const reply = await run(
      [],
      async () => {
        entries += 1;
        return {
          viewId: "fixture",
          title: "Fixture",
          state: "empty",
          rows: [],
        };
      },
      { gill: true, ...selection },
    );
    assert.equal(reply.ok, false);
    assert.equal(
      reply.code,
      selection.foreignTenant
        ? "installation_tenant_mismatch"
        : "instance_identity_mismatch",
    );
    assert.equal(entries, 0);
    assertLoaderCache(run, { probes: 1, live: false });
  }
});

test("Gill Git reads cannot reach another installation's physical repository", async (t) => {
  const names = [];
  const run = await instanceFixture(t, {
    ARTIFACTS: {
      get: async (name) => {
        names.push(name);
        if (name !== "notes--draft")
          throw Object.assign(new Error("Repository absent"), {
            code: "NOT_FOUND",
          });
        return {
          info: async () => ({
            id: name,
            name,
            defaultBranch: "main",
            remote:
              "https://fixture.artifacts.cloudflare.net/git/default/notes--draft.git",
          }),
        };
      },
    },
  });
  const reply = await run(
    [{ name: "GIT", operations: ["read"] }],
    async ({ GIT }) => {
      const own = await GIT.info("draft");
      assert.equal(own.name, "draft");
      assert.equal(await GIT.info("foreign--private"), null);
      return { viewId: "fixture", title: "Fixture", state: "empty", rows: [] };
    },
    { gill: true, requires: ["git.repository"] },
  );
  assert.equal(reply.ok, true);
  assert.deepEqual(names, ["notes--draft", "notes--foreign--private"]);
  assert.equal(names.includes("foreign--private"), false);
});
for (const malformed of [
  { name: "missing", fields: {} },
  { name: "empty", fields: { frameId: "" } },
  {
    name: "foreign family",
    fields: { frameId: "instance_7rid3mf288uvsdldxmu5l" },
  },
  {
    name: "extra field",
    fields: { frameId: "app_frame_7rid3mf288uvsdldxmu5l", authority: "write" },
  },
]) {
  test(`a ${malformed.name} frame identity is refused before Instance dispatch`, async () => {
    let dispatches = 0;
    const binding = new OysterBinding(
      {
        props: {
          instanceId: instanceIds.instance.generate(),
          binding: "GIT",
          ...malformed.fields,
        },
      },
      {
        INSTANCES: {
          getByName: () => {
            dispatches += 1;
            return { bindingCall: async () => "https://git.invalid/notes" };
          },
        },
      },
    );
    assert.deepEqual(await binding.cloneUrl("notes"), {
      kind: "local_refusal",
      code: "revoked",
    });
    assert.equal(dispatches, 0);
  });
}

test("the Loader facade calls only the App's own class chain, never platform members", async () => {
  const { facetInvocationModule, facetFrameBindingModule } =
    await import("../dist/facet-invocation.js");
  const backendSource = `
    import { DurableObject } from "cloudflare:workers";
    class Parent extends DurableObject { inherited() { return "own parent"; } }
    export class Guest extends Parent {
      declared(value) { return value; }
      fetch() { return new Response("healthy HTTP"); }
      get accessor() { throw new Error("getter executed"); }
    }
  `;
  const moduleHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers")
        return {
          url: new URL("../dist/testing/workers-runtime.js", import.meta.url)
            .href,
          shortCircuit: true,
        };
      if (specifier === "./backend.js")
        return {
          url: `data:text/javascript,${encodeURIComponent(backendSource)}`,
          shortCircuit: true,
        };
      if (specifier === "./frame-binding-wire.js")
        return {
          url: `data:text/javascript,${encodeURIComponent(facetFrameBindingModule)}`,
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
  });
  const platform = await import("../dist/testing/workers-runtime.js");
  platform.DurableObject.prototype.platformMember = () => "platform effect";
  try {
    const { AppInvocation } = await import(
      `data:text/javascript,${encodeURIComponent(facetInvocationModule("Guest"))}`
    );
    const facade = new AppInvocation({}, {});
    assert.equal(await facade.invoke("declared", ["healthy"], {}), "healthy");
    assert.equal(await facade.invoke("inherited", [], {}), "own parent");
    await assert.rejects(
      facade.invoke(
        "fetch",
        [
          {
            url: "https://guest.invalid/",
            method: "GET",
            headers: [],
            body: null,
          },
        ],
        {},
      ),
      /App method unavailable/u,
    );
    const http = await facade.http(
      {
        url: "https://guest.invalid/",
        method: "GET",
        headers: [],
        body: null,
      },
      {},
    );
    assert.equal(http.status, 200);
    assert.equal(
      await new globalThis.Response(http.body).text(),
      "healthy HTTP",
    );
    for (const method of [
      "platformMember",
      "accessor",
      "constructor",
      "toString",
    ]) {
      await assert.rejects(
        facade.invoke(method, [], {}),
        /App method unavailable/u,
      );
    }
  } finally {
    delete platform.DurableObject.prototype.platformMember;
    moduleHooks.deregister();
  }
});

test("the frame entrypoint carries a closed local refusal as data before RPC", async () => {
  let dispatches = 0;
  const binding = new OysterBinding(
    {
      props: {
        instanceId: instanceIds.instance.generate(),
        binding: "GIT",
        frameId: "",
      },
    },
    {
      INSTANCES: {
        getByName: () => {
          dispatches += 1;
        },
      },
    },
  );
  assert.deepEqual(await binding.cloneUrl("notes"), {
    kind: "local_refusal",
    code: "revoked",
  });
  assert.equal(dispatches, 0);
});

test("the guest facade distinguishes a local refusal from a domain refusal", async () => {
  const { facetInvocationModule, facetFrameBindingModule } =
    await import("../dist/facet-invocation.js");
  const backendSource = `export class Guest {
    constructor(ctx, env) { this.env = env; }
    async observe() {
      try { return { value: await this.env.BACKGROUND.admit({}) }; }
      catch (cause) { return { name: cause.name, code: cause.code }; }
    }
  }`;
  const moduleHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers")
        return {
          url: new URL("../dist/testing/workers-runtime.js", import.meta.url)
            .href,
          shortCircuit: true,
        };
      if (specifier === "./backend.js")
        return {
          url: `data:text/javascript,${encodeURIComponent(backendSource)}`,
          shortCircuit: true,
        };
      if (specifier === "./frame-binding-wire.js")
        return {
          url: `data:text/javascript,${encodeURIComponent(facetFrameBindingModule)}`,
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
  });
  try {
    const { AppInvocation } = await import(
      `data:text/javascript,${encodeURIComponent(facetInvocationModule("Guest"))}#refusal`
    );
    const facade = new AppInvocation({}, {});
    const local = globalThis.structuredClone({
      kind: "local_refusal",
      code: "revoked",
    });
    assert.deepEqual(
      await facade.invoke("observe", [], {
        BACKGROUND: { admit: () => Promise.resolve(local) },
      }),
      { name: "AppInstanceError", code: "revoked" },
    );
    const domain = globalThis.structuredClone({
      kind: "result",
      value: { kind: "refused", code: "access_changed" },
    });
    assert.deepEqual(
      await facade.invoke("observe", [], {
        BACKGROUND: { admit: () => Promise.resolve(domain) },
      }),
      { value: { kind: "refused", code: "access_changed" } },
    );
  } finally {
    moduleHooks.deregister();
  }
});

function countedBody(chunkBytes, chunkCount) {
  const counts = { chunks: 0, cancelled: 0 };
  const body = new globalThis.ReadableStream(
    {
      pull(controller) {
        if (counts.chunks === chunkCount) {
          controller.close();
          return;
        }
        counts.chunks += 1;
        controller.enqueue(new globalThis.Uint8Array(chunkBytes));
      },
      cancel() {
        counts.cancelled += 1;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, counts };
}

test("the HTTP host stops an oversized request before invoking the guest", async (t) => {
  const run = await instanceFixture(t);
  const input = countedBody(64 * 1024, 4);
  let invocations = 0;
  const response = await run([], undefined, {
    rawBackend: true,
    responseOnly: true,
    request: new globalThis.Request("https://guest.invalid/", {
      method: "PUT",
      body: input.body,
      duplex: "half",
    }),
    facetReply: () => {
      invocations += 1;
      return { status: 200, statusText: "OK", headers: [], body: null };
    },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(
    { ...input.counts, invocations },
    { chunks: 2, cancelled: 1, invocations: 0 },
  );
});

test("the HTTP host bounds and cancels a guest reply stream", async (t) => {
  const run = await instanceFixture(t);
  const output = countedBody(240 * 1024, 4);
  const response = await run([], undefined, {
    rawBackend: true,
    responseOnly: true,
    facetReply: () => ({
      status: 200,
      statusText: "OK",
      headers: [],
      body: output.body,
    }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(output.counts, { chunks: 2, cancelled: 1 });
});

test("the HTTP host admits bodies exactly at its retained byte ceilings", async (t) => {
  const run = await instanceFixture(t);
  const input = countedBody(64 * 1024, 1);
  const output = countedBody(240 * 1024, 1);
  let sentBytes = 0;
  const response = await run([], undefined, {
    rawBackend: true,
    responseOnly: true,
    request: new globalThis.Request("https://guest.invalid/", {
      method: "PUT",
      body: input.body,
      duplex: "half",
    }),
    facetReply: ([request]) => {
      sentBytes = request.body.byteLength;
      return { status: 200, statusText: "OK", headers: [], body: output.body };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(sentBytes, 64 * 1024);
  assert.equal((await response.arrayBuffer()).byteLength, 240 * 1024);
  assert.deepEqual(
    [input.counts, output.counts],
    [
      { chunks: 1, cancelled: 0 },
      { chunks: 1, cancelled: 0 },
    ],
  );
});

test("complete static vocabulary distinguishes ungranted and unavailable without provider effects", async (t) => {
  const run = await instanceFixture(t);
  const result = await run(
    [{ name: "MEDIA", operations: ["models"] }],
    async (bindings) => {
      assert.deepEqual(
        Object.keys(bindings).sort(),
        Object.keys(appBackendBindingKinds).sort(),
      );
      await assert.rejects(bindings.COMPUTER.ports({}), {
        code: "binding_not_granted",
      });
      await assert.rejects(bindings.MEDIA.models({}), {
        code: "binding_unavailable",
      });
      return { refused: true };
    },
    { effect: "read", requires: ["media.generation"] },
  );
  assert.deepEqual(result, {
    ok: true,
    value: { kind: "ok", value: { refused: true } },
  });
});

test("a root without its binding entrypoint refuses the frame by code, promptly", async (t) => {
  let entries = 0;
  const run = await instanceFixture(t, { withoutBindingEntrypoint: true });
  const started = Date.now();
  const result = await run(
    [{ name: "GIT", operations: ["read"] }],
    async () => {
      entries += 1;
      return {};
    },
    { effect: "read", requires: ["git.repository"] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "binding_unavailable");
  assert.equal(entries, 0);
  assert.ok(Date.now() - started < 5000);
});

test("the HTTP host does not retain empty chunks for reply reconstruction", async (t) => {
  const run = await instanceFixture(t);
  const empty = new Set(
    Array.from({ length: 8 }, () => new globalThis.Uint8Array()),
  );
  const chunks = [...empty, new globalThis.TextEncoder().encode("healthy")];
  let copiedEmptyChunks = 0;
  const originalSet = globalThis.Uint8Array.prototype.set;
  t.mock.method(
    globalThis.Uint8Array.prototype,
    "set",
    function (values, offset) {
      if (empty.has(values)) copiedEmptyChunks += 1;
      return originalSet.call(this, values, offset);
    },
  );
  const body = new globalThis.ReadableStream(
    {
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  const response = await run([], undefined, {
    rawBackend: true,
    responseOnly: true,
    facetReply: () => ({ status: 200, statusText: "OK", headers: [], body }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "healthy");
  assert.equal(
    copiedEmptyChunks,
    0,
    "empty chunks never reach host reconstruction",
  );
});

// MODELED codec/verifier law; no native frame or transport qualification.
test("BACKGROUND.admit refuses wrong arity without admitting a valid extra origin", async () => {
  const key = await backgroundOriginKey("fixture-only-background-key");
  const frame = {
    instanceId: "fixture-instance",
    lane: "member:fixture-member",
    admitted: ["save"],
  };
  const origin = await sealBackgroundOrigin(key, { ...frame, method: "save" });
  for (const raw of [[], [origin, origin]]) {
    const [decoded] = backgroundFrameMethods.BACKGROUND.admit.decodeArgs(raw);
    assert.deepEqual(await admitClaimedOrigin(key, frame, decoded), {
      kind: "refused",
      code: "access_changed",
    });
  }
  const [decoded] = backgroundFrameMethods.BACKGROUND.admit.decodeArgs([
    origin,
  ]);
  assert.deepEqual(await admitClaimedOrigin(key, frame, decoded), {
    kind: "admitted",
  });
});

test("replay exposes the canonical claimed-origin binding before allowing Git", async (t) => {
  const run = await instanceFixture(t, { ARTIFACTS: {} });
  const result = await run(
    [{ name: "GIT", operations: ["read"] }],
    async ({ BACKGROUND, GIT }) => {
      assert.ok(BACKGROUND);
      await assert.rejects(GIT.info("draft"), /revoked/u);
      assert.deepEqual(
        await BACKGROUND.admit({ method: "read", seal: "invalid" }),
        { kind: "refused", code: "access_changed" },
      );
      return {};
    },
    { effect: "write", requires: ["git.repository"], replay: true },
  );
  assert.equal(result.ok, true);
});

test("each replay frame verifies the claimed seal before provider reads", async (t) => {
  let providerReads = 0;
  const run = await instanceFixture(t, {
    ARTIFACTS: {
      get: async (name) => {
        providerReads += 1;
        return {
          info: async () => ({
            id: name,
            name,
            defaultBranch: "main",
            remote:
              "https://fixture.artifacts.cloudflare.net/git/default/notes--draft.git",
          }),
        };
      },
    },
  });
  const key = await backgroundOriginKey("fixture-owner-key-not-a-real-secret");
  const origin = await sealBackgroundOrigin(key, {
    instanceId: run.instanceId,
    lane: "member:owner",
    method: "read",
  });
  const replay = {
    effect: "write",
    requires: ["git.repository"],
    replay: true,
  };
  const accepted = await run(
    [{ name: "GIT", operations: ["read"] }],
    async ({ BACKGROUND, GIT }) => {
      await assert.rejects(GIT.info("draft"), /revoked/u);
      assert.equal(providerReads, 0);
      assert.deepEqual(await BACKGROUND.admit(origin), { kind: "admitted" });
      assert.equal((await GIT.info("draft")).name, "draft");
      assert.deepEqual(await BACKGROUND.admit(origin), {
        kind: "refused",
        code: "access_changed",
      });
      return {};
    },
    replay,
  );
  assert.equal(accepted.ok, true);
  assert.equal(providerReads, 1);
  const refused = await run(
    [{ name: "GIT", operations: ["read"] }],
    async ({ BACKGROUND, GIT }) => {
      await assert.rejects(GIT.info("draft"), /revoked/u);
      assert.deepEqual(await BACKGROUND.admit(origin), {
        kind: "refused",
        code: "access_changed",
      });
      await assert.rejects(GIT.info("draft"), /revoked/u);
      return {};
    },
    { ...replay, admittedOrigins: [] },
  );
  assert.equal(refused.ok, true);
  assert.equal(providerReads, 1);
});

test("replay refuses INBOX and AGENTS packets before claimed-origin admission", async (t) => {
  let sends = 0;
  const run = await instanceFixture(t, {
    sendFromApp: async () => {
      sends += 1;
      return { status: "accepted" };
    },
  });
  const result = await run(
    [
      { name: "AGENTS", operations: ["send"] },
      { name: "INBOX", operations: ["page"] },
    ],
    async ({ AGENTS, INBOX }) => {
      await assert.rejects(
        AGENTS.send({
          agentId: "agent",
          sessionId: "session",
          requestId: "send-before-admission",
          text: "before admission",
          delivery: "followUp",
        }),
        /revoked/u,
      );
      await assert.rejects(INBOX.page({}), /revoked/u);
      assert.equal(sends, 0);
      return {};
    },
    { effect: "write", requires: ["agent.send", "agent.read"], replay: true },
  );
  assert.equal(sends, 0);
  assert.equal(result.ok, true);
});

for (const config of [{ noBackgroundHost: true }, { ownerKey: "" }]) {
  test(`replay origin admission returns typed refusal for ${config.noBackgroundHost ? "unavailable tenant host" : "empty root key"}`, async (t) => {
    const run = await instanceFixture(t, {
      ...config,
      ARTIFACTS: {
        get: async () => {
          throw new Error("Provider must not be reached");
        },
      },
    });
    const origin = await sealBackgroundOrigin(
      await backgroundOriginKey("fixture-owner-key-not-a-real-secret"),
      { instanceId: run.instanceId, lane: "member:owner", method: "read" },
    );
    const result = await run(
      [{ name: "GIT", operations: ["read"] }],
      async ({ BACKGROUND, GIT }) => {
        assert.deepEqual(await BACKGROUND.admit(origin), {
          kind: "refused",
          code: "access_changed",
        });
        await assert.rejects(GIT.info("draft"), /revoked/u);
        return {};
      },
      { effect: "write", requires: ["git.repository"], replay: true },
    );
    assert.equal(result.ok, true);
  });
}

test("concurrent admits through the actual binding RPC consume one origin and block racing Git", async (t) => {
  const key = await backgroundOriginKey("fixture-owner-key-not-a-real-secret");
  const lookup = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const run = await instanceFixture(t, {
    backgroundOriginKey: () => {
      entered.resolve();
      return lookup.promise;
    },
    ARTIFACTS: {
      get: async () => {
        throw new Error("Provider must not be reached");
      },
    },
  });
  const origin = await sealBackgroundOrigin(key, {
    instanceId: run.instanceId,
    lane: "member:owner",
    method: "read",
  });
  const result = await run(
    [{ name: "GIT", operations: ["read"] }],
    async ({ BACKGROUND, GIT }) => {
      const first = BACKGROUND.admit(origin);
      const second = BACKGROUND.admit(origin);
      await entered.promise;
      await assert.rejects(GIT.info("draft"), /revoked/u);
      lookup.resolve(key);
      const decisions = await Promise.all([first, second]);
      assert.equal(
        decisions.filter((value) => value.kind === "admitted").length,
        1,
      );
      assert.equal(
        decisions.filter((value) => value.kind === "refused").length,
        1,
      );
      return {};
    },
    { effect: "write", requires: ["git.repository"], replay: true },
  );
  assert.equal(result.ok, true);
});

test("EVENTS and APPS refuse before claimed-origin admission", async (t) => {
  const run = await instanceFixture(t);
  const result = await run(
    [
      { name: "EVENTS", operations: ["emit"] },
      { name: "APPS", operations: ["catalog"] },
    ],
    async ({ EVENTS, APPS }) => {
      await assert.rejects(
        EVENTS.emit(
          "note.saved",
          {
            type: "note.saved",
            timestamp: "2026-10-13T00:00:00.000Z",
            data: {},
          },
          "before-admit",
        ),
        /revoked/u,
      );
      await assert.rejects(APPS.catalog({}), /revoked/u);
      return {};
    },
    {
      effect: "write",
      requires: ["app.events.emit", "team.workbenchHost"],
      replay: true,
    },
  );
  assert.equal(result.ok, true);
});

test("a BACKGROUND admission packet reads the registry exactly once", async (t) => {
  const run = await instanceFixture(t);
  const origin = await sealBackgroundOrigin(
    await backgroundOriginKey("fixture-owner-key-not-a-real-secret"),
    { instanceId: run.instanceId, lane: "member:owner", method: "read" },
  );
  const result = await run(
    [],
    async ({ BACKGROUND }) => {
      const before = run.registryReads();
      assert.deepEqual(await BACKGROUND.admit(origin), { kind: "admitted" });
      return { reads: run.registryReads() - before };
    },
    { effect: "write", requires: [], replay: true },
  );
  assert.equal(result.value?.value?.reads, 1);
  assert.equal(result.ok, true);
});

test("revocation during the background key lookup refuses the packet without provider effects", async (t) => {
  const lookup = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let effects = 0;
  const key = await backgroundOriginKey("fixture-owner-key-not-a-real-secret");
  const run = await instanceFixture(t, {
    backgroundOriginKey: () => {
      entered.resolve();
      return lookup.promise;
    },
    ARTIFACTS: {
      get: async () => {
        effects += 1;
        throw new Error("Provider must not be reached");
      },
    },
  });
  const origin = await sealBackgroundOrigin(key, {
    instanceId: run.instanceId,
    lane: "member:owner",
    method: "read",
  });
  const pending = run(
    [{ name: "GIT", operations: ["read"] }],
    async ({ BACKGROUND, GIT }) => {
      const admission = BACKGROUND.admit(origin);
      const refusal = assert.rejects(admission, /revoked/u);
      await entered.promise;
      await run.revokeFrame();
      lookup.resolve(key);
      await refusal;
      await assert.rejects(GIT.info("draft"), /revoked/u);
      return {};
    },
    { effect: "write", requires: ["git.repository"], replay: true },
  );
  await pending;
  assert.equal(effects, 0);
});
