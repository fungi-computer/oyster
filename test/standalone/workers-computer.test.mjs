import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { URL } from "node:url";
import { withBackendConstruction } from "../boot-construction.fixture.ts";
import { fauxModel } from "@fungi.computer/mule/testing";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.ts";

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
const { fromNodeSqlite } = await import("@fungi.computer/watchdog/node-sqlite");
const { instanceIds, appInstanceErrorCodeSchema, selectionOf } =
  await import("@fungi.computer/oyster");
const { createFrameBindingWire } =
  await import("@fungi.computer/oyster/testing");
const bindingWire = createFrameBindingWire(appInstanceErrorCodeSchema.literals);
const { approvedInstallation } = await import("@fungi.computer/oyster/testing");
const { createAppBuild, appBackendBindingOperation } =
  await import("@fungi.computer/puffball/app");
const { applyInstallationCommand, deriveDeclaredOperations } =
  await import("@fungi.computer/oyster/apps");
const Result = await import("effect/Result");
const { bindAgentExtension, bindSessionExtension } =
  await import("@fungi.computer/shiitake/client");
const { almanacContract } =
  await import("@fungi.computer/shiitake-extensions/almanac");
const { loopContract } =
  await import("@fungi.computer/shiitake-extensions/loop");
const { backendMediaType } = await import("@fungi.computer/puffball/backend");
const {
  standaloneWorkspace,
  standaloneComputerCapabilities,
  ComputerDO,
  computerInvocation,
} = await import("../../src/standalone/computer.ts");
const { serveCapability } = await import("../../src/authorization.ts");
const { StandaloneInstance, StandaloneAgent } =
  await import("../../src/standalone/worker.ts");
const {
  ComputerFileConflict,
  mintComputerProcessId,
  ComputerPortConflictError,
  computerCapabilities,
} = await import("@fungi.computer/computer-contract");
const { FleetGrantRefused, createFleetComputers } =
  await import("@fungi.computer/computer/fleet");
const { OysterBinding, standaloneBindings } =
  await import("../../src/standalone/instance.ts");
const { defaultTenant, tenantScope } =
  await import("@fungi.computer/oyster/tenant");
/** The same default-tenant scope every test env here resolves under. */
const scopeOf = (env) => tenantScope(defaultTenant, env.OYSTER_ORIGIN);
/**
 * A passthrough `keysLive` port over the fixture's own `env.KEYS` mock, the
 * same one `oysterGitWorkerHost` would build from a real owner check; these
 * fixtures already decide a key's Computer access by what `KEYS.live`
 * returns, so this is not re-testing the owner check itself (tenant-host.test.mjs
 * does), just standing in for the one path `computerActor` now requires.
 */
const keysLiveOf = (env) => (keyId) =>
  env.KEYS.getByName(scopeOf(env).durableName("keys")).live(keyId);
const { backgroundOriginKey, sealBackgroundOrigin } =
  await import("@fungi.computer/puffball/background-replay");
const { AgentDirectory, agentFrameMethods } =
  await import("../../src/standalone/agents.ts");
const { StandaloneTenants, standaloneTenancy } =
  await import("../../src/standalone/tenancy.ts");
hooks.deregister();

test("captured fleet frames keep A and B files and processes isolated from the configured default", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const fleet = createFleetComputers(fromNodeSqlite(database), {
      limit: 2,
      retryAfterSeconds: 30,
    });
    fleet.ensure();
    const actor = { kind: "owner", id: "owner" };
    const a = fleet.create(actor, { name: "A", requestId: "A" }, []).computer;
    const b = fleet.create(actor, { name: "B", requestId: "B" }, []).computer;
    const files = new Map();
    const processes = new Map();
    const scope = scopeOf({ OYSTER_ORIGIN: "https://fleet.test" });
    const env = {
      OYSTER_COMPUTER_ID: "configured-build-computer",
      REGISTRY: {
        getByName: (name) => {
          assert.equal(name, scope.durableName("registry"));
          return { ownsComputer: (id) => fleet.read(id) !== null };
        },
      },
      COMPUTER: {
        getByName: (id) => ({
          value: async (authority, action, input) => {
            assert.equal(authority.computerId, id);
            if (action === "files.write") {
              files.set(id, input.content);
              return { path: input.path, bytesWritten: input.content.length };
            }
            if (action === "files.readBytes") return { content: files.get(id) };
            if (action === "processStart") {
              processes.set(id, input.command);
              return { command: input.command };
            }
            throw new Error(`Unexpected action ${action}`);
          },
        }),
      },
    };
    const frame = (computerId) => ({
      signal: new globalThis.AbortController().signal,
      facts: {
        subject: {
          kind: "call",
          context: {
            computerId,
            actor: { kind: "member", memberId: "owner" },
            idempotencyKey: "start",
          },
        },
        selection: { owner: { kind: "installation", id: "shed" } },
        deadlineAt: Date.now() + 60_000,
      },
      host: { method: { name: "run" } },
    });
    const capturedA = frame(a.computerId);
    const capturedB = frame(b.computerId);
    for (const [captured, name] of [
      [capturedA, "A"],
      [capturedB, "B"],
    ]) {
      await computerInvocation(env, scope, captured, "write", [
        { path: "/workspace/same.txt", content: name },
      ]);
      await computerInvocation(env, scope, captured, "processStart", [
        { command: `echo ${name}` },
      ]);
    }
    assert.deepEqual(
      await computerInvocation(env, scope, capturedA, "read", [
        { path: "/workspace/same.txt" },
      ]),
      { content: "A" },
    );
    assert.deepEqual(
      await computerInvocation(env, scope, capturedB, "read", [
        { path: "/workspace/same.txt" },
      ]),
      { content: "B" },
    );
    assert.equal(processes.get(a.computerId), "echo A");
    assert.equal(processes.get(b.computerId), "echo B");
    await assert.rejects(
      computerInvocation(env, scope, frame("foreign"), "write", [
        { path: "/workspace/same.txt", content: "foreign" },
      ]),
      { code: "revoked" },
    );
    assert.equal(files.size, 2);
  } finally {
    database.close();
  }
});

for (const { name, env, expected } of [
  { name: "container", env: {}, expected: [{ kind: "platform-container" }] },
  {
    name: "VM",
    env: { COMPUTER_VM_DEFAULT_HOST: "proof-host" },
    expected: [{ kind: "on-box-vm", hostId: "proof-host" }],
  },
]) {
  test(`a fresh Computer selects its configured ${name} backing and retains it on reopen`, () => {
    class BackingSelection extends ComputerDO {
      selectBackends() {
        return this.attachedBackends();
      }
    }
    const database = new DatabaseSync(":memory:");
    try {
      const state = {
        id: { name: "host-selected-workspace" },
        storage: fromNodeSqlite(database),
      };
      const computer = new BackingSelection(state, env);
      assert.deepEqual(computer.selectBackends(), expected);
      assert.deepEqual(computer.selectBackends(), expected);
      const reopened = new BackingSelection(state, {
        COMPUTER_VM_DEFAULT_HOST: "changed-host",
      });
      assert.deepEqual(reopened.selectBackends(), expected);
    } finally {
      database.close();
    }
  });
}

test("multiple Computers start independently on standalone and foreign grants wake neither", async () => {
  const pushed = [];
  class HostedComputer extends ComputerDO {
    workspace() {
      return {
        push: async () => {
          pushed.push(this.state.id.name);
          return 0;
        },
      };
    }
    async containerRunning() {
      return true;
    }
  }
  for (const computerId of ["A", "B"]) {
    const database = new DatabaseSync(":memory:");
    try {
      const computer = new HostedComputer(
        {
          id: { name: computerId },
          storage: fromNodeSqlite(database),
        },
        {},
      );
      const authority = {
        computerId,
        actions: new Set(["start"]),
        expiresAt: Date.now() + 60_000,
        provenance: { actor: "owner" },
      };
      await assert.rejects(
        computer.startHostedComputer({
          ...authority,
          computerId: "foreign",
        }),
        FleetGrantRefused,
      );
      assert.deepEqual(await computer.startHostedComputer(authority), {
        state: "running",
      });
    } finally {
      database.close();
    }
  }
  assert.deepEqual(pushed, ["A", "B"]);
});

