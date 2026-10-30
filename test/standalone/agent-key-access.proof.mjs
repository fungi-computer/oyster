// Regression for CTO sm:f5257262d393: named key Agent access and read ceiling.
//
//   node test/standalone/agent-key-access.proof.mjs
//
// Real code under test: createOyster's HTTP admission (host.ts), the capability
// gate (apps/gate.ts), agentCapabilities' routes (agents.ts), the real OysterKeys
// Durable Object class and the real ownerOrKeyAuth adapter. The Agent behind
// OysterAgents.fetch is a session store standing in for Shiitake's /sessions
// surface: Shiitake's own ShiitakeDO.fetch performs no principal check
// ("Route an authenticated client request", shiitake/src/cloudflare.ts:915),
// so every authorization decision on this path is Oyster's.
/* global Response, TextEncoder, console, process */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import * as Schema from "effect/Schema";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { parseArtifactRef, parseSha256Digest } from "@fungi.computer/puffball";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { seededAvatar } from "@fungi.computer/sprite/avatar";
import { fromNodeSqlite } from "@fungi.computer/ear-tag/keys/node";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: new URL("../../dist/testing/workers-runtime.js", import.meta.url)
          .href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { OysterKeys, gitAdminRoutes } =
  await import("../../dist/workers-git.js");
hooks.deregister();
const { createOyster, sha256, verifyRelease } =
  await import("../../dist/host.js");
const { agentCapabilities } = await import("../../dist/agents.js");
const { ownerOrKeyAuth } = await import("../../dist/auth.js");
const { approvedInstallation } = await import("../../dist/testing/index.js");
const { instanceIds } = await import("../../dist/index.js");
const { tenantScope, defaultTenant } = await import("../../dist/tenant.js");

const ownerKey = "owner-proof-secret-24-characters"; //gitleaks:allow
const ownerId = "owner";
const origin = "https://oyster.proof";
const transcript = [];

// ---------------------------------------------------------------- artifacts
const artifacts = new Map();
const encode = (text) => new TextEncoder().encode(text);
async function put(bytes) {
  const digest = parseSha256Digest(await sha256(bytes));
  const artifactRef = parseArtifactRef(`artifact:sha256-${digest.slice(7)}`);
  artifacts.set(artifactRef, bytes);
  return { artifactRef, digest };
}
const uiBytes = encode("<!doctype html><title>Agent App</title>");
const ui = {
  ...(await put(uiBytes)),
  version: "proof",
  byteLength: uiBytes.length,
  mediaType: "text/html; charset=utf-8",
};
const artifactStore = {
  get: (ref) => Promise.resolve(artifacts.get(ref) ?? null),
  put: () => Promise.reject(new Error("read-only")),
};
// One App Release that declares the ordinary Agent capabilities an Agent App
// (Grove and the Tourtois desk both do) declares.
const declaredCapabilities = [
  "agent.list",
  "agent.manage",
  "agent.read",
  "agent.send",
];
const root = await put(
  encode(
    JSON.stringify(
      createAppBuild(ui, null, {
        capabilities: declaredCapabilities,
        handlers: [],
        roles: [],
      }),
    ),
  ),
);
const release = Schema.decodeUnknownSync(releaseSchema)({
  releaseId: "rel_agentapp",
  appId: "app_agentapp",
  artifact: {
    artifactRef: root.artifactRef,
    artifactDigest: root.digest,
    provenance: {
      sourceRevision: `git:${"a".repeat(40)}`,
      sourceTreeDigest: root.digest,
      buildRecipeDigest: root.digest,
    },
  },
});
const declaration = (await verifyRelease(artifactStore, release)).declaration;

