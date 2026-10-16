import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { createAgentDirectory } from "@fungi.computer/shiitake/fleet";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import {
  createOyster,
  sha256,
  verifyRelease,
} from "@fungi.computer/oyster/host";
import { invocationCallerContext } from "@fungi.computer/oyster/invocation";
import { defaultTenant, tenantScope } from "@fungi.computer/oyster/tenant";
import { deriveDeclaredOperations } from "@fungi.computer/oyster/apps";
import { instanceIds } from "@fungi.computer/oyster";
import { approvedInstallation } from "@fungi.computer/oyster/testing";

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
const { ownerOrKeyAuth } = await import("@fungi.computer/oyster/auth");
const { StandaloneAgent } = await import("../../src/standalone/worker.ts");
const { AgentDirectory, standaloneAgents } =
  await import("../../src/standalone/agents.ts");
const { OysterBinding } = await import("../../src/standalone/instance.ts");
hooks.deregister();

// Canonical stored membership fixture; production uses the seeded registry.
function newDirectory(state, env) {
  if (env.TENANCY === undefined)
    env.TENANCY = {
      memberById: async (_tenantId, memberId) =>
        memberId === (env.OYSTER_OWNER_NAME ?? "owner")
          ? {
              actor: { kind: "member", memberId },
              role: "owner",
              membershipVersion: 1,
            }
          : null,
    };
  return new AgentDirectory(state, env);
}
async function createApproved(
  directory,
  name,
  requestId,
  principal,
  tenantId = defaultTenant,
) {
  const entry = directory.create(name, requestId, principal, "owner-direct");
  if (entry.policyRevision !== null) {
    const policy = await directory.approveAppToolPolicy(
      entry.agentId,
      principal,
      "write",
      entry.policyRevision,
      "owner-direct",
      tenantId,
    );
    assert.equal("error" in policy, false);
  }
  return { agentId: entry.agentId, name: entry.name };
}
const approve = (directory, agentId, principal, level, revision) =>
  directory.approveAppToolPolicy(
    agentId,
    principal,
    level,
    revision,
    "owner-direct",
    defaultTenant,
  );

const request = (headers) =>
  new globalThis.Request("https://oyster.test/", { headers });

test("Agent loopbacks forward parsed packets to their originating Instance", async () => {
  const calls = [];
  const replies = {
    visit: { visited: true },
    send: { status: "accepted", commandId: "command_one" },
  };
  const env = {
    INSTANCES: {
      getByName: (instanceId) => ({
        bindingCall: async (props, method, args) => {
          calls.push({ instanceId, props, method, args });
          return { kind: "result", value: replies[method] };
        },
      }),
    },
  };
  const instanceId = instanceIds.instance.generate();
  const frameId = "app_frame_7rid3mf288uvsdldxmu5l";
  const props = { instanceId, frameId, binding: "INBOX" };
  const inbox = new OysterBinding({ props }, env);
  const input = { agentId: "morel", sessionId: "conversation" };
  assert.deepEqual(await inbox.visit(input), {
    kind: "result",
    value: { visited: true },
  });
  assert.deepEqual(calls, [
    { instanceId, props, method: "visit", args: [input] },
  ]);
  assert.deepEqual(await inbox.visit({ agentId: "morel" }), {
    kind: "local_refusal",
    code: "invalid_invocation_facts",
  });
  assert.equal(calls.length, 1, "invalid packets never reach the provider");
  const sender = new OysterBinding(
    { props: { instanceId, frameId, binding: "AGENTS" } },
    env,
  );
  assert.deepEqual(
    await sender.send({ ...input, text: "Continue", delivery: "followUp" }),
    { kind: "result", value: replies.send },
  );
  assert.equal(calls[1].method, "send");
  assert.deepEqual(calls[1].props, { instanceId, frameId, binding: "AGENTS" });
});

