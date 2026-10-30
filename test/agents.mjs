/* global Request, URL, Headers, console, fetch */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { agentCapabilities } from "../dist/agents.js";
import { capabilityFixture } from "../dist/testing/index.js";
import { seededAvatar } from "@fungi.computer/sprite/avatar";

const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
const agents = [];
const archived = new Set();
const forwarded = [];
let approvalWrites = 0;
let renameWrites = 0;
let avatarWrites = 0;
// Simulates an Agent already pending from before owner-direct creation, or an
// auto-approval that failed open; the "Allow App tools" control recovers it.
let approvedPolicy = { status: "pending", revision: "agent_1:requested" };
let inboxReads = 0;
let revisionReads = 0;
let inboxRevision = 3;
let inboxItems = [];
const adapter = {
  list: async (options) =>
    agents.filter((agent) =>
      options?.archived === true
        ? archived.has(agent.agentId)
        : !archived.has(agent.agentId),
    ),
  setArchived: async (agentId, value, principal) => {
    assert.deepEqual(principal, owner);
    if (!agents.some((agent) => agent.agentId === agentId))
      return { error: "not_found" };
    if (value) archived.add(agentId);
    else archived.delete(agentId);
    return { archived: value, revision: 1 };
  },
  create: async (name, requestId, principal, actor, avatar) => {
    assert.equal(actor, "owner-direct");
    assert.deepEqual(principal, owner);
    const found = agents.find((agent) => agent.requestId === requestId);
    if (found) return found;
    const agent = {
      agentId: `agent_${agents.length + 1}`,
      name,
      avatar: avatar ?? seededAvatar(`agent_${agents.length + 1}`),
      sessionOperations: ["agent.read", "agent.send", "agent.manage"],
      requestId,
    };
    agents.push(agent);
    return agent;
  },
  rename: async (agentId, name, principal) => {
    assert.deepEqual(principal, owner);
    const agent = agents.find((item) => item.agentId === agentId);
    if (!agent) return { error: "not_found" };
    if (agents.some((item) => item.agentId !== agentId && item.name === name))
      return { error: "name_taken" };
    renameWrites += 1;
    agent.name = name;
    return agent;
  },
  setAvatar: async (agentId, avatar, principal) => {
    assert.deepEqual(principal, owner);
    const agent = agents.find((item) => item.agentId === agentId);
    if (!agent) return { error: "not_found" };
    avatarWrites += 1;
    agent.avatar = avatar;
    return agent;
  },
  policyStatus: async (agentId) => {
    if (!agents.some((agent) => agent.agentId === agentId)) return null;
    return { status: approvedPolicy.status, revision: approvedPolicy.revision };
  },
  appToolPolicy: async () => null,
  policyRevision: async () => approvedPolicy?.revision ?? null,
  approveAppToolPolicy: async (
    agentId,
    principal,
    level,
    expectedRevision,
    actor,
  ) => {
    if ((approvedPolicy?.revision ?? null) !== expectedRevision)
      return { error: "revision_conflict" };
    approvalWrites += 1;
    assert.deepEqual(principal, owner);
    assert.equal(actor, "owner-direct");
    approvedPolicy = {
      status: "approved",
      level,
      grantedBy: principal.actor.memberId,
      revision: `${agentId}:approved`,
    };
    return {
      level,
      grantedBy: principal.actor.memberId,
      revision: approvedPolicy.revision,
    };
  },
  fetch: async (agentId, request) => {
    if (!agents.some((agent) => agent.agentId === agentId)) return null;
    forwarded.push(new URL(request.url).pathname);
    // A Durable Object stub answers like fetch: its headers are immutable.
    return fetch('data:application/json,{"ok":true}');
  },
  inbox: async () => {
    inboxReads += 1;
    return { items: inboxItems, revision: inboxRevision };
  },
  revision: async () => {
    revisionReads += 1;
    return inboxRevision;
  },
  visit: async (agentId) => agents.some((agent) => agent.agentId === agentId),
};
/** The fixture's admitted principals; any other caller is anonymous. */
const principalOf = (who) => {
  switch (who) {
    case "owner":
      return { actor: { kind: "member", memberId: "owner" }, role: "owner" };
    case "key":
      return { actor: { kind: "team-key", keyId: "key" } };
    default:
      return null;
  }
};
let agentGrants = [];
const liveKey = async (keyId) =>
  keyId === "key"
    ? {
        keyId,
        owner: "owner",
        grantVersion: 1,
        grants: [
          {
            capability: "apps.use",
            targets: { kind: "selected", ids: ["capability-fixture"] },
          },
          ...agentGrants,
        ],
      }
    : null;
