import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { URL } from "node:url";

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
const { createAppBuild } = await import("@fungi.computer/puffball/app");
const { backendMediaType } = await import("@fungi.computer/puffball/backend");
const { standaloneWorkspace, standaloneComputerCapabilities, ComputerDO } =
  await import("../../src/standalone/computer.ts");
const { StandaloneInstance } = await import("../../src/standalone/worker.ts");
const { ComputerFileConflict } = await import("@fungi.computer/computer");
const {
  mintComputerProcessId,
  ComputerPortConflictError,
  computerCapabilities,
} = await import("@fungi.computer/computer/operations");
const { FleetGrantRefused } = await import("@fungi.computer/computer/fleet");
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
      "computer.list",
      "computer.readFile",
      "computer.writeFile",
      "computer.execute",
      ...agentBindings.flatMap(({ name }) =>
        name === "INBOX"
          ? ["agent.read"]
          : name === "WORKFLOWS"
            ? ["workflow.run"]
            : ["agent.send"],
      ),
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
  const selected = {
    instanceId,
    appId: release.appId,
    releaseId: release.releaseId,
    authorityVersion: 1,
    owner: { kind: "installation", id: installationId },
  };
  const installation = await approvedInstallation({
    installationId: selected.owner.id,
    instanceId,
    release,
    declaration,
  });
  const registry = env.REGISTRY;
  const cache = new Map();
  let perform;
  let facet;
  let instance;
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
        get: async () => ({
          ...installation,
          status: (await registry.getByName("registry").get("computer-proof"))
            .status,
        }),
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
        return { getDurableObjectClass: () => cache.get(id) };
      },
    },
  };
  const Instance = host.Instance ?? StandaloneInstance;
  instance = new Instance(
    {
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
            OysterBinding: ({ props }) =>
              new OysterBinding({ props }, bindings),
          },
      facets: {
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
    },
    bindings,
  );
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
    close: () => instance.revoke(installationId),
    /** The host applies a disabled owner state, as it does on every status change. */
    disable: async () =>
      assert.equal(
        (
          await instance.apply(
            {
              ...selected,
              authorityVersion: selected.authorityVersion + 1,
              status: "disabled",
            },
            release,
            undefined,
            tenant ?? defaultScope,
          )
        ).ok,
        true,
      ),
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
  const computer = new FilePorts({ id: { name: computerId } }, {});
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
    const routes = standaloneComputerCapabilities(
      env,
      workspace,
      keysLiveOf(env),
    )[0].routes;
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
    const routes = standaloneComputerCapabilities(
      env,
      standaloneWorkspace(env, keysLiveOf(env)),
      keysLiveOf(env),
    )[0].routes;
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
  const routes = standaloneComputerCapabilities(
    env,
    standaloneWorkspace(env, keysLiveOf(env)),
    keysLiveOf(env),
  )[0].routes;
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
    const routes = standaloneComputerCapabilities(
      env,
      standaloneWorkspace(env),
    )[0].routes;
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
  const routes = standaloneComputerCapabilities(
    env,
    standaloneWorkspace(env, keysLiveOf(env)),
    keysLiveOf(env),
  )[0].routes;
  const ports = (principal) =>
    routes.request("/ports", {}, { principal, installation });
  // Port previews stay owner-only even for an admitted key.
  const key = await ports({ actor: { kind: "team-key", keyId: "caller" } });
  assert.equal(key.status, 403);
  assert.deepEqual(await key.json(), {
    error: "Owner preview access required",
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
  const routes = standaloneComputerCapabilities(
    env,
    standaloneWorkspace(env, keysLiveOf(env)),
    keysLiveOf(env),
  )[0].routes;
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
  const native = new UnavailablePort(
    { id: { name: env.OYSTER_COMPUTER_ID } },
    {},
  );
  env.COMPUTER = { getByName: () => native };
  const { binding } = await instanceBinding(t, env, ["processStart"]);
  assert.deepEqual(
    await binding.processStart({ command: "serve", port: 3000 }),
    { error: "conflict" },
  );
  const routes = standaloneComputerCapabilities(
    env,
    standaloneWorkspace(env, keysLiveOf(env)),
    keysLiveOf(env),
  )[0].routes;
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
  const routes = standaloneComputerCapabilities(
    env,
    standaloneWorkspace(env),
  )[0].routes;
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

test("cached Agent bindings admit only the current frame before fleet effects", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const directory = new AgentDirectory(
    { storage: fromNodeSqlite(database) },
    { OYSTER_OWNER_NAME: "Levi" },
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
  assert.ok(sends[0].message.requestId.length > 0);
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
            return { has: async () => true };
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
  assert.equal(await workspace.computer({ actor: { kind: "visitor" } }), null);
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
