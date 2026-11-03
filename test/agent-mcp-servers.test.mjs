/* global AbortController, Headers, Request, Response */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Knapsack } from "@fungi.computer/knapsack";
import { Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { z } from "zod";
import { agentMcpServerRoutes } from "../dist/agents.js";
import { serveHost } from "../dist/authorization.js";
import {
  agentMcpSourceOptions,
  createAgentMcpConnections,
  mcpRequestData,
} from "../dist/standalone/agent-connections.js";
import { createInstanceCredentialStore } from "../dist/standalone/model-key-vault.js";

const token = "marker-bearer-0123456789abcdef"; //gitleaks:allow
const endpoint = "https://mcp.example.com/mcp";

/** The host's admitted principals; anyone else is an Agent. */
const principalOf = (who) => {
  switch (who) {
    case "owner":
      return { actor: { kind: "member", memberId: "owner" }, role: "owner" };
    case "key":
      return { actor: { kind: "team-key", keyId: "key" } };
    default:
      return { actor: { kind: "agent", agentId: "agent_1" } };
  }
};

/** A real SDK MCP server that insists on the bearer. */
function upstream() {
  const calls = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "fixture", version: "1" });
    server.registerTool(
      "add",
      {
        description: "Add two numbers.",
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        outputSchema: z.object({ sum: z.number() }),
      },
      ({ a, b }) => {
        calls.push({ a, b });
        return {
          content: [{ type: "text", text: String(a + b) }],
          structuredContent: { sum: a + b },
        };
      },
    );
    return server;
  });
  const seen = [];
  const send = async (request) => {
    seen.push(request.headers.get("authorization"));
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    return handler.fetch(request);
  };
  return { send, calls, seen };
}