const capabilities = agentCapabilities(adapter);
const declared = [
  "agent.list",
  "agent.manage",
  "agent.rename",
  "agent.avatar",
  "agent.toolPolicy",
  "agent.read",
  "agent.send",
];
const host = await capabilityFixture({
  capabilities: declared,
  adapters: capabilities,
  agents: adapter,
  liveKey,
  authenticate: async (request) => {
    const principal = principalOf(request.headers.get("x-who"));
    return principal === null
      ? { kind: "refused", status: 401 }
      : { kind: "admitted", principal };
  },
});
const call = (path, init = {}, who = "owner", app = host.app) => {
  const headers = new Headers(init.headers);
  if (who !== null) headers.set("x-who", who);
  headers.set("X-Oyster-Installation", "capability-fixture");
  return app.fetch(
    new Request(`https://oyster.test${path}`, { ...init, headers }),
  );
};
const create = (who, requestId = "r1") =>
  call(
    "/agents",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Koi keeper", requestId }),
    },
    who,
  );

assert.equal((await host.app.request("/agents")).status, 401);
assert.equal((await call("/agents", {}, "anonymous")).status, 401);
assert.equal((await create("key")).status, 403);
const created = await (await create("owner")).json();
assert.equal(created.agentId, "agent_1");
assert.equal((await (await create("owner")).json()).agentId, "agent_1");
assert.deepEqual(await (await call("/agents", {}, "key")).json(), []);
for (const path of [
  "/agents/agent_1/sessions",
  "/agents/agent_1/sessions/s/prompt",
  "/agents/agent_1/sessions/s/events",
  "/agents/agent_1/browser/sessions/s/browser/events",
]) {
  assert.equal((await call(path, {}, "key")).status, 403, path);
}
assert.equal((await call("/agents/agent_1/sessions?limit=5")).status, 200);
assert.deepEqual(forwarded, ["/sessions"]);
// Starting a conversation forwards to the Agent's own immutable response;
// the timing middleware still names the request's waits on a copy of it.
const started = await call("/agents/agent_1/sessions", { method: "POST" });
assert.equal(started.status, 200);
assert.deepEqual(await started.json(), { ok: true });
assert.match(started.headers.get("Server-Timing") ?? "", /total;dur=/u);
assert.equal(forwarded.at(-1), "/sessions");
assert.equal(
  (await call("/agents/agent_1/browser/sessions/s/browser/events")).status,
  200,
);
assert.equal(forwarded.at(-1), "/browser/sessions/s/browser/events");
assert.equal((await call("/agents/agent_1/extensions")).status, 404);
assert.equal((await call("/agents/agent_9/sessions")).status, 404);
assert.deepEqual(await (await call("/member/inbox")).json(), {
  items: [],
  next: null,
  cursor: 3,
});
const visit = (agentId) =>
  call("/member/inbox/visits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId, sessionId: "s" }),
  });
assert.equal((await visit("agent_1")).status, 204);
assert.equal((await visit("agent_9")).status, 404);