test("App tool policy retains its authenticated approver and changes revision only on approval", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const state = { storage: fromNodeSqlite(database) };
    const env = { OYSTER_OWNER_NAME: "authenticated-owner" };
    const directory = newDirectory(state, env);
    const owner = {
      actor: { kind: "member", memberId: "authenticated-owner" },
      role: "owner",
    };
    const agent = await createApproved(
      directory,
      "Morel",
      "approved-morel",
      owner,
    );
    const target = { kind: "agent", agentId: agent.agentId };
    const policy = await directory.appToolPolicy(target);
    assert.equal(policy.level, "write");
    assert.equal(policy.grantedBy, "authenticated-owner");
    assert.ok(policy.revision.length > 0);
    const reopened = newDirectory(state, env);
    assert.deepEqual(await reopened.appToolPolicy(target), policy);
    assert.deepEqual(
      await createApproved(reopened, "Morel", "approved-morel", owner),
      agent,
    );
    assert.deepEqual(await reopened.appToolPolicy(target), policy);
    const changed = await approve(
      reopened,
      agent.agentId,
      owner,
      "read",
      policy.revision,
    );
    assert.equal(changed.level, "read");
    assert.equal(changed.grantedBy, "authenticated-owner");
    assert.notEqual(changed.revision, policy.revision);
    assert.deepEqual(
      await approve(reopened, agent.agentId, owner, "write", policy.revision),
      { error: "revision_conflict" },
    );
    assert.deepEqual(await directory.appToolPolicy(target), changed);
    // A key's App access is its own Ear Tag grants now, never this policy,
    // so appToolPolicy's contract narrowed to Agent actors only (callers in
    // production code never pass it a team-key actor).
    env.OYSTER_OWNER_NAME = "replacement-owner";
    assert.equal(
      await directory.appToolPolicy(target),
      null,
      "former owner approval is no longer current",
    );
    env.OYSTER_OWNER_NAME = owner.actor.memberId;
    for (const principal of [
      { actor: { kind: "agent", agentId: "agent-claim" } },
      { actor: { kind: "team-key", keyId: "key-claim" } },
      {
        actor: { kind: "member", memberId: "ordinary-member" },
        role: "member",
      },
    ]) {
      assert.deepEqual(
        await approve(
          reopened,
          agent.agentId,
          principal,
          "write",
          changed.revision,
        ),
        { error: "not_granted" },
      );
      assert.deepEqual(await reopened.appToolPolicy(target), changed);
    }
  } finally {
    database.close();
  }
});

test("the standalone Agent adapter uses its host-selected tenant directory", async () => {
  const names = [];
  const env = {
    AGENT_DIRECTORY: {
      getByName: (name) => {
        names.push(name);
        return { list: async () => [] };
      },
    },
  };
  await standaloneAgents(env, {
    tenantId: "another-tenant",
    durableName: () => "t.another-tenant.agents",
  }).list();
  assert.deepEqual(names, ["t.another-tenant.agents"]);
});

test("nondefault Agent policies recheck their grantor through the current tenant membership owner", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = {
      actor: { kind: "member", memberId: "tenant-owner" },
      role: "owner",
      membershipVersion: 1,
    };
    let current = owner;
    const reads = [];
    const directory = newDirectory(
      { storage: fromNodeSqlite(database) },
      {
        OYSTER_OWNER_NAME: "unrelated-stock-owner",
        TENANCY: {
          memberById: async (tenantId, memberId) => {
            reads.push({ tenantId, memberId });
            return current;
          },
        },
      },
    );
    const agent = await createApproved(
      directory,
      "Tenant Morel",
      "tenant-morel",
      owner,
      "alpha",
    );
    const target = { kind: "agent", agentId: agent.agentId };
    const approved = await directory.appToolPolicy(target, "alpha");
    assert.equal(approved.grantedBy, "tenant-owner");
    assert.deepEqual(
      reads,
      [
        { tenantId: "alpha", memberId: "tenant-owner" },
        { tenantId: "alpha", memberId: "tenant-owner" },
      ],
      "approval and invocation both read current membership",
    );
    current = { ...owner, role: "member" };
    assert.equal(await directory.appToolPolicy(target, "alpha"), null);
    for (const transition of [
      "demote/re-promote",
      "remove/re-add",
      "suspend/reactivate",
    ]) {
      current =
        transition === "demote/re-promote"
          ? { ...owner, role: "member", membershipVersion: 2 }
          : null;
      assert.equal(await directory.appToolPolicy(target, "alpha"), null);
      current = { ...owner, membershipVersion: owner.membershipVersion + 2 };
      assert.equal(
        await directory.appToolPolicy(target, "alpha"),
        null,
        transition,
      );
    }
    current = null;
    assert.equal(await directory.appToolPolicy(target, "alpha"), null);
    const noLookup = new AgentDirectory(
      { storage: fromNodeSqlite(database) },
      {},
    );
    assert.equal(await noLookup.appToolPolicy(target, "alpha"), null);
    assert.deepEqual(
      await noLookup.approveAppToolPolicy(
        agent.agentId,
        { actor: { kind: "member", memberId: "tenant-owner" }, role: "owner" },
        "write",
        approved.revision,
        "owner-direct",
        defaultTenant,
      ),
      { error: "not_granted" },
      "a static owner label without registry membership cannot mint a version",
    );
  } finally {
    database.close();
  }
});

