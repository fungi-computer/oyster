/* global Headers, Request, URL, fetch */
import assert from "node:assert/strict";
import { test } from "node:test";
import { seededAvatar } from "@fungi.computer/sprite/avatar";
import { agentCapabilities } from "../dist/agents.js";
import { serveCapability } from "../dist/authorization.js";
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
      setAvatar: async (agentId) => {
        reached.push(`avatar:${agentId}`);
        return known(agentId) ? { agentId } : { error: "not_found" };
      },
      readInstructions: async (agentId) => {
        reached.push(`instructions:${agentId}`);
        return known(agentId)
          ? { agentId, home: null, content: null, bytes: 0, limit: 32_000 }
          : { error: "not_found" };
      },
      setInstructions: async (agentId) => {
        reached.push(`instructions-set:${agentId}`);
        return known(agentId)
          ? { agentId, home: null, content: null, bytes: 0, limit: 32_000 }
          : { error: "not_found" };
      },
      extensionChoices: async (agentId) => {
        reached.push(`extensions:${agentId}`);
        return known(agentId) ? { agentId, attached: [], available: [] } : null;
      },
      attachExtension: async (agentId, installationId) => {
        reached.push(`attach:${agentId}`);
        return { installationId, attachedBy: "owner" };
      },
      detachExtension: async (agentId) => {
        reached.push(`detach:${agentId}`);
        return "detached";
      },
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

// The reducer never lets an owner select Agents for these three capabilities
// (their catalog scope is null), so a narrower ceiling cannot be composed
// through the fixture. The routes still decide per Agent: serve each
// capability's table under an admitted grant that selects only agent_a, as the
// host dispatcher would if a catalog scope ever allowed it.
const selecting = (capability) => {
  const { adapter, reached } = dummyAgents();
  const table = agentCapabilities(adapter).find(({ id }) => id === capability);
  const served = serveCapability(table.routes, {
    liveKey: () => Promise.resolve(null),
    appToolPolicy: () => null,
  });
  const admission = {
    principal: owner,
    installation: { installationId: "capability-fixture", status: "enabled" },
    grant: {
      capability,
      capabilityApproved: true,
      operations: [],
      fingerprints: {},
      resources: onlyA,
    },
  };
  return {
    reached,
    call: (path, init = {}) => served.request(path, init, admission),
  };
};

const avatar = seededAvatar("agent_a");
const json = (method, body) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("an App whose Agent ceiling excludes agent_b cannot change its avatar", async () => {
  const { call, reached } = selecting("agent.avatar");
  assert.equal(
    (await call("/agent-avatars/agent_b", json("PUT", { avatar }))).status,
    403,
  );
  assert.deepEqual(reached, [], "agent_b's directory is never reached");
  assert.equal(
    (await call("/agent-avatars/agent_a", json("PUT", { avatar }))).status,
    200,
  );
  assert.deepEqual(reached, ["avatar:agent_a"]);
});

test("an App whose Agent ceiling excludes agent_b cannot read or write its instructions", async () => {
  const { call, reached } = selecting("agent.instructions");
  assert.equal((await call("/agent-instructions/agent_b")).status, 403);
  assert.equal(
    (
      await call(
        "/agent-instructions/agent_b",
        json("PUT", { expectedContent: null, content: "Be brief." }),
      )
    ).status,
    403,
  );
  assert.deepEqual(reached, [], "agent_b's instructions are never reached");
  assert.equal((await call("/agent-instructions/agent_a")).status, 200);
  assert.deepEqual(reached, ["instructions:agent_a"]);
});

test("an App whose Agent ceiling excludes agent_b cannot list, attach or detach its extensions", async () => {
  const { call, reached } = selecting("agent.extensions");
  assert.equal((await call("/agent-extensions/agent_b")).status, 403);
  for (const method of ["PUT", "DELETE"])
    assert.equal(
      (await call("/agent-extensions/agent_b/notes", { method })).status,
      403,
    );
  assert.deepEqual(reached, [], "agent_b's extensions are never reached");
  assert.equal((await call("/agent-extensions/agent_a")).status, 200);
  assert.equal(
    (await call("/agent-extensions/agent_a/notes", { method: "PUT" })).status,
    200,
  );
  assert.deepEqual(reached, [
    "extensions:agent_a",
    "attach:agent_a",
    "extensions:agent_a",
  ]);
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

// The reducer never lets an owner select Agents for renaming or tool-policy
// approval (their catalog scope is null), so a narrower ceiling cannot be
// composed through the fixture. The routes still decide per Agent: serve each
// capability's table under an admitted grant that selects only agent_a, as the
// host dispatcher would if a catalog scope ever allowed it.
const servedFor = (capability) => {
  const base = dummyAgents();
  const { reached } = base;
  const adapter = {
    ...base.adapter,
    rename: async (agentId, name) => {
      reached.push(`rename:${agentId}`);
      return { agentId, name };
    },
    approveAppToolPolicy: async (agentId, _principal, level) => {
      reached.push(`policy:${agentId}`);
      return { agentId, level, revision: "r2" };
    },
  };
  const table = agentCapabilities(adapter).find(({ id }) => id === capability);
  const served = serveCapability(table.routes, {
    liveKey: () => Promise.resolve(null),
    appToolPolicy: () => null,
  });
  const admission = {
    principal: owner,
    installation: { installationId: "capability-fixture", status: "enabled" },
    grant: {
      capability,
      capabilityApproved: true,
      operations: [],
      fingerprints: {},
      resources: onlyA,
    },
  };
  return {
    reached,
    call: (path, init = {}) => served.request(path, init, admission),
  };
};
const putJson = (body) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("an App whose Agent ceiling excludes agent_b cannot rename it", async () => {
  const { call, reached } = servedFor("agent.rename");
  assert.equal(
    (await call("/agent-names/agent_b", putJson({ name: "B" }))).status,
    403,
  );
  assert.deepEqual(reached, [], "agent_b's directory entry is never reached");
  assert.equal(
    (await call("/agent-names/agent_a", putJson({ name: "A" }))).status,
    200,
  );
  assert.deepEqual(reached, ["rename:agent_a"]);
});

test("an App whose Agent ceiling excludes agent_b cannot approve its tool policy", async () => {
  const { call, reached } = servedFor("agent.toolPolicy");
  const approve = putJson({ level: "read", expectedRevision: null });
  assert.equal((await call("/agent-policies/agent_b", approve)).status, 403);
  assert.deepEqual(reached, [], "agent_b's policy is never reached");
  assert.equal((await call("/agent-policies/agent_a", approve)).status, 200);
  assert.deepEqual(reached, ["policy:agent_a"]);
});
