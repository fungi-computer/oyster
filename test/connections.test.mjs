/* global AbortController, Headers, Request, Response, URL, URLSearchParams */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
import { connectionRoutes } from "../dist/agents.js";
import { serveHost } from "../dist/authorization.js";
import { mcpRequestData } from "@fungi.computer/veil/connections";
import {
  agentMcpSourceOptions,
  createAgentMcpConnections,
} from "../dist/standalone/agent-connections.js";
import { createInstanceCredentialStore } from "../dist/standalone/model-key-vault.js";

const token = "marker-bearer-0123456789abcdef"; //gitleaks:allow
const endpoint = "https://mcp.example.com/mcp";
const callbackUrl = "https://oyster.test/api/connections/callback";

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
function upstream(requireBearer = true) {
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
    if (
      requireBearer &&
      request.headers.get("authorization") !== `Bearer ${token}`
    )
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    return handler.fetch(request);
  };
  return { send, calls, seen };
}

/** The directory's owner side over real SQLite and the real credential store. */
function fixture(send, bearer = true) {
  const database = new DatabaseSync(":memory:");
  const vaultRows = new Map();
  const fake =
    send === undefined ? upstream(bearer) : { send, calls: [], seen: [] };
  const agents = new Set(["agent_1", "agent_2"]);
  const notified = [];
  const connections = createAgentMcpConnections({
    ownerId: "agents",
    callbackUrl,
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
    list: async () => [
      { agentId: "agent_1", name: "Helper" },
      { agentId: "agent_2", name: "Guest" },
    ],
    connections: connections.list,
    addConnection: connections.add,
    grantConnection: connections.grant,
    ungrantConnection: connections.ungrant,
    removeConnection: connections.remove,
    connectionTools: connections.tools,
    completeMcpConnection: connections.complete,
    mcpCallbackUrl: () => callbackUrl,
  };
  const routes = serveHost(
    connectionRoutes(adapter),
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
  const add = (body) =>
    call("/api/connections", { method: "POST", body: JSON.stringify(body) });
  const grant = (connectionId, agentId, access = "all") =>
    call(`/api/connections/${connectionId}/agents/${agentId}`, {
      method: "PUT",
      body: JSON.stringify({ access }),
    });
  return { call, add, grant, connections, dump, fake, notified, vaultRows };
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

test("the owner connects, lists, grants and removes a connection", async () => {
  const h = fixture();
  const added = await h.add({ name: "linear", url: endpoint, bearer: token });
  assert.equal(added.status, 201);
  const body = await added.text();
  assert.ok(!body.includes(token), "the bearer never comes back");
  const { connectionId, authorizeUrl } = JSON.parse(body);
  assert.equal(authorizeUrl, null);
  assert.ok(!h.dump().includes(token), "no storage holds the bearer in clear");

  // Connected, but no Agent has it until the owner grants it.
  const before = await (await h.call("/api/connections")).json();
  assert.deepEqual(before.connections[0].grants, []);
  assert.equal(before.connections[0].auth, "token");
  assert.equal(before.callbackUrl, callbackUrl);
  assert.deepEqual(
    before.agents.map((agent) => agent.agentId),
    ["agent_1", "agent_2"],
  );

  assert.equal((await h.grant(connectionId, "agent_1")).status, 204);
  const listed = await (await h.call("/api/connections")).text();
  assert.ok(!listed.includes(token));
  assert.deepEqual(JSON.parse(listed).connections[0].grants, [
    { agentId: "agent_1", access: "all" },
  ]);

  const duplicate = await h.add({
    name: "linear",
    url: "https://other.example.com/mcp",
    bearer: null,
  });
  assert.equal(duplicate.status, 409);

  assert.equal(
    (
      await h.call(`/api/connections/${connectionId}/agents/agent_1`, {
        method: "DELETE",
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await h.call(`/api/connections/${connectionId}/agents/agent_1`, {
        method: "DELETE",
      })
    ).status,
    404,
  );
  assert.equal(
    (await h.call(`/api/connections/${connectionId}`, { method: "DELETE" }))
      .status,
    204,
  );
  assert.equal(
    (await h.call(`/api/connections/${connectionId}`, { method: "DELETE" }))
      .status,
    404,
  );
  assert.equal((await h.grant(connectionId, "agent_1")).status, 404);
});

test("only the owner, directly, reaches connection custody", async () => {
  const h = fixture();
  const body = JSON.stringify({ name: "linear", url: endpoint, bearer: null });
  const post = (init = {}, who = "owner") =>
    h.call("/api/connections", { method: "POST", body, ...init }, who);
  assert.equal((await h.call("/api/connections", {}, null)).status, 403);
  assert.equal((await h.call("/api/connections", {}, "key")).status, 403);
  assert.equal((await post({}, null)).status, 403);
  assert.equal((await post({}, "key")).status, 403);
  const installed = await post({ headers: { "X-Oyster-Installation": "app" } });
  assert.equal(installed.status, 403);
  assert.deepEqual(await h.connections.list(), []);
  const { connectionId } = await (await post()).json();
  assert.equal((await h.grant(connectionId, "agent_9")).status, 404);
  assert.equal(
    (
      await h.call(
        `/api/connections/${connectionId}/agents/agent_1`,
        { method: "PUT", body: JSON.stringify({ access: "all" }) },
        "key",
      )
    ).status,
    403,
  );
});

test("endpoint, name, bearer and access are parsed before custody", async () => {
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
  assert.deepEqual(await h.connections.list(), []);
  const { connectionId } = await (
    await h.add({ name: "linear", url: endpoint, bearer: null })
  ).json();
  for (const access of [{}, "some", [], 1])
    if (!Array.isArray(access))
      assert.equal(
        (
          await h.call(`/api/connections/${connectionId}/agents/agent_1`, {
            method: "PUT",
            body: JSON.stringify({ access }),
          })
        ).status,
        400,
        JSON.stringify(access),
      );
});

test("a granted Agent calls through the owner, is narrowed, and loses access without a restart", async () => {
  const h = fixture();
  const { connectionId } = await (
    await h.add({ name: "notes", url: endpoint, bearer: token })
  ).json();
  assert.equal((await h.grant(connectionId, "agent_1")).status, 204);
  const projection = await h.connections.projection("agent_1");
  assert.ok(!JSON.stringify(projection).includes(token));
  assert.deepEqual((await h.connections.projection("agent_2")).connections, []);

  // The owner sees the server's tools to choose from.
  const offered = await (
    await h.call(`/api/connections/${connectionId}/tools`)
  ).json();
  assert.deepEqual(offered.tools, ["add"]);

  const acquired = await acquire(h, "agent_1");
  try {
    assert.equal(acquired.snapshot.modules.length, 1);
    assert.deepEqual(
      await callTool(acquired.snapshot.modules, "add", { a: 2, b: 3 }),
      { sum: 5 },
    );
    assert.ok(h.fake.seen.every((value) => value === `Bearer ${token}`));

    // Another Agent holds no grant: the owner refuses it.
    const ref = projection.connections[0];
    const other = await h.connections.fetch(
      "agent_2",
      { connectionId: ref.connectionId, grantVersion: ref.grantVersion },
      await mcpRequestData(new Request(endpoint, { method: "GET" })),
    );
    assert.deepEqual(other, { error: "revoked" });

    // The owner narrows to a tool the Agent is not calling: its next call is refused.
    assert.equal(
      (await h.grant(connectionId, "agent_1", ["other_tool"])).status,
      204,
    );
    await assert.rejects(() =>
      callTool(acquired.snapshot.modules, "add", { a: 1, b: 1 }),
    );
    assert.deepEqual(h.fake.calls, [{ a: 2, b: 3 }]);

    // Widening again restores it; removing the connection ends it for good.
    assert.equal((await h.grant(connectionId, "agent_1", ["add"])).status, 204);
    const reacquired = await acquire(h, "agent_1");
    try {
      assert.deepEqual(
        await callTool(reacquired.snapshot.modules, "add", { a: 4, b: 4 }),
        { sum: 8 },
      );
      assert.equal(
        (await h.call(`/api/connections/${connectionId}`, { method: "DELETE" }))
          .status,
        204,
      );
      await assert.rejects(() =>
        callTool(reacquired.snapshot.modules, "add", { a: 1, b: 1 }),
      );
    } finally {
      await reacquired.release();
    }
  } finally {
    await acquired.release();
  }
  assert.ok(!h.dump().includes(token));
});

/** An OAuth authorization server with dynamic registration and an MCP server behind it. */
function oauthWorld() {
  const valid = new Set();
  const codes = new Map();
  let issued = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "fixture", version: "1" });
    server.registerTool(
      "ping",
      { description: "Ping.", inputSchema: z.object({}) },
      () => ({ content: [{ type: "text", text: "pong" }] }),
    );
    return server;
  });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetch = async (request) => {
    const url = new URL(request.url);
    if (url.host === "mcp.example.com") {
      if (url.pathname.startsWith("/.well-known/"))
        return json({
          resource: endpoint,
          authorization_servers: ["https://auth.example.com"],
        });
      const bearer = request.headers.get("authorization") ?? "";
      if (!valid.has(bearer.replace("Bearer ", "")))
        return new Response("{}", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      return handler.fetch(request);
    }
    switch (url.pathname) {
      case "/.well-known/oauth-authorization-server":
        return json({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
      case "/register":
        return json({ ...(await request.json()), client_id: "dcr-1" }, 201);
      case "/token": {
        const form = new URLSearchParams(await request.text());
        const code = codes.get(form.get("code") ?? "");
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (code !== challenge) return json({ error: "invalid_grant" }, 400);
        issued += 1;
        valid.add(`access-${String(issued)}`);
        return json({
          access_token: `access-${String(issued)}`,
          token_type: "Bearer",
          refresh_token: `refresh-${String(issued)}`,
          expires_in: 3600,
        });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  };
  const approve = (authorizeUrl) => {
    const query = new URL(authorizeUrl).searchParams;
    const code = `code-${query.get("state")}`;
    codes.set(code, query.get("code_challenge"));
    return new URLSearchParams({
      state: query.get("state"),
      code,
      iss: "https://auth.example.com",
    });
  };
  return { fetch, approve };
}

test("an OAuth server signs in through the callback route, then serves the granted Agent", async () => {
  const world = oauthWorld();
  const h = fixture(world.fetch);
  const response = await h.add({
    name: "notes",
    url: endpoint,
    bearer: null,
    oauth: {},
  });
  assert.equal(response.status, 201);
  const added = await response.json();
  assert.ok(
    added.authorizeUrl.startsWith("https://auth.example.com/authorize"),
  );
  assert.equal(
    new URL(added.authorizeUrl).searchParams.get("redirect_uri"),
    callbackUrl,
  );
  const listedPending = await (await h.call("/api/connections")).json();
  assert.equal(listedPending.connections[0].state, "pending");
  assert.equal(listedPending.connections[0].auth, "oauth");
  // Granting waits for nothing, but nothing is usable until the owner signs in.
  assert.equal((await h.grant(added.connectionId, "agent_1")).status, 204);
  assert.deepEqual((await h.connections.projection("agent_1")).connections, []);

  const back = (query, who = "owner") =>
    h.call(
      `/api/connections/callback?${query.toString()}`,
      { method: "GET" },
      who,
    );
  const approval = world.approve(added.authorizeUrl);
  assert.equal((await back(approval, null)).status, 403);
  assert.equal((await back(approval, "key")).status, 403);
  assert.equal((await back(approval)).status, 303);
  // The state is single use.
  assert.equal((await back(approval)).status, 400);
  assert.ok(h.notified.includes("agent_1"));

  const listed = await (await h.call("/api/connections")).json();
  assert.equal(listed.connections[0].state, "connected");
  const acquired = await acquire(h, "agent_1");
  try {
    assert.equal(acquired.snapshot.modules.length, 1);
    assert.deepEqual(await callTool(acquired.snapshot.modules, "ping", {}), {
      isError: false,
      content: [{ type: "text", text: "pong" }],
    });
  } finally {
    await acquired.release();
  }
  assert.ok(!h.dump().includes("access-1") && !h.dump().includes("refresh-1"));
});

test("a server that asks for no token works with no credential at all", async () => {
  const h = fixture(undefined, false);
  const added = await (
    await h.add({ name: "open", url: endpoint, bearer: null })
  ).json();
  assert.equal((await h.grant(added.connectionId, "agent_1")).status, 204);
  const acquired = await acquire(h, "agent_1");
  try {
    assert.equal(acquired.snapshot.modules.length, 1);
    assert.deepEqual(
      await callTool(acquired.snapshot.modules, "add", { a: 4, b: 5 }),
      { sum: 9 },
    );
    assert.ok(h.fake.seen.every((value) => value === null));
  } finally {
    await acquired.release();
  }
});