// Exercise the public Instance and real shared gate. Only the Worker Loader,
// facet transport and native Computer port are supplied by this Node fixture.
async function instanceBinding(
  t,
  env,
  operations,
  installationId = "computer-proof",
  agentBindings = [],
  beforeBindingCall = () => Promise.resolve(),
  tenant,
  replay = false,
  host = {},
) {
  const database = new DatabaseSync(":memory:");
  const pending = [];
  t.after(async () => {
    await Promise.all(pending);
    database.close();
  });
  const artifacts = new Map();
  const api = {
    methods: Object.fromEntries(
      ["run", "other"].map((name) => [
        name,
        {
          description: `Fixture ${name} method`,
          input: { type: "object" },
          output: {},
          effect: "write",
          requires: [
            "computer.list",
            "computer.readFile",
            "computer.writeFile",
            "computer.execute",
            ...(replay ? ["workflow.run"] : []),
          ],
        },
      ]),
    ),
  };
  const persist = async (value) => {
    const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    artifacts.set(artifactRef, bytes);
    return { artifactRef, digest, byteLength: bytes.length, version: digest };
  };
  const backend = {
    ...(await persist({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-25",
      exportName: "Guest",
      code: "export class Guest {}",
    })),
    mediaType: backendMediaType,
  };
  const declaration = {
    capabilities: [
      ...new Set([
        "computer.list",
        "computer.readFile",
        "computer.writeFile",
        "computer.execute",
        ...agentBindings.flatMap(({ name, operations }) =>
          operations.flatMap((operation) => {
            const registered = appBackendBindingOperation(name, operation);
            assert.ok(
              registered,
              "The ordinary binding registry owns operations",
            );
            return registered.requires;
          }),
        ),
      ]),
    ],
    handlers: [],
    roles: [],
    api,
    backend: { bindings: [{ name: "COMPUTER", operations }, ...agentBindings] },
  };
  const root = await persist(createAppBuild(null, backend, declaration));
  const release = {
    appId: "app_computerproof",
    releaseId: "rel_computerproof",
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
  const defaultScope = tenantScope(defaultTenant, "https://oyster.invalid");
  let installation = await approvedInstallation({
    installationId,
    instanceId,
    release,
    declaration,
  });
  // The actual owner command produces finite Agent selections; no frame grants
  // or DeclaredOperations snapshots are reconstructed by this fixture.
  const changeAgentResources = async (resources) => {
    const changed = applyInstallationCommand(
      installation,
      {
        kind: "change-grants",
        changes: installation.authority.approvedGrants
          .filter(({ capability }) =>
            ["agent.read", "agent.manage", "agent.send"].includes(capability),
          )
          .map(({ capability, operations }) => ({
            capability,
            grant: resources === null ? null : { operations, resources },
          })),
      },
      {
        by: { kind: "member", memberId: "fixture-owner" },
        role: "owner",
        expectedVersion: installation.authority.authorityVersion,
        declaration,
        declaredOperations: await deriveDeclaredOperations(
          release,
          declaration,
          [],
        ),
        now: Date.now(),
        identity: installation,
      },
    );
    if (Result.isFailure(changed)) throw new Error(changed.failure.code);
    installation = changed.success.next;
  };
  if (host.agentResources !== undefined)
    await changeAgentResources(host.agentResources);
  const selected = {
    instanceId,
    appId: release.appId,
    releaseId: release.releaseId,
    authorityVersion: installation.authority.authorityVersion,
    owner: { kind: "installation", id: installationId },
  };
  const registry = env.REGISTRY;
  const cache = new Map();
  const loaded = [];
  let perform;
  let facet;
  let instance;
  let registryReads = 0;
  const bindings = {
    ...env,
    OYSTER_ORIGIN: "https://oyster.invalid",
    RELEASES: {
      get: async (ref) => {
        const bytes = artifacts.get(ref);
        return bytes === undefined
          ? null
          : { arrayBuffer: async () => bytes.buffer };
      },
    },
    REGISTRY: {
      getByName: () => ({
        ownsComputer: (computerId) => computerId === env.OYSTER_COMPUTER_ID,
        selectedComputer: async () => env.OYSTER_COMPUTER_ID,
        get: async () => {
          registryReads += 1;
          return {
            ...installation,
            status: (await registry.getByName("registry").get("computer-proof"))
              .status,
          };
        },
      }),
    },
    INSTANCES: {
      getByName: (id) => {
        assert.equal(id, instanceId);
        return {
          bindingCall: async (props, method, args) => {
            await beforeBindingCall(props);
            return instance.bindingCall(props, method, args);
          },
        };
      },
    },
    LOADER: {
      get: (id, configure) => {
        if (!cache.has(id)) cache.set(id, configure());
        const configured = cache.get(id);
        assert.deepEqual(configured.env, {});
        assert.equal(configured.globalOutbound, null);
        loaded.push({ name: id, limits: configured.limits });
        return { getDurableObjectClass: () => cache.get(id) };
      },
    },
  };
  const Instance = host.Instance ?? StandaloneInstance;
  const context = {
    id: { name: instanceId },
    storage: fromNodeSqlite(database),
    blockConcurrencyWhile: (work) => {
      const result = work();
      pending.push(result);
      return result;
    },
    // Every binding in every frame is the root's one entrypoint.
    exports: host.withoutBindingEntrypoint
      ? {}
      : {
          OysterBinding: ({ props }) => new OysterBinding({ props }, bindings),
        },
    facets: {
      // The binding Guest has no App storage; copying it is empty.
      clone: (source, destination) => {
        assert.equal(source, "app");
        assert.equal(destination, "candidate");
      },
      get: (_name, prepare) => {
        facet ??= prepare().class;
        return {
          // A generated App method answers with its typed reply.
          invoke: async (_name, _args, rawBindings) => {
            const bindings = bindingWire.wrap(rawBindings);
            return {
              kind: "ok",
              value: await perform(bindings.COMPUTER, bindings),
            };
          },
          http: async (_input, rawBindings) => {
            const bindings = bindingWire.wrap(rawBindings);
            const value = await perform(bindings.COMPUTER, bindings);
            return {
              status: 200,
              statusText: "OK",
              headers: [],
              body: globalThis.Response.json(value).body,
            };
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
  const construction = withBackendConstruction(context.facets, bindings.LOADER);
  bindings.LOADER = construction.loader;
  context.facets = construction.facets;
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
  instance = new Instance(context, bindings);
  assert.equal(
    (
      await instance.apply(
        { ...selected, status: "enabled" },
        release,
        undefined,
        tenant ?? defaultScope,
      )
    ).ok,
    true,
  );
  const run = (
    work,
    context = {
      computerId: env.OYSTER_COMPUTER_ID,
      actor: { kind: "member", memberId: "owner" },
      idempotencyKey: "process-start-proof",
    },
    deadlineAt = Date.now() + 60_000,
    agentGrants = agentBindings.map(({ name, operations }) => ({
      binding: name,
      operations,
    })),
  ) => {
    perform = work;
    return instance.backend(
      {
        instanceId,
        selection: selected,
        artifactDigest: backend.digest,
        subject: { kind: "call", context },
        grants: [{ binding: "COMPUTER", operations }, ...agentGrants],
        deadlineAt,
        ancestry: [],
      },
      new globalThis.Request("https://guest.invalid/"),
      undefined,
      tenant?.tenantId,
    );
  };
  // The Instance result with the method's ok reply unwrapped to its value.
  const call = async (
    work,
    name = "run",
    context = {
      computerId: env.OYSTER_COMPUTER_ID,
      actor: { kind: "member", memberId: "owner" },
      idempotencyKey: "process-start-proof",
    },
    deadlineAt = Date.now() + 60_000,
  ) => {
    perform = work;
    const subject = { kind: "call", context };
    const grants = [{ binding: "COMPUTER", operations }];
    if (replay) {
      subject.method = { name: "run", effect: "write" };
      subject.replay = { lane: "member:owner", epoch: 1, admitted: ["run"] };
      grants.push(
        ...agentBindings.map(({ name, operations }) => ({
          binding: name,
          operations,
        })),
        { binding: "BACKGROUND", operations: ["admit"] },
      );
    }
    const result = await instance.call(
      {
        instanceId,
        selection: selected,
        artifactDigest: backend.digest,
        subject,
        grants,
        deadlineAt,
        ancestry: [],
      },
      api,
      name,
      {},
    );
    if (!result.ok) return result;
    assert.equal(result.value.kind, "ok");
    return { ok: true, value: result.value.value };
  };
  const binding = Object.fromEntries(
    [
      "list",
      "read",
      "write",
      "ports",
      "processes",
      "exec",
      "preview",
      "processStart",
      "processKill",
    ].map((method) => [
      method,
      async (input) => {
        if (method === "processStart") {
          const result = await call((computer) => computer.processStart(input));
          if (!result.ok) throw new Error(result.code);
          return result.value;
        }
        const response = await run((computer) => computer[method](input));
        if (response.status !== 200)
          throw new Error((await response.json()).error);
        return response.json();
      },
    ]),
  );
  return {
    binding,
    run,
    call,
    instanceId,
    selection: selected,
    releaseDigest: root.digest,
    installation,
    registryReads: () => registryReads,
    changeAgentResources,
    close: () => instance.revoke(installationId),
    /** The host commits the new owner state before delivering its activation. */
    disable: async () => {
      installation = {
        ...installation,
        status: "disabled",
        authority: {
          ...installation.authority,
          authorityVersion: installation.authority.authorityVersion + 1,
        },
      };
      assert.equal(
        (
          await instance.apply(
            {
              ...selected,
              authorityVersion: installation.authority.authorityVersion,
              status: "disabled",
            },
            release,
            undefined,
            tenant ?? defaultScope,
          )
        ).ok,
        true,
      );
    },
  };
}

async function nativeFileBinding(t) {
  const calls = [];
  class FilePorts extends ComputerDO {
    async readFileAfterAcceptance(input, accept) {
      accept();
      calls.push({ operation: "readBytes", input });
      const source = new Uint8Array([65, 0, 255, 66]);
      const offset = input.byteOffset ?? 0;
      const bytes = source.slice(
        offset,
        offset + (input.byteLength ?? source.length),
      );
      return {
        offset,
        total: source.length,
        length: bytes.length,
        body: new globalThis.Response(bytes).body,
      };
    }
    async replaceFileIfUnchangedAfterAcceptance(input, accept) {
      accept();
      calls.push({ operation: "replace", input });
      if (input.expectedContent === "stale") throw new ComputerFileConflict();
      return {
        path: input.path,
        bytes: new globalThis.TextEncoder().encode(input.content).length,
      };
    }
    async callAfterAcceptance(operation, input, accept) {
      accept();
      assert.equal(
        operation,
        "write",
        "binary reads must use the native byte-read port",
      );
      assert.equal(
        Object.hasOwn(input, "expectedContent"),
        false,
        "CAS must use the native conditional replacement port",
      );
      calls.push({ operation, input });
      return {
        path: input.path,
        bytes: new globalThis.TextEncoder().encode(input.content).length,
      };
    }
  }
  const computerId = "host-selected-workspace";
  // The native Computer keeps its durable execution record in its storage.
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const computer = new FilePorts(
    { id: { name: computerId }, storage: fromNodeSqlite(database) },
    {},
  );
  const { binding } = await instanceBinding(
    t,
    {
      OYSTER_COMPUTER_ID: computerId,
      REGISTRY: {
        getByName: () => ({ get: async () => ({ status: "enabled" }) }),
      },
      COMPUTER: {
        getByName: (id) => {
          assert.equal(id, computerId);
          return computer;
        },
      },
    },
    ["read", "write"],
  );
  return { binding, calls };
}

test("the scoped native read binding preserves binary byte windows and base64 replies", async (t) => {
  const { binding, calls } = await nativeFileBinding(t);
  const input = { path: "/standalone.bin", byteOffset: 1, byteLength: 2 };
  assert.deepEqual(await binding.read(input), {
    path: input.path,
    byteOffset: 1,
    content: "AP8=",
    encoding: "base64",
    truncated: true,
  });
  assert.deepEqual(await binding.read({ ...input, byteOffset: 4 }), {
    path: input.path,
    byteOffset: 4,
    content: "",
    encoding: "base64",
    truncated: false,
  });
  assert.deepEqual(calls, [
    { operation: "readBytes", input },
    { operation: "readBytes", input: { ...input, byteOffset: 4 } },
  ]);
});

test("the scoped native write binding selects atomic CAS and preserves conflicts", async (t) => {
  const { binding, calls } = await nativeFileBinding(t);
  const replacement = {
    path: "/standalone.txt",
    expectedContent: "before",
    content: "after",
  };
  assert.deepEqual(await binding.write(replacement), {
    path: replacement.path,
    bytes: 5,
  });
  assert.deepEqual(
    await binding.write({ ...replacement, expectedContent: "stale" }),
    { error: "conflict" },
  );
  const ordinary = { path: replacement.path, content: "ordinary" };
  assert.deepEqual(await binding.write(ordinary), {
    path: replacement.path,
    bytes: 8,
  });
  assert.deepEqual(calls, [
    { operation: "replace", input: replacement },
    {
      operation: "replace",
      input: { ...replacement, expectedContent: "stale" },
    },
    { operation: "write", input: ordinary },
  ]);
});

function fixture() {
  const processes = new Map();
  const requests = new Map();
  const calls = [];
  const authorities = [];
  let enabled = true;
  const env = {
    OYSTER_COMPUTER_ID: "host-selected-workspace",
    REGISTRY: {
      getByName: () => ({
        get: async () => ({ status: enabled ? "enabled" : "disabled" }),
      }),
    },
    COMPUTER: {
      getByName(id) {
        assert.equal(id, "host-selected-workspace");
        return {
          value: async (authority, action, input) => {
            assert.equal(authority.computerId, id);
            assert.ok(authority.actions.has(action));
            authorities.push(authority);
            calls.push({ action, input, actor: authority.provenance.actor });
            if (action === "files.list")
              return { path: input.path, entries: [], nextOffset: null };
            if (action === "files.readBytes")
              return {
                path: input.path,
                byteOffset: 0,
                content: "bmF0aXZlIGZpbGVz",
                encoding: "base64",
                truncated: false,
              };
            if (action === "files.write")
              return { path: input.path, bytes: input.content.length };
            if (action === "processStart") {
              const prior = requests.get(
                JSON.stringify([input.requestScope, input.requestId]),
              );
              if (prior) {
                if (prior.input !== JSON.stringify(input))
                  return { error: "conflict" };
                return processes.get(prior.id);
              }
              const process = {
                id: mintComputerProcessId(),
                command: input.command,
                port: input.port ?? null,
                cwd: input.cwd ?? null,
                state: "running",
                exitCode: null,
                sync: "unknown",
                startedAt: Date.now(),
                endedAt: null,
              };
              requests.set(
                JSON.stringify([input.requestScope, input.requestId]),
                {
                  id: process.id,
                  input: JSON.stringify(input),
                },
              );
              processes.set(process.id, process);
              return process;
            }
            if (action === "processKill") {
              const process = processes.get(input.id);
              assert.ok(process);
              const ended = {
                ...process,
                state: "exited",
                endedAt: Date.now(),
              };
              processes.set(input.id, ended);
              return { process: ended, signalled: true };
            }
            if (action === "processList")
              return { processes: [...processes.values()] };
            return action === "listPorts" ? { ports: [] } : { processes: [] };
          },
          fileRead: async (authority, path) => {
            assert.equal(authority.computerId, id);
            assert.equal(path, "/proof.txt");
            return new globalThis.TextEncoder().encode("native files");
          },
          portPreviews: async (authority, selector) => {
            authorities.push(authority);
            calls.push({
              action: "preview",
              selector,
              actor: authority.provenance.actor,
            });
            return {
              kind: "ok",
              value: {
                ports: [
                  {
                    port: 3000,
                    previewUrl:
                      "https://oyster-contest.levi-fe0.workers.dev/preview/fixture/",
                    expiresAt: Date.now() + 60_000,
                    openMode: "external-only",
                  },
                ],
              },
            };
          },
          fetch: async (request) => {
            const authority = JSON.parse(
              request.headers.get("X-Oyster-Computer-Grant"),
            );
            assert.equal(authority.computerId, id);
            calls.push({
              actor: authority.provenance.actor,
              path: new URL(request.url).pathname,
            });
            return new globalThis.Response("native upgrade");
          },
        };
      },
    },
    OYSTER_ORIGIN: "https://oyster.invalid",
    // Every key in this fixture carries its own computer.use grant, the
    // same Computer access every other actor kind here already has.
    KEYS: {
      getByName: () => ({
        live: async (keyId) => ({
          keyId,
          owner: "owner",
          grantVersion: 1,
          grants: [{ capability: "computer.use", targets: { kind: "all" } }],
        }),
      }),
    },
  };
  return {
    env,
    calls,
    authorities,
    revoke: () => {
      enabled = false;
    },
  };
}

/** The host's admission; these routes read only the principal from it. */
const admitted = (principal) => ({
  principal,
  installation: { installationId: "computer-proof", status: "enabled" },
});

test("owner and key routes use the same fixed Computer as workspace files, ignoring guest selectors", async () => {
  for (const principal of [
    { actor: { kind: "member", memberId: "caller" }, role: "owner" },
    { actor: { kind: "team-key", keyId: "caller" } },
  ]) {
    const { env, calls } = fixture();
    const workspace = standaloneWorkspace(env, keysLiveOf(env));
    assert.equal(workspace.computerId, "host-selected-workspace");
    assert.equal(
      new globalThis.TextDecoder().decode(
        await workspace.files.read("/proof.txt"),
      ),
      "native files",
    );
    const routes = serveCapability(
      standaloneComputerCapabilities(env, workspace)[0].routes,
      { liveKey: keysLiveOf(env), appToolPolicy: () => null },
    );
    const response = await routes.request(
      "/processes?computerId=guest-selected",
      {},
      admitted(principal),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { processes: [] });
    const upgrade = await routes.request(
      "/terminal?computerId=guest-selected&session=one&cols=80&rows=24",
      {
        headers: {
          Upgrade: "websocket",
          "X-Oyster-Computer-Grant": JSON.stringify({ computerId: "forged" }),
        },
      },
      admitted(principal),
    );
    assert.equal(await upgrade.text(), "native upgrade");
    assert.deepEqual(calls, [
      { action: "processList", input: {}, actor: JSON.stringify(principal) },
      { actor: JSON.stringify(principal), path: "/_oyster/terminal" },
    ]);
  }
});

test("owner and key process starts preserve the client requestId and reject missing or forged identity", async () => {
  for (const principal of [
    { actor: { kind: "member", memberId: "caller" }, role: "owner" },
    { actor: { kind: "team-key", keyId: "caller" } },
  ]) {
    const { env, calls } = fixture();
    const routes = serveCapability(
      standaloneComputerCapabilities(
        env,
        standaloneWorkspace(env, keysLiveOf(env)),
      )[0].routes,
      { liveKey: keysLiveOf(env), appToolPolicy: () => null },
    );
    const start = (input) =>
      routes.request(
        "/processes/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
        admitted(principal),
      );
    assert.equal((await start({ command: "serve" })).status, 400);
    assert.equal(
      (
        await start({
          command: "serve",
          requestScope: "forged",
          requestId: "client-proof",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await start({
          command: "serve",
          requestId: "x".repeat(257),
        })
      ).status,
      400,
    );
    assert.deepEqual(calls, []);
    const response = await start({
      command: "serve",
      cwd: "/app",
      requestId: "client-proof",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).command, "serve");
    assert.deepEqual(calls, [
      {
        action: "processStart",
        input: {
          command: "serve",
          cwd: "/app",
          requestId: "client-proof",
          requestScope: "owner:owner",
        },
        actor: JSON.stringify(principal),
      },
    ]);
    const conflict = await start({
      command: "other",
      requestId: "client-proof",
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "conflict" });
  }
});

test("Shed's start -> list -> kill sequence round-trips over the standalone HTTP routes", async () => {
  const principal = {
    actor: { kind: "member", memberId: "caller" },
    role: "owner",
  };
  const { env } = fixture();
  const routes = serveCapability(
    standaloneComputerCapabilities(
      env,
      standaloneWorkspace(env, keysLiveOf(env)),
    )[0].routes,
    { liveKey: keysLiveOf(env), appToolPolicy: () => null },
  );
  const start = await routes.request(
    "/processes/start",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "node server.mjs",
        requestId: "shed-start",
      }),
    },
    admitted(principal),
  );
  assert.equal(start.status, 200);
  const started = await start.json();
  assert.equal(started.command, "node server.mjs");
  assert.equal(started.state, "running");

  const list = await routes.request("/processes", {}, admitted(principal));
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { processes: [started] });

  const kill = await routes.request(
    "/processes/kill",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: started.id }),
    },
    admitted(principal),
  );
  assert.equal(kill.status, 200);
  const killed = await kill.json();
  assert.equal(killed.process.id, started.id);
  assert.equal(killed.process.state, "exited");
  assert.equal(killed.signalled, true);
});

test("Expose, Unexpose and Stop accept exactly the page's wire bodies and refuse bare arguments typed", async () => {
  const database = new DatabaseSync(":memory:");
  const received = [];
  class WirePorts extends ComputerDO {
    exposePortAfterAcceptance(input, accept) {
      accept();
      received.push(["expose", input]);
      return Promise.resolve({ port: input.port, exposed: true });
    }
    unexposePortAfterAcceptance(input, accept) {
      accept();
      received.push(["unexpose", input]);
      return Promise.resolve({ port: input.port, removed: true });
    }
    killProcessAfterAcceptance(input, accept) {
      accept();
      received.push(["kill", input]);
      return Promise.resolve({
        process: {
          id: input.id,
          command: "node server.mjs",
          port: 8099,
          cwd: null,
          state: "exited",
          exitCode: null,
          startedAt: 1,
          endedAt: 2,
          sync: null,
        },
        signalled: true,
      });
    }
  }
  try {
    const computer = new WirePorts(
      { id: { name: "workspace" }, storage: fromNodeSqlite(database) },
      {},
    );
    const env = {
      OYSTER_COMPUTER_ID: "workspace",
      COMPUTER: { getByName: () => computer },
    };
    const routes = serveCapability(
      standaloneComputerCapabilities(env, standaloneWorkspace(env))[0].routes,
      { liveKey: async () => null, appToolPolicy: () => null },
    );
    const post = (path, body) =>
      routes.request(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        admitted({
          actor: { kind: "member", memberId: "owner" },
          role: "owner",
        }),
      );
    const id = "computer_process_es2qzb7hbuxyxn8etwrg2";
    // packages/oyster/src/page/computer-handles.ts sends these bodies.
    const expose = await post("/ports/expose", { port: 8099 });
    assert.equal(expose.status, 200);
    assert.deepEqual(await expose.json(), { port: 8099, exposed: true });
    const unexpose = await post("/ports/unexpose", { port: 8099 });
    assert.equal(unexpose.status, 200);
    assert.deepEqual(await unexpose.json(), { port: 8099, removed: true });
    const kill = await post("/processes/kill", { id });
    assert.equal(kill.status, 200);
    assert.equal((await kill.json()).signalled, true);
    assert.deepEqual(received, [
      ["expose", { port: 8099 }],
      ["unexpose", { port: 8099 }],
      ["kill", { id }],
    ]);
    // A bare argument is not the wire contract: a typed 400, never a 500.
    for (const [path, body] of [
      ["/ports/expose", 8099],
      ["/ports/unexpose", 8099],
      ["/processes/kill", id],
    ]) {
      const response = await post(path, body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_input" });
    }
    assert.equal(received.length, 3);
  } finally {
    database.close();
  }
});

test("a canonical owner principal can request the frozen installation port preview", async (t) => {
  const { env, calls } = fixture();
  const { installation, selection, releaseDigest } = await instanceBinding(
    t,
    env,
    ["ports"],
  );
  env.OYSTER_ORIGIN = "https://oyster.shiit.app";
  env.OYSTER_PREVIEW_ORIGIN = "https://oyster-contest.levi-fe0.workers.dev";
  const routes = serveCapability(
    standaloneComputerCapabilities(
      env,
      standaloneWorkspace(env, keysLiveOf(env)),
    )[0].routes,
    { liveKey: keysLiveOf(env), appToolPolicy: () => null },
  );
  const ports = (principal) =>
    routes.request("/ports", {}, { principal, installation });
  // Port previews stay owner-only even for an admitted key.
  const key = await ports({ actor: { kind: "team-key", keyId: "caller" } });
  assert.equal(key.status, 403);
  assert.deepEqual(await key.json(), {
    error: "Owner only",
  });
  assert.deepEqual(calls, []);
  const response = await ports({
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ports[0].port, 3000);
  assert.equal(calls[0].actor, "owner:owner");
  assert.deepEqual(calls[0].selector, {
    ownerId: "owner",
    installationId: "computer-proof",
    selection,
    artifactDigest: releaseDigest,
  });
});

test("an admitted Agent cannot use Computer routes", async () => {
  const { env, calls } = fixture();
  const routes = serveCapability(
    standaloneComputerCapabilities(
      env,
      standaloneWorkspace(env, keysLiveOf(env)),
    )[0].routes,
    { liveKey: keysLiveOf(env), appToolPolicy: () => null },
  );
  const agent = admitted({ actor: { kind: "agent", agentId: "caller" } });
  assert.equal((await routes.request("/processes", {}, agent)).status, 403);
  assert.equal(
    (
      await routes.request(
        "/processes/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "serve", requestId: "agent" }),
        },
        agent,
      )
    ).status,
    403,
  );
  assert.deepEqual(calls, []);
});

test("native port conflicts become safe frame and HTTP conflict replies", async (t) => {
  class UnavailablePort extends ComputerDO {
    async startProcessAfterAcceptance(_input, accept) {
      accept();
      throw new ComputerPortConflictError();
    }
  }
  const { env } = fixture();
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const native = new UnavailablePort(
    { id: { name: env.OYSTER_COMPUTER_ID }, storage: fromNodeSqlite(database) },
    {},
  );
  env.COMPUTER = { getByName: () => native };
  const { binding } = await instanceBinding(t, env, ["processStart"]);
  assert.deepEqual(
    await binding.processStart({ command: "serve", port: 3000 }),
    { error: "conflict" },
  );
  const routes = serveCapability(
    standaloneComputerCapabilities(
      env,
      standaloneWorkspace(env, keysLiveOf(env)),
    )[0].routes,
    { liveKey: keysLiveOf(env), appToolPolicy: () => null },
  );
  const response = await routes.request(
    "/processes/start",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "serve",
        port: 3000,
        requestId: "port-conflict-proof",
      }),
    },
    admitted({
      actor: { kind: "member", memberId: "owner" },
      role: "owner",
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "conflict" });
});