test("an App-created Agent has no approved write tools before direct owner approval", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = {
      actor: { kind: "member", memberId: "owner" },
      role: "owner",
    };
    const directory = newDirectory(
      { storage: fromNodeSqlite(database) },
      { OYSTER_OWNER_NAME: "owner" },
    );
    const agent = await directory.create("App Morel", "app-morel", owner, {
      installationId: "grove-installation",
    });
    assert.equal(
      await directory.appToolPolicy({ kind: "agent", agentId: agent.agentId }),
      null,
    );
    const row = database
      .prepare("SELECT policy FROM app_tool_policies WHERE agent_id=?")
      .get(agent.agentId);
    const pending = JSON.parse(row.policy);
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.actingInstallation, {
      installationId: "grove-installation",
    });
    assert.equal(Object.hasOwn(pending, "grantedBy"), false);
    const approved = await directory.approveAppToolPolicy(
      agent.agentId,
      owner,
      "write",
      pending.revision,
      "owner-direct",
      defaultTenant,
    );
    assert.equal(approved.grantedBy, owner.actor.memberId);
    const recorded = JSON.parse(
      database
        .prepare("SELECT policy FROM app_tool_policies WHERE agent_id=?")
        .get(agent.agentId).policy,
    );
    assert.equal(recorded.membershipVersion, 1);
    assert.equal(recorded.actingInstallation, "owner-direct");
    assert.deepEqual(
      await directory.appToolPolicy({ kind: "agent", agentId: agent.agentId }),
      approved,
    );
  } finally {
    database.close();
  }
});

test("policy compare-and-swap admits only one concurrent owner approval", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = {
      actor: { kind: "member", memberId: "owner" },
      role: "owner",
    };
    const directory = newDirectory(
      { storage: fromNodeSqlite(database) },
      { OYSTER_OWNER_NAME: "owner" },
    );
    const agent = await createApproved(
      directory,
      "CAS Morel",
      "cas-morel",
      owner,
    );
    const current = await directory.appToolPolicy({
      kind: "agent",
      agentId: agent.agentId,
    });
    const outcomes = await Promise.all([
      approve(directory, agent.agentId, owner, "read", current.revision),
      approve(directory, agent.agentId, owner, "write", current.revision),
    ]);
    assert.equal(
      outcomes.filter((value) => value.error === "revision_conflict").length,
      1,
    );
    assert.equal(
      outcomes.filter((value) => value.grantedBy === "owner").length,
      1,
    );
  } finally {
    database.close();
  }
});

test("approval refuses an unpinned Agent and an Agent from another tenant", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = {
      actor: { kind: "member", memberId: "owner" },
      role: "owner",
    };
    const directory = newDirectory(
      { storage: fromNodeSqlite(database) },
      { OYSTER_OWNER_NAME: "owner" },
    );
    const agent = await createApproved(
      directory,
      "Pinned Morel",
      "pinned-morel",
      owner,
    );
    let pin = null;
    const env = {
      AGENT_DIRECTORY: { getByName: () => directory },
      AGENTS: { getByName: () => ({ policyDirectory: async () => pin }) },
    };
    const adapter = standaloneAgents(env, {
      tenantId: "alpha",
      durableName: () => "t.alpha.agents",
    });
    const policy = await directory.appToolPolicy({
      kind: "agent",
      agentId: agent.agentId,
    });
    assert.deepEqual(
      await adapter.approveAppToolPolicy(
        agent.agentId,
        owner,
        "write",
        policy.revision,
        "owner-direct",
      ),
      { error: "not_found" },
    );
    pin = { tenantId: "beta", directoryName: "t.beta.agents" };
    assert.deepEqual(
      await adapter.approveAppToolPolicy(
        agent.agentId,
        owner,
        "write",
        policy.revision,
        "owner-direct",
      ),
      { error: "not_found" },
    );
    assert.deepEqual(
      await directory.appToolPolicy({ kind: "agent", agentId: agent.agentId }),
      policy,
    );
    const other = {
      actor: { kind: "member", memberId: "unapproved-owner" },
      role: "owner",
    };
    assert.deepEqual(
      await approve(directory, agent.agentId, other, "write", policy.revision),
      { error: "not_granted" },
    );
  } finally {
    database.close();
  }
});

test("an Agent retains one immutable host-selected policy directory", async () => {
  let pinned;
  const agent = new StandaloneAgent(
    {
      storage: {
        get: async () => pinned,
        put: async (_key, value) => {
          pinned = value;
        },
      },
    },
    {},
  );
  const selected = { directoryName: "t.alpha.agents", tenantId: "alpha" };
  await agent.usePolicyDirectory(selected);
  await agent.usePolicyDirectory(selected);
  await assert.rejects(
    agent.usePolicyDirectory({
      directoryName: "t.beta.agents",
      tenantId: "beta",
    }),
    /directory mismatch/u,
  );
});