// ------------------------------------------------------------------- agents
// The Agent directory and one session store per Agent: what Shiitake serves
// behind OysterAgents.fetch(agentId, request).
const directory = [];
const stores = new Map();
const forwarded = [];
function sessionsOf(agentId) {
  let store = stores.get(agentId);
  if (store === undefined) {
    store = new Map();
    stores.set(agentId, store);
  }
  return store;
}
const adapter = {
  list: async () =>
    directory.map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      avatar: agent.avatar,
      sessionOperations: ["agent.read", "agent.send", "agent.manage"],
    })),
  create: async (name, requestId, principal, actor, avatar) => {
    const agentId = `agent_${String(directory.length + 1)}`;
    const agent = {
      agentId,
      name,
      requestId,
      avatar: avatar ?? seededAvatar(agentId),
      sessionOperations: ["agent.read", "agent.send", "agent.manage"],
    };
    directory.push(agent);
    return agent;
  },
  rename: async () => ({ error: "not_found" }),
  setAvatar: async () => ({ error: "not_found" }),
  policyStatus: async () => null,
  appToolPolicy: async () => null,
  policyRevision: async () => null,
  approveAppToolPolicy: async () => ({ error: "not_found" }),
  readModelChoice: async () => null,
  decodeModelChoice: () => null,
  setModelChoice: async () => ({ error: "not_found" }),
  mcpServers: async () => [],
  addMcpServer: async () => ({ error: "not_found" }),
  removeMcpServer: async () => ({ error: "not_found" }),
  inbox: async () => ({ items: [], revision: 1 }),
  revision: async () => 1,
  visit: async () => false,
  // The real standalone adapter is `env.AGENTS.getByName(agentId).fetch(request)`
  // (standalone/agents.ts:1993); its signature carries no principal, so nothing
  // downstream can scope the request to the caller.
  fetch: async (agentId, request) => {
    const url = new URL(request.url);
    forwarded.push({
      agentId,
      method: request.method,
      path: url.pathname,
    });
    if (!directory.some((agent) => agent.agentId === agentId)) return null;
    const sessions = sessionsOf(agentId);
    const parts = url.pathname.split("/").filter((part) => part !== "");
    if (parts[0] !== "sessions") return Response.json({ ok: true });
    if (parts.length === 1 && request.method === "POST") {
      const body = await request.json();
      const sessionId = `ses_${String(sessions.size + 1)}`;
      sessions.set(sessionId, { title: body.title ?? "Session", messages: [] });
      return Response.json({ sessionId }, { status: 201 });
    }
    if (parts.length === 1)
      return Response.json({
        sessions: [...sessions].map(([sessionId, session]) => ({
          sessionId,
          title: session.title,
        })),
      });
    const session = sessions.get(parts[1]);
    if (session === undefined)
      return Response.json({ error: "not_found" }, { status: 404 });
    if (parts[2] === "messages" && request.method === "POST") {
      const body = await request.json();
      session.messages.push({ role: "user", text: body.text });
      return Response.json(
        { accepted: true, messages: session.messages.length },
        { status: 202 },
      );
    }
    return Response.json({
      sessionId: parts[1],
      title: session.title,
      messages: session.messages,
    });
  },
};
const adapters = agentCapabilities(adapter);

// ------------------------------------------------------------- installations
const installations = new Map();
for (const installationId of ["owner-app", "guest-app"])
  installations.set(
    installationId,
    await approvedInstallation({
      installationId,
      instanceId: instanceIds.instance.generate(),
      release,
      declaration,
      descriptors: adapters,
    }),
  );

// --------------------------------------------------------------------- keys
// One real OysterKeys Durable Object instance over real node:sqlite.
const database = new DatabaseSync(":memory:");
let savepoint = 0;
const keyStub = new OysterKeys(
  {
    id: { name: "keys" },
    storage: {
      sql: fromNodeSqlite(database),
      transactionSync: (body) => {
        const name = `proof_${String(savepoint++)}`;
        database.exec(`SAVEPOINT ${name}`);
        try {
          const value = body();
          database.exec(`RELEASE ${name}`);
          return value;
        } catch (error) {
          database.exec(`ROLLBACK TO ${name}`);
          database.exec(`RELEASE ${name}`);
          throw error;
        }
      },
    },
  },
  {},
);
const keysNamespace = { getByName: () => keyStub };
const auth = ownerOrKeyAuth(ownerKey, ownerId, () => keyStub);
const scope = tenantScope(defaultTenant, origin);