test("standalone frame processStart preserves the maintained process packet and exact grant", async (t) => {
  const { env, calls, authorities } = fixture();
  const { binding } = await instanceBinding(t, env, ["processStart"]);
  const result = await binding.processStart({
    command: "node server.mjs",
    cwd: "/app",
  });
  assert.equal(result.state, "running");
  assert.equal(result.command, "node server.mjs");
  assert.deepEqual(calls, [
    {
      action: "processStart",
      input: {
        command: "node server.mjs",
        cwd: "/app",
        requestId: "process-start-proof",
        requestScope: 'installation:["computer-proof","run","member:owner"]',
      },
      actor: "member:owner",
    },
  ]);
  assert.deepEqual([...authorities[0].actions], ["processStart"]);
});

test("a declared port reaches native processStart with the host key and returns on the process", async (t) => {
  const { env, calls } = fixture();
  const { binding } = await instanceBinding(t, env, ["processStart"]);
  const process = await binding.processStart({
    command: "serve",
    cwd: "/app",
    port: 3000,
  });
  assert.equal(process.port, 3000);
  assert.deepEqual(calls[0].input, {
    command: "serve",
    cwd: "/app",
    port: 3000,
    requestId: "process-start-proof",
    requestScope: 'installation:["computer-proof","run","member:owner"]',
  });
});