const rename = (name, agentId = "agent_1", who = "owner") =>
  call(
    `/agent-names/${agentId}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    who,
  );
assert.equal((await rename("Gardener", "agent_1", "key")).status, 403);
assert.equal(renameWrites, 0, "a non-owner never reaches the directory");
const renamed = await (await rename("Gardener")).json();
assert.equal(renamed.name, "Gardener");
assert.equal(renamed.agentId, "agent_1");
assert.equal(renameWrites, 1);
assert.deepEqual(
  (await (await call("/agents")).json()).map((agent) => agent.name),
  ["Gardener"],
  "the renamed Agent reads back everywhere the directory is listed",
);
assert.equal((await rename("")).status, 400, "an empty name is refused");
assert.equal(
  (await rename("x".repeat(257))).status,
  400,
  "an oversized name is refused",
);
assert.equal((await rename("Gardener", "agent_9")).status, 404);
const second = await (await create("owner", "r2")).json();
agentGrants = [
  { capability: "agents.use", targets: { kind: "selected", ids: ["agent_1"] } },
];
assert.deepEqual(
  (await (await call("/agents", {}, "key")).json()).map(
    (agent) => agent.agentId,
  ),
  ["agent_1"],
);
assert.equal((await call("/agents/agent_1/sessions", {}, "key")).status, 200);
assert.equal(
  (await call("/agents/agent_1/sessions/s/prompt", { method: "POST" }, "key"))
    .status,
  200,
);
assert.equal(
  (await call("/agents/agent_1/sessions/s/events", {}, "key")).status,
  200,
);
assert.equal(
  (await call(`/agents/${second.agentId}/sessions`, {}, "key")).status,
  403,
);
inboxItems = [
  { agentId: "agent_1", sessionId: "one", state: "unavailable" },
  { agentId: second.agentId, sessionId: "private", state: "unavailable" },
];
assert.deepEqual(
  await (await call("/member/inbox", {}, "key")).json(),
  { items: [inboxItems[0]], next: null, cursor: 0 },
  "a key sees only granted Sessions and no Oyster-wide revision",
);
inboxItems = [];
assert.deepEqual(
  (await (await call("/agents")).json()).map((agent) => agent.agentId),
  ["agent_1", second.agentId],
);
assert.equal((await rename("Gardener", second.agentId)).status, 409);
assert.equal(renameWrites, 1, "a name conflict never writes");

const cat = {
  v: 1,
  character: "cat",
  appearance: { body: "#9bd47a", stripes: "#e6f8d8" },
  expression: "normal",
  renderStyle: "plain",
};
const setAvatar = (avatar, agentId = "agent_1", who = "owner") =>
  call(
    `/agent-avatars/${agentId}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, avatar }),
    },
    who,
  );
assert.deepEqual(
  created.avatar,
  seededAvatar("agent_1"),
  "an Agent created without a choice wears its seeded avatar",
);
assert.equal((await setAvatar(cat, "agent_1", "key")).status, 403);
assert.equal(avatarWrites, 0, "a non-owner never changes an avatar");
assert.equal(
  (await setAvatar({ ...cat, appearance: { cap: "#ffffff" } })).status,
  400,
  "an avatar outside its character's catalog is refused",
);
assert.equal((await setAvatar({ ...cat, v: 2 })).status, 400);
assert.equal((await setAvatar(cat, "agent_9")).status, 404);
assert.deepEqual((await (await setAvatar(cat)).json()).avatar, cat);
assert.equal(avatarWrites, 1);
assert.deepEqual(
  (await (await call("/agents")).json()).find(
    (agent) => agent.agentId === "agent_1",
  ).avatar,
  cat,
  "the chosen avatar reads back wherever the Agent is listed",
);
const chosen = await (
  await call(
    "/agents",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Burger", requestId: "r3", avatar: cat }),
    },
    "owner",
  )
).json();
assert.deepEqual(chosen.avatar, cat, "creation stores a chosen avatar");
assert.equal(
  (
    await call(
      "/agents",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Broken",
          requestId: "r4",
          avatar: { v: 1 },
        }),
      },
      "owner",
    )
  ).status,
  400,
  "creation refuses an invalid avatar",
);

assert.deepEqual(await (await call("/agent-policies/agent_1")).json(), {
  status: "pending",
  revision: "agent_1:requested",
});
assert.equal((await call("/agent-policies/agent_9")).status, 404);