const host = {
  bootUi: () => Promise.resolve({ kind: "passed" }),
  auth,
  artifacts: artifactStore,
  installations: {
    generation: () => Promise.resolve("proof-generation"),
    list: () => Promise.resolve([...installations.values()]),
    get: (id) => Promise.resolve(installations.get(id) ?? null),
    compareAndPut: () => Promise.reject(new Error("read-only")),
  },
  instances: {
    get: () => {
      throw new Error("Capability routes must not execute an App backend");
    },
  },
  capabilities: adapters,
  // The same port the standalone worker wires (workers-git.ts:1661).
  keys: { live: (keyId) => keyStub.live(keyId) },
  ownerRoutes: gitAdminRoutes({ KEYS: keysNamespace }, scope),
};
const app = createOyster(host);

async function call(label, credential, path, init = {}) {
  const headers = { ...init.headers };
  if (credential !== null) headers.Authorization = `Bearer ${credential}`;
  const response = await app.request(`${origin}${path}`, { ...init, headers });
  const text = await response.text();
  const entry = {
    label,
    request: `${init.method ?? "GET"} ${path}`,
    installationHeader: headers["X-Oyster-Installation"] ?? null,
    status: response.status,
    body: text.length > 600 ? `${text.slice(0, 600)}…` : text,
  };
  transcript.push(entry);
  return { status: response.status, text, json: () => JSON.parse(text) };
}

// 1. The owner mints a second, NON-OWNER key through the shipped route,
//    granted apps.use on ONE App only.
const minted = await call("owner mints guest key", ownerKey, "/api/keys", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "guest",
    grants: [
      {
        capability: "apps.use",
        targets: { kind: "selected", ids: ["guest-app"] },
      },
    ],
  }),
});
assert.equal(minted.status, 201, "POST /api/keys must mint a named key");
const guestKey = minted.json().plaintext;
const guestKeyId = minted.json().key.keyId;
transcript[transcript.length - 1].body = transcript[
  transcript.length - 1
].body.replace(guestKey, "<REDACTED-GUEST-KEY>");

// 2. The owner creates an Agent and seeds one private Session.
const created = await call("owner creates Agent", ownerKey, "/agents", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Oyster-Installation": "owner-app",
  },
  body: JSON.stringify({ name: "Shiitake", requestId: "req-owner-1" }),
});
assert.equal(created.status, 200);
const agentId = created.json().agentId;
const openedSession = await call(
  "owner opens Session",
  ownerKey,
  `/agents/${agentId}/sessions`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Oyster-Installation": "owner-app",
    },
    body: JSON.stringify({ title: "Owner private thread" }),
  },
);
const sessionId = openedSession.json().sessionId;
await call(
  "owner sends private message",
  ownerKey,
  `/agents/${agentId}/sessions/${sessionId}/messages`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Oyster-Installation": "owner-app",
    },
    body: JSON.stringify({ text: "OWNER-PRIVATE-NOTE-7f3a" }),
  },
);

// 3. The guest key, granted only `guest-app`, names its OWN installation and
//    then reaches the owner's Agent.
const guestHeaders = { "X-Oyster-Installation": "guest-app" };
const listed = await call("(a) guest lists Agents", guestKey, "/agents", {
  headers: guestHeaders,
});
const history = await call(
  "(b) guest reads the owner's Session history",
  guestKey,
  `/agents/${agentId}/sessions/${sessionId}`,
  { headers: guestHeaders },
);
const sent = await call(
  "(c) guest sends a prompt into the owner's Session",
  guestKey,
  `/agents/${agentId}/sessions/${sessionId}/messages`,
  {
    method: "POST",
    headers: { ...guestHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "GUEST-INJECTED-PROMPT" }),
  },
);
const installationList = await call(
  "(d) guest lists installations",
  guestKey,
  "/api/installations",
);
// (d2) The signed-in home page (host.ts:1090) lists every enabled
// installation to any non-visitor principal.
const guestHome = await call(
  "(d2) guest loads the signed-in home",
  guestKey,
  "/",
);
transcript[transcript.length - 1].body = (/<h1>.*<\/ul>/u.exec(
  guestHome.text,
) ?? ["no list"])[0];