test("an existing Agent with no stored tool approval requires authenticated re-approval", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const state = { storage: fromNodeSqlite(database) };
    const existing = createAgentDirectory(state.storage.sql).create(
      {
        agents: "all",
        actions: ["create"],
        expiresAt: Date.now() + 60_000,
        provenance: { actor: "old-agent-creator-is-not-a-grantor" },
      },
      { name: "Old Morel", requestId: "old-morel", configuration: "none" },
    ).agent;
    const directory = newDirectory(state, {
      OYSTER_OWNER_NAME: "authenticated-reattaching-owner",
    });
    const target = { kind: "agent", agentId: existing.agentId };
    const owner = {
      actor: { kind: "member", memberId: "authenticated-reattaching-owner" },
      role: "owner",
    };
    assert.equal(await directory.appToolPolicy(target), null);
    state.storage.sql.exec(
      "INSERT INTO app_tool_policies(agent_id,policy) VALUES(?,?)",
      existing.agentId,
      JSON.stringify({ level: "write", revision: "legacy" }),
    );
    assert.equal(
      await directory.appToolPolicy(target),
      null,
      "legacy stored approval needs re-approval",
    );
    state.storage.sql.exec(
      "UPDATE app_tool_policies SET policy=? WHERE agent_id=?",
      "{",
      existing.agentId,
    );
    assert.equal(
      await directory.appToolPolicy(target),
      null,
      "malformed persisted approval grants nothing",
    );
    assert.throws(
      () => directory.create("Old Morel", "old-morel", owner, "owner-direct"),
      /request_conflict/u,
    );
    assert.equal(
      await directory.appToolPolicy(target),
      null,
      "creation replay cannot synthesize an approval",
    );
    const approved = await approve(
      directory,
      existing.agentId,
      owner,
      "read",
      null,
    );
    assert.equal(approved.grantedBy, owner.actor.memberId);
    assert.deepEqual(await directory.appToolPolicy(target), approved);
  } finally {
    database.close();
  }
});

test("the standalone directory retains replay, oldest-first names and visits across reopen", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const database = new DatabaseSync(":memory:");
  try {
    const state = { storage: fromNodeSqlite(database) };
    const env = { OYSTER_OWNER_NAME: "Levi" };
    const directory = newDirectory(state, env);
    const morel = await createApproved(directory, "Morel", "create-morel", {
      actor: { kind: "member", memberId: "Levi" },
      role: "owner",
    });
    context.mock.timers.tick(1);
    const enoki = await createApproved(directory, "Enoki", "create-enoki", {
      actor: { kind: "member", memberId: "Levi" },
      role: "owner",
    });
    assert.equal(directory.revision(), 4);
    assert.deepEqual(
      await createApproved(directory, "Morel", "create-morel", {
        actor: { kind: "member", memberId: "Levi" },
        role: "owner",
      }),
      morel,
    );
    assert.equal(directory.revision(), 4, "replay adds no directory change");
    assert.deepEqual(directory.list(), [morel, enoki]);
    assert.equal(directory.has(morel.agentId), true);
    assert.equal(directory.readCreator(morel.agentId), "Levi");
    assert.equal(directory.readCreator("unknown"), null);
    assert.equal(directory.has("unknown"), false);
    directory.visit(morel.agentId, "conversation");
    const reopened = newDirectory(state, env);
    assert.deepEqual(reopened.list(), [morel, enoki]);
    assert.equal(reopened.readCreator(enoki.agentId), "Levi");
    assert.deepEqual(reopened.visits(), [
      {
        agentId: morel.agentId,
        sessionId: "conversation",
        visitedAt: 1001,
      },
    ]);
    assert.equal(reopened.revision(), 5);
    assert.deepEqual(
      await createApproved(reopened, "Morel", "create-morel", {
        actor: { kind: "member", memberId: "Levi" },
        role: "owner",
      }),
      morel,
    );
    assert.equal(reopened.revision(), 5);
  } finally {
    database.close();
  }
});

test("HTTP credentials and forged agent claims never authenticate an internal agent", async () => {
  const ownerKey = "owner-fixture-secret-24-characters";
  const key = "agent-key-fixture";
  const auth = ownerOrKeyAuth(ownerKey, "owner", () => ({
    verify: async (value) =>
      value === key
        ? {
            kind: "ok",
            value: {
              keyId: "morel",
              owner: "owner",
              name: "morel",
              scope: { grants: [] },
              grantVersion: 1,
              expiresAt: null,
            },
          }
        : { kind: "error", error: { code: "denied" } },
  }));
  const forged = {
    "X-Oyster-Principal": "agent",
    "X-Oyster-Agent": "morel",
    "X-Agent-Id": "morel",
    "X-Principal-Kind": "agent",
    Cookie: "oyster_session=agent; principal=agent; agentId=morel",
  };
  for (const Authorization of [
    undefined,
    "Bearer agent",
    'Bearer {"kind":"agent","id":"morel"}',
  ]) {
    const headers = new globalThis.Headers(forged);
    if (Authorization !== undefined)
      headers.set("Authorization", Authorization);
    const result = await auth.authenticate(request(headers));
    assert.deepEqual(result, { kind: "refused", status: 401 });
  }
  for (const [credential, principal] of [
    [ownerKey, { actor: { kind: "member", memberId: "owner" }, role: "owner" }],
    [key, { actor: { kind: "team-key", keyId: "morel" } }],
  ]) {
    const result = await auth.authenticate(
      request({ ...forged, Authorization: `Bearer ${credential}` }),
    );
    assert.deepEqual(result, { kind: "admitted", principal });
  }
  const cookie = await sha256(
    new globalThis.TextEncoder().encode(`oyster:${ownerKey}`),
  );
  assert.deepEqual(
    await auth.authenticate(
      request({
        ...forged,
        Cookie: `oyster_session=${cookie}; principal=agent`,
      }),
    ),
    {
      kind: "admitted",
      principal: {
        actor: { kind: "member", memberId: "owner" },
        role: "owner",
      },
    },
  );
  // Forged claims cannot reach an App route through real HTTP admission.
  const app = createOyster({
    auth,
    installations: { list: async () => [], get: async () => null },
  });
  assert.equal(
    (
      await app.request("https://oyster.test/apps/missing/", {
        headers: forged,
      })
    ).status,
    401,
  );
  assert.deepEqual(
    invocationCallerContext(
      { actor: { kind: "team-key", keyId: "morel" } },
      null,
    ),
    {
      computerId: null,
      actor: { kind: "team-key", keyId: "morel" },
    },
  );
});