test("law 2a: closing the frame immediately before native send creates no process", async (t) => {
  const { env, calls } = fixture();
  const { call, close } = await instanceBinding(t, env, ["processStart"]);
  const native = env.COMPUTER.getByName;
  let closed;
  env.COMPUTER.getByName = (id) => {
    closed = close();
    return native(id);
  };
  const response = await call((computer) =>
    computer.processStart({ command: "node server.mjs" }),
  );
  await closed;
  assert.equal(response.ok, false);
  assert.equal(response.code, "revoked");
  assert.deepEqual(calls, []);
});

test("law 2b/c: a process dispatched before frame close remains listed, replayable and killable", async (t) => {
  const { env, calls } = fixture();
  const { call, close, binding } = await instanceBinding(t, env, [
    "processStart",
    "processKill",
    "processes",
  ]);
  const native = env.COMPUTER.getByName;
  const dispatched = Promise.withResolvers();
  const accept = Promise.withResolvers();
  const completed = Promise.withResolvers();
  env.COMPUTER.getByName = (id) => {
    const computer = native(id);
    return {
      ...computer,
      value: async (...args) => {
        dispatched.resolve();
        await accept.promise;
        const result = await computer.value(...args);
        completed.resolve(result);
        return result;
      },
    };
  };
  const running = call((computer) =>
    computer.processStart({ command: "node server.mjs" }),
  );
  await dispatched.promise;
  assert.deepEqual(calls, []);
  await close();
  const response = await running;
  assert.equal(response.ok, false);
  assert.equal(response.code, "revoked");
  accept.resolve();
  const accepted = await completed.promise;
  env.COMPUTER.getByName = native;
  const replay = await binding.processStart({ command: "node server.mjs" });
  assert.equal(replay.id, accepted.id);
  assert.deepEqual((await binding.processes({})).processes, [accepted]);
  const killed = await binding.processKill({ id: accepted.id });
  assert.equal(killed.process.id, accepted.id);
  assert.equal(killed.signalled, true);
  assert.equal(killed.process.state, "exited");
  assert.deepEqual(
    calls
      .filter((call) => call.action === "processStart")
      .map((call) => call.input.requestId),
    ["process-start-proof", "process-start-proof"],
  );
});

// The 180 s hang: a root missing one per-binding export threw while minting the
// guest env, the frame failed untyped and a dispatch-awaiting caller never woke.
// One entrypoint serves every binding; a missing export or row is a typed refusal.
test("a root without its binding entrypoint refuses the frame with binding_unavailable within 5 s", async (t) => {
  const { env, calls } = fixture();
  const { call } = await instanceBinding(
    t,
    env,
    ["processStart"],
    undefined,
    [],
    undefined,
    undefined,
    false,
    { withoutBindingEntrypoint: true },
  );
  const started = Date.now();
  const response = await call((computer) =>
    computer.processStart({ command: "node server.mjs" }),
  );
  assert.equal(response.ok, false);
  assert.equal(response.code, "binding_unavailable");
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(calls, []);
});

test("an Instance without a binding's row refuses that binding with binding_unavailable within 5 s", async (t) => {
  class WithoutComputer extends StandaloneInstance {
    bindings = { ...standaloneBindings, COMPUTER: undefined };
  }
  const { env, calls } = fixture();
  const { call } = await instanceBinding(
    t,
    env,
    ["list"],
    undefined,
    [],
    undefined,
    undefined,
    false,
    { Instance: WithoutComputer },
  );
  const started = Date.now();
  const response = await call(async (computer) => ({
    code: await refusedCode(computer.list({ path: "/" })),
  }));
  assert.deepEqual(response, {
    ok: true,
    value: { code: "binding_unavailable" },
  });
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(calls, []);
});

// A guest observes a host refusal as its typed local code. A refusal the guest
// rethrows is its own failure; the host never trusts a guest-thrown code.
const refusedCode = (pending) =>
  pending.then(
    () => null,
    (error) => error.code,
  );

test("processStart refuses a missing host key and guest-owned host fields", async (t) => {
  const { env, calls } = fixture();
  const { call, binding } = await instanceBinding(t, env, ["processStart"]);
  const response = await call(
    async (computer) => ({
      refused: await refusedCode(computer.processStart({ command: "serve" })),
    }),
    "run",
    {
      computerId: env.OYSTER_COMPUTER_ID,
      actor: { kind: "member", memberId: "owner" },
    },
  );
  assert.deepEqual(response, { ok: true, value: { refused: "revoked" } });
  await assert.rejects(
    binding.processStart({ command: "serve", requestId: "guest" }),
  );
  await assert.rejects(
    binding.processStart({ command: "serve", requestScope: "guest" }),
  );
  await assert.rejects(
    binding.processStart({ command: "serve", method: "guest" }),
  );
  assert.deepEqual(calls, []);
});