// 4. Controls.
const foreignHeader = await call(
  "control: guest names an App it holds no grant for",
  guestKey,
  "/agents",
  { headers: { "X-Oyster-Installation": "owner-app" } },
);
const guestCreate = await call(
  "control: guest creates an Agent",
  guestKey,
  "/agents",
  {
    method: "POST",
    headers: { ...guestHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Intruder", requestId: "req-guest-1" }),
  },
);
const ownerList = await call(
  "control: owner lists installations",
  ownerKey,
  "/api/installations",
);
const anonymous = await call("control: no credential", null, "/agents", {
  headers: guestHeaders,
});

// 4b. A read-only grant: does the capability-route branch apply a level check?
const readMinted = await call(
  "owner mints read-only key",
  ownerKey,
  "/api/keys",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "reader",
      grants: [
        {
          capability: "apps.read",
          targets: { kind: "selected", ids: ["guest-app"] },
        },
        {
          capability: "agents.use",
          targets: { kind: "selected", ids: [agentId] },
        },
      ],
    }),
  },
);
const readerKey = readMinted.json().plaintext;
transcript[transcript.length - 1].body = transcript[
  transcript.length - 1
].body.replace(readerKey, "<REDACTED-READER-KEY>");
const readerList = await call(
  "read-only key lists Agents",
  readerKey,
  "/agents",
  {
    headers: guestHeaders,
  },
);
const readerWrite = await call(
  "read-only key sends a prompt",
  readerKey,
  `/agents/${agentId}/sessions/${sessionId}/messages`,
  {
    method: "POST",
    headers: { ...guestHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "READER-INJECTED-PROMPT" }),
  },
);

