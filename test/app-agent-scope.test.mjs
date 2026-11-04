/* global Headers, Request, URL, fetch */
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentCapabilities } from "../dist/agents.js";
import { capabilityFixture } from "../dist/testing/index.js";

// An ordinary App the owner narrowed to agent_a, composed through the real
// grant reducer, gate, host dispatcher and Agent capability table. Only the
// Agent directory port is a dummy, and it records every call that reaches it.
const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
const directory = ["agent_a", "agent_b"];

function dummyAgents() {
  const reached = [];
  const known = (agentId) => directory.includes(agentId);
  const unused = (name) => () => {
    throw new Error(`${name} is not part of this scope check`);
  };
  return {
    reached,
    adapter: {
      list: async () =>
        directory.map((agentId) => ({ agentId, name: agentId })),
      setArchived: async (agentId, archived) => {
        reached.push(`archive:${agentId}`);
        return known(agentId)
          ? { archived, revision: 1 }
          : { error: "not_found" };
      },
      fetch: async (agentId, request) => {
        if (!known(agentId)) return null;
        reached.push(`fetch:${agentId}${new URL(request.url).pathname}`);
        return fetch('data:application/json,{"ok":true}');
      },
      inbox: async () => ({
        items: directory.map((agentId) => ({
          agentId,
          sessionId: `${agentId}-session`,
          state: "unavailable",
        })),
        revision: 7,
      }),
      revision: async () => 7,
      visit: async (agentId) => {
        reached.push(`visit:${agentId}`);
        return known(agentId);
      },
      create: unused("create"),
      rename: unused("rename"),
      setAvatar: unused("setAvatar"),
      policyStatus: unused("policyStatus"),
      appToolPolicy: async () => null,
      policyRevision: unused("policyRevision"),
      approveAppToolPolicy: unused("approveAppToolPolicy"),
    },
  };
}

async function narrowedApp(capability, resources) {
  const agents = dummyAgents();
  const host = await capabilityFixture({
    capabilities: [capability],
    adapters: agentCapabilities(agents.adapter),
    agents: agents.adapter,
    selected: resources === undefined ? {} : { [capability]: resources },
    authenticate: async () => ({ kind: "admitted", principal: owner }),
  });
  const call = (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-Oyster-Installation", "capability-fixture");
    return host.app.fetch(
      new Request(`https://oyster.test${path}`, { ...init, headers }),
    );
  };
  return { call, reached: agents.reached };
}

const onlyA = [{ kind: "agent", id: "agent_a" }];
const visit = (agentId) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ agentId, sessionId: `${agentId}-session` }),
});

test("an App selected for agent_a reads only agent_a's Sessions and inbox rows", async () => {
  const { call, reached } = await narrowedApp("agent.read", onlyA);
  assert.equal((await call("/agents/agent_a/sessions")).status, 200);
  assert.equal((await call("/agents/agent_b/sessions")).status, 403);
  assert.deepEqual(reached, ["fetch:agent_a/sessions"]);
  const inbox = await (await call("/member/inbox")).json();
  assert.deepEqual(
    inbox.items.map((item) => item.agentId),
    ["agent_a"],
    "an unselected Agent's Session never reaches the App",
  );
});

test("an App selected for agent_a sends to and visits only agent_a", async () => {
  const { call, reached } = await narrowedApp("agent.send", onlyA);
  assert.equal(
    (await call("/agents/agent_b/sessions/s/prompt", { method: "POST" }))
      .status,
    403,
  );
  assert.equal(
    (await call("/member/inbox/visits", visit("agent_b"))).status,
    403,
  );
  assert.equal(
    (await call("/member/inbox/visits", visit("agent_a"))).status,
    204,
  );
  assert.deepEqual(reached, ["visit:agent_a"]);
});

test("an App managing agent_a cannot open or archive agent_b", async () => {
  const { call, reached } = await narrowedApp("agent.manage", onlyA);
  assert.equal((await call("/agents/agent_b/sessions")).status, 403);
  assert.equal(
    (await call("/agents/agent_b/archive", { method: "POST" })).status,
    403,
  );
  assert.equal(
    (await call("/agents/agent_a/archive", { method: "POST" })).status,
    200,
  );
  assert.deepEqual(reached, ["archive:agent_a"]);
});

test("a tenant-scope grant still reaches every Agent in the directory", async () => {
  const { call, reached } = await narrowedApp("agent.read");
  assert.equal((await call("/agents/agent_b/sessions")).status, 200);
  const inbox = await (await call("/member/inbox")).json();
  assert.deepEqual(
    inbox.items.map((item) => item.agentId),
    ["agent_a", "agent_b"],
  );
  assert.equal(inbox.cursor, 7);
  assert.deepEqual(reached, ["fetch:agent_b/sessions"]);
});