test("raw backend processStart has no verified method and cannot dispatch", async (t) => {
  const { env, calls } = fixture();
  const { run } = await instanceBinding(t, env, ["processStart"]);
  const response = await run(async (computer) => ({
    refused: await refusedCode(computer.processStart({ command: "serve" })),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { refused: "revoked" });
  assert.deepEqual(calls, []);
});

test("processKill requires its declared operation and a maintained process id before native send", async (t) => {
  const { env, calls } = fixture();
  const missing = await instanceBinding(t, env, ["processes"]);
  await assert.rejects(
    missing.binding.processKill({ id: mintComputerProcessId() }),
  );
  const allowed = await instanceBinding(t, env, ["processKill"]);
  await assert.rejects(allowed.binding.processKill({ id: "forged" }));
  await assert.rejects(
    allowed.binding.processKill({
      id: mintComputerProcessId(),
      computerId: "forged",
    }),
  );
  assert.deepEqual(calls, []);
});

test("reusing a process key with changed input returns a typed conflict", async (t) => {
  const { env } = fixture();
  const { binding } = await instanceBinding(t, env, ["processStart"]);
  await binding.processStart({ command: "serve" });
  assert.deepEqual(await binding.processStart({ command: "other" }), {
    error: "conflict",
  });
});

test("one declared invocation cannot start a second command with its host key", async (t) => {
  const { env } = fixture();
  const { call, binding } = await instanceBinding(t, env, [
    "processStart",
    "processes",
  ]);
  const result = await call(async (computer) => {
    const process = await computer.processStart({ command: "serve" });
    const second = await computer.processStart({ command: "other" });
    return { process, second };
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.second, { error: "conflict" });
  assert.deepEqual((await binding.processes({})).processes, [
    result.value.process,
  ]);
});

test("the same opaque key in two installations receives separate host-owned process scopes", async (t) => {
  const { env, calls } = fixture();
  const first = await instanceBinding(t, env, ["processStart"], "first-app");
  const second = await instanceBinding(t, env, ["processStart"], "second-app");
  const a = await first.binding.processStart({ command: "serve" });
  const b = await second.binding.processStart({ command: "serve" });
  assert.notEqual(a.id, b.id);
  assert.deepEqual(
    calls.map((call) => [call.input.requestScope, call.input.requestId]),
    [
      [
        'installation:["first-app","run","member:owner"]',
        "process-start-proof",
      ],
      [
        'installation:["second-app","run","member:owner"]',
        "process-start-proof",
      ],
    ],
  );
});

test("the same opaque key in two admitted actors cannot replay another actor's process", async (t) => {
  const { env, calls } = fixture();
  const { call } = await instanceBinding(t, env, ["processStart"]);
  const work = (computer) => computer.processStart({ command: "serve" });
  const first = await call(work, "run", {
    computerId: env.OYSTER_COMPUTER_ID,
    actor: { kind: "member", memberId: "first" },
    idempotencyKey: "process-start-proof",
  });
  const second = await call(work, "run", {
    computerId: env.OYSTER_COMPUTER_ID,
    actor: { kind: "member", memberId: "second" },
    idempotencyKey: "process-start-proof",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.value.id, second.value.id);
  assert.deepEqual(
    calls.map((call) => call.input.requestId),
    ["process-start-proof", "process-start-proof"],
  );
});

test("the same opaque key in two declared methods cannot replay another method's process", async (t) => {
  const { env } = fixture();
  const { call } = await instanceBinding(t, env, ["processStart"]);
  const work = (computer) => computer.processStart({ command: "serve" });
  const context = {
    computerId: env.OYSTER_COMPUTER_ID,
    actor: { kind: "member", memberId: "owner" },
    idempotencyKey: "process-start-proof",
  };
  const first = await call(work, "run", context);
  const second = await call(work, "other", context);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.value.id, second.value.id);
});

for (const actor of [
  { kind: "agent", agentId: "owner" },
  { kind: "team-key", keyId: "owner" },
]) {
  test(`processStart refuses ${actor.kind} actors without a member fallback`, async (t) => {
    const { env, calls } = fixture();
    const { call } = await instanceBinding(t, env, ["processStart"]);
    const result = await call(
      async (computer) => ({
        refused: await refusedCode(computer.processStart({ command: "serve" })),
      }),
      "run",
      {
        computerId: env.OYSTER_COMPUTER_ID,
        actor,
        idempotencyKey: "process-start-proof",
      },
    );
    assert.deepEqual(result, { ok: true, value: { refused: "revoked" } });
    assert.deepEqual(calls, []);
  });
}

test("distinct opaque invocation keys in the same member method start distinct processes and replay unchanged", async (t) => {
  const { env, calls } = fixture();
  const { call } = await instanceBinding(t, env, ["processStart"]);
  const work = (computer) => computer.processStart({ command: "serve" });
  const start = (idempotencyKey) =>
    call(work, "run", {
      computerId: env.OYSTER_COMPUTER_ID,
      actor: { kind: "member", memberId: "owner" },
      idempotencyKey,
    });
  const first = await start("first-intent");
  const second = await start("second-intent");
  const replay = await start("first-intent");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(replay.ok, true);
  assert.notEqual(first.value.id, second.value.id);
  assert.equal(replay.value.id, first.value.id);
  assert.deepEqual(
    calls.map((entry) => entry.input.requestId),
    ["first-intent", "second-intent", "first-intent"],
  );
  assert.deepEqual(
    new Set(calls.map((entry) => entry.input.requestScope)),
    new Set(['installation:["computer-proof","run","member:owner"]']),
  );
});

test("standalone frame preview requires the owner role and selects by the admitted member id", async (t) => {
  const { env, calls } = fixture();
  env.OYSTER_OWNER_NAME = "configured-owner-label";
  const { run, selection, releaseDigest } = await instanceBinding(t, env, [
    "preview",
  ]);
  for (const context of [
    { actor: { kind: "member", memberId: "owner" }, role: "member" },
    { actor: { kind: "member", memberId: "owner" } },
    { actor: { kind: "agent", agentId: "owner" }, role: "owner" },
    { actor: { kind: "team-key", keyId: "owner" }, role: "owner" },
  ]) {
    const response = await run(
      async (computer) => ({
        refused: await refusedCode(computer.preview({ port: 3000 })),
      }),
      {
        computerId: env.OYSTER_COMPUTER_ID,
        ...context,
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { refused: "revoked" });
  }
  assert.deepEqual(calls, []);
  // The owner's tenant member id is never its configured sign-in label; the
  // frame hands the admitted id to the Computer owner, which proves it live.
  const accepted = await run((computer) => computer.preview({ port: 3000 }), {
    computerId: env.OYSTER_COMPUTER_ID,
    actor: { kind: "member", memberId: "member_canonical_owner" },
    role: "owner",
  });
  assert.equal(accepted.status, 200);
  assert.equal(
    (await accepted.json()).previewUrl,
    "https://oyster-contest.levi-fe0.workers.dev/preview/fixture/",
  );
  assert.equal(calls[0].actor, "owner:member_canonical_owner");
  assert.deepEqual(calls[0].selector, {
    ownerId: "member_canonical_owner",
    installationId: "computer-proof",
    selection,
    artifactDigest: releaseDigest,
  });
});

/** A durable-object state over one in-memory database, with the KV both owners read. */
function kvState(database, name) {
  const storage = fromNodeSqlite(database);
  storage.sql.exec(
    "CREATE TABLE fixture_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  return {
    id: { name },
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
    blockConcurrencyWhile: (work) => work(),
  };
}

test("the Computer owner issues port previews to the live canonical owner member, never its configured label", async (t) => {
  const tenantsDatabase = new DatabaseSync(":memory:");
  const computerDatabase = new DatabaseSync(":memory:");
  t.after(() => {
    tenantsDatabase.close();
    computerDatabase.close();
  });
  const artifacts = new Map();
  const persist = async (value) => {
    const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    artifacts.set(artifactRef, bytes);
    return { artifactRef, digest, byteLength: bytes.length, version: digest };
  };
  const declaration = {
    capabilities: ["computer.execute"],
    handlers: [],
    roles: [],
    api: {
      methods: {
        run: {
          description: "Fixture run method",
          input: { type: "object" },
          output: {},
          effect: "write",
          requires: ["computer.execute"],
        },
      },
    },
    backend: { bindings: [{ name: "COMPUTER", operations: ["preview"] }] },
  };
  const backend = {
    ...(await persist({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-25",
      exportName: "Guest",
      code: "export class Guest {}",
    })),
    mediaType: backendMediaType,
  };
  const root = await persist(createAppBuild(null, backend, declaration));
  const release = {
    appId: "app_computerproof",
    releaseId: "rel_computerproof",
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
  const installation = await approvedInstallation({
    installationId: "shed",
    instanceId: instanceIds.instance.generate(),
    release,
    declaration,
  });
  const tenants = new StandaloneTenants(kvState(tenantsDatabase, "registry"));
  const env = {
    OYSTER_ORIGIN: "https://oyster.shiit.app",
    OYSTER_PREVIEW_ORIGIN: "https://oyster-contest.levi-fe0.workers.dev",
    OYSTER_OWNER_NAME: "levi",
    OYSTER_OWNER_KEY: "computer-preview-owner-key-24-characters",
    OYSTER_COMPUTER_ID: "workspace",
    TENANTS: { getByName: () => tenants },
    KEYS: { getByName: () => assert.fail("No credential lookup expected") },
    REGISTRY: {
      getByName: () => ({
        get: async (id) =>
          id === installation.installationId ? installation : null,
      }),
    },
    RELEASES: {
      get: async (ref) => {
        const bytes = artifacts.get(ref);
        return bytes === undefined
          ? null
          : { arrayBuffer: async () => bytes.buffer };
      },
    },
  };
  class ExposedPort extends ComputerDO {
    listPortsAfterAcceptance(accept) {
      accept();
      return Promise.resolve({ ports: [8099] });
    }
  }
  const computer = new ExposedPort(kvState(computerDatabase, "workspace"), env);
  const owner = await (await standaloneTenancy(env)).owner();
  assert.ok(owner);
  assert.notEqual(owner.actor.memberId, env.OYSTER_OWNER_NAME);
  const previews = (ownerId) =>
    computer.portPreviews(
      {
        computerId: "workspace",
        actions: new Set(["listPorts"]),
        expiresAt: Date.now() + 60_000,
        provenance: { actor: `owner:${ownerId}` },
      },
      {
        ownerId,
        installationId: installation.installationId,
        selection: selectionOf(installation),
        artifactDigest: release.artifact.artifactDigest,
      },
    );
  const listed = await previews(owner.actor.memberId);
  assert.equal(listed.kind, "ok");
  const { ports } = listed.value;
  assert.equal(ports.length, 1);
  assert.equal(ports[0].port, 8099);
  assert.equal(ports[0].openMode, "external-only");
  assert.match(
    ports[0].previewUrl,
    /^https:\/\/oyster-contest\.levi-fe0\.workers\.dev\/preview\/workspace\/8099\/[a-z2-7]{20}\/$/u,
  );
  // The configured sign-in label and any other member id are refused typed.
  const refused = {
    kind: "refused",
    code: "forbidden",
    message:
      "Port previews belong to the current owner of an enabled installation.",
  };
  for (const forged of [env.OYSTER_OWNER_NAME, "member_not_the_owner"])
    assert.deepEqual(await previews(forged), refused);
  // The owner route presents the same decision: 200 for the live owner, a
  // typed 403 (never an uncaught 500) for an owner-role principal that is not.
  env.COMPUTER = { getByName: () => computer };
  const routes = serveCapability(
    standaloneComputerCapabilities(env, standaloneWorkspace(env))[0].routes,
    { liveKey: async () => null, appToolPolicy: () => null },
  );
  const portsRoute = (memberId) =>
    routes.request(
      "/ports",
      {},
      {
        principal: { actor: { kind: "member", memberId }, role: "owner" },
        installation,
      },
    );
  const accepted = await portsRoute(owner.actor.memberId);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).ports[0].port, 8099);
  for (const forged of [env.OYSTER_OWNER_NAME, "member_not_the_owner"]) {
    const response = await portsRoute(forged);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: refused.code,
      message: refused.message,
    });
  }
});

test("standalone preview and processStart reject missing operations and forged selectors before native effects", async (t) => {
  const { env, calls, revoke } = fixture();
  const missing = await instanceBinding(t, env, ["ports"]);
  await assert.rejects(
    missing.binding.processStart({ command: "node server.mjs" }),
  );
  await assert.rejects(missing.binding.preview({ port: 3000 }));
  const admitted = await instanceBinding(t, env, ["preview", "processStart"]);
  for (const input of [
    { command: "" },
    { command: "node server.mjs", computerId: "forged" },
    { command: "node server.mjs", actorId: "owner" },
  ])
    await assert.rejects(admitted.binding.processStart(input));
  revoke();
  await admitted.disable();
  await assert.rejects(
    admitted.binding.processStart({ command: "node server.mjs" }),
  );
  assert.deepEqual(calls, []);
});

test("Computer binding packets return to their originating Instance with immutable frame authority", async () => {
  const { env, calls } = fixture();
  const props = {
    instanceId: instanceIds.instance.generate(),
    binding: "COMPUTER",
    frameId: "app_frame_7rid3mf288uvsdldxmu5l",
  };
  const packets = [];
  env.INSTANCES = {
    getByName(instanceId) {
      assert.equal(instanceId, props.instanceId);
      return {
        async bindingCall(authority, method, args) {
          packets.push({ authority, method, args });
          return { kind: "result", value: { ports: [] } };
        },
      };
    },
  };
  const binding = bindingWire.wrap({
    COMPUTER: new OysterBinding({ props }, env),
  }).COMPUTER;
  assert.deepEqual(await binding.ports({}), { ports: [] });
  assert.deepEqual(packets, [
    { authority: props, method: "ports", args: [{}] },
  ]);
  assert.deepEqual(
    calls,
    [],
    "only the resolved Instance may contact the Computer",
  );
});

test("declared file and process bindings preserve native inputs, replies and caller attribution", async (t) => {
  const { env, calls } = fixture();
  const { binding } = await instanceBinding(t, env, [
    "list",
    "read",
    "write",
    "processes",
  ]);
  const listing = { path: "/", limit: 10, offset: 2 };
  const reading = { path: "/proof.txt" };
  const writing = { path: "/proof.txt", content: "new text" };
  assert.deepEqual(await binding.list(listing), {
    path: "/",
    entries: [],
    nextOffset: null,
  });
  assert.deepEqual(await binding.read(reading), {
    path: "/proof.txt",
    byteOffset: 0,
    content: "bmF0aXZlIGZpbGVz",
    encoding: "base64",
    truncated: false,
  });
  assert.deepEqual(await binding.write(writing), {
    path: "/proof.txt",
    bytes: 8,
  });
  assert.deepEqual(await binding.processes({}), { processes: [] });
  assert.deepEqual(calls, [
    { action: "files.list", input: listing, actor: "member:owner" },
    { action: "files.readBytes", input: reading, actor: "member:owner" },
    { action: "files.write", input: writing, actor: "member:owner" },
    { action: "processList", input: {}, actor: "member:owner" },
  ]);
});

test("App bindings enforce declared operations and refuse selectors and disabled installations", async (t) => {
  const { env, calls, revoke } = fixture();
  const { binding, run, disable } = await instanceBinding(t, env, [
    "ports",
    "exec",
  ]);
  assert.deepEqual(await binding.ports({}), { ports: [] });
  const denied = await run(async (computer) => {
    await assert.rejects(computer.read({ path: "/proof.txt" }), {
      code: "binding_not_granted",
    });
    return { refused: true };
  });
  assert.equal(denied.status, 200);
  await assert.rejects(() => binding.ports({ computerId: "guest-selected" }));
  await assert.rejects(() =>
    binding.exec({ command: "pwd", computerId: "guest-selected" }),
  );
  revoke();
  await disable();
  await assert.rejects(binding.ports({}), /instance_inactive/u);
  assert.deepEqual(calls, [
    { action: "listPorts", input: {}, actor: "member:owner" },
  ]);
});

for (const [actor, expected] of [
  [{ kind: "member", memberId: "owner" }, "member:owner"],
  [{ kind: "agent", agentId: "agent_one" }, "agent:agent_one"],
  [{ kind: "team-key", keyId: "key_one" }, "team-key:key_one"],
]) {
  test(`Computer effects use the admitted ${actor.kind} on a Workflow node`, async (t) => {
    const { env, calls, authorities } = fixture();
    const { run } = await instanceBinding(t, env, ["ports"]);
    const response = await run((computer) => computer.ports({}), {
      computerId: env.OYSTER_COMPUTER_ID,
      actor,
      workflow: {
        workflowId: "workflow_one",
        runId: "run_one",
        nodeId: "node_one",
        armedBy: actor,
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ports: [] });
    assert.deepEqual(calls, [
      { action: "listPorts", input: {}, actor: expected },
    ]);
    assert.deepEqual([...authorities[0].actions], ["listPorts"]);
  });
}

test("a retained routing stub is refused between frames and during every successor", async (t) => {
  const { env, calls } = fixture();
  const { run } = await instanceBinding(t, env, ["ports"]);
  let retained;
  assert.equal(
    (
      await run(async (computer) => {
        retained = computer;
        return computer.ports({});
      })
    ).status,
    200,
  );
  await assert.rejects(retained.ports({}), { code: "revoked" });
  for (const actor of [
    { kind: "agent", agentId: "next" },
    { kind: "member", memberId: "owner" },
  ]) {
    const response = await run(
      async (computer) => {
        await assert.rejects(retained.ports({}), { code: "revoked" });
        return computer.ports({});
      },
      {
        computerId: env.OYSTER_COMPUTER_ID,
        actor,
      },
    );
    assert.equal(response.status, 200);
  }
  assert.deepEqual(
    calls.map((call) => call.actor),
    ["member:owner", "agent:next", "member:owner"],
  );
});

test("a Computer grant cannot outlive its admitted frame deadline", async (t) => {
  const { env, authorities } = fixture();
  const { run } = await instanceBinding(t, env, ["ports"]);
  const deadlineAt = Date.now() + 30_000;
  const response = await run(
    (computer) => computer.ports({}),
    undefined,
    deadlineAt,
  );
  assert.equal(response.status, 200);
  assert.equal(authorities[0].expiresAt, deadlineAt);
});

for (const computerId of [null, "another-workspace"]) {
  test(`a Computer binding refuses an admitted context pinned to ${computerId}`, async (t) => {
    const { env, calls } = fixture();
    const { run } = await instanceBinding(t, env, ["ports"]);
    const response = await run(
      async (computer) => {
        await assert.rejects(computer.ports({}), { code: "revoked" });
        return { refused: true };
      },
      { computerId, actor: { kind: "member", memberId: "owner" } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { refused: true });
    assert.deepEqual(calls, []);
  });
}

test("App send packets require a caller-owned requestId with the ordinary UTF-8 bound", () => {
  const { decodeArgs } = agentFrameMethods.AGENTS.send;
  const input = {
    agentId: "morel",
    sessionId: "conversation",
    text: "Continue",
    delivery: "followUp",
  };
  assert.throws(() => decodeArgs([input]));
  for (const requestId of ["intent", "a".repeat(256), "é".repeat(128)]) {
    assert.deepEqual(decodeArgs([{ ...input, requestId }]), [
      { ...input, requestId },
    ]);
  }
  for (const requestId of ["", "a".repeat(257), "é".repeat(129)]) {
    assert.throws(() => decodeArgs([{ ...input, requestId }]));
  }
});

test("App send retries the same intent after an UNKNOWN reply with one real Agent delivery", async (t) => {
  const database = new DatabaseSync(":memory:");
  const agentDatabase = new DatabaseSync(":memory:");
  const tasks = [];
  t.after(async () => {
    for (const task of tasks) await task;
    agentDatabase.close();
    database.close();
  });
  // A named directory Durable Object, as the Worker addresses it.
  const directory = new AgentDirectory(
    { id: { name: "agents" }, storage: fromNodeSqlite(database) },
    { OYSTER_OWNER_NAME: "Levi", OYSTER_ORIGIN: "https://oyster.invalid" },
  );
  const entry = directory.create(
    "Morel",
    "create-morel",
    { actor: { kind: "member", memberId: "Levi" }, role: "owner" },
    "owner-direct",
  );
  const model = fauxModel([
    fauxAssistantMessage("Delivered once"),
    fauxAssistantMessage("A second delivery would be a defect"),
  ]);
  class Receiver extends StandaloneAgent {
    modelSource() {
      return {
        acquire: async () => ({
          model: model.model,
          stream: model.stream,
          release: () => Promise.resolve(),
        }),
      };
    }
    client() {
      return this.shiitake();
    }
    async shiitakeOptions() {
      const options = await super.shiitakeOptions();
      return {
        ...options,
        // This recipient replies with text; App/tool execution is not under test.
        tools: [],
      };
    }
  }
  const { env } = fixture();
  const values = new Map();
  env.AGENT_DIRECTORY = { getByName: () => directory };
  const receiver = new Receiver(
    {
      id: { name: entry.agentId },
      storage: {
        ...cloudflareStorageFixture(fromNodeSqlite(agentDatabase)),
        get: async (key) => values.get(key),
        put: async (key, value) => {
          values.set(key, value);
        },
      },
      waitUntil: (task) => tasks.push(task),
    },
    env,
  );
  await receiver.usePolicyDirectory({
    directoryName: "agents",
    tenantId: defaultTenant,
  });
  const client = await receiver.client();
  const sessionId = await client.createSession("app-send-session");
  let lostReceipt;
  let attempts = 0;
  env.AGENTS = {
    getByName: (agentId) => {
      assert.equal(agentId, entry.agentId);
      return {
        sendFromApp: async (...args) => {
          attempts += 1;
          const receipt = await receiver.sendFromApp(...args);
          if (attempts === 1) {
            lostReceipt = receipt;
            throw new Error("UNKNOWN: receipt lost after real Agent admission");
          }
          return receipt;
        },
      };
    },
  };
  const { run } = await instanceBinding(t, env, ["ports"], "computer-proof", [
    { name: "AGENTS", operations: ["send"] },
  ]);
  // Mint once for this user intent, outside either invocation/retry.
  const input = {
    agentId: entry.agentId,
    sessionId,
    requestId: "app-intent-once",
    text: "Deliver this once",
    delivery: "followUp",
  };
  const send = (_computer, bindings) => bindings.AGENTS.send(input);
  const unknown = await run(send);
  assert.equal(unknown.status, 502);
  assert.ok(
    lostReceipt?.commandId,
    "the real Agent admitted before reply loss",
  );
  const retry = await run(send);
  assert.equal(retry.status, 200, await retry.clone().text());
  const receipt = await retry.json();
  assert.equal(attempts, 2, "the retry reaches the real recipient again");
  for (const task of tasks) await task;
  const snapshot = await client.session(sessionId).read();
  assert.equal(
    snapshot.messages.filter(({ value }) => value.role === "user").length,
    1,
  );
  assert.equal(
    snapshot.terminals.filter(({ outcome }) => outcome === "completed").length,
    1,
  );
  assert.equal(receipt.commandId, lostReceipt.commandId);
});

/** A real standalone Agent kernel and directory; only Worker transport is supplied. */
async function nativeScheduleAgent(t) {
  const database = new DatabaseSync(":memory:");
  const agentDatabase = new DatabaseSync(":memory:");
  const tasks = [];
  const { env } = fixture();
  const scope = scopeOf({ OYSTER_ORIGIN: "https://oyster.invalid" });
  const pin = {
    directoryName: scope.durableName("agents"),
    tenantId: scope.tenantId,
  };
  const directory = new AgentDirectory(
    { id: { name: pin.directoryName }, storage: fromNodeSqlite(database) },
    { OYSTER_OWNER_NAME: "Levi", OYSTER_ORIGIN: "https://oyster.invalid" },
  );
  const principal = {
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  };
  const a = directory.create("A", "create-A", principal, "owner-direct");
  const b = directory.create("B", "create-B", principal, "owner-direct");
  const calls = { addressed: 0, reads: 0, controls: 0, sends: 0, opened: 0 };
  const model = fauxModel([
    fauxAssistantMessage("Retained native history"),
    fauxAssistantMessage("Replacement native work"),
  ]);
  class ScheduleAgent extends StandaloneAgent {
    modelSource() {
      return {
        acquire: async () => ({
          model: model.model,
          stream: model.stream,
          release: () => Promise.resolve(),
        }),
      };
    }
    async shiitakeOptions() {
      calls.opened += 1;
      return { ...(await super.shiitakeOptions()), tools: [] };
    }
    client() {
      return this.shiitake();
    }
    close() {
      return this.closeShiitake();
    }
    readSchedules(...args) {
      calls.reads += 1;
      return super.readSchedules(...args);
    }
    controlSchedule(...args) {
      calls.controls += 1;
      return super.controlSchedule(...args);
    }
    sendFromApp(...args) {
      calls.sends += 1;
      return super.sendFromApp(...args);
    }
  }
  const values = new Map();
  env.AGENT_DIRECTORY = {
    getByName: (name) => {
      assert.equal(name, pin.directoryName);
      return directory;
    },
  };
  const agent = new ScheduleAgent(
    {
      id: { name: a.agentId },
      storage: {
        ...cloudflareStorageFixture(fromNodeSqlite(agentDatabase)),
        get: async (key) => values.get(key),
        put: async (key, value) => {
          values.set(key, value);
        },
      },
      waitUntil: (task) => tasks.push(task),
    },
    env,
  );
  env.AGENTS = {
    getByName: (agentId) => {
      calls.addressed += 1;
      assert.equal(agentId, a.agentId);
      return agent;
    },
  };
  t.after(async () => {
    await agent.close();
    for (const task of tasks) await task;
    agentDatabase.close();
    database.close();
  });
  return { env, agent, a, b, pin, calls, tasks };
}

test("standalone native schedules retain bounded keys, exact receipts and Session history", async (t) => {
  const { agent, a, pin, tasks } = await nativeScheduleAgent(t);
  await agent.usePolicyDirectory(pin);
  const client = await agent.client();
  const sessionId = await client.createSession("retained-schedule-session");
  const almanac = bindAgentExtension(client, almanacContract);
  const loop = bindSessionExtension(client.session(sessionId), loopContract);
  for (const requestId of ["c", "a", "b"])
    await almanac.call("createOneShot", {
      requestId,
      sessionId,
      prompt: "Private Almanac instruction",
      dueAt: Date.now() + 3_600_000,
    });
  const started = await loop.call("startFixedInterval", {
    requestId: "first-loop",
    prompt: "Private Loop instruction",
    expression: "0 * * * *",
    timeZone: "UTC",
  });
  const first = await agent.readSchedules(pin, {
    agentId: a.agentId,
    limit: 2,
  });
  assert.deepEqual(
    first.items.map((row) => row.schedule.id),
    ["a", "b"],
  );
  assert.deepEqual(first.next, {
    agentId: a.agentId,
    kind: "almanac",
    after: "b",
  });
  const second = await agent.readSchedules(pin, {
    agentId: a.agentId,
    limit: 2,
    after: first.next,
  });
  assert.equal(second.items.length, 2);
  assert.equal(second.items[0].schedule.id, "c");
  assert.partialDeepStrictEqual(second.items[1], {
    agentId: a.agentId,
    kind: "loop",
    schedule: {
      sessionId,
      loopId: started.loop.loopId,
      prompt: "Private Loop instruction",
    },
  });
  assert.deepEqual(second.next, {
    agentId: a.agentId,
    kind: "loop",
    after: sessionId,
  });
  assert.deepEqual(
    await agent.readSchedules(pin, {
      agentId: a.agentId,
      limit: 2,
      after: second.next,
    }),
    { items: [], next: null },
  );
  await assert.rejects(
    agent.readSchedules(pin, { agentId: a.agentId, limit: 65 }),
  );
  await assert.rejects(
    agent.readSchedules(pin, {
      agentId: a.agentId,
      after: { agentId: "foreign", kind: "loop" },
    }),
    /another Agent/u,
  );

  for (const task of tasks) await task;
  const history = await client.session(sessionId).read();
  assert.ok(history.messages.length > 0);
  assert.ok(
    history.terminals.some(
      (row) =>
        row.commandId === started.accepted.commandId &&
        row.outcome === "completed",
    ),
  );
  const targets = [
    { agentId: a.agentId, kind: "almanac", scheduleId: "a" },
    {
      agentId: a.agentId,
      kind: "loop",
      sessionId,
      loopId: started.loop.loopId,
    },
  ];
  for (const target of targets) {
    assert.deepEqual(await agent.controlSchedule(pin, target, "pause"), {
      ...target,
      state: "paused",
    });
    assert.deepEqual(await agent.controlSchedule(pin, target, "delete"), {
      ...target,
      state: "cancelled",
    });
  }
  const retained = await client.session(sessionId).read();
  assert.deepEqual(retained.messages, history.messages);
  assert.deepEqual(retained.terminals, history.terminals);
  const replacement = await loop.call("startFixedInterval", {
    requestId: "replacement",
    prompt: "Replacement instruction",
    expression: "0 * * * *",
    timeZone: "UTC",
  });
  for (const action of ["pause", "delete"])
    await assert.rejects(agent.controlSchedule(pin, targets[1], action), {
      boundary: "store",
      cause: "conflict",
    });
  await assert.rejects(
    agent.controlSchedule(
      pin,
      {
        agentId: a.agentId,
        kind: "almanac",
        scheduleId: "missing",
      },
      "pause",
    ),
  );
  assert.deepEqual(
    await agent.controlSchedule(
      pin,
      {
        ...targets[1],
        loopId: replacement.loop.loopId,
      },
      "pause",
    ),
    {
      ...targets[1],
      loopId: replacement.loop.loopId,
      state: "paused",
    },
  );
});

test("standalone schedule initialization refuses before opening the native owner", async (t) => {
  const { agent, a, b, pin, calls } = await nativeScheduleAgent(t);
  const input = { agentId: a.agentId };
  const target = { ...input, kind: "almanac", scheduleId: "once" };
  for (const invoke of [
    () => agent.readSchedules(pin, input),
    () => agent.controlSchedule(pin, target, "pause"),
    () => agent.controlSchedule(pin, target, "delete"),
  ])
    await assert.rejects(invoke(), { code: "revoked" });
  assert.equal(
    calls.opened,
    0,
    "an existing directory row is not initialization",
  );
  await agent.usePolicyDirectory(pin);
  for (const expected of [
    { ...pin, directoryName: "another-directory" },
    { ...pin, tenantId: "another-tenant" },
  ]) {
    await assert.rejects(agent.readSchedules(expected, input), {
      code: "revoked",
    });
    await assert.rejects(agent.controlSchedule(expected, target, "pause"), {
      code: "revoked",
    });
    await assert.rejects(agent.controlSchedule(expected, target, "delete"), {
      code: "revoked",
    });
  }
  await assert.rejects(agent.readSchedules(pin, { agentId: b.agentId }), {
    code: "revoked",
  });
  assert.equal(calls.opened, 0);
  assert.deepEqual(await agent.readSchedules(pin, input), {
    items: [],
    next: null,
  });
  assert.equal(calls.opened, 1);
});

test("standalone AGENTS packets match finite selected Agents with one live Registry read", async (t) => {
  const { env, agent, a, b, pin, calls } = await nativeScheduleAgent(t);
  await agent.usePolicyDirectory(pin);
  const client = await agent.client();
  const almanac = bindAgentExtension(client, almanacContract);
  await almanac.call("createOneShot", {
    requestId: "once",
    sessionId: "garden",
    prompt: "Private native prompt",
    dueAt: Date.now() + 3_600_000,
  });
  const methods = ["schedules", "pauseSchedule", "deleteSchedule", "send"];
  const proof = await instanceBinding(
    t,
    env,
    ["ports"],
    "schedule-proof",
    [{ name: "AGENTS", operations: methods }],
    undefined,
    undefined,
    false,
    { agentResources: [{ kind: "agent", id: a.agentId }] },
  );
  const result = await proof.run(async (_computer, { AGENTS }) => {
    const packet = async (invoke) => {
      const before = proof.registryReads();
      try {
        return await invoke();
      } finally {
        assert.equal(proof.registryReads() - before, 1);
      }
    };
    const target = { agentId: a.agentId, kind: "almanac", scheduleId: "once" };
    const inputFor = (method, agentId) =>
      method === "schedules"
        ? { agentId }
        : method === "send"
          ? {
              agentId,
              sessionId: "garden",
              requestId: "finite-send",
              text: "An independently admitted send",
              delivery: "followUp",
            }
          : { ...target, agentId };
    const dispatches = () => calls.reads + calls.controls + calls.sends;
    for (const method of methods) {
      const before = dispatches();
      await assert.rejects(
        packet(() => AGENTS[method](inputFor(method, b.agentId))),
        { code: "binding_not_granted" },
      );
      assert.equal(dispatches(), before);
      assert.equal(
        calls.addressed,
        0,
        "finite selection refuses before AGENTS addressing",
      );
    }
    for (const invalid of [
      { agentId: a.agentId, limit: 65 },
      {
        agentId: a.agentId,
        after: {
          agentId: a.agentId,
          kind: "almanac",
          after: "not/a/native/key",
        },
      },
    ])
      await assert.rejects(packet(() => AGENTS.schedules(invalid)));
    assert.equal(
      dispatches(),
      0,
      "invalid serialized inputs never reach the owner",
    );
    assert.equal(calls.addressed, 0);
    const page = await packet(() =>
      AGENTS.schedules({ agentId: a.agentId, limit: 1 }),
    );
    assert.partialDeepStrictEqual(page, {
      items: [
        {
          kind: "almanac",
          schedule: { id: "once", prompt: "Private native prompt" },
        },
      ],
      next: { agentId: a.agentId, kind: "almanac", after: "once" },
    });
    assert.deepEqual(await packet(() => AGENTS.pauseSchedule(target)), {
      ...target,
      state: "paused",
    });
    assert.deepEqual(await packet(() => AGENTS.deleteSchedule(target)), {
      ...target,
      state: "cancelled",
    });
    assert.equal(
      (await packet(() => AGENTS.send(inputFor("send", a.agentId)))).status,
      "accepted",
    );
    const beforeRevocation = dispatches();
    const addressedBeforeRevocation = calls.addressed;
    await proof.changeAgentResources(null);
    for (const method of methods)
      await assert.rejects(
        packet(() => AGENTS[method](inputFor(method, a.agentId))),
        { code: "revoked" },
      );
    assert.equal(dispatches(), beforeRevocation);
    assert.equal(calls.addressed, addressedBeforeRevocation);
    return { refused: true };
  });
  assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(await result.json(), { refused: true });
});

test("standalone AGENTS initialization failure addresses the owner but opens no native runtime", async (t) => {
  const { env, agent, a, pin, calls } = await nativeScheduleAgent(t);
  const methods = ["schedules", "pauseSchedule", "deleteSchedule"];
  const proof = await instanceBinding(
    t,
    env,
    ["ports"],
    "schedule-init-proof",
    [{ name: "AGENTS", operations: methods }],
  );
  const result = await proof.run(async (_computer, { AGENTS }) => {
    const target = { agentId: a.agentId, kind: "almanac", scheduleId: "once" };
    for (const method of methods) {
      const before = proof.registryReads();
      await assert.rejects(
        AGENTS[method](
          method === "schedules" ? { agentId: a.agentId } : target,
        ),
        { code: "revoked" },
      );
      assert.equal(proof.registryReads() - before, 1);
    }
    assert.equal(calls.addressed, 3, "initialization is an owner-side fence");
    assert.equal(calls.opened, 0, "no schedule extension was opened");
    await agent.usePolicyDirectory(pin);
    const before = proof.registryReads();
    assert.deepEqual(await AGENTS.schedules({ agentId: a.agentId }), {
      items: [],
      next: null,
    });
    assert.equal(proof.registryReads() - before, 1);
    assert.equal(calls.opened, 1);
    return { initialized: true };
  });
  assert.equal(result.status, 200, await result.clone().text());
});

for (const operation of ["schedules", "pauseSchedule", "deleteSchedule"]) {
  test(`standalone ${operation} does not acquire the other schedule authority`, async (t) => {
    const { env, agent, a, pin, calls } = await nativeScheduleAgent(t);
    await agent.usePolicyDirectory(pin);
    const client = await agent.client();
    await bindAgentExtension(client, almanacContract).call("createOneShot", {
      requestId: "once",
      sessionId: "garden",
      prompt: "Not a manage receipt",
      dueAt: Date.now() + 3_600_000,
    });
    const proof = await instanceBinding(
      t,
      env,
      ["ports"],
      "schedule-authority-proof",
      [{ name: "AGENTS", operations: [operation] }],
    );
    const result = await proof.run(async (_computer, { AGENTS }) => {
      const target = {
        agentId: a.agentId,
        kind: "almanac",
        scheduleId: "once",
      };
      const input = operation === "schedules" ? { agentId: a.agentId } : target;
      const before = proof.registryReads();
      const accepted = await AGENTS[operation](input);
      assert.equal(proof.registryReads() - before, 1);
      const denied =
        operation === "schedules"
          ? ["pauseSchedule", "deleteSchedule", "send"]
          : ["schedules", "send"];
      const dispatches = calls.reads + calls.controls + calls.sends;
      for (const method of denied) {
        const args =
          method === "schedules"
            ? { agentId: a.agentId }
            : method === "send"
              ? {
                  agentId: a.agentId,
                  sessionId: "garden",
                  requestId: "not-granted",
                  text: "Must not send",
                  delivery: "followUp",
                }
              : target;
        const before = proof.registryReads();
        await assert.rejects(AGENTS[method](args), {
          code: "binding_not_granted",
        });
        assert.equal(proof.registryReads() - before, 1);
      }
      assert.equal(calls.reads + calls.controls + calls.sends, dispatches);
      if (operation !== "schedules")
        assert.deepEqual(accepted, {
          ...target,
          state: operation === "pauseSchedule" ? "paused" : "cancelled",
        });
      return { admitted: true };
    });
    assert.equal(result.status, 200, await result.clone().text());
  });
}

test("cached Agent bindings admit only the current frame before fleet effects", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  // A named directory Durable Object, as the Worker addresses it.
  const directory = new AgentDirectory(
    { id: { name: "agents" }, storage: fromNodeSqlite(database) },
    { OYSTER_OWNER_NAME: "Levi", OYSTER_ORIGIN: "https://oyster.invalid" },
  );
  const agent = directory.create(
    "Morel",
    "create-morel",
    { actor: { kind: "member", memberId: "Levi" }, role: "owner" },
    "owner-direct",
  );
  const sends = [];
  const { env } = fixture();
  const { run } = await instanceBinding(
    t,
    {
      ...env,
      AGENT_DIRECTORY: { getByName: () => directory },
      AGENTS: {
        getByName: (agentId) => {
          assert.equal(agentId, agent.agentId);
          return {
            inboxRows: async () => ({ rows: [], revision: 10 }),
            sendFromApp: async (installationId, sessionId, message) => {
              sends.push({ installationId, sessionId, message });
              return { status: "accepted", commandId: "command_one" };
            },
          };
        },
      },
    },
    ["ports"],
    "computer-proof",
    [
      { name: "INBOX", operations: ["page", "visit"] },
      { name: "AGENTS", operations: ["send"] },
    ],
  );
  const input = {
    agentId: agent.agentId,
    sessionId: "conversation",
    requestId: "continue-work",
    text: "Continue the work",
    delivery: "followUp",
  };
  let retained;
  const send = (_computer, bindings) => {
    retained = bindings.AGENTS;
    return bindings.AGENTS.send(input);
  };
  const first = await run(send);
  assert.equal(first.status, 200, await first.clone().text());
  assert.deepEqual(await first.json(), {
    status: "accepted",
    commandId: "command_one",
  });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].installationId, "computer-proof");
  assert.equal(sends[0].sessionId, input.sessionId);
  assert.equal(sends[0].message.text, input.text);
  assert.equal(sends[0].message.delivery, input.delivery);
  assert.equal(sends[0].message.requestId, input.requestId);
  const missing = await run(async (_computer, bindings) => {
    await assert.rejects(
      bindings.AGENTS.send({ ...input, agentId: "unknown" }),
      /No such agent/u,
    );
    await assert.rejects(
      bindings.INBOX.visit({ agentId: "unknown", sessionId: "conversation" }),
      /No such agent/u,
    );
    return { refused: true };
  });
  assert.equal(missing.status, 200);
  assert.equal(sends.length, 1, "missing targets never dispatch");
  await assert.rejects(retained.send(input), /revoked/u);
  const denied = await run(
    async (_computer, bindings) => {
      await assert.rejects(bindings.AGENTS.send(input), {
        code: "binding_not_granted",
      });
      return { refused: true };
    },
    undefined,
    undefined,
    [],
  );
  assert.equal(denied.status, 200);
  assert.equal(sends.length, 1);
  const page = await run((_computer, bindings) => bindings.INBOX.page());
  assert.deepEqual(await page.json(), { items: [], next: null, cursor: 11 });
  const visit = await run((_computer, bindings) =>
    bindings.INBOX.visit({ agentId: agent.agentId, sessionId: "conversation" }),
  );
  assert.deepEqual(await visit.json(), { visited: true });
  const deniedVisit = await run(
    async (_computer, bindings) => {
      await assert.rejects(
        bindings.INBOX.visit({ agentId: agent.agentId, sessionId: "other" }),
        { code: "binding_not_granted" },
      );
      return { refused: true };
    },
    undefined,
    undefined,
    [],
  );
  assert.equal(deniedVisit.status, 200);
  assert.equal(directory.visits().length, 1);
  assert.equal((await run(send)).status, 200);
  assert.equal(sends.length, 2);
});