test("the agent host captures one App source per acquisition and retains agent attribution", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => {
    database.close();
  });
  const directory = newDirectory(
    { storage: fromNodeSqlite(database) },
    { OYSTER_OWNER_NAME: "authenticated-approver" },
  );
  const agent = await createApproved(directory, "Morel", "acquisition-agent", {
    actor: { kind: "member", memberId: "authenticated-approver" },
    role: "owner",
  });
  const artifacts = new Map();
  const put = async (value) => {
    const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
    const digest = await sha256(bytes);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    artifacts.set(artifactRef, bytes);
    return { artifactRef, digest, byteLength: bytes.length, version: digest };
  };
  const backend = await put({
    runtime: { kind: "durable-facet", stateSchema: 1 },
    compatibilityDate: "2026-09-04",
    exportName: "Notes",
    code: "export class Notes {}",
  });
  const declaration = {
    capabilities: [],
    handlers: [],
    roles: [],
    api: {
      methods: {
        "notes.read": {
          description: "Read",
          input: { type: "object" },
          output: { type: "object" },
          effect: "read",
          requires: [],
        },
      },
    },
  };
  const root = await put({
    format: "fungi-app-v1",
    backend: {
      ...backend,
      mediaType: "application/vnd.fungi.app-backend+json",
    },
    declaration,
  });
  const release = {
    releaseId: "rel_agent1",
    appId: "app_notes",
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
  const verified = await verifyRelease(
    { get: async (ref) => artifacts.get(ref) ?? null },
    release,
  );
  if (verified.declaration === null)
    throw new Error("Agent fixture declaration missing");
  let rows = [
    await approvedInstallation({
      installationId: "notes",
      instanceId: instanceIds.instance.generate(),
      release,
      declaration: verified.declaration,
    }),
  ];
  let reads = 0;
  const calls = [];
  const env = {
    OYSTER_ORIGIN: "https://oyster.test",
    OYSTER_OWNER_KEY: "owner-fixture-secret-24-characters",
    OYSTER_COMPUTER_ID: "agent-workspace",
    REGISTRY: {
      getByName: () => ({
        list: async () => {
          reads += 1;
          return rows;
        },
        get: async (installationId) =>
          rows.find((row) => row.installationId === installationId) ?? null,
      }),
    },
    RELEASES: {
      get: async (ref) =>
        artifacts.has(ref)
          ? { arrayBuffer: async () => artifacts.get(ref).buffer }
          : null,
    },
    INSTANCES: {
      getByName: () => ({
        call: async (facts, api, name) => {
          assert.equal(facts.subject.kind, "call");
          calls.push({
            selection: facts.selection,
            name,
            context: facts.subject.context,
          });
          return { ok: true, value: { kind: "ok", value: {} } };
        },
      }),
    },
    LOADER: {},
  };
  class Agent extends StandaloneAgent {
    modelSource() {
      return {
        acquire: async () => {
          throw new Error("No model calls in catalog proof");
        },
      };
    }
    options() {
      return this.shiitakeOptions();
    }
  }
  env.AGENT_DIRECTORY = { getByName: () => directory };
  const options = new Agent(
    {
      id: { name: agent.agentId },
      storage: {
        get: async () => ({ directoryName: "agents", tenantId: "default" }),
      },
    },
    env,
  ).options();
  assert.equal(reads, 0, "construction does not capture an installation list");
  assert.equal(
    (await options.instructions.load({})).modules,
    undefined,
    "instructions do not project duplicate modules",
  );
  const { text } = await options.instructions.load({});
  assert.match(text, /env\.BONSAI\.repos\.list\(\{\}\)/u);
  assert.doesNotMatch(text, /\["/u, "no bracket call syntax in the prompt");
  const acquired = [];
  let legacyApproval = false;
  const source = options.tools.sources[0];
  const runtime = await Mycelium.make({
    sources: [
      {
        ...source,
        acquire: async (context) => {
          const lease = await source.acquire(context);
          acquired.push(lease.snapshot);
          return lease;
        },
      },
    ],
    sandbox: directSandbox(async (bindings) => {
      if (legacyApproval) {
        // The call WAS captured with a real approval on first acquire; the
        // legacy-shaped row now makes that approval unreadable, which is
        // authority drift on an already-approved call, not an absent one --
        // the same `stale_authority` a revoked key gets after capture.
        await assert.rejects(
          bindings.NOTES["notes.read"]({}),
          /App method refused: stale_authority/u,
        );
      } else {
        await bindings.NOTES["notes.read"]({});
      }
      return null;
    }),
  });
  const first = await runtime.acquire();
  try {
    assert.equal(reads, 1);
    const prepared = await Effect.runPromise(
      first.executeTool.prepare({
        type: "toolCall",
        id: "read",
        name: "execute",
        arguments: { code: "return null" },
      }),
    );
    await Effect.runPromise(Stream.runCollect(prepared.execute()));
    assert.equal(reads, 1, "method invocation uses the captured source");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].context, {
      computerId: "agent-workspace",
      actor: { kind: "agent", agentId: agent.agentId },
    });
    legacyApproval = true;
    database
      .prepare("UPDATE app_tool_policies SET policy=? WHERE agent_id=?")
      .run(
        JSON.stringify({ level: "write", revision: "legacy" }),
        agent.agentId,
      );
    assert.equal(
      await directory.appToolPolicy({ kind: "agent", agentId: agent.agentId }),
      null,
    );
    const refused = await Effect.runPromise(
      first.executeTool.prepare({
        type: "toolCall",
        id: "legacy-refused",
        name: "execute",
        arguments: { code: "return null" },
      }),
    );
    await Effect.runPromise(Stream.runCollect(refused.execute()));
    assert.equal(
      calls.length,
      1,
      "legacy stored approval never reaches Instance dispatch",
    );
  } finally {
    await first.release();
    await runtime.close();
  }
  let version = acquired[0].version;
  const context = {
    signal: new globalThis.AbortController().signal,
    invalidate: () => assert.fail("captured source unexpectedly invalidated"),
  };
  for (const change of [
    { authorityVersion: 2 },
    { release: { ...release, releaseId: "rel_agent2" } },
    { status: "disabled" },
  ]) {
    rows = [{ ...rows[0], ...change }];
    const before = reads;
    const lease = await source.acquire(context);
    assert.equal(reads, before + 1);
    assert.notEqual(lease.snapshot.version, version);
    version = lease.snapshot.version;
    if (rows[0].status === "disabled")
      assert.deepEqual(lease.snapshot.modules, []);
    await lease.release();
  }
});