// 5. No Agent grant: a key with App access has no Agent access.
assert.equal(listed.status, 200);
assert.deepEqual(
  listed.json().map((agent) => agent.agentId),
  [],
  "(a) ungranted key lists no Agents",
);
assert.equal(history.status, 403, "(b) ungranted key cannot read the Session");
assert.equal(sent.status, 403, "(c) ungranted key cannot write the Session");
assert.deepEqual(sessionsOf(agentId).get(sessionId).messages, [
  { role: "user", text: "OWNER-PRIVATE-NOTE-7f3a" },
]);
assert.deepEqual(
  readerList.json().map((agent) => agent.agentId),
  [agentId],
);
assert.equal(
  readerWrite.status,
  403,
  "read-level App grant cannot write even with Agent grant",
);
assert.equal(foreignHeader.status, 403, "control: ungranted App must refuse");
assert.equal(guestCreate.status, 403, "control: Agent creation is owner-only");
assert.equal(anonymous.status, 401, "control: anonymous must refuse");
assert.equal(ownerList.status, 200, "control: the owner lists installations");
assert.equal(
  installationList.status,
  403,
  "installation management remains owner-only",
);
const ownerHome = await call("owner loads home", ownerKey, "/");
assert.match(ownerHome.text, /owner-app/u);
assert.match(ownerHome.text, /guest-app/u);
assert.equal(guestHome.status, 200);
assert.doesNotMatch(guestHome.text, /owner-app/u, "home hides the owner's App");
assert.match(guestHome.text, /guest-app/u);
assert.equal(
  (
    await call("ungranted inbox", guestKey, "/member/inbox", {
      headers: guestHeaders,
    })
  ).json().items.length,
  0,
);
for (const path of [
  `/agents/${agentId}/sessions/${sessionId}/events`,
  `/agents/${agentId}/browser/sessions/${sessionId}/browser/events`,
  "/member/inbox/events",
]) {
  assert.equal(
    (await call("ungranted stream", guestKey, path, { headers: guestHeaders }))
      .status,
    403,
    path,
  );
}
for (const operation of ["claims", "results"]) {
  assert.equal(
    (
      await call(
        `ungranted browser ${operation}`,
        guestKey,
        `/agents/${agentId}/browser/sessions/${sessionId}/browser/${operation}`,
        {
          method: "POST",
          headers: { ...guestHeaders, "Content-Type": "application/json" },
          body: "{}",
        },
      )
    ).status,
    403,
    `an ungranted principal cannot post browser ${operation}`,
  );
}
const scoped = await call("owner grants one Agent", ownerKey, "/api/keys", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "scoped",
    grants: [
      {
        capability: "apps.use",
        targets: { kind: "selected", ids: ["guest-app"] },
      },
      {
        capability: "agents.use",
        targets: { kind: "selected", ids: [agentId] },
      },
    ],
  }),
});
assert.equal(scoped.status, 201);
const scopedKey = scoped.json().plaintext;
transcript[transcript.length - 1].body = transcript[
  transcript.length - 1
].body.replace(scopedKey, "<REDACTED-SCOPED-KEY>");
const other = await call("owner creates second Agent", ownerKey, "/agents", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Oyster-Installation": "owner-app",
  },
  body: JSON.stringify({ name: "Another", requestId: "req-owner-2" }),
});
assert.equal(other.status, 200);
const otherId = other.json().agentId;
assert.deepEqual(
  (await call("scoped list", scopedKey, "/agents", { headers: guestHeaders }))
    .json()
    .map((agent) => agent.agentId),
  [agentId],
);
assert.equal(
  (
    await call(
      "scoped read",
      scopedKey,
      `/agents/${agentId}/sessions/${sessionId}`,
      { headers: guestHeaders },
    )
  ).status,
  200,
);
assert.equal(
  (
    await call(
      "scoped stream",
      scopedKey,
      `/agents/${agentId}/sessions/${sessionId}/events`,
      { headers: guestHeaders },
    )
  ).status,
  200,
);
assert.equal(
  (
    await call(
      "scoped write",
      scopedKey,
      `/agents/${agentId}/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { ...guestHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "SCOPED-PROMPT" }),
      },
    )
  ).status,
  202,
);
assert.equal(
  (
    await call(
      "other Agent refused",
      scopedKey,
      `/agents/${otherId}/sessions`,
      { headers: guestHeaders },
    )
  ).status,
  403,
);
for (const operation of ["events", "claims", "results"]) {
  /** @type {RequestInit} */
  const init = {
    method: operation === "events" ? "GET" : "POST",
    headers: { ...guestHeaders, "Content-Type": "application/json" },
  };
  if (operation !== "events") init.body = "{}";
  assert.equal(
    (
      await call(
        `other Agent browser ${operation} refused`,
        scopedKey,
        `/agents/${otherId}/browser/sessions/${sessionId}/browser/${operation}`,
        init,
      )
    ).status,
    403,
    `a grant for one Agent cannot reach another Agent's browser ${operation}`,
  );
}
assert.deepEqual(
  (
    await call("owner lists both", ownerKey, "/agents", {
      headers: { "X-Oyster-Installation": "owner-app" },
    })
  )
    .json()
    .map((agent) => agent.agentId),
  [agentId, otherId],
);
console.log(
  JSON.stringify(
    {
      guestKeyId,
      agentId,
      sessionId,
      transcript,
      forwardedToAgents: forwarded,
      ownerSessionAfterScopedWrite: [
        ...sessionsOf(agentId).get(sessionId).messages,
      ],
    },
    null,
    2,
  ),
);
console.log(
  `\nGET /api/installations as the guest key => ${String(installationList.status)}`,
);
database.close();
process.exitCode = 0;