for (const binding of ["COMPUTER", "WORKFLOWS"]) {
  test(`a delayed Bonsai ${binding} packet cannot borrow the successor frame`, async (t) => {
    const { env, calls } = fixture();
    const workflowCalls = [];
    env.WORKFLOW_RUNS = {
      getByName: () => ({
        catalog: async (facts) => {
          workflowCalls.push(facts.subject.context.actor);
          return { apps: [] };
        },
      }),
    };
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    let hold = false;
    const { run } = await instanceBinding(
      t,
      env,
      ["ports"],
      "computer-proof",
      [{ name: "WORKFLOWS", operations: ["catalog"] }],
      async (props) => {
        if (hold && props.binding === binding) {
          hold = false;
          arrived.resolve();
          await release.promise;
        }
      },
    );
    const invoke = (stub) =>
      binding === "COMPUTER" ? stub.ports({}) : stub.catalog({});
    let retained;
    let delayed;
    const first = await run(async (_computer, bindings) => {
      retained = bindings[binding];
      hold = true;
      delayed = assert.rejects(invoke(retained), { code: "revoked" });
      await arrived.promise;
      return {};
    });
    assert.equal(first.status, 200);
    await assert.rejects(invoke(retained), { code: "revoked" });
    const second = await run(async (_computer, bindings) => {
      release.resolve();
      await delayed;
      assert.equal(calls.length + workflowCalls.length, 0);
      return invoke(bindings[binding]);
    });
    assert.equal(second.status, 200);
    assert.equal(calls.length + workflowCalls.length, 1);
    await assert.rejects(invoke(retained), { code: "revoked" });
    assert.equal(calls.length + workflowCalls.length, 1);
  });
}