test("the Agent tool host derives the same App catalog as the MCP host for Computer and Media Apps", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const directory = newDirectory(
    { storage: fromNodeSqlite(database) },
    { OYSTER_OWNER_NAME: "owner" },
  );
  const agent = await createApproved(directory, "Shelf", "parity-agent", {
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  });
  const artifacts = new Map();
  const put = async (value) => {
    const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
    const digest = await sha256(bytes);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    artifacts.set(artifactRef, bytes);
    return { artifactRef, digest, byteLength: bytes.length, version: digest };
  };
  const backend = await put({
    runtime: { kind: "durable-facet", stateSchema: 1 },
    compatibilityDate: "2026-09-04",
    exportName: "Studio",
    code: "export class Studio {}",
  });
  const declaration = {
    capabilities: ["computer.execute", "media.generation"],
    handlers: [],
    roles: [],
    api: {
      methods: {
        "studio.read": {
          description: "Read",
          input: { type: "object" },
          output: { type: "object" },
          effect: "read",
          requires: [],
        },
      },
    },
  };
  const root = await put({
    format: "fungi-app-v1",
    backend: {
      ...backend,
      mediaType: "application/vnd.fungi.app-backend+json",
    },
    declaration,
  });
  const release = {
    releaseId: "rel_studio1",
    appId: "app_studio",
    artifact: {
      artifactRef: root.artifactRef,
      artifactDigest: root.digest,
      provenance: {
        sourceRevision: `git:${"b".repeat(40)}`,
        sourceTreeDigest: root.digest,
        buildRecipeDigest: root.digest,
      },
    },
  };
  const verified = await verifyRelease(
    { get: async (ref) => artifacts.get(ref) ?? null },
    release,
  );
  if (verified.declaration === null)
    throw new Error("Studio fixture declaration missing");
  let rows = [];
  const calls = [];
  const env = {
    OYSTER_ORIGIN: "https://oyster.test",
    OYSTER_OWNER_KEY: "owner-fixture-secret-24-characters",
    OYSTER_COMPUTER_ID: "agent-workspace",
    REGISTRY: {
      getByName: () => ({
        list: async () => rows,
        get: async (installationId) =>
          rows.find((row) => row.installationId === installationId) ?? null,
      }),
    },
    RELEASES: {
      get: async (ref) =>
        artifacts.has(ref)
          ? { arrayBuffer: async () => artifacts.get(ref).buffer }
          : null,
    },
    INSTANCES: {
      getByName: () => ({
        call: async (facts, api, name) => {
          calls.push(name);
          return { ok: true, value: { kind: "ok", value: {} } };
        },
      }),
    },
    AGENT_DIRECTORY: { getByName: () => directory },
    LOADER: {},
  };
  class Agent extends StandaloneAgent {
    modelSource() {
      return {
        acquire: async () => {
          throw new Error("No model calls in catalog parity proof");
        },
      };
    }
    options() {
      return this.shiitakeOptions();
    }
    rootHost(scope) {
      return this.hostFor(scope);
    }
  }
  const shelf = new Agent(
    {
      id: { name: agent.agentId },
      storage: {
        get: async () => ({ directoryName: "agents", tenantId: "default" }),
      },
    },
    env,
  );
  // Installation consent derives its operations from the root's HTTP/MCP host.
  const mcpHost = shelf.rootHost(tenantScope(defaultTenant, env.OYSTER_ORIGIN));
  const consented = await deriveDeclaredOperations(
    release,
    verified.declaration,
    mcpHost.capabilities,
  );
  rows = [
    await approvedInstallation({
      installationId: "studio",
      instanceId: instanceIds.instance.generate(),
      release,
      declaration: verified.declaration,
      descriptors: mcpHost.capabilities,
    }),
  ];
  assert.equal(rows[0].declaredOperationsDigest, consented.digest);
  const options = shelf.options();
  const runtime = await Mycelium.make({
    sources: [options.tools.sources[0]],
    sandbox: directSandbox(async (bindings) => {
      reads.push(await bindings.STUDIO["studio.read"]({}));
      return null;
    }),
  });
  const reads = [];
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "read",
        name: "execute",
        arguments: { code: "return null" },
      }),
    );
    await Effect.runPromise(Stream.runCollect(prepared.execute()));
  } finally {
    await lease.release();
    await runtime.close();
  }
  assert.equal(reads.length, 1);
  assert.deepEqual(
    calls,
    ["studio.read"],
    "the Agent reaches an App the MCP host admits",
  );
});