const readOnly = await capabilityFixture({
  capabilities: ["agent.read"],
  adapters: capabilities,
  agents: adapter,
});
assert.equal(
  (
    await call(
      "/agents/agent_1/browser/sessions/s/browser/events",
      {},
      "owner",
      readOnly.app,
    )
  ).status,
  200,
);
for (const operation of ["claims", "results"])
  assert.equal(
    (
      await call(
        `/agents/agent_1/browser/sessions/s/browser/${operation}`,
        { method: "POST" },
        "owner",
        readOnly.app,
      )
    ).status,
    403,
  );
assert.equal(
  (await call("/agents/agent_1/sessions", {}, "owner", readOnly.app)).status,
  200,
);
assert.equal(
  (
    await call(
      "/agents/agent_1/sessions/s/command",
      { method: "POST" },
      "owner",
      readOnly.app,
    )
  ).status,
  403,
);
assert.equal(
  (
    await call(
      "/member/inbox/visits",
      { method: "POST" },
      "owner",
      readOnly.app,
    )
  ).status,
  403,
);
const denied = await capabilityFixture({
  capabilities: declared,
  adapters: agentCapabilities(adapter),
  admitted: false,
});
assert.equal((await call("/agents", {}, "owner", denied.app)).status, 403);
const sendOnly = await capabilityFixture({
  capabilities: ["agent.send"],
  adapters: agentCapabilities(adapter),
});
assert.equal(
  (
    await call(
      "/agent-policies/agent_1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "write", expectedRevision: null }),
      },
      "owner",
      sendOnly.app,
    )
  ).status,
  403,
);
const directApproval = (path, init, who = "owner") => {
  const headers = new Headers(init.headers);
  headers.set("x-who", who ?? "anonymous");
  return host.app.fetch(
    new Request(`https://oyster.test${path}`, { ...init, headers }),
  );
};
// A stale (here, absent) expectedRevision is refused as a conflict.
assert.equal(
  (
    await call("/agent-policies/agent_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "write", expectedRevision: null }),
    })
  ).status,
  409,
);
assert.equal(approvedPolicy.grantedBy, undefined);
// The App capability route approves directly too: the owner's own
// authentication is the grant, the same as direct approval, no second path.
const approvedViaApp = await call("/agent-policies/agent_1", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    level: "write",
    expectedRevision: "agent_1:requested",
  }),
});
assert.equal(approvedViaApp.status, 200);
assert.deepEqual(await approvedViaApp.json(), {
  level: "write",
  grantedBy: "owner",
  revision: "agent_1:approved",
});
assert.deepEqual(await (await call("/agent-policies/agent_1")).json(), {
  status: "approved",
  revision: "agent_1:approved",
});
// Approval identity comes from authentication, never the policy request body.
assert.deepEqual(
  await (
    await directApproval("/api/agent-policies/agent_1", { method: "GET" })
  ).json(),
  { expectedRevision: "agent_1:approved" },
);
const approval = await directApproval("/api/agent-policies/agent_1", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    level: "read",
    expectedRevision: "agent_1:approved",
  }),
});
assert.equal(approval.status, 200);
assert.deepEqual(await approval.json(), {
  level: "read",
  grantedBy: "owner",
  revision: "agent_1:approved",
});
assert.equal(
  (
    await directApproval("/api/agent-policies/agent_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "write", expectedRevision: "stale" }),
    })
  ).status,
  409,
);
for (const who of ["key", null])
  assert.equal(
    (
      await directApproval(
        "/api/agent-policies/agent_1",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            level: "write",
            expectedRevision: "agent_1:approved",
          }),
        },
        who,
      )
    ).status,
    who === null ? 401 : 403,
    `approval refusal for ${String(who)}`,
  );
assert.equal(
  (
    await directApproval("/api/agent-policies/agent_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "write",
        expectedRevision: "agent_1:approved",
        grantedBy: "forged-member",
      }),
    })
  ).status,
  400,
);