for (const [binding, method, valid] of [
  ["INBOX", "page", { items: [], next: null, cursor: 0 }],
  ["INBOX", "visit", { visited: true }],
  ["AGENTS", "send", { status: "accepted", commandId: "work-1" }],
]) {
  test(`${binding}.${method} decodes its domain reply separately from local refusals`, () => {
    const { decodeResult } = agentFrameMethods[binding][method];
    assert.deepEqual(decodeResult(valid), valid);
    for (const invalid of [
      null,
      false,
      [],
      {},
      { kind: "local_refusal", code: "revoked" },
    ]) {
      assert.throws(() => decodeResult(invalid));
    }
  });
}

for (const tenantId of ["default", "alpha"]) {
  test(`Agent provider uses the host-selected ${tenantId} directory`, async (t) => {
    const { tenantScope } = await import("@fungi.computer/oyster/tenant");
    const origin = "https://oyster.invalid";
    const scope = tenantScope(tenantId, origin);
    const directories = [];
    const sends = [];
    const { env } = fixture();
    const { run } = await instanceBinding(
      t,
      {
        ...env,
        AGENT_DIRECTORY: {
          getByName: (name) => {
            directories.push(name);
            assert.equal(name, scope.durableName("agents"));
            return {
              has: async () => true,
              agentHome: async () => ({ kind: "hosted" }),
            };
          },
        },
        AGENTS: {
          getByName: () => ({
            sendFromApp: async (...args) => {
              sends.push(args);
              return { status: "accepted", commandId: "command_one" };
            },
          }),
        },
      },
      ["ports"],
      "computer-proof",
      [{ name: "AGENTS", operations: ["send"] }],
      () => Promise.resolve(),
      { tenantId, origin },
    );
    const response = await run((_computer, bindings) =>
      bindings.AGENTS.send({
        agentId: "morel",
        sessionId: "conversation",
        requestId: "continue-work",
        text: "Continue",
        delivery: "followUp",
      }),
    );
    assert.deepEqual(directories, [scope.durableName("agents")]);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(sends.length, 1);
  });
}