test("an Agent's App tools reach only its pinned tenant's registry", async () => {
  const registries = [];
  const env = {
    OYSTER_ORIGIN: "https://oyster.test",
    OYSTER_OWNER_KEY: "owner-fixture-secret-24-characters",
    OYSTER_COMPUTER_ID: "agent-workspace",
    REGISTRY: {
      getByName: (name) => {
        registries.push(name);
        return { list: async () => [] };
      },
    },
    AGENT_DIRECTORY: {
      getByName: () => ({ appToolPolicy: async () => null }),
    },
    LOADER: {},
  };
  class Agent extends StandaloneAgent {
    modelSource() {
      return {
        acquire: async () => {
          throw new Error("No model calls in tenant proof");
        },
      };
    }
    options() {
      return this.shiitakeOptions();
    }
  }
  const acquire = async (pin) => {
    const source = new Agent(
      { id: { name: "tenant-agent" }, storage: { get: async () => pin } },
      env,
    ).options().tools.sources[0];
    const lease = await source.acquire({
      signal: new globalThis.AbortController().signal,
      invalidate: () => assert.fail("captured source unexpectedly invalidated"),
    });
    await lease.release();
    return lease.snapshot.modules;
  };
  await acquire({ directoryName: "t.aa.agents", tenantId: "aa" });
  assert.deepEqual(registries, ["t.aa.registry"]);
  assert.deepEqual(
    await acquire({ directoryName: "agents", tenantId: "aa" }),
    [],
    "a pin whose directory is not its tenant's reaches no registry",
  );
  assert.deepEqual(
    await acquire(undefined),
    [],
    "an unpinned Agent has no Apps",
  );
  assert.deepEqual(registries, ["t.aa.registry"]);
});

test("the contest Agent creates its model lease from the Luna Worker secret without an AI binding", async () => {
  const agent = new StandaloneAgent(
    { id: { name: "contest-luna" } },
    {
      OYSTER_AGENT_MODEL: "@fungi/luna",
      AI_GATEWAY_AUTH_TOKEN: "fixture-only-not-a-real-provider-key",
      AI_GATEWAY_ACCOUNT_ID: "fixture-account",
      AI_GATEWAY_ID: "fixture-gateway",
    },
  );
  const lease = await agent.modelSource().acquire({});
  try {
    assert.equal(lease.model.id, "openai/gpt-6-luna");
    assert.equal(
      lease.model.baseUrl,
      "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/compat",
    );
    assert.equal(lease.model.provider, "openai");
    assert.equal(lease.model.api, "openai-responses");
    assert.equal(JSON.stringify(lease).includes("fixture-only"), false);
  } finally {
    await lease.release();
  }
});