/** The directory's owner side over real SQLite and the real credential store. */
function fixture() {
  const database = new DatabaseSync(":memory:");
  const vaultRows = new Map();
  const fake = upstream();
  const agents = new Set(["agent_1", "agent_2"]);
  const notified = [];
  const connections = createAgentMcpConnections({
    ownerId: "agents",
    store: fromNodeSqlite(database),
    vault: createInstanceCredentialStore({
      credentialKey: randomBytes(32).toString("base64url"),
      storage: {
        get: async (key) => vaultRows.get(key),
        put: async (key, value) => {
          vaultRows.set(key, value);
        },
        delete: async (key) => vaultRows.delete(key),
        list: async (prefix) =>
          new Map([...vaultRows].filter(([key]) => key.startsWith(prefix))),
      },
    }),
    send: fake.send,
    hasAgent: (agentId) => agents.has(agentId),
    notify: async (agentId) => {
      notified.push(agentId);
    },
  });
  const adapter = {
    list: async () => [{ agentId: "agent_1", name: "Helper" }],
    mcpServers: connections.servers,
    addMcpServer: connections.add,
    removeMcpServer: connections.remove,
  };
  const routes = serveHost(
    agentMcpServerRoutes(adapter),
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
    if (who !== null) headers.set("x-who", who);
    return routes.fetch(
      new Request(`https://oyster.test${path}`, { ...init, headers }),
    );
  };
  const dump = () =>
    JSON.stringify([
      ...[
        "veil_connections",
        "veil_connection_attempts",
        "veil_connection_grants",
        "veil_connection_receipts",
        "veil_connection_cleanup",
      ].map((table) => database.prepare(`SELECT * FROM ${table}`).all()),
      [...vaultRows],
    ]);
  const add = (body, agentId = "agent_1") =>
    call(`/api/agent-mcp-servers/${agentId}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  return { call, add, connections, dump, fake, notified, vaultRows };
}

/** Run Knapsack against the Agent half exactly as the Agent Durable Object wires it. */
async function acquire(h, agentId) {
  const source = Knapsack.mcpServers(
    agentMcpSourceOptions({
      read: () => h.connections.projection(agentId),
      subscribe: () => () => undefined,
      onUnavailable: (error) => {
        throw error;
      },
      fetch: async (ref, request) => {
        const answer = await h.connections.fetch(
          agentId,
          ref,
          await mcpRequestData(request),
        );
        if (!(answer instanceof Response))
          throw new Error(`MCP connection refused: ${answer.error}`);
        return answer;
      },
    }),
  );
  return source.acquire({
    signal: new AbortController().signal,
    invalidate: () => undefined,
  });
}

async function callTool(modules, operation, input) {
  let value = null;
  const runtime = await Mycelium.make({
    modules,
    sandbox: directSandbox(async (bindings) => {
      const binding = Object.values(bindings)
        .map((operations) => operations[operation])
        .find((candidate) => candidate !== undefined);
      if (binding === undefined) throw new Error(`No ${operation} binding`);
      value = await binding(input);
      return null;
    }),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "call",
        name: "execute",
        arguments: { code: `return mcp.${operation}(input)` },
      }),
    );
    const events = await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
    );
    if (JSON.stringify(events).includes('"isError":true'))
      throw new Error("execute failed");
    return value;
  } finally {
    await lease.release();
    await runtime.close();
  }
}

test("the owner connects, lists and removes an Agent's MCP server", async () => {
  const h = fixture();
  const added = await h.add({ name: "linear", url: endpoint, bearer: token });
  assert.equal(added.status, 201);
  const body = await added.text();
  assert.ok(!body.includes(token), "the bearer never comes back");
  const server = JSON.parse(body);
  assert.deepEqual(
    { ...server, serverId: undefined },
    { name: "linear", url: endpoint, hasBearer: true, serverId: undefined },
  );
  assert.ok(!h.dump().includes(token), "no storage holds the bearer in clear");

  const listed = await (await h.call("/api/agent-mcp-servers")).text();
  assert.ok(!listed.includes(token));
  assert.deepEqual(JSON.parse(listed), {
    agents: [{ agentId: "agent_1", name: "Helper", servers: [server] }],
  });

  const duplicate = await h.add({
    name: "linear",
    url: "https://other.example.com/mcp",
    bearer: null,
  });
  assert.equal(duplicate.status, 409);

  const removed = await h.call(
    `/api/agent-mcp-servers/agent_1/${server.serverId}`,
    {
      method: "DELETE",
    },
  );
  assert.equal(removed.status, 204);
  assert.deepEqual(await h.connections.servers("agent_1"), []);
  assert.deepEqual(h.notified, ["agent_1", "agent_1"]);
  const gone = await h.call(
    `/api/agent-mcp-servers/agent_1/${server.serverId}`,
    {
      method: "DELETE",
    },
  );
  assert.equal(gone.status, 404);
});

test("only the owner, directly, reaches MCP server custody", async () => {
  const h = fixture();
  const body = JSON.stringify({ name: "linear", url: endpoint, bearer: null });
  const add = (path, init = {}, who = "owner") =>
    h.call(path, { method: "POST", body, ...init }, who);
  const path = "/api/agent-mcp-servers/agent_1";
  assert.equal((await h.call("/api/agent-mcp-servers", {}, null)).status, 403);
  assert.equal((await h.call("/api/agent-mcp-servers", {}, "key")).status, 403);
  assert.equal((await add(path, {}, null)).status, 403);
  assert.equal((await add(path, {}, "key")).status, 403);
  const installed = await add(path, {
    headers: { "X-Oyster-Installation": "app" },
  });
  assert.equal(installed.status, 403);
  assert.equal((await add("/api/agent-mcp-servers/agent_9")).status, 404);
  assert.deepEqual(await h.connections.servers("agent_1"), []);
});

test("endpoint, name and bearer are parsed before custody", async () => {
  const h = fixture();
  const refused = [
    { name: "linear", url: "http://mcp.example.com/mcp", bearer: null },
    {
      name: "linear",
      url: "https://user:pw@mcp.example.com/mcp",
      bearer: null,
    },
    { name: "linear", url: "not a url", bearer: null },
    { name: "Linear-MCP", url: endpoint, bearer: null },
    { name: "linear", url: endpoint, bearer: "a b" },
    { name: "linear", url: endpoint },
    { name: "linear", url: endpoint, bearer: null, extra: true },
  ];
  for (const input of refused)
    assert.equal((await h.add(input)).status, 400, JSON.stringify(input));
  // The core refuses a private destination the schema cannot see.
  assert.equal(
    (
      await h.add({
        name: "linear",
        url: "https://127.0.0.1/mcp",
        bearer: null,
      })
    ).status,
    400,
  );
  assert.deepEqual(await h.connections.servers("agent_1"), []);
});

test("a granted Agent calls the server through the owner; the token never reaches it", async () => {
  const h = fixture();
  const server = await (
    await h.add({ name: "notes", url: endpoint, bearer: token })
  ).json();
  const projection = await h.connections.projection("agent_1");
  assert.ok(!JSON.stringify(projection).includes(token));
  const acquired = await acquire(h, "agent_1");
  try {
    assert.equal(acquired.snapshot.modules.length, 1);
    assert.deepEqual(
      await callTool(acquired.snapshot.modules, "add", { a: 2, b: 3 }),
      {
        sum: 5,
      },
    );
    assert.deepEqual(h.fake.calls, [{ a: 2, b: 3 }]);
    assert.ok(h.fake.seen.every((value) => value === `Bearer ${token}`));

    // Another Agent holds no grant: the owner refuses it.
    const ref = projection.connections[0];
    const other = await h.connections.fetch(
      "agent_2",
      { connectionId: ref.connectionId, grantVersion: ref.grantVersion },
      await mcpRequestData(new Request(endpoint, { method: "GET" })),
    );
    assert.deepEqual(other, { error: "revoked" });

    // The owner revokes; the live module's next call fails without a restart.
    const removed = await h.call(
      `/api/agent-mcp-servers/agent_1/${server.serverId}`,
      {
        method: "DELETE",
      },
    );
    assert.equal(removed.status, 204);
    await assert.rejects(() =>
      callTool(acquired.snapshot.modules, "add", { a: 1, b: 1 }),
    );
    assert.deepEqual(h.fake.calls, [{ a: 2, b: 3 }]);
  } finally {
    await acquired.release();
  }
  assert.ok(!h.dump().includes(token));
});