for (const [path, body, status] of [
  ["/api/agent-policies/agent_1", "{", 400],
  [
    "/api/agent-policies/agent_missing",
    JSON.stringify({ level: "read", expectedRevision: null }),
    404,
  ],
]) {
  assert.equal(
    (
      await directApproval(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      })
    ).status,
    status,
  );
}
const writesBeforePathTricks = approvalWrites;
for (const path of [
  "/agents/agent_1/%2Fagent-policies/agent_1",
  "/agents/agent_1/../../agent-policies/agent_1",
  "/agent-policies/agent_1/",
  "/AGENT-POLICIES/agent_1",
  "/api/agent-policies/agent_1",
]) {
  const response = await call(
    path,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "write",
        expectedRevision: "agent_1:approved",
      }),
    },
    "owner",
    sendOnly.app,
  );
  assert.ok(response.status === 403 || response.status === 404);
}
assert.equal(
  approvalWrites,
  writesBeforePathTricks,
  "send-only path tricks never reach approval",
);
assert.equal(
  approvalWrites,
  2,
  "only the App request and direct owner approval write policy state",
);
// An idle feed checks clocks, never the full inbox. A reset leaves the row
// read to the client's ordinary GET /member/inbox.
inboxReads = 0;
revisionReads = 0;
const abort = new globalThis.AbortController();
mock.timers.enable({ apis: ["setTimeout"] });
try {
  const response = await call("/member/inbox/events?after=3", {
    signal: abort.signal,
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  const decode = new globalThis.TextDecoder();
  assert.equal(decode.decode((await reader.read()).value), ": open\n\n");
  assert.equal(decode.decode((await reader.read()).value), ": keep-alive\n\n");
  assert.equal(inboxReads, 0, "an unchanged SSE tick must not enumerate rows");
  assert.equal(revisionReads, 1);
  inboxRevision = 4;
  mock.timers.tick(2_000);
  assert.equal(
    decode.decode((await reader.read()).value),
    "event: reset\ndata: {}\n\n",
  );
  assert.equal(
    inboxReads,
    0,
    "even a changed tick leaves the row read to the client",
  );
  assert.equal(revisionReads, 2);
  assert.deepEqual(await (await call("/member/inbox")).json(), {
    items: [],
    next: null,
    cursor: 4,
  });
  assert.equal(inboxReads, 1);
  abort.abort();
  mock.timers.tick(2_000);
  assert.equal((await reader.read()).done, true);
} finally {
  abort.abort();
  mock.timers.tick(2_000);
  mock.timers.reset();
}

const archiveRoute = (operation, who = "owner", agentId = "agent_1") =>
  call(`/agents/${agentId}/${operation}`, { method: "POST" }, who);
assert.equal((await archiveRoute("archive", "key")).status, 403);
assert.equal((await archiveRoute("archive", "owner", "agent_9")).status, 404);
assert.equal((await call("/agents?archived=maybe")).status, 400);
assert.equal((await archiveRoute("archive")).status, 200);
assert.equal(
  (await (await call("/agents")).json()).some(
    (agent) => agent.agentId === "agent_1",
  ),
  false,
);
assert.deepEqual(
  (await (await call("/agents?archived=true", {}, "key")).json()).map(
    (agent) => agent.agentId,
  ),
  ["agent_1"],
  "a key can read only granted archived Agents",
);
assert.equal(
  (await directApproval("/api/agent-policies/agent_1", { method: "GET" }))
    .status,
  200,
  "owner-addressed policy remains readable while archived",
);
assert.equal((await archiveRoute("unarchive", "key")).status, 403);
assert.equal((await archiveRoute("unarchive")).status, 200);
assert.equal(
  (await (await call("/agents")).json()).some(
    (agent) => agent.agentId === "agent_1",
  ),
  true,
);

await host.removeDeclaration();
assert.equal((await call("/agents")).status, 403);
assert.equal((await call("/agents/agent_1/sessions")).status, 403);
assert.equal((await rename("Nope")).status, 403);
assert.equal((await call("/agent-policies/agent_1")).status, 403);
console.log("oyster declared agent capabilities: ok");