test("Luna streams through the existing Veil gateway owner without exposing its credential", async (context) => {
  const sent = [];
  context.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new globalThis.Request(input, init);
    sent.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      gateway: request.headers.get("cf-aig-authorization"),
      body: await request.json(),
    });
    return globalThis.Response.json(
      { error: { message: "Fixture refuses inference" } },
      { status: 401 },
    );
  });
  const env = {
    OYSTER_AGENT_MODEL: "@fungi/luna",
    AI_GATEWAY_AUTH_TOKEN: "fixture-gateway-secret",
    AI_GATEWAY_ACCOUNT_ID: "account",
    AI_GATEWAY_ID: "gateway",
  };
  const agent = new StandaloneAgent({ id: { name: "luna" } }, env);
  const lease = await agent.modelSource().acquire({});
  try {
    const result = await lease
      .stream(
        lease.model,
        { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
        {},
      )
      .result();
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].url,
      "https://gateway.ai.cloudflare.com/v1/account/gateway/compat/responses",
    );
    assert.equal(sent[0].authorization, null);
    assert.equal(sent[0].gateway, "Bearer fixture-gateway-secret");
    assert.equal(sent[0].body.model, "openai/gpt-6-luna");
    assert.equal(
      JSON.stringify(result).includes("fixture-gateway-secret"),
      false,
    );
  } finally {
    await lease.release();
  }
  assert.throws(
    () =>
      new StandaloneAgent(
        { id: { name: "luna" } },
        { OYSTER_AGENT_MODEL: "@fungi/luna", AI: {} },
      ).modelSource(),
    /Configure the Luna AI Gateway/u,
  );
});

test("inbox starts every agent read before waiting and preserves rows, visits and revision", async () => {
  const entries = ["one", "two", "three", "four", "five"].map((agentId) => ({
    agentId,
    name: agentId,
  }));
  const started = [];
  const releases = [];
  const env = {
    AGENT_DIRECTORY: {
      getByName: () => ({
        list: async () => entries,
        visits: async () => [
          { agentId: "two", sessionId: "session_two", visitedAt: 90 },
        ],
        revision: async () => 7,
      }),
    },
    AGENTS: {
      getByName: (agentId) => ({
        inboxRows: () => {
          started.push(agentId);
          return new Promise((resolve) =>
            releases.push(() =>
              resolve({
                rows: [
                  {
                    sessionId: `session_${agentId}`,
                    title: agentId,
                    createdAt: 1,
                    lastActivityAt: 80,
                    state: "done",
                  },
                ],
                revision:
                  entries.findIndex((entry) => entry.agentId === agentId) + 1,
              }),
            ),
          );
        },
      }),
    },
  };
  const pending = standaloneAgents(env).inbox();
  try {
    await nextTurn();
    assert.deepEqual([...started], ["one", "two", "three", "four", "five"]);
    releases.forEach((release) => release());
    const page = await pending;
    assert.equal(page.revision, 22);
    assert.deepEqual(
      page.items.map((item) => item.agentId),
      ["one", "two", "three", "four", "five"],
    );
    assert.equal(page.items[1].visitedAt, 90);
    assert.equal(page.items[0].visitedAt, undefined);
  } finally {
    releases.forEach((release) => release());
  }
});

test("revision polling reads only agent clocks and includes directory changes", async () => {
  let directoryRevision = 3;
  const clocks = { one: 2, two: 3, three: 4 };
  let rowReads = 0;
  let visitReads = 0;
  const adapter = standaloneAgents({
    AGENT_DIRECTORY: {
      getByName: () => ({
        list: async () =>
          Object.keys(clocks).map((agentId) => ({ agentId, name: agentId })),
        revision: async () => directoryRevision,
        visits: async () => {
          visitReads += 1;
          return [];
        },
      }),
    },
    AGENTS: {
      getByName: (agentId) => ({
        revision: async () => clocks[agentId],
        inboxRows: async () => {
          rowReads += 1;
          return { rows: [], revision: clocks[agentId] };
        },
      }),
    },
  });
  assert.equal(await adapter.revision(), 12);
  assert.equal(await adapter.revision(), 12);
  directoryRevision = 4;
  assert.equal(
    await adapter.revision(),
    13,
    "a member visit invalidates the feed",
  );
  clocks.three = 6;
  assert.equal(
    await adapter.revision(),
    15,
    "a changed Session invalidates the feed",
  );
  assert.equal(rowReads, 0);
  assert.equal(visitReads, 0);
});
