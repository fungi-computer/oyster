import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { URL } from "node:url";
import * as Schema from "effect/Schema";
import { invokeNativeGit } from "@fungi.computer/agar/git-rpc";

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
const { createArtifactsGit, OysterBinding } =
  await import("../dist/workers-git.js");
const { instanceIds } = await import("../dist/index.js");
const { frameBindingPropsSchema } = await import("../dist/cloudflare.js");
hooks.deregister();

function bindingFixture({ refuseCleanup = false } = {}) {
  const calls = [];
  const options = [];
  const info = (name) => ({
    id: `id-${name}`,
    name,
    defaultBranch: "main",
    remote: `https://fixture.artifacts.cloudflare.net/git/default/${name}.git`,
  });
  const created = (name) => ({ ...info(name), token: `initial-${name}` });
  return {
    calls,
    options,
    binding: {
      create: async (name, input) => {
        calls.push(`create:${name}`);
        options.push(input);
        return created(name);
      },
      get: async (name) => ({
        info: async () => info(name),
        createToken: async () => ({
          id: "exchange-id",
          plaintext: "fixture-exchange-token",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
        revokeToken: async (token) => {
          calls.push(`revoke:${name}:${token}`);
          if (refuseCleanup)
            throw new Error("provider-private-token must not escape");
          return true;
        },
        fork: async (target, input) => {
          calls.push(`fork:${name}:${target}`);
          options.push(input);
          return created(target);
        },
      }),
      list: async () => ({
        repos: [{ name: "notes--fork", status: "ready" }],
        total: 1,
      }),
      delete: async (name) => {
        calls.push(`delete:${name}`);
        return true;
      },
    },
  };
}

test("Git create defaults omitted fields while preserving explicit provider options", async () => {
  const cases = [
    [undefined, "", "main"],
    [{}, "", "main"],
    [{ description: "Draft" }, "Draft", "main"],
    [{ defaultBranch: "feature" }, "", "feature"],
    [{ description: "", defaultBranch: "" }, "", ""],
    [{ description: "Draft", defaultBranch: "feature" }, "Draft", "feature"],
  ];
  for (const [input, description, setDefaultBranch] of cases) {
    const { calls, options, binding } = bindingFixture();
    const git = createArtifactsGit(binding, "notes--", {
      operations: ["create"],
    });
    const result = await git.create("draft", input);
    assert.deepEqual(options, [
      { description, readOnly: false, setDefaultBranch },
    ]);
    assert.equal("token" in result, false);
    assert.deepEqual(calls, [
      "create:notes--draft",
      "revoke:notes--draft:initial-notes--draft",
    ]);
  }
});

test("Git fork defaults omitted descriptions and keeps destination cleanup and readiness", async () => {
  for (const [input, description] of [
    [undefined, ""],
    [{}, ""],
    [{ description: "Fork" }, "Fork"],
    [{ description: "" }, ""],
  ]) {
    const { calls, options, binding } = bindingFixture();
    const git = createArtifactsGit(binding, "notes--", {
      operations: ["fork"],
    });
    const result = await git.fork("source", "fork", input);
    assert.equal(result.name, "fork");
    assert.equal("token" in result, false);
    assert.deepEqual(options, [
      { description, readOnly: false, defaultBranchOnly: false },
    ]);
    assert.deepEqual(calls, [
      "fork:notes--source:notes--fork",
      "revoke:notes--fork:initial-notes--fork",
    ]);
  }
});

test("omitted Git options cannot bypass the operation grant", async () => {
  const { calls, binding } = bindingFixture();
  const git = createArtifactsGit(binding, "notes--", { operations: ["read"] });
  await assert.rejects(git.create("draft"), /Git operation denied: create/u);
  await assert.rejects(
    git.fork("source", "fork"),
    /Git operation denied: fork/u,
  );
  assert.deepEqual(calls, []);
});

test("the GIT entrypoint forwards canonical omitted create and fork options", async () => {
  const { calls, options, binding } = bindingFixture();
  const physical = createArtifactsGit(binding, "notes--", {
    operations: ["create", "fork"],
  });
  const props = Schema.decodeUnknownSync(frameBindingPropsSchema)({
    instanceId: instanceIds.instance.generate(),
    frameId: "app_frame_7rid3mf288uvsdldxmu5l",
    binding: "GIT",
  });
  const packets = [];
  // This fixture proves forwarding and provider defaults; gate admission has
  // its own invocation suite.
  const git = new OysterBinding(
    { props },
    {
      INSTANCES: {
        getByName(instanceId) {
          assert.equal(instanceId, props.instanceId);
          return {
            async bindingCall(authority, method, args) {
              packets.push({ authority, method, args });
              return {
                kind: "result",
                value: await invokeNativeGit(physical, method, args),
              };
            },
          };
        },
      },
    },
  );
  await git.create("draft");
  await git.fork("source", "fork");
  assert.deepEqual(packets, [
    { authority: props, method: "create", args: ["draft"] },
    { authority: props, method: "fork", args: ["source", "fork"] },
  ]);
  assert.deepEqual(options, [
    { description: "", readOnly: false, setDefaultBranch: "main" },
    { description: "", readOnly: false, defaultBranchOnly: false },
  ]);
  assert.deepEqual(calls, [
    "create:notes--draft",
    "revoke:notes--draft:initial-notes--draft",
    "fork:notes--source:notes--fork",
    "revoke:notes--fork:initial-notes--fork",
  ]);
});

test("Oyster create revokes the initial binding token and never returns it to the App", async () => {
  const { calls, binding } = bindingFixture();
  const git = createArtifactsGit(binding, "notes--", {
    operations: ["create"],
  });
  const result = await git.create("draft", {
    description: "Draft",
    defaultBranch: "main",
  });
  assert.deepEqual(result, {
    name: "draft",
    defaultBranch: "main",
    lastPushAt: null,
    source: null,
  });
  assert.deepEqual(calls, [
    "create:notes--draft",
    "revoke:notes--draft:initial-notes--draft",
  ]);
});

test("Oyster fork revokes only the new destination's initial binding token", async () => {
  const { calls, binding } = bindingFixture();
  const git = createArtifactsGit(binding, "notes--", { operations: ["fork"] });
  const result = await git.fork("source", "fork", { description: "Fork" });
  assert.equal(result.name, "fork");
  assert.equal("token" in result, false);
  assert.deepEqual(calls, [
    "fork:notes--source:notes--fork",
    "revoke:notes--fork:initial-notes--fork",
  ]);
});

test("failed initial binding token cleanup removes only the new destination and refuses activation", async () => {
  const { calls, binding } = bindingFixture({ refuseCleanup: true });
  const git = createArtifactsGit(binding, "notes--", {
    operations: ["create"],
  });
  await assert.rejects(
    git.create("draft", { description: "Draft", defaultBranch: "main" }),
    {
      message:
        "Artifacts initial token cleanup refused repository activation (revoke Error)",
    },
  );
  assert.deepEqual(calls, [
    "create:notes--draft",
    "revoke:notes--draft:initial-notes--draft",
    "delete:notes--draft",
  ]);
});

test("Git exchange refuses provider redirects without forwarding its credential", async (t) => {
  const forwarded = [];
  const server = createServer((request, response) => {
    if (request.url === "/escaped") {
      forwarded.push(request.headers.authorization);
      response.end("escaped");
      return;
    }
    response.writeHead(302, { location: "/escaped" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address);
  assert.ok(address.port > 0);
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    const target = new URL(input);
    assert.equal(target.hostname, "fixture.artifacts.cloudflare.net");
    return nativeFetch(
      `http://127.0.0.1:${address.port}${target.pathname}${target.search}`,
      init,
    );
  });
  const { binding } = bindingFixture();
  const git = createArtifactsGit(binding, "notes--", {
    operations: ["exchange"],
  });
  await assert.rejects(
    git.exchange("draft", {
      service: "upload-pack",
      phase: "advertise",
      headers: {},
      body: null,
    }),
    { message: "Artifacts Git redirect refused" },
  );
  assert.deepEqual(forwarded, []);
});

test("canonical Git reads return mutable results without mutating provider metadata", async () => {
  const commit = Object.freeze({
    hash: "a".repeat(40),
    treeHash: "b".repeat(40),
    message: "Fixture",
    author: Object.freeze({ name: "Author", email: "author@example.com" }),
    committer: Object.freeze({
      name: "Committer",
      email: "committer@example.com",
    }),
    parents: Object.freeze(["c".repeat(40)]),
    authoredAt: 1,
    committedAt: 2,
  });
  const tree = Object.freeze([
    Object.freeze({
      name: "file",
      mode: "100644",
      hash: "d".repeat(40),
      type: "blob",
    }),
  ]);
  const git = createArtifactsGit(
    {
      get: async () => ({
        log: async () => Object.freeze([commit]),
        readCommit: async () => commit,
        readTree: async () => tree,
      }),
    },
    "notes--",
    { operations: ["read"] },
  );
  const history = await git.log("draft", { ref: "main", limit: 1, offset: 0 });
  history.push(commit);
  history[0].parents.push("e".repeat(40));
  history[0].author.name = "Changed";
  assert.deepEqual(commit.parents, ["c".repeat(40)]);
  assert.equal(commit.author.name, "Author");
  const read = await git.readCommit("draft", commit.hash);
  read.parents.push("f".repeat(40));
  read.committer.name = "Changed";
  assert.equal(commit.committer.name, "Committer");
  assert.equal(commit.parents.length, 1);
  const children = await git.readTree("draft", commit.treeHash);
  children.push(tree[0]);
  assert.equal(tree.length, 1);
});

test("canonical log fills omitted pagination while preserving explicit zero", async () => {
  const calls = [];
  const git = createArtifactsGit(
    {
      get: async () => ({
        log: async (options) => {
          calls.push(options);
          return [];
        },
      }),
    },
    "notes--",
    { operations: ["read"] },
  );
  await git.log("draft", { ref: "main" });
  await git.log("draft", { ref: "main", limit: 0, offset: 0 });
  assert.deepEqual(calls, [
    { ref: "main", limit: 50, offset: 0 },
    { ref: "main", limit: 0, offset: 0 },
  ]);
});

for (const stage of ["lookup", "info"]) {
  test(`Git credential refuses token mint when the frame closes during ${stage}`, async (t) => {
    const controller = new globalThis.AbortController();
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const { binding } = bindingFixture();
    const get = binding.get;
    let infoCalls = 0;
    let tokenCalls = 0;
    binding.get = async (name) => {
      const repo = await get(name);
      if (stage === "lookup") {
        entered.resolve();
        await resume.promise;
      }
      return {
        ...repo,
        info: async () => {
          infoCalls += 1;
          if (stage === "info") {
            entered.resolve();
            await resume.promise;
          }
          return repo.info();
        },
        createToken: (...args) => {
          tokenCalls += 1;
          return repo.createToken(...args);
        },
      };
    };
    t.mock.method(globalThis, "fetch", () =>
      Promise.resolve(new globalThis.Response("")),
    );
    const git = createArtifactsGit(binding, "notes--", {
      operations: ["exchange"],
      beforeProvider: () => controller.signal.throwIfAborted(),
    });
    const exchange = git.exchange("draft", {
      service: "upload-pack",
      phase: "advertise",
      headers: {},
      body: null,
    });
    await entered.promise;
    controller.abort(new Error("Invocation frame closed"));
    resume.resolve();
    await assert.rejects(exchange, { message: "Invocation frame closed" });
    assert.equal(tokenCalls, 0, "closed frames cannot mint provider tokens");
    assert.equal(infoCalls, stage === "lookup" ? 0 : 1);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });
}

test("Git exchange rechecks the host frame after awaiting its credential", async (t) => {
  const controller = new globalThis.AbortController();
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const { binding } = bindingFixture();
  const get = binding.get;
  binding.get = async (name) => ({
    ...(await get(name)),
    createToken: async () => {
      entered.resolve();
      await resume.promise;
      return {
        id: "exchange-id",
        plaintext: "fixture-exchange-token",
        expiresAt: "2099-01-01T00:00:00Z",
      };
    },
  });
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("unexpected provider call");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && address.port > 0);
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    const target = new URL(input);
    return nativeFetch(
      `http://127.0.0.1:${address.port}${target.pathname}${target.search}`,
      init,
    );
  });
  const git = createArtifactsGit(binding, "notes--", {
    operations: ["exchange"],
    beforeProvider: () => controller.signal.throwIfAborted(),
  });
  const exchange = git.exchange("draft", {
    service: "upload-pack",
    phase: "advertise",
    headers: {},
    body: null,
  });
  await entered.promise;
  controller.abort(new Error("Invocation frame closed"));
  resume.resolve();
  await assert.rejects(exchange, { message: "Invocation frame closed" });
  assert.equal(requests, 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

for (const [method, operation, args] of [
  ["fork", "fork", ["source", "fork"]],
  ["info", "read", ["draft"]],
  ["log", "read", ["draft", { ref: "main" }]],
  ["readCommit", "read", ["draft", "a".repeat(40)]],
  ["readTree", "read", ["draft", "a".repeat(40)]],
  ["readBlob", "read", ["draft", "a".repeat(40)]],
]) {
  test(`Git ${method} refuses provider work when the frame closes during repository lookup`, async () => {
    const controller = new globalThis.AbortController();
    const { binding } = bindingFixture();
    const get = binding.get;
    const calls = [];
    binding.get = async (name) => {
      const repo = await get(name);
      controller.abort(new Error("Invocation frame closed"));
      return {
        ...repo,
        [method]: async () => {
          calls.push(method);
          throw new Error("Unexpected provider work");
        },
      };
    };
    const git = createArtifactsGit(binding, "notes--", {
      operations: [operation],
      beforeProvider: () => controller.signal.throwIfAborted(),
    });
    await assert.rejects(git[method](...args), {
      message: "Invocation frame closed",
    });
    assert.deepEqual(calls, []);
  });
}

for (const [method, operation] of [
  ["create", "create"],
  ["delete", "write"],
]) {
  test(`Git ${method} refuses an already closed host frame before provider work`, async () => {
    const controller = new globalThis.AbortController();
    controller.abort(new Error("Invocation frame closed"));
    const { binding, calls } = bindingFixture();
    const git = createArtifactsGit(binding, "notes--", {
      operations: [operation],
      beforeProvider: () => controller.signal.throwIfAborted(),
    });
    await assert.rejects(git[method]("draft"), {
      message: "Invocation frame closed",
    });
    assert.deepEqual(calls, []);
  });
}

for (const refuseCleanup of [false, true]) {
  test(`Git initial token cleanup survives frame cancellation${refuseCleanup ? " and revoke failure" : ""}`, async () => {
    const controller = new globalThis.AbortController();
    const { binding, calls } = bindingFixture({ refuseCleanup });
    const create = binding.create;
    binding.create = async (...args) => {
      const created = await create(...args);
      controller.abort(new Error("Invocation frame closed"));
      return created;
    };
    const git = createArtifactsGit(binding, "notes--", {
      operations: ["create"],
      beforeProvider: () => controller.signal.throwIfAborted(),
    });
    if (refuseCleanup) {
      await assert.rejects(git.create("draft"), {
        message:
          "Artifacts initial token cleanup refused repository activation (revoke Error)",
      });
    } else {
      const result = await git.create("draft");
      assert.equal("token" in result, false);
    }
    assert.deepEqual(calls, [
      "create:notes--draft",
      "revoke:notes--draft:initial-notes--draft",
      ...(refuseCleanup ? ["delete:notes--draft"] : []),
    ]);
  });
}

test("Git accepts a final provider name of 128 characters and refuses 129 before provider I/O", async () => {
  const prefix = `t.${"a".repeat(40)}--${"i".repeat(63)}--`;
  const accepted = "r".repeat(19);
  const refused = "r".repeat(20);
  const { binding, calls } = bindingFixture();
  const git = createArtifactsGit(binding, prefix, { operations: ["create"] });
  assert.equal((prefix + accepted).length, 128);
  assert.equal((prefix + refused).length, 129);
  const info = await git.create(accepted);
  assert.equal(info.name, accepted);
  assert.deepEqual(calls, [
    `create:${prefix}${accepted}`,
    `revoke:${prefix}${accepted}:initial-${prefix}${accepted}`,
  ]);
  calls.length = 0;
  await assert.rejects(git.create(refused), /Invalid repository name/);
  assert.deepEqual(calls, [], "over-length names must never reach Artifacts");
});

test("repos.get binding sequence reuses only its verified frame backend and reopens selection", async (t) => {
  const { oysterWorkerGit } = await import("../dist/workers-git.js");
  const { defaultTenant, tenantScope } = await import("../dist/tenant.js");
  const { createAppBuild } = await import("@fungi.computer/puffball/app");
  const { backendMediaType } = await import("@fungi.computer/puffball/backend");
  const { resolveBackend, sha256 } = await import("../dist/release.js");
  const { createInvocationGate, invocationFacts } =
    await import("../dist/invocation.js");
  const { selectionOf } = await import("../dist/index.js");
  const bytes = new Map();
  const labels = new Map();
  const reads = [];
  const put = async (value, label) => {
    const data = new globalThis.TextEncoder().encode(JSON.stringify(value));
    const digest = await sha256(data);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    bytes.set(artifactRef, data);
    labels.set(artifactRef, label);
    return { artifactRef, digest, byteLength: data.length, version: digest };
  };
  const ui = await put({ unrelated: "UI must not enter Git admission" }, "ui");
  const backend = await put(
    {
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "Guest",
      code: "export class Guest {}",
    },
    "backend",
  );
  const root = await put(
    createAppBuild(
      { ...ui, mediaType: "text/html; charset=utf-8" },
      { ...backend, mediaType: backendMediaType },
      {
        capabilities: ["git.repository"],
        handlers: [],
        roles: [],
        backend: {
          bindings: [{ name: "GIT", operations: ["read", "exchange"] }],
        },
      },
    ),
    "release-manifest",
  );
  const release = {
    appId: "app_fixture",
    releaseId: "rel_fixture",
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
  const installation = {
    installationId: "notes",
    instanceId: instanceIds.instance.generate(),
    release,
    authorityVersion: 1,
    status: "enabled",
  };
  let current = installation;
  let registryReads = 0;
  let providerReads = 0;
  const bucket = {
    get: async (key) => {
      const data = bytes.get(key);
      reads.push({ label: labels.get(key), bytes: data?.length ?? 0 });
      return data ? { arrayBuffer: async () => data } : null;
    },
  };
  const resolved = await resolveBackend(
    {
      get: async (key) => {
        const object = await bucket.get(key);
        return object ? object.arrayBuffer() : null;
      },
    },
    release,
  );
  const { binding } = bindingFixture();
  const get = binding.get;
  binding.get = async (...args) => {
    providerReads++;
    return get(...args);
  };
  t.mock.method(globalThis, "fetch", async () => {
    providerReads++;
    return new globalThis.Response("0000");
  });
  const env = {
    OYSTER_OWNER_KEY: "fixture-owner-key-that-is-long-enough",
    OYSTER_ORIGIN: "https://fixture.invalid",
    RELEASES: bucket,
    ARTIFACTS: binding,
    REGISTRY: {
      getByName: () => ({
        get: async () => {
          registryReads++;
          return current;
        },
      }),
    },
    INSTANCES: {
      getByName: () => ({
        authorizeGitPush: async (policyFacts, question) => {
          assert.deepEqual(policyFacts.grants, []);
          assert.deepEqual(policyFacts.ancestry, []);
          assert.equal(policyFacts.artifactDigest, backend.digest);
          assert.ok(policyFacts.deadlineAt <= facts.deadlineAt);
          assert.deepEqual(policyFacts.subject.context.workflow, {
            workflowId: "workflow_fixture",
            runId: "run_fixture",
            nodeId: "node_fixture",
            armedBy: { kind: "member", memberId: "member_fixture" },
          });
          return {
            allowed: false,
            refused: question.updates.map((update) => ({
              ref: update.ref,
              message: "fixture refusal",
            })),
          };
        },
      }),
    },
  };
  const facts = invocationFacts.fromCaller(
    {
      instanceId: installation.instanceId,
      selection: selectionOf(installation),
      artifactDigest: backend.digest,
      grants: [{ binding: "GIT", operations: ["read", "exchange"] }],
      ancestry: [],
    },
    { computerId: null, actor: { kind: "member", memberId: "member_fixture" } },
    { deadlineAt: Date.now() + 10_000, grantExpiresAt: Date.now() + 10_000 },
  );
  const gate = createInvocationGate({
    abortGuest: () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
  let retainedGit;
  await gate.run(
    facts,
    { artifact: { release, ...resolved }, declaration: resolved.declaration },
    async (frame) => {
      const scope = tenantScope(defaultTenant, env.OYSTER_ORIGIN);
      const hostGit = oysterWorkerGit(env, { scope }, { invocation: frame });
      const git = (await hostGit.git(installation)).binding(
        facts.subject.context.actor,
      );
      retainedGit = git;
      await git.info("fork");
      await git.refs("fork");
      await git.cloneUrl("fork");
      assert.equal(reads.filter((read) => read.label === "ui").length, 0);
      assert.equal(
        reads.filter((read) => read.label === "release-manifest").length,
        1,
      );
      assert.equal(registryReads, 3);
      const before = providerReads;
      const { pktLine } = await import("@fungi.computer/agar/git-wire");
      await (
        await hostGit.git(installation)
      ).push(
        {
          kind: "actor",
          actor: facts.subject.context.actor,
          role: "owner",
          workflow: {
            workflowId: "workflow_fixture",
            runId: "run_fixture",
            nodeId: "node_fixture",
            armedBy: facts.subject.context.actor,
            branches: ["refs/heads/main"],
          },
        },
        "fork",
        {
          service: "receive-pack",
          phase: "exchange",
          headers: {},
          body: new globalThis.TextEncoder().encode(
            pktLine(
              `${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\0report-status\n`,
            ) + "0000",
          ),
        },
      );
      assert.equal(providerReads, before);
      current = { ...installation, authorityVersion: 2 };
      await assert.rejects(git.info("fork"));
      assert.equal(providerReads, before);
      current = { ...installation, status: "disabled" };
      await assert.rejects(git.info("fork"));
      assert.equal(providerReads, before);
      current = installation;
      for (const captured of [
        { ...release, releaseId: "rel_other" },
        {
          ...release,
          artifact: {
            ...release.artifact,
            artifactRef: `artifact:sha256-${"b".repeat(64)}`,
          },
        },
        {
          ...release,
          artifact: {
            ...release.artifact,
            artifactDigest: `sha256:${"b".repeat(64)}`,
          },
        },
      ]) {
        const altered = {
          ...frame,
          host: {
            ...frame.host,
            artifact: { ...frame.host.artifact, release: captured },
          },
        };
        const denied = (
          await oysterWorkerGit(env, { scope }, { invocation: altered }).git(
            installation,
          )
        ).binding(facts.subject.context.actor);
        await assert.rejects(denied.info("fork"));
        assert.equal(providerReads, before);
      }
      const altered = {
        ...frame,
        host: {
          ...frame.host,
          artifact: {
            ...frame.host.artifact,
            digest: `sha256:${"b".repeat(64)}`,
          },
        },
      };
      await assert.rejects(
        (
          await oysterWorkerGit(env, { scope }, { invocation: altered }).git(
            installation,
          )
        )
          .binding(facts.subject.context.actor)
          .info("fork"),
      );
      assert.equal(providerReads, before);
    },
  );
  const before = providerReads;
  await assert.rejects(retainedGit.info("fork"));
  assert.equal(providerReads, before);
});

test("credential minting coalesces only the same repository and scope", async () => {
  const { binding } = bindingFixture();
  const get = binding.get;
  const minted = [];
  binding.get = async (name) => ({
    ...(await get(name)),
    createToken: async (scope) => {
      minted.push({ name, scope });
      return {
        id: `token-${minted.length}`,
        plaintext: `private-token-${minted.length}`,
        expiresAt: "2099-01-01T00:00:00Z",
      };
    },
  });
  const git = createArtifactsGit(binding, "notes--", {
    operations: ["read", "write"],
  });
  const [first, second] = await Promise.all([
    git.credential("draft", "read"),
    git.credential("draft", "read"),
    git.credential("draft", "write"),
    git.credential("other", "read"),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(minted, [
    { name: "notes--draft", scope: "read" },
    { name: "notes--draft", scope: "write" },
    { name: "notes--other", scope: "read" },
  ]);
});

test("failed credential minting is evicted so a later packet can retry", async () => {
  const { binding } = bindingFixture();
  const get = binding.get;
  let refuse = true;
  let calls = 0;
  binding.get = async (name) => ({
    ...(await get(name)),
    createToken: async () => {
      calls++;
      if (refuse) throw new Error("Provider unavailable");
      return {
        id: "recovered-token",
        plaintext: "private-recovered-token",
        expiresAt: "2099-01-01T00:00:00Z",
      };
    },
  });
  const git = createArtifactsGit(binding, "notes--", { operations: ["read"] });
  const failed = await Promise.allSettled([
    git.credential("draft", "read"),
    git.credential("draft", "read"),
  ]);
  assert.deepEqual(
    failed.map(({ status }) => status),
    ["rejected", "rejected"],
  );
  assert.equal(
    calls,
    4,
    "concurrent callers share the maintained retry budget",
  );
  refuse = false;
  await git.credential("draft", "read");
  assert.equal(calls, 5);
});

test("a token finishing after frame closure cannot be returned to the caller", async () => {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const { binding } = bindingFixture();
  const get = binding.get;
  let closed = false;
  let calls = 0;
  binding.get = async (name) => ({
    ...(await get(name)),
    createToken: async () => {
      calls++;
      entered.resolve();
      await resume.promise;
      return {
        id: `token-${calls}`,
        plaintext: `private-token-${calls}`,
        expiresAt: "2099-01-01T00:00:00Z",
      };
    },
  });
  const git = createArtifactsGit(binding, "notes--", {
    operations: ["read"],
    beforeProvider: () => {
      if (closed) throw new Error("Invocation frame closed");
    },
  });
  const pending = git.credential("draft", "read");
  await entered.promise;
  closed = true;
  resume.resolve();
  await assert.rejects(pending, { message: "Invocation frame closed" });
  assert.equal(calls, 1, "closure cannot mint another token on retry");
});

test("smart HTTP returns 404 for a missing provider repository without retrying or leaking errors", async () => {
  const { createArtifactsRestNamespace } =
    await import("@fungi.computer/burrow");
  const { createGitDoor, createAdmittedGit } = await import("../dist/git.js");
  let requests = 0;
  const binding = createArtifactsRestNamespace({
    accountId: "fixture-account",
    namespace: "fixture",
    apiToken: "fixture-token",
    fetch: async () => {
      requests++;
      return globalThis.Response.json(
        {
          success: false,
          result: null,
          errors: [{ code: 10200, message: "private provider detail" }],
        },
        { status: 404 },
      );
    },
  });
  const git = createAdmittedGit({
    installationId: "bonsai",
    store: createArtifactsGit(binding, "bonsai--", {
      operations: ["read", "exchange"],
    }),
    grants: { admits: async () => true },
    policy: {
      authorize: async () => {
        throw new Error("Read must not authorize a push");
      },
    },
    journal: {
      tip: async () => null,
      record: async () => {
        throw new Error("Read must not record a push");
      },
    },
  });
  const door = createGitDoor({
    authenticate: async () => null,
    isPublic: async () => true,
    git: async () => git,
  });
  const response = await door.request(
    "/git/bonsai/missing.git/info/refs?service=git-upload-pack",
  );
  assert.equal(response.status, 404);
  assert.doesNotMatch(
    await response.text(),
    /private provider detail|fixture-token/u,
  );
  assert.equal(requests, 1);
});

test("smart HTTP authenticates against the exact repository and scope it names", async () => {
  const { createGitDoor } = await import("../dist/git.js");
  const targets = [];
  const door = createGitDoor({
    authenticate: async (_request, target) => {
      targets.push(target);
      return null;
    },
    isPublic: async () => false,
    git: async () => {
      throw new Error("An unauthenticated request must not reach Git");
    },
  });
  for (const path of [
    "/git/bonsai/pond.git/info/refs?service=git-upload-pack",
    "/git/bonsai/pond.git/info/refs?service=git-receive-pack",
  ])
    assert.equal((await door.request(path)).status, 401);
  assert.deepEqual(targets, [
    { installationId: "bonsai", repository: "pond", scope: "read" },
    { installationId: "bonsai", repository: "pond", scope: "write" },
  ]);
});

test("smart HTTP never logs or echoes a presented bearer pass", async () => {
  const { createGitDoor } = await import("../dist/git.js");
  const secret = `wgp.library.${"c".repeat(64)}`;
  const logged = [];
  const methods = ["log", "info", "warn", "error", "debug"];
  const originals = methods.map((name) => globalThis.console[name]);
  for (const name of methods)
    globalThis.console[name] = (...values) => {
      logged.push(values.map(String).join(" "));
    };
  let bodies = "";
  try {
    const door = createGitDoor({
      authenticate: async (request) =>
        request.headers.get("authorization") === `Bearer ${secret}`
          ? { kind: "actor", actor: { kind: "member", memberId: "owner" } }
          : null,
      isPublic: async () => false,
      git: async () => null,
    });
    for (const service of ["git-upload-pack", "git-receive-pack"]) {
      const response = await door.request(
        `/git/bonsai/pond.git/info/refs?service=${service}`,
        { headers: { Authorization: `Bearer ${secret}` } },
      );
      assert.equal(response.status, 403);
      bodies += await response.text();
    }
  } finally {
    methods.forEach((name, index) => {
      globalThis.console[name] = originals[index];
    });
  }
  assert.equal(bodies.includes("c".repeat(64)), false);
  assert.equal(logged.join("\n").includes("c".repeat(64)), false);
});

/** A provider whose forks copy asynchronously and refuse work until ready. */
function asyncForkProvider({ failFirstCleanup = false, existing = [] } = {}) {
  const calls = [];
  const repos = new Map(existing.map((repo) => [repo.name, repo]));
  const coded = (code) =>
    Object.assign(new Error(`provider ${code}`), { code });
  const info = (repo) => ({
    id: `id-${repo.name}`,
    name: repo.name,
    defaultBranch: "main",
    remote: `https://fixture.artifacts.cloudflare.net/git/default/${repo.name}.git`,
    source: repo.source === null ? null : `artifacts:default/${repo.source}`,
  });
  // Each status read advances a copying fork one step toward ready.
  const tick = () => {
    for (const repo of repos.values())
      if (repo.status === "forking" && --repo.pending <= 0)
        repo.status = "ready";
  };
  let cleanupFailures = failFirstCleanup ? 1 : 0;
  return {
    calls,
    repos,
    binding: {
      get: async (name) => ({
        info: async () => {
          const repo = repos.get(name);
          if (repo === undefined) throw coded("NOT_FOUND");
          if (repo.status !== "ready") throw coded("FORK_IN_PROGRESS");
          return info(repo);
        },
        revokeToken: async (token) => {
          calls.push(`revoke:${name}:${token}`);
          if (repos.get(name)?.status !== "ready")
            throw coded("FORK_IN_PROGRESS");
          if (cleanupFailures > 0) {
            cleanupFailures -= 1;
            throw coded("INTERNAL");
          }
          return true;
        },
        fork: async (target) => {
          calls.push(`fork:${name}:${target}`);
          if (!repos.has(name)) throw coded("NOT_FOUND");
          if (repos.has(target)) throw coded("ALREADY_EXISTS");
          repos.set(target, {
            name: target,
            source: name,
            status: "forking",
            pending: 2,
          });
          return { ...info(repos.get(target)), token: `initial-${target}` };
        },
      }),
      list: async () => {
        tick();
        return {
          repos: [...repos.values()].map(({ name, status }) => ({
            name,
            status,
          })),
          total: repos.size,
        };
      },
      delete: async (name) => {
        calls.push(`delete:${name}`);
        if (repos.get(name)?.status !== "ready")
          throw coded("FORK_IN_PROGRESS");
        throw coded("INTERNAL");
      },
    },
  };
}

test("Oyster fork waits for the asynchronous copy before revoking its initial token", async () => {
  const provider = asyncForkProvider({
    existing: [{ name: "notes--source", source: null, status: "ready" }],
  });
  const git = createArtifactsGit(provider.binding, "notes--", {
    operations: ["fork"],
  });
  const result = await git.fork("source", "fork");
  assert.deepEqual(
    { name: result.name, source: result.source },
    { name: "fork", source: "source" },
  );
  assert.deepEqual(provider.calls, [
    "fork:notes--source:notes--fork",
    "revoke:notes--fork:initial-notes--fork",
  ]);
});

test("Oyster fork answers an existing same-source destination once it is ready", async () => {
  const provider = asyncForkProvider({
    existing: [
      { name: "notes--source", source: null, status: "ready" },
      {
        name: "notes--fork",
        source: "notes--source",
        status: "forking",
        pending: 2,
      },
    ],
  });
  const git = createArtifactsGit(provider.binding, "notes--", {
    operations: ["fork"],
  });
  const result = await git.fork("source", "fork");
  assert.deepEqual(
    { name: result.name, source: result.source },
    { name: "fork", source: "source" },
  );
  assert.deepEqual(provider.calls, ["fork:notes--source:notes--fork"]);
});

test("Oyster fork reports an existing destination's other source for the caller to refuse", async () => {
  const provider = asyncForkProvider({
    existing: [
      { name: "notes--source", source: null, status: "ready" },
      { name: "notes--other", source: null, status: "ready" },
      { name: "notes--fork", source: "notes--other", status: "ready" },
    ],
  });
  const git = createArtifactsGit(provider.binding, "notes--", {
    operations: ["fork"],
  });
  const result = await git.fork("source", "fork");
  assert.equal(result.source, "other");
  assert.deepEqual(provider.calls, ["fork:notes--source:notes--fork"]);
});

test("Oyster fork rethrows a refused fork whose destination does not exist", async () => {
  const provider = asyncForkProvider();
  const git = createArtifactsGit(provider.binding, "notes--", {
    operations: ["fork"],
  });
  await assert.rejects(git.fork("missing", "fork"), /provider NOT_FOUND/u);
  assert.equal(provider.repos.has("notes--fork"), false);
});

test("a fork retry after a partial failure answers the provider repository the first attempt left", async () => {
  const provider = asyncForkProvider({
    failFirstCleanup: true,
    existing: [{ name: "notes--source", source: null, status: "ready" }],
  });
  const git = createArtifactsGit(provider.binding, "notes--", {
    operations: ["fork"],
  });
  await assert.rejects(
    git.fork("source", "fork"),
    /refused repository activation \(revoke INTERNAL, delete INTERNAL\)/u,
  );
  assert.equal(provider.repos.get("notes--fork")?.status, "ready");
  const retried = await git.fork("source", "fork");
  assert.deepEqual(
    { name: retried.name, source: retried.source },
    { name: "fork", source: "source" },
  );
  assert.deepEqual(provider.calls, [
    "fork:notes--source:notes--fork",
    "revoke:notes--fork:initial-notes--fork",
    "delete:notes--fork",
    "fork:notes--source:notes--fork",
  ]);
});
