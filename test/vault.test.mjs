/* global Headers, ReadableStream, Request, Response, TextEncoder */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { modelKeyRoutes } from "../dist/agents.js";
import { serveHost } from "../dist/authorization.js";
import { createAgentMcpConnections } from "../dist/standalone/agent-connections.js";
import { createInstanceCredentialStore } from "../dist/standalone/model-key-vault.js";
import { createModelKeyUsage } from "../dist/standalone/model-key-usage.js";
import { createInstanceVault } from "../dist/standalone/vault.js";

const principalOf = (who) =>
  who === "owner"
    ? { actor: { kind: "member", memberId: "owner" }, role: "owner" }
    : who === "key"
      ? { actor: { kind: "team-key", keyId: "key" } }
      : { actor: { kind: "agent", agentId: "agent_1" } };

/** The instance Vault over real SQLite, the real credential store and the real routes. */
function fixture() {
  const database = new DatabaseSync(":memory:");
  const rows = new Map();
  const sent = [];
  let clock = 1_000_000;
  const store = fromNodeSqlite(database);
  const connections = createAgentMcpConnections({
    ownerId: "agents",
    callbackUrl: "https://oyster.test/api/connections/callback",
    store,
    vault: createInstanceCredentialStore({
      owner: store,
      ownerId: "agents",
      keyring: {
        activeKeyId: "test",
        keys: { test: randomBytes(32).toString("base64url") },
      },
      storage: {
        get: async (key) => rows.get(key),
        put: async (key, value) => {
          rows.set(key, value);
        },
        delete: async (key) => rows.delete(key),
        list: async (prefix) =>
          new Map([...rows].filter(([key]) => key.startsWith(prefix))),
      },
    }),
    send: async (request) => {
      sent.push(request);
      return Response.json({ ok: true });
    },
    hasAgent: (agentId) => agentId === "agent_1",
    subjectLive: async (subject) =>
      subject.kind === "computer" || subject.id === "agent_1",
    notify: async () => undefined,
  });
  const usage = createModelKeyUsage({ sql: store.sql, now: () => clock });
  const vault = createInstanceVault({
    connections,
    modelKeys: async () => [],
    modelKeyUsage: (keyId) => usage.list(keyId),
  });
  const unused = () => assert.fail("not in this proof");
  const routes = serveHost(
    modelKeyRoutes({
      modelKeys: unused,
      setup: unused,
      sealModelKey: unused,
      removeModelKey: unused,
      vault,
    }),
    (request) =>
      Promise.resolve({
        kind: "admitted",
        principal: principalOf(request.headers.get("x-who") ?? undefined),
      }),
    { liveKey: async () => null, appToolPolicy: () => null },
  );
  const call = (path, init = {}, who = "owner") => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("x-who", who);
    return routes.fetch(
      new Request(`https://oyster.test${path}`, { ...init, headers }),
    );
  };
  const dump = () =>
    JSON.stringify([
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(({ name }) => database.prepare(`SELECT * FROM "${name}"`).all()),
      [...rows],
    ]);
  return {
    call,
    connections,
    dump,
    sent,
    usage,
    database,
    tick: (ms) => (clock += ms),
  };
}

const value = () => `sk-test-VAULTCANARY-${randomUUID()}`;
const json = (body) => JSON.stringify(body);

