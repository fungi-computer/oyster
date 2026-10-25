import { seededAvatar } from "@fungi.computer/sprite/avatar";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { URL } from "node:url";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { PostRowSchema } from "@fungi.computer/carrier/post";
import { createAgentDirectory } from "@fungi.computer/shiitake/fleet";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SubagentsProjection } from "@fungi.computer/shiitake-extensions/subagents";
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
import { fauxModel } from "@fungi.computer/mule/testing";
import { memoryHost, fauxModelSource } from "@fungi.computer/shiitake/testing";
import { run as runMule } from "@fungi.computer/mule/effect";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  messageAuthor,
  messageDelegationReply,
} from "@fungi.computer/agar/agents";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.ts";
import { createInstallationStoreGeneration } from "../../src/installation-store-generation.js";
import { ordinaryRosterLaw } from "./roster-laws.ts";

const { Response, Request, AbortController } = globalThis;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@fungi.computer/shiitake/cloudflare")
      return {
        url: new URL("../../../shiitake/src/cloudflare.ts", import.meta.url)
          .href,
        shortCircuit: true,
      };
    if (specifier === "@fungi.computer/computer/fleet")
      return {
        url: new URL("../../../computer/src/fleet/index.ts", import.meta.url)
          .href,
        shortCircuit: true,
      };
    if (specifier === "@fungi.computer/shiitake/fleet")
      return {
        url: new URL("../../../shiitake/src/fleet.ts", import.meta.url).href,
        shortCircuit: true,
      };
    if (specifier === "@fungi.computer/knapsack")
      return {
        url: new URL("../../../knapsack/src/index.ts", import.meta.url).href,
        shortCircuit: true,
      };
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
const { AgentDelegation } = await import("@fungi.computer/shiitake/delegation");
const {
  AgentDirectory,
  standaloneAgents,
  StandaloneAgentBase,
  dispatchAgentBinding,
} = await import("../../src/standalone/agents.ts");
const { OysterBinding } = await import("../../src/standalone/instance.ts");
hooks.deregister();

for (const home of [
  { kind: "machine", deviceId: "device", memberId: "owner" },
  null,
]) {
  const label = home?.kind ?? "missing";
  test(`root fetch refuses unsupported homes (${label}) before addressing AGENTS`, async () => {
    let addressed = 0;
    const adapter = standaloneAgents({
      AGENT_DIRECTORY: {
        getByName: () => ({
          has: () => Promise.resolve(true),
          agentHome: () => Promise.resolve(home),
        }),
      },
      AGENTS: {
        getByName: () => {
          addressed += 1;
          return { fetch: () => Promise.resolve(new Response("hosted")) };
        },
      },
    });
    const response = await adapter.fetch(
      "target",
      new Request("https://oyster.test/sessions"),
    );
    if (home?.kind === "machine") {
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "actor_not_allowed" });
    } else assert.equal(response, null);
    assert.equal(addressed, 0);
  });

  test(`App send refuses unsupported homes (${label}) before addressing AGENTS`, async () => {
    let addressed = 0;
    const env = {
      AGENT_DIRECTORY: {
        getByName: () => ({
          has: () => Promise.resolve(true),
          agentHome: () => Promise.resolve(home),
        }),
      },
      AGENTS: {
        getByName: () => {
          addressed += 1;
          throw new Error("Unsupported target addressed a hosted Agent");
        },
      },
    };
    // Instance frame admission is outside this target-resolution law.
    const frame = {
      frameId: "frame",
      facts: { selection: { owner: { kind: "installation", id: "app" } } },
      host: undefined,
      signal: new AbortController().signal,
    };
    await assert.rejects(
      dispatchAgentBinding(
        env,
        tenantScope(defaultTenant, "https://oyster.test"),
        frame,
        { instanceId: "instance", frameId: "frame", binding: "AGENTS" },
        "send",
        [
          {
            agentId: "target",
            sessionId: "main",
            requestId: "send",
            text: "Hello",
            delivery: "followUp",
          },
        ],
      ),
      home?.kind === "machine"
        ? {
            name: "MachineLinkRefused",
            reason: "actor_not_allowed",
            message: "machine-link:actor_not_allowed",
          }
        : { name: "AppInstanceError", code: "revoked" },
    );
    assert.equal(addressed, 0);
  });
}

test("App send preserves installation attribution for a hosted target", async () => {
  const sent = [];
  const accepted = { status: "accepted", commandId: "command" };
  const env = {
    AGENT_DIRECTORY: {
      getByName: () => ({
        has: () => Promise.resolve(true),
        agentHome: () => Promise.resolve({ kind: "hosted" }),
      }),
    },
    AGENTS: {
      getByName: (agentId) => {
        assert.equal(agentId, "target");
        return {
          sendFromApp: (...args) => {
            sent.push(args);
            return Promise.resolve(accepted);
          },
        };
      },
    },
  };
  const input = {
    agentId: "target",
    sessionId: "main",
    requestId: "send",
    text: "Hello",
    delivery: "followUp",
  };
  assert.deepEqual(
    await dispatchAgentBinding(
      env,
      tenantScope(defaultTenant, "https://oyster.test"),
      {
        frameId: "frame",
        facts: { selection: { owner: { kind: "installation", id: "app" } } },
        host: undefined,
        signal: new AbortController().signal,
      },
      { instanceId: "instance", frameId: "frame", binding: "AGENTS" },
      "send",
      [input],
    ),
    accepted,
  );
  assert.deepEqual(sent, [
    ["app", "main", { requestId: "send", text: "Hello", delivery: "followUp" }],
  ]);
});