test("StandaloneInstance blocks Computer and Workflow replay effects until claimed-origin admission", async (t) => {
  const { env, calls } = fixture();
  env.OYSTER_OWNER_KEY = "computer-replay-fixture-not-a-real-secret";
  const workflowCalls = [];
  env.WORKFLOW_RUNS = {
    getByName: (installationId) => ({
      catalog: async (facts) => {
        workflowCalls.push({
          installationId,
          actor: facts.subject.context.actor,
        });
        return { apps: [] };
      },
    }),
  };
  const { call, instanceId } = await instanceBinding(
    t,
    env,
    ["ports"],
    "computer-proof",
    [{ name: "WORKFLOWS", operations: ["catalog"] }],
    undefined,
    undefined,
    true,
  );
  const key = await backgroundOriginKey(env.OYSTER_OWNER_KEY);
  const origin = await sealBackgroundOrigin(key, {
    instanceId,
    lane: "member:owner",
    method: "run",
  });
  const result = await call(async (computer, { WORKFLOWS, BACKGROUND }) => {
    await assert.rejects(computer.ports({}), { code: "revoked" });
    await assert.rejects(WORKFLOWS.catalog({}), { code: "revoked" });
    assert.deepEqual(calls, []);
    assert.deepEqual(workflowCalls, []);
    assert.deepEqual(await BACKGROUND.admit(origin), { kind: "admitted" });
    assert.deepEqual(await computer.ports({}), { ports: [] });
    assert.deepEqual(await WORKFLOWS.catalog({}), { apps: [] });
    return { admitted: true };
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { admitted: true });
  assert.deepEqual(calls, [
    { action: "listPorts", input: {}, actor: "member:owner" },
  ]);
  assert.deepEqual(workflowCalls, [
    {
      installationId: "computer-proof",
      actor: { kind: "member", memberId: "owner" },
    },
  ]);
});

test("MCP Computer tools carry the HTTP routes' caller grant; visitors and Agents get none", async () => {
  const id = "host-selected-workspace";
  const calls = [];
  const env = {
    OYSTER_COMPUTER_ID: id,
    OYSTER_ORIGIN: "https://oyster.invalid",
    COMPUTER: {
      getByName: (name) => {
        assert.equal(name, id);
        return {
          tool: async (authority, capabilityId, input) => {
            calls.push({ authority, capabilityId, input });
            return { status: "succeeded", output: null };
          },
        };
      },
    },
    // The "named" key below carries its own computer.use grant.
    KEYS: {
      getByName: () => ({
        live: async (keyId) => ({
          keyId,
          owner: "owner",
          grantVersion: 1,
          grants: [{ capability: "computer.use", targets: { kind: "all" } }],
        }),
      }),
    },
  };
  const workspace = standaloneWorkspace(env, keysLiveOf(env));
  assert.equal(
    await workspace.computer({
      actor: { kind: "agent", agentId: "agent-one" },
    }),
    null,
  );
  for (const principal of [
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    { actor: { kind: "team-key", keyId: "named" } },
    { actor: { kind: "member", memberId: "member-one" }, role: "member" },
  ]) {
    const actor = JSON.stringify(principal);
    calls.length = 0;
    const computer = await workspace.computer(principal);
    assert.ok(computer);
    assert.deepEqual(
      await computer.getCapabilities(new globalThis.AbortController().signal),
      computerCapabilities(),
    );
    assert.deepEqual(await computer.call("exec", { command: "ls" }), {
      status: "succeeded",
      output: null,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].capabilityId, "exec");
    assert.equal(calls[0].authority.computerId, id);
    assert.equal(calls[0].authority.provenance.actor, actor);
    assert.ok(calls[0].authority.actions.has("exec"));
  }
});

// The standalone Computer's native execution hooks: each library's run owner
// issues, renews and closes its own credential; nothing is live before the
// native Computer proves it.
test("standalone execution hooks reach the grant's own library issuer; an unopened invocation is not live", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const calls = [];
    const issuer = (library) => ({
      async issueWorkflowGit(invocationId, grant) {
        calls.push(["issue", library, invocationId, grant.runId]);
        return {
          bearer: "wgp." + library + "." + "d".repeat(64),
          remote: "https://oyster.test/git/bonsai/pond.git",
          expiresAt: 61_000,
        };
      },
      async renewWorkflowGit(invocationId) {
        calls.push(["renew", library, invocationId]);
      },
      async closeWorkflowGit(invocationId) {
        calls.push(["close", library, invocationId]);
      },
    });
    const computer = new ComputerDO(
      { id: { name: "workspace" }, storage: fromNodeSqlite(database) },
      { WORKFLOW_RUNS: { getByName: issuer } },
    );
    const grant = (library) => ({
      teamId: library,
      computerId: "workspace",
      memberId: "owner",
      runId: "run-" + library,
      workflow: {
        workflowId: "save",
        runId: "run-" + library,
        nodeId: "push",
        armedBy: { kind: "member", memberId: "owner" },
      },
      nodeId: "push",
      iteration: "0",
      scope: "write",
      gitAccess: {
        repository: {
          kind: "installation",
          installationId: "bonsai",
          repository: "pond",
        },
        branches: ["refs/heads/main"],
      },
    });
    const hooks = computer.executionHooks();
    const opened = await hooks.open(
      { id: "exec:a", kind: "exec" },
      { workflowGit: grant("library-a") },
    );
    assert.deepEqual(opened, {
      env: {
        FUNGI_GIT_REMOTE: "https://oyster.test/git/bonsai/pond.git",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0:
          "http.https://oyster.test/git/bonsai/pond.git.extraHeader",
        GIT_CONFIG_VALUE_0:
          "Authorization: Bearer wgp.library-a." + "d".repeat(64),
      },
    });
    await hooks.renew(
      { id: "process:b", kind: "process" },
      { workflowGit: grant("library-b") },
    );
    await hooks.close(
      { id: "exec:a", kind: "exec" },
      { workflowGit: grant("library-a") },
      "native_exit",
    );
    assert.deepEqual(calls, [
      ["issue", "library-a", "exec:a", "run-library-a"],
      ["renew", "library-b", "process:b"],
      ["close", "library-a", "exec:a"],
    ]);
    // A context that is not exactly a public grant reaches no issuer.
    await assert.rejects(
      hooks.open(
        { id: "exec:c", kind: "exec" },
        { workflowGit: { ...grant("library-a"), bearer: "wgp.x" } },
      ),
    );
    assert.equal(calls.length, 3);
    // No native subscriber was ever opened for this invocation.
    assert.equal(await computer.executionIsLive("exec:a"), false);
  } finally {
    database.close();
  }
});

test("only a native command carries an exact public Workflow Git context", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const computer = new ComputerDO(
      { id: { name: "workspace" }, storage: fromNodeSqlite(database) },
      {},
    );
    const grant = {
      teamId: "library",
      computerId: "workspace",
      memberId: "owner",
      runId: "run_1",
      workflow: {
        workflowId: "save",
        runId: "run_1",
        nodeId: "push",
        armedBy: { kind: "member", memberId: "owner" },
      },
      nodeId: "push",
      iteration: "0",
      scope: "read",
      gitAccess: {
        repository: {
          kind: "installation",
          installationId: "bonsai",
          repository: "pond",
        },
        access: "read",
      },
    };
    const authority = {
      computerId: "workspace",
      actions: new Set(["exec"]),
      expiresAt: Date.now() + 60_000,
      provenance: { actor: "member:owner" },
    };
    const exec = { command: "git fetch" };
    // Anything beyond the public grant is not an execution context at all.
    await assert.rejects(
      computer.value(authority, "exec", exec, {
        workflowGit: { ...grant, bearer: "wgp.library." + "e".repeat(64) },
      }),
      { code: "binding_unavailable" },
    );
    // A file or port operation never carries one.
    await assert.rejects(
      computer.value(
        { ...authority, actions: new Set(["files.list"]) },
        "files.list",
        { path: "/" },
        { workflowGit: grant },
      ),
      { code: "binding_unavailable" },
    );
  } finally {
    database.close();
  }
});

test("the Computer owner refuses a tool call whose grant does not admit it", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const computer = new ComputerDO(
      {
        id: { name: "host-selected-workspace" },
        storage: fromNodeSqlite(database),
      },
      {},
    );
    const grant = {
      computerId: "host-selected-workspace",
      actions: new Set(["exec"]),
      expiresAt: Date.now() + 60_000,
      provenance: { actor: "owner:owner" },
    };
    for (const refused of [
      { ...grant, computerId: "another-workspace" },
      { ...grant, actions: new Set(["files.read"]) },
      { ...grant, expiresAt: Date.now() - 1 },
    ])
      await assert.rejects(
        computer.tool(refused, "exec", { command: "ls" }),
        FleetGrantRefused,
      );
    await assert.rejects(
      computer.tool(grant, "terminal", {}),
      /Invalid option/u,
    );
  } finally {
    database.close();
  }
});

test("App build preflight reports typed no_backend for a local-only Computer", async () => {
  const { createFleetBacking } = await import("@fungi.computer/computer/fleet");
  const { Buffer } = await import("node:buffer");
  const database = new DatabaseSync(":memory:");
  try {
    const storage = fromNodeSqlite(database);
    const backing = createFleetBacking(storage);
    backing.ensure();
    backing.computerCreated("local-build", []);
    backing.attachLocal("owner", {
      computerId: "local-build",
      requestId: "local-build-attach",
      publicKey: Buffer.alloc(32, 7).toString("base64"),
      hostLabel: "Laptop",
      folderLabel: "App",
    });
    const computer = new ComputerDO(
      {
        id: { name: "local-build", toString: () => "local-build-object" },
        storage,
      },
      {
        REGISTRY: {
          getByName: () => ({ admitBuildExecution: async () => true }),
        },
      },
    );
    assert.deepEqual(await computer.buildBackend(), { kind: "no_backend" });
    await assert.rejects(
      computer.runBuild({
        jobId: "build_fixture",
        command: "echo must-not-run",
        timeoutMs: 1000,
      }),
      { code: "no_backend" },
    );
  } finally {
    database.close();
  }
});