test("the owner adds, scopes, rotates and revokes a secret; no answer carries its value", async () => {
  const h = fixture();
  const first = value();
  const next = value();
  try {
    const added = await h.call("/api/vault/secrets", {
      method: "POST",
      body: json({
        name: "payments",
        destinations: [
          { host: "api.example.com", methods: ["GET"] },
          { host: "files.example.com", methods: ["GET"] },
        ],
        placement: "bearer",
        secret: first,
      }),
    });
    assert.equal(added.status, 201);
    const { connectionId } = await added.json();
    const listed = await h.call("/api/vault");
    assert.equal(listed.headers.get("cache-control"), "private, no-store");
    const text = await listed.text();
    assert.ok(!text.includes(first));
    const view = JSON.parse(text);
    assert.deepEqual(view.coverage, { state: "complete" });
    assert.deepEqual(view.credentials[0], {
      connectionId,
      name: "payments",
      label: "payments",
      kind: "secret",
      origin: "https://api.example.com",
      destinations: [
        { host: "api.example.com", methods: ["GET"] },
        { host: "files.example.com", methods: ["GET"] },
      ],
      credential: "value",
      placement: "bearer",
      state: "active",
      version: 1,
      subjects: [],
    });
    const granted = await h.call(
      `/api/vault/credentials/${connectionId}/subjects/computer/computer_1`,
      { method: "PUT" },
    );
    assert.equal(granted.status, 200);
    const app = await h.call(
      `/api/vault/credentials/${connectionId}/subjects/app/app_1`,
      { method: "PUT" },
    );
    assert.equal(app.status, 400);
    const widened = await h.call(`/api/vault/credentials/${connectionId}`, {
      method: "PUT",
      body: json({
        expectedVersion: 1,
        destinations: [{ host: "evil.example.net", methods: ["GET"] }],
      }),
    });
    assert.equal(widened.status, 403);
    const narrowed = await h.call(`/api/vault/credentials/${connectionId}`, {
      method: "PUT",
      body: json({
        expectedVersion: 1,
        destinations: [{ host: "api.example.com", methods: ["GET"] }],
      }),
    });
    assert.equal(narrowed.status, 200);
    const rotated = await h.call(`/api/vault/credentials/${connectionId}`, {
      method: "PUT",
      body: json({
        expectedVersion: (await narrowed.json()).version,
        secret: next,
      }),
    });
    assert.equal(rotated.status, 200);
    const [held] = await h.connections.credentials();
    assert.deepEqual(
      held.grants.map((grant) => grant.subject),
      [{ kind: "computer", id: "computer_1" }],
    );
    const answer = await h.connections.fetchSecret(
      { kind: "computer", id: "computer_1" },
      { connectionId, grantVersion: held.grants[0].version },
      {
        url: "https://api.example.com/v1",
        method: "GET",
        headers: [],
        body: null,
      },
    );
    assert.equal(answer.status, 200);
    assert.equal(h.sent.at(-1).headers.get("authorization"), `Bearer ${next}`);
    const usage = await h.call(`/api/vault/credentials/${connectionId}/usage`);
    const used = await usage.text();
    assert.deepEqual(
      JSON.parse(used).usage.map(({ outcome }) => outcome),
      ["placed", "upstream_status"],
    );
    const revoked = await h.call(`/api/vault/credentials/${connectionId}`, {
      method: "DELETE",
      body: json({ expectedVersion: (await rotated.json()).version }),
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(
      (await (await h.call("/api/vault")).json()).credentials,
      [],
    );
    for (const secret of [first, next]) {
      assert.ok(!used.includes(secret));
      assert.ok(!h.dump().includes(secret));
    }
  } finally {
    h.database.close();
  }
});

test("the Vault sets and clears a Connection's value; the Connection stays", async () => {
  const h = fixture();
  const token = value();
  try {
    const added = await h.connections.add({
      name: "tracker",
      url: "https://mcp.example.com/mcp",
      bearer: null,
    });
    const set = await h.call(`/api/vault/credentials/${added.connectionId}`, {
      method: "PUT",
      body: json({ expectedVersion: 1, secret: token }),
    });
    assert.equal(set.status, 200);
    let [listed] = (await (await h.call("/api/vault")).json()).credentials;
    assert.equal(listed.kind, "mcp");
    assert.equal(listed.credential, "value");
    const cleared = await h.call(
      `/api/vault/credentials/${added.connectionId}`,
      {
        method: "DELETE",
        body: json({ expectedVersion: (await set.json()).version }),
      },
    );
    assert.equal(cleared.status, 200);
    [listed] = (await (await h.call("/api/vault")).json()).credentials;
    assert.equal(listed.credential, "none");
    assert.ok(!h.dump().includes(token));
  } finally {
    h.database.close();
  }
});

test("only the owner, directly, reaches the Vault", async () => {
  const h = fixture();
  try {
    for (const who of ["key", "agent"]) {
      const read = await h.call("/api/vault", {}, who);
      assert.ok(
        read.status === 401 || read.status === 403,
        String(read.status),
      );
      const add = await h.call(
        "/api/vault/secrets",
        { method: "POST", body: json({}) },
        who,
      );
      assert.ok(add.status === 401 || add.status === 403, String(add.status));
    }
  } finally {
    h.database.close();
  }
});

test("model-key uses are listed per key and Agent, coalesced within a minute", async () => {
  const h = fixture();
  try {
    h.usage.record({ keyId: "cred_a", agentId: "agent_1", status: 200 });
    h.tick(30_000);
    h.usage.record({ keyId: "cred_a", agentId: "agent_1", status: 200 });
    h.usage.record({ keyId: "cred_a", agentId: "agent_1", status: 429 });
    h.usage.record({ keyId: "cred_b", agentId: null, status: null });
    h.tick(60_000);
    h.usage.record({ keyId: "cred_a", agentId: "agent_1", status: 200 });
    const listed = await (
      await h.call("/api/vault/model-keys/cred_a/usage")
    ).json();
    assert.deepEqual(
      listed.usage.map(({ subject, status, count, outcome }) => [
        subject,
        status,
        count,
        outcome,
      ]),
      [
        [{ kind: "agent", id: "agent_1" }, 200, 2, "upstream_status"],
        [{ kind: "agent", id: "agent_1" }, 429, 1, "upstream_status"],
        [{ kind: "agent", id: "agent_1" }, 200, 1, "upstream_status"],
      ],
    );
    h.tick(90 * 24 * 60 * 60 * 1_000);
    assert.deepEqual(h.usage.list("cred_a"), []);
  } finally {
    h.database.close();
  }
});

test("an oversized chunked body is refused while it is read, with no Content-Length to trust", async () => {
  const h = fixture();
  // One JSON body, streamed in 16 KiB pieces with no Content-Length.
  const chunked = (prefix, bytes, suffix) => {
    const pieces = [prefix, "x".repeat(bytes), suffix];
    return new ReadableStream({
      pull(controller) {
        const next = pieces.shift();
        if (next === undefined) return controller.close();
        for (let at = 0; at < next.length; at += 16 * 1024)
          controller.enqueue(
            new TextEncoder().encode(next.slice(at, at + 16 * 1024)),
          );
      },
    });
  };
  const before = h.dump();
  const secret = await h.call("/api/vault/secrets", {
    method: "POST",
    duplex: "half",
    body: chunked(
      '{"name":"big","destinations":[{"host":"api.example.com","methods":["GET"]}],"placement":"bearer","secret":"',
      200 * 1024,
      '"}',
    ),
  });
  assert.equal(secret.status, 413);
  assert.equal(h.dump(), before);
  const modelKey = await h.call("/api/model-keys", {
    method: "POST",
    duplex: "half",
    body: chunked('{"provider":"openai","name":"big","key":"', 64 * 1024, '"}'),
  });
  assert.equal(modelKey.status, 413);
});