test("root hosted fetch rechecks the current home before each dispatch", async () => {
  let home = { kind: "hosted" };
  let addressed = 0;
  const adapter = standaloneAgents({
    AGENT_DIRECTORY: {
      getByName: () => ({
        has: () => Promise.resolve(true),
        agentHome: () => Promise.resolve(home),
      }),
    },
    AGENTS: {
      getByName: () => {
        addressed += 1;
        return { fetch: () => Promise.resolve(new Response("hosted")) };
      },
    },
  });
  assert.equal(
    (await adapter.fetch("target", new Request("https://oyster.test/sessions")))
      .status,
    200,
  );
  home = { kind: "machine", deviceId: "device", memberId: "owner" };
  const refusal = await adapter.fetch(
    "target",
    new Request("https://oyster.test/sessions"),
  );
  assert.equal(refusal.status, 409);
  assert.deepEqual(await refusal.json(), { error: "actor_not_allowed" });
  assert.equal(addressed, 1);
});

test("standalone serves Knapsack.ui only for stored Sessions and closes its source with the host", async () => {
  const database = new DatabaseSync(":memory:");
  const tasks = [];
  class Agent extends StandaloneAgentBase {
    hostFor() {
      throw new Error("No App host in this UI transport test");
    }
    modelSource() {
      return {
        acquire: () => Promise.reject(new Error("No model in this test")),
      };
    }
    client() {
      return this.shiitake();
    }
    options() {
      return this.shiitakeOptions();
    }
    close() {
      return this.closeShiitake();
    }
  }
  const agent = new Agent(
    {
      id: { name: "agent_ui" },
      storage: cloudflareStorageFixture(fromNodeSqlite(database)),
      waitUntil: (task) => tasks.push(task),
    },
    { OYSTER_ORIGIN: "https://oyster.test", LOADER: {} },
  );
  const abort = new globalThis.AbortController();
  let sourceLease;
  let uiRuntime;
  try {
    const client = await agent.client();
    const sessionId = await client.createSession("stage");
    const request = () =>
      new globalThis.Request(
        `https://agent.test/browser/sessions/${sessionId}/browser/events`,
        { signal: abort.signal },
      );
    const response = await agent.fetch(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const missing = await agent.fetch(
      new globalThis.Request(
        "https://agent.test/browser/sessions/absent/browser/events",
      ),
    );
    assert.equal(missing.status, 404);
    const options = await agent.options();
    const source = options.tools.sources.find(
      (item) => item.id === "oyster-ui",
    );
    assert.ok(source, "the real Agent run borrows Knapsack.ui");
    uiRuntime = await Mycelium.make({
      sources: [source],
      session: { sessionId },
      sandbox: directSandbox(() => Promise.resolve(null)),
    });
    sourceLease = await uiRuntime.acquire();
    const paths = sourceLease.catalog.list({}).results.map((item) => item.path);
    assert.ok(paths.includes("ui.discover"));
    assert.ok(paths.includes("ui.execute"));
    await agent.close();
    assert.equal((await agent.fetch(request())).status, 410);
  } finally {
    abort.abort();
    await sourceLease?.release();
    await uiRuntime?.close();
    await agent.close();
    await Promise.allSettled(tasks);
    database.close();
  }
});

for (const delivery of ["steer", "followUp"]) {
  for (const state of ["pending", "active", "settled"]) {
    test(`hosted ${delivery} recall is exact and pending-only (${state})`, async () => {
      const database = new DatabaseSync(":memory:");
      const storage = cloudflareStorageFixture(fromNodeSqlite(database));
      const entered = Promise.withResolvers();
      const released = Promise.withResolvers();
      let modelSignal;
      let reconciliation;
      const target = await memoryHost({
        model: fauxModelSource([
          async (_context, options) => {
            modelSignal = options?.signal;
            entered.resolve();
            if (state === "active") await released.promise;
            return fauxAssistantMessage("Done");
          },
        ]),
      });
      let authorized = true;
      let opens = 0;
      let releases = 0;
      const directory = {
        list: async () => [
          { agentId: "parent", name: "Parent" },
          { agentId: "other-parent", name: "Other parent" },
          ...(authorized ? [{ agentId: "child", name: "Child" }] : []),
        ],
        open: async () => {
          opens += 1;
          return {
            agent: target.agent,
            release: async () => {
              releases += 1;
            },
          };
        },
      };
      const deps = {
        storage,
        expiresAt: () => Date.now() + 60_000,
        identity: () => ({ scopeId: "team", agentId: "parent" }),
        directory: () => directory,
        deliver: async (mail) =>
          target.agent
            .withMeta(mail.meta)
            .session(mail.to.sessionId)
            .send(mail.content, {
              requestId: mail.key,
              delivery: "followUp",
            }),
        prepare: () => Promise.resolve(),
        accept: async () => {
          throw new Error("No replies in this fixture");
        },
      };
      const input = {
        agentId: "child",
        sessionId: "child-main",
        requestId: "caller-request",
        text: "Work",
        delivery,
      };
      const request = {
        agentId: input.agentId,
        sessionId: input.sessionId,
        requestId: input.requestId,
      };
      const signal = new globalThis.AbortController().signal;
      try {
        const owner = new AgentDelegation(deps);
        const sent = await owner.send(input, "parent-main", signal, {
          toolCallId: "first",
          sendIndex: 0,
        });
        const reopened = new AgentDelegation(deps);
        assert.deepEqual(
          await reopened.send(input, "parent-main", signal, {
            toolCallId: "retry",
            sendIndex: 1,
          }),
          sent,
        );
        assert.equal(
          (await target.agent.session("child-main").read()).pending.prompts
            .length,
          1,
        );
        assert.deepEqual(
          await reopened.recall(request, "other-source", signal),
          { status: "unknown" },
        );
        const otherSenderDatabase = new DatabaseSync(":memory:");
        try {
          const otherSender = new AgentDelegation({
            ...deps,
            storage: cloudflareStorageFixture(
              fromNodeSqlite(otherSenderDatabase),
            ),
            identity: () => ({ scopeId: "team", agentId: "other-parent" }),
          });
          assert.deepEqual(
            await otherSender.recall(request, "parent-main", signal),
            {
              status: "unknown",
            },
          );
        } finally {
          otherSenderDatabase.close();
        }
        assert.deepEqual(
          await reopened.recall(
            { ...request, sessionId: "other-target" },
            "parent-main",
            signal,
          ),
          { status: "unknown" },
        );
        authorized = false;
        await assert.rejects(
          reopened.recall(request, "parent-main", signal),
          /outside this scope/,
        );
        authorized = true;
        if (state === "active") {
          reconciliation = target.reconcile();
          await entered.promise;
        } else if (state === "settled") await target.settle("child-main");
        const expected =
          state === "pending"
            ? sent
            : { status: "too_late", commandId: sent.commandId };
        assert.deepEqual(
          await reopened.recall(request, "parent-main", signal),
          expected,
        );
        assert.deepEqual(
          await reopened.recall(request, "parent-main", signal),
          expected,
        );
        if (state === "active") assert.equal(modelSignal.aborted, false);
        assert.equal(opens, releases);
      } finally {
        released.resolve();
        await reconciliation;
        await target.close();
        database.close();
      }
    });
  }
}

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
  return {
    agentId: entry.agentId,
    name: entry.name,
    avatar: entry.avatar,
    createdBy: entry.createdBy,
  };
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

test("standalone: ordinary Agent creation freezes createdBy and preserves the human credential owner", async () => {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const owner = {
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  };
  const directory = newDirectory({ storage }, {});
  const create = (name, requestId, createdBy = null) =>
    directory.create(
      name,
      requestId,
      owner,
      "owner-direct",
      undefined,
      createdBy,
    );
  try {
    const parent = await create("Parent", "parent");
    const child = await create("Child", "child", parent.agentId);
    assert.equal(parent.createdBy, null);
    assert.equal(child.createdBy, parent.agentId);
    assert.equal(directory.readCreator(child.agentId), "owner");
    assert.equal(
      (await create("Child", "child", parent.agentId)).agentId,
      child.agentId,
    );
    await assert.rejects(
      async () => create("Child", "child"),
      /request_conflict/u,
    );
    assert.equal(
      directory.list().find((agent) => agent.agentId === child.agentId)
        .createdBy,
      parent.agentId,
    );
  } finally {
    database.close();
  }
});

// Real Fleet SQLite owns receipt reuse. The transport deliberately returns a
// fresh receipt on EVERY call: it cannot hide duplicate delivery with dedupe.
function delegationCallerFixture(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const storage = fromNodeSqlite(database);
  const delivered = [];
  const open = (scopeId = "scope", agentId = "sender") =>
    new AgentDelegation({
      storage,
      expiresAt: () => Date.now() + 60_000,
      identity: () => ({ scopeId, agentId }),
      directory: () => ({
        list: async () =>
          ["sender", "other-sender", "recipient", "other-recipient"].map(
            (id) => ({ agentId: id, name: id, createdBy: null }),
          ),
        open: async () => {
          throw new Error("An addressed send must not create a Session");
        },
      }),
      deliver: async (mail) => {
        delivered.push(mail);
        return {
          status: "accepted",
          commandId: `transport-receipt-${delivered.length}`,
        };
      },
      prepare: async () => undefined,
      accept: async () => {
        throw new Error("This sender test must not admit incoming mail");
      },
    });
  return { open, delivered };
}
const callerTask = {
  agentId: "recipient",
  sessionId: "recipient-session",
  requestId: "one-intent",
  text: "Do this work",
  delivery: "followUp",
};
const callerInvocation = {
  commandId: "creator-command",
  toolCallId: "creator-tool",
  sendIndex: 0,
  toolCallCode: "await agents.send(task)",
};
const nextCallerInvocation = {
  ...callerInvocation,
  commandId: "next-creator-command",
  toolCallId: "next-creator-tool",
  sendIndex: 7,
};
const callerSignal = () => new globalThis.AbortController().signal;

test("delegation caller identity reuses its Fleet receipt across a new turn and reopen", async (t) => {
  const f = delegationCallerFixture(t);
  const sender = f.open();
  const first = await sender.send(
    callerTask,
    "source-session",
    callerSignal(),
    callerInvocation,
  );
  assert.deepEqual(
    await sender.send(
      callerTask,
      "source-session",
      callerSignal(),
      nextCallerInvocation,
    ),
    first,
  );
  assert.deepEqual(
    await f
      .open()
      .send(callerTask, "source-session", callerSignal(), nextCallerInvocation),
    first,
  );
  assert.equal(f.delivered.length, 1);
});

for (const [dimension, variant] of [
  ["requestId", { input: { requestId: "another-intent" } }],
  ["scope", { scopeId: "other-scope" }],
  ["sender", { agentId: "other-sender" }],
  ["sender Session", { sourceSessionId: "other-source-session" }],
  ["recipient", { input: { agentId: "other-recipient" } }],
  ["recipient Session", { input: { sessionId: "other-recipient-session" } }],
]) {
  test(`delegation caller identity does not alias a distinct ${dimension}`, async (t) => {
    const f = delegationCallerFixture(t);
    const first = await f
      .open()
      .send(callerTask, "source-session", callerSignal(), callerInvocation);
    const second = await f
      .open(variant.scopeId, variant.agentId)
      .send(
        { ...callerTask, ...variant.input },
        variant.sourceSessionId ?? "source-session",
        callerSignal(),
        callerInvocation,
      );
    assert.notEqual(second.commandId, first.commandId);
    assert.equal(f.delivered.length, 2);
    assert.notEqual(f.delivered[0].key, f.delivered[1].key);
  });
}

test("delegation caller identity refuses changed payload on the same requestId", async (t) => {
  const f = delegationCallerFixture(t);
  await f
    .open()
    .send(callerTask, "source-session", callerSignal(), callerInvocation);
  await assert.rejects(
    f
      .open()
      .send(
        { ...callerTask, text: "Different work" },
        "source-session",
        callerSignal(),
        nextCallerInvocation,
      ),
    /request_conflict/u,
  );
  assert.equal(f.delivered.length, 1);
});

for (const outcome of [
  "completed",
  "failed",
  "cancelled",
  "revoked",
  "deferred-revoked",
]) {
  test(
    outcome === "deferred-revoked"
      ? "standalone refuses a queued reply after transport failure, sender revocation and reopen"
      : outcome === "revoked"
        ? "standalone finishes revoked sender work but sends no evidence and refuses new mail"
        : `standalone delegation authenticates one ${outcome} reply, replays once and refuses foreign targets`,
    { timeout: 15_000 },
    async (t) => {
      let announceTransportFailure;
      const transportFailed = new Promise((resolve) => {
        announceTransportFailure = resolve;
      });
      const databases = [];
      const tasks = [];
      const hosts = new Map();
      const models = new Map();
      const states = new Map();
      const storage = () => {
        const database = new DatabaseSync(":memory:");
        databases.push(database);
        const kv = new Map();
        return {
          ...cloudflareStorageFixture(fromNodeSqlite(database)),
          get: async (key) => kv.get(key),
          put: async (key, value) => {
            kv.set(key, value);
          },
          delete: async (key) => kv.delete(key),
          list: async ({ prefix, startAfter, limit }) =>
            new Map(
              [...kv]
                .filter(
                  ([key]) =>
                    key.startsWith(prefix) &&
                    (startAfter === undefined || key > startAfter),
                )
                .sort(([a], [b]) => a.localeCompare(b))
                .slice(0, limit),
            ),
        };
      };
      const directoryStorage = storage();
      const directory = newDirectory(
        { id: { name: "agents" }, storage: directoryStorage },
        { OYSTER_ORIGIN: "https://oyster.test" },
      );
      const delivered = [];
      let replyTransportAvailable = outcome !== "deferred-revoked";
      let replyAttempts = 0;
      const owner = {
        actor: { kind: "member", memberId: "owner" },
        role: "owner",
      };
      const parent = directory.create(
        "Parent",
        "parent",
        owner,
        "owner-direct",
      );
      const child = directory.create(
        "Child",
        "child",
        owner,
        "owner-direct",
        undefined,
        parent.agentId,
      );
      assert.equal(child.createdBy, parent.agentId);
      assert.equal(directory.readCreator(child.agentId), "owner");
      assert.deepEqual(await directory.agentHome(parent.agentId), {
        kind: "hosted",
      });
      assert.deepEqual(await directory.agentHome(child.agentId), {
        kind: "hosted",
      });
      const env = {
        OYSTER_ORIGIN: "https://oyster.test",
        AGENT_DIRECTORY: { getByName: () => directory },
        AGENTS: {
          getByName: (id) => {
            const host = hosts.get(id);
            assert.ok(host, "host exists");
            return {
              fetch: (request) => host.fetch(request),
              settlement: (principal, sessionId, commandId) =>
                host.settlement(principal, sessionId, commandId),
              deliver: (envelope) => {
                if (id === parent.agentId && envelope.kind === "agentMail") {
                  replyAttempts += 1;
                  if (!replyTransportAvailable) {
                    announceTransportFailure();
                    return Promise.reject(
                      new Error("Reply transport unavailable before dispatch"),
                    );
                  }
                }
                delivered.push(envelope);
                // Reaching the wire is already disclosure, even if the removed
                // recipient would refuse the envelope rather than start work.
                if (outcome === "deferred-revoked" && id === parent.agentId)
                  return Promise.resolve("refused");
                return host.deliver(envelope);
              },
              usePolicyDirectory: (pin) => host.usePolicyDirectory(pin),
            };
          },
        },
        LOADER: {},
      };
      class Agent extends StandaloneAgent {
        modelSource() {
          const model = models.get(this.ctx.id.name);
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
            tools: {
              ...options.tools,
              sources: options.tools.sources.filter(
                (source) => source.id === "shiitake-agent-control",
              ),
              sandbox: directSandbox(async () => null),
            },
          };
        }
        async sources() {
          return (await this.shiitakeOptions()).tools.sources.filter(
            (source) => source.id === "shiitake-agent-control",
          );
        }
      }
      const parentModel = fauxModel([fauxAssistantMessage("Reply received")]);
      let started;
      const running = new Promise((resolve) => {
        started = resolve;
      });
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const childModel = fauxModel([
        async () => {
          started();
          if (
            outcome === "cancelled" ||
            outcome === "revoked" ||
            outcome === "deferred-revoked"
          )
            await held;
          return fauxAssistantMessage(
            "Child result",
            outcome === "failed"
              ? { stopReason: "error", errorMessage: "provider failed" }
              : outcome === "cancelled"
                ? { stopReason: "aborted" }
                : {},
          );
        },
      ]);
      models.set(parent.agentId, parentModel);
      models.set(child.agentId, childModel);
      for (const entry of [parent, child]) {
        const state = {
          id: { name: entry.agentId },
          storage: storage(),
          waitUntil: (task) => {
            tasks.push(task);
          },
        };
        states.set(entry.agentId, state);
        const host = new Agent(state, env);
        hosts.set(entry.agentId, host);
        await host.usePolicyDirectory({
          directoryName: "agents",
          tenantId: defaultTenant,
        });
      }
      let target = child.agentId;
      let requestId = "run-child";
      let operation = "send";
      const sandbox = directSandbox(async (bindings) =>
        operation === "recall"
          ? bindings.agents.recall({
              agentId: target,
              sessionId: "main",
              requestId,
            })
          : bindings.agents.send({
              agentId: target,
              sessionId: "main",
              requestId,
              text: "Run child",
              delivery: "followUp",
            }),
      );
      const parentHost = hosts.get(parent.agentId);
      const parentClient = await parentHost.client();
      const sessionId = await parentClient.createSession("parent-session");
      await assert.rejects(
        parentHost.settlement(
          {
            teamId: "agents",
            actor: { kind: "agent", id: child.agentId },
          },
          sessionId,
          "missing-command",
        ),
        /Accepted Session command is unavailable/u,
      );
      await ordinaryRosterLaw(parentClient, sessionId);
      const runtime = await Mycelium.make({
        session: { sessionId },
        sources: await parentHost.sources(),
        sandbox,
      });
      const lease = await runtime.acquire();
      const invocation = {
        type: "toolCall",
        id: "delegate",
        name: "execute",
        arguments: { code: "agents.send" },
      };
      try {
        operation = "recall";
        requestId = "unknown-request";
        const unknown = await Effect.runPromise(
          lease.executeTool.prepare({ ...invocation, id: "unknown-recall" }),
        );
        const unknownParts = await Effect.runPromise(
          Stream.runCollect(unknown.execute()),
        );
        assert.deepEqual(JSON.parse(unknownParts[0].result.content[0].text), {
          status: "unknown",
        });
        operation = "send";
        requestId = "run-child";
        const call = await Effect.runPromise(
          lease.executeTool.prepare(invocation),
        );
        const sent = await Effect.runPromise(Stream.runCollect(call.execute()));
        assert.equal(sent[0].result.isError, false);
        assert.deepEqual(
          await Effect.runPromise(Stream.runCollect(call.execute())),
          sent,
        );
        // Caller request identity survives a different model tool invocation.
        const retry = await Effect.runPromise(
          lease.executeTool.prepare({ ...invocation, id: "retry-new-call" }),
        );
        assert.deepEqual(
          await Effect.runPromise(Stream.runCollect(retry.execute())),
          sent,
        );
        await running;
        operation = "recall";
        const late = await Effect.runPromise(
          lease.executeTool.prepare({ ...invocation, id: "late-recall" }),
        );
        const lateParts = await Effect.runPromise(
          Stream.runCollect(late.execute()),
        );
        const receipt = JSON.parse(sent[0].result.content[0].text);
        if (
          outcome === "cancelled" ||
          outcome === "revoked" ||
          outcome === "deferred-revoked"
        )
          await assert.rejects(
            hosts.get(child.agentId).settlement(
              {
                teamId: "agents",
                actor: { kind: "agent", id: parent.agentId },
              },
              "main",
              receipt.commandId,
            ),
            /Settled delegated command evidence is unavailable/u,
          );
        assert.deepEqual(JSON.parse(lateParts[0].result.content[0].text), {
          status: "too_late",
          commandId: receipt.commandId,
        });
        operation = "send";
        if (outcome === "deferred-revoked") release();
        if (outcome === "revoked") {
          directoryStorage.transactionSync(() => {
            createAgentDirectory(directoryStorage.sql).remove(
              {
                agents: "all",
                actions: ["manage"],
                expiresAt: Date.now() + 60_000,
                provenance: { actor: "owner" },
              },
              parent.agentId,
            );
          });
          release();
        }
        if (outcome === "cancelled") {
          await (
            await hosts.get(child.agentId).client()
          )
            .withMeta({ author: { id: "owner", name: "Owner" } })
            .session("main")
            .abort();
          release();
        }
        if (outcome === "deferred-revoked") await transportFailed;
        else for (const task of tasks) await task;
        const childClient = await hosts.get(child.agentId).client();
        const terminal = (await childClient.session("main").read())
          .terminals[0];
        assert.ok(terminal, "recipient command settled");
        assert.equal(
          (await childClient.readSettlement("main", terminal.commandId))
            .acceptedSender,
          parent.agentId,
        );
        if (outcome === "cancelled")
          assert.equal(messageAuthor(terminal.meta)?.id, "owner");
        if (outcome === "deferred-revoked") {
          assert.equal(terminal.outcome, "completed");
          assert.equal(parentModel.state.callCount, 0);
          assert.ok(replyAttempts >= 1);
          const original = delivered.find(
            (mail) => mail.address.agentId === child.agentId,
          );
          assert.ok(original);
          const childState = states.get(child.agentId);
          const readReply = () =>
            Schema.decodeUnknownSync(PostRowSchema)(
              childState.storage.sql
                .exec(
                  "SELECT value FROM carrier_post_rows WHERE key = ?",
                  `post:${original.key}:reply:0`,
                )
                .one().value,
            );
          assert.equal(readReply().state, "pending");
          const mailRoom = (await hosts.get(child.agentId).shiitakeOptions())
            .mailRoom;
          assert.equal(
            await Effect.runPromise(mailRoom.nextWakeAt()),
            readReply().nextAttemptAt,
            "the shared mail owner retains Carrier's owed retry in its wake answer",
          );
          directoryStorage.transactionSync(() => {
            createAgentDirectory(directoryStorage.sql).remove(
              {
                agents: "all",
                actions: ["manage"],
                expiresAt: Date.now() + 60_000,
                provenance: { actor: "owner" },
              },
              parent.agentId,
            );
          });
          await childClient.close();
          const pending = readReply();
          assert.equal(pending.state, "pending");
          const attemptsBeforeRetry = replyAttempts;
          const reopened = new Agent(childState, env);
          hosts.set(child.agentId, reopened);
          replyTransportAvailable = true;
          const wakeAt = async (now) => {
            const clock = t.mock.method(Date, "now", () => now);
            try {
              await reopened.alarm();
            } finally {
              clock.mock.restore();
            }
            for (const task of tasks) await task;
          };
          await wakeAt(pending.nextAttemptAt + 1);
          assert.equal(
            delivered.filter((mail) => mail.address.agentId === parent.agentId)
              .length,
            0,
          );
          assert.partialDeepStrictEqual(readReply(), {
            state: "dead",
            reason: "refused",
            attempts: pending.attempts + 1,
          });
          await wakeAt(pending.nextAttemptAt + 60_000);
          assert.partialDeepStrictEqual(readReply(), {
            state: "dead",
            reason: "refused",
            attempts: pending.attempts + 1,
          });
          assert.equal(replyAttempts, attemptsBeforeRetry);
          assert.equal(parentModel.state.callCount, 0);
          assert.equal(childModel.state.callCount, 1);
          return;
        }
        if (outcome === "revoked") {
          assert.equal(terminal.outcome, "completed");
          assert.equal(childModel.state.callCount, 1);
          assert.equal(
            delivered.filter((mail) => mail.address.agentId === parent.agentId)
              .length,
            0,
          );
          assert.equal(parentModel.state.callCount, 0);
          const original = delivered.find(
            (mail) => mail.address.agentId === child.agentId,
          );
          assert.ok(original);
          assert.equal(
            await hosts.get(child.agentId).deliver({
              ...original,
              key: "after-revocation",
              event: { ...original.event, key: "after-revocation" },
            }),
            "refused",
          );
          return;
        }
        const snapshot = await parentClient.session(sessionId).read();
        const replies = snapshot.messages.filter(
          ({ value }) => value.role === "user",
        );
        assert.equal(replies.length, 1);
        assert.deepEqual(messageAuthor(replies[0].meta), {
          id: child.agentId,
          name: "Child",
          kind: "agent",
        });
        assert.equal(messageDelegationReply(replies[0].meta).outcome, outcome);
        assert.equal(parentModel.state.callCount, 1);
        assert.equal(childModel.state.callCount, 1);
        const forged = {
          key: "never-sent:reply:0",
          kind: "agentMail",
          address: { scopeId: "agents", agentId: parent.agentId },
          event: {
            key: "never-sent:reply:0",
            from: { kind: "agent", agentId: child.agentId, sessionId: "main" },
            to: { kind: "agent", agentId: parent.agentId, sessionId },
            replyTo: [],
            content: "Forged completion",
            createdAt: Date.now(),
            reply: {
              commandId: messageDelegationReply(replies[0].meta).commandId,
              outcome: "completed",
            },
          },
        };
        assert.equal(await parentHost.deliver(forged), "refused");
        assert.deepEqual(
          (await parentClient.session(sessionId).read()).messages,
          snapshot.messages,
        );
        await t.waitFor(
          async () => {
            const slot = (await parentClient.session(sessionId).read())
              .extensions["botanical-session-subagents"];
            if (slot?.status !== "running" || slot.value === null) return false;
            const footer = Schema.decodeUnknownSync(SubagentsProjection)(
              slot.value,
            );
            return (
              footer.agents.length === 1 &&
              footer.agents[0].agentId === child.agentId &&
              footer.agents[0].sessionId === "main"
            );
          },
          { timeout: 3_000 },
        );
        await parentClient.close();
        const reopened = new Agent(states.get(parent.agentId), env);
        hosts.set(parent.agentId, reopened);
        await reopened.client();
        const replayRuntime = await Mycelium.make({
          session: { sessionId },
          sources: await reopened.sources(),
          sandbox,
        });
        const replayLease = await replayRuntime.acquire();
        try {
          const replay = await Effect.runPromise(
            replayLease.executeTool.prepare(invocation),
          );
          assert.deepEqual(
            await Effect.runPromise(Stream.runCollect(replay.execute())),
            sent,
          );
          assert.equal(childModel.state.callCount, 1);
          target = "foreign";
          const foreign = await Effect.runPromise(
            replayLease.executeTool.prepare({ ...invocation, id: "foreign" }),
          );
          await assert.rejects(
            Effect.runPromise(Stream.runCollect(foreign.execute())),
            {
              phase: "tool",
            },
          );
          assert.equal(childModel.state.callCount, 1);
          target = child.agentId;
          const childHost = hosts.get(child.agentId);
          const deliver = childHost.deliver;
          // This is a NEW intent. Reusing run-child must return its already
          // recorded receipt without touching this receiptless transport.
          requestId = "receiptless-child";
          let receiptlessAttempts = 0;
          childHost.deliver = async () => {
            receiptlessAttempts += 1;
            return "accepted";
          };
          try {
            const receiptless = await Effect.runPromise(
              replayLease.executeTool.prepare({
                ...invocation,
                id: "receiptless",
              }),
            );
            await assert.rejects(
              Effect.runPromise(Stream.runCollect(receiptless.execute())),
              { phase: "tool" },
            );
            assert.equal(receiptlessAttempts, 1);
            assert.equal(childModel.state.callCount, 1);
          } finally {
            childHost.deliver = deliver;
          }
        } finally {
          await replayLease.release();
          await replayRuntime.close();
        }
      } finally {
        release();
        await lease.release();
        await runtime.close();
        for (const host of hosts.values()) await (await host.client()).close();
        await Promise.all(tasks);
        for (const database of databases) database.close();
      }
    },
  );
}

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
    await sender.send({
      ...input,
      requestId: "continue-intent",
      text: "Continue",
      delivery: "followUp",
    }),
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

    // The avatar is the Agent's: seeded until chosen, then kept across reopen.
    assert.deepEqual(morel.avatar, seededAvatar(morel.agentId));
    const cat = {
      v: 1,
      character: "cat",
      appearance: { body: "#9bd47a", stripes: "#e6f8d8" },
      expression: "normal",
      renderStyle: "plain",
    };
    const owner = {
      actor: { kind: "member", memberId: "Levi" },
      role: "owner",
    };
    assert.deepEqual(
      reopened.setAvatar(morel.agentId, cat, {
        actor: { kind: "member", memberId: "Levi" },
        role: "member",
      }),
      { error: "not_granted" },
    );
    assert.deepEqual(reopened.setAvatar("unknown", cat, owner), {
      error: "not_found",
    });
    assert.deepEqual(reopened.setAvatar(morel.agentId, cat, owner), {
      ...morel,
      avatar: cat,
    });
    assert.equal(
      reopened.revision(),
      6,
      "an avatar change is a directory change",
    );
    const burger = {
      v: 1,
      character: "burger",
      appearance: { topBun: "#9b8cf0" },
      expression: "normal",
      renderStyle: "plain",
    };
    context.mock.timers.tick(1);
    const chosen = reopened.create(
      "Shiitake",
      "create-shiitake",
      owner,
      "owner-direct",
      burger,
    );
    assert.deepEqual(chosen.avatar, burger, "creation stores a chosen avatar");
    assert.deepEqual(
      newDirectory(state, env)
        .list()
        .map(({ name, avatar }) => ({ name, avatar })),
      [
        { name: "Morel", avatar: cat },
        { name: "Enoki", avatar: enoki.avatar },
        { name: "Shiitake", avatar: burger },
      ],
    );
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
    bootUi: () => Promise.resolve({ kind: "passed" }),
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
  const generation = createInstallationStoreGeneration(
    fromNodeSqlite(database).sql,
  );
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
        generation: async () => generation(),
        selectedComputer: async () => env.OYSTER_COMPUTER_ID,
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
  const options = await new Agent(
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
  const generation = createInstallationStoreGeneration(
    fromNodeSqlite(database).sql,
  );
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
        generation: async () => generation(),
        selectedComputer: async () => env.OYSTER_COMPUTER_ID,
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
  const mcpHost = await shelf.rootHost(
    tenantScope(defaultTenant, env.OYSTER_ORIGIN),
  );
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
  assert.equal(rows[0].authority.declaredOperationsDigest, consented.digest);
  const options = await shelf.options();
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

test("an Agent's App tools reach only its pinned tenant's registry", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const generation = createInstallationStoreGeneration(
    fromNodeSqlite(database).sql,
  );
  const registries = [];
  const env = {
    OYSTER_ORIGIN: "https://oyster.test",
    OYSTER_OWNER_KEY: "owner-fixture-secret-24-characters",
    OYSTER_COMPUTER_ID: "agent-workspace",
    REGISTRY: {
      getByName: (name) => {
        registries.push(name);
        return {
          generation: async () => generation(),
          selectedComputer: async () => env.OYSTER_COMPUTER_ID,
          list: async () => [],
        };
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
    const source = (
      await new Agent(
        { id: { name: "tenant-agent" }, storage: { get: async () => pin } },
        env,
      ).options()
    ).tools.sources[0];
    const lease = await source.acquire({
      signal: new globalThis.AbortController().signal,
      invalidate: () => assert.fail("captured source unexpectedly invalidated"),
    });
    await lease.release();
    return lease.snapshot.modules;
  };
  await acquire({ directoryName: "t.aa.agents", tenantId: "aa" });
  assert.deepEqual(registries, [
    "t.aa.registry",
    "t.aa.registry",
    "t.aa.registry",
  ]);
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
  assert.deepEqual(registries, [
    "t.aa.registry",
    "t.aa.registry",
    "t.aa.registry",
  ]);
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
  const lease = await agent.modelSource().acquire({
    signal: new globalThis.AbortController().signal,
  });
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
  const lease = await agent.modelSource().acquire({
    signal: new globalThis.AbortController().signal,
  });
  try {
    const response = await lease.stream(
      lease.model,
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
      {},
    );
    const result = await response.result();
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

for (const binding of [false, true]) {
  for (const { status, code, retryable } of [
    { status: 503, code: "unavailable", retryable: true },
    { status: 400, code: "invalid_request", retryable: false },
    { status: 429, code: "insufficient_quota", retryable: false },
    { status: 429, code: "rate_limit_exceeded", retryable: true },
  ]) {
    test(`typed provider decisions for ${binding ? "AI binding" : "Luna"} ${code}`, async (context) => {
      let requests = 0;
      const fetch = async () => {
        requests += 1;
        return globalThis.Response.json(
          {
            error: {
              code,
              message: retryable ? "401 permanently rejected" : "503 retry now",
            },
          },
          { status },
        );
      };
      if (!binding) context.mock.method(globalThis, "fetch", fetch);
      const agent = new StandaloneAgent(
        { id: { name: "typed-provider" } },
        binding
          ? { AI: { fetch } }
          : {
              OYSTER_AGENT_MODEL: "@fungi/luna",
              AI_GATEWAY_AUTH_TOKEN: "fixture-only-gateway",
              AI_GATEWAY_ACCOUNT_ID: "fixture-account",
              AI_GATEWAY_ID: "fixture-gateway",
            },
      );
      const controller = new globalThis.AbortController();
      const lease = await agent.modelSource().acquire({
        signal: controller.signal,
      });
      try {
        const response = await lease.stream(
          lease.model,
          { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
          { maxRetries: 0, signal: controller.signal },
        );
        let terminal;
        for await (const event of response)
          if (event.type === "error") terminal = event.error;
        assert.notEqual(terminal, undefined);
        assert.equal(lease.retryable(terminal), retryable);
        const result = await response.result();
        assert.equal(result.stopReason, "error");
        assert.equal(requests, 1);
        assert.equal(lease.retryable(result), retryable);
        assert.equal(
          lease.retryable(globalThis.structuredClone(result)),
          false,
        );
        requests = 0;
        const outcome = await Effect.runPromise(
          runMule({
            model: lease.model,
            stream: lease.stream,
            retryable: lease.retryable,
            systemPrompt: "Synthetic provider retry proof.",
            messages: [{ role: "user", content: "Hello", timestamp: 0 }],
            retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
          }),
        );
        assert.equal(outcome.status, "failed");
        assert.equal(requests, retryable ? 2 : 1);
        controller.abort();
        assert.equal(lease.retryable(result), false);
      } finally {
        await lease.release();
      }
    });
  }
}

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
