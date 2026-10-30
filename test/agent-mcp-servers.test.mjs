/* global Headers, Request */
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentMcpServerRoutes } from "../dist/agents.js";
import { serveHost } from "../dist/authorization.js";

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

/** An adapter that keeps the bearer, as the Agent's Durable Object does. */
function fixture() {
  const stored = new Map([["agent_1", []]]);
  const adapter = {
    list: async () => [{ agentId: "agent_1", name: "Helper" }],
    mcpServers: async (agentId) =>
      stored.get(agentId)?.map(({ bearer, ...server }) => ({
        ...server,
        hasBearer: bearer !== null,
      })) ?? null,
    addMcpServer: async (agentId, input) => {
      const servers = stored.get(agentId);
      if (servers === undefined) return { error: "not_found" };
      if (servers.some((server) => server.name === input.name))
        return { error: "duplicate_name" };
      const server = {
        serverId: `mcp_${String(servers.length + 1)}`,
        name: input.name,
        url: input.url,
        bearer: input.bearer,
      };
      servers.push(server);
      return {
        serverId: server.serverId,
        name: server.name,
        url: server.url,
        hasBearer: server.bearer !== null,
      };
    },
    removeMcpServer: async (agentId, serverId) => {
      const servers = stored.get(agentId);
      const index = servers?.findIndex(
        (server) => server.serverId === serverId,
      );
      if (servers === undefined || index === undefined || index < 0)
        return false;
      servers.splice(index, 1);
      return true;
    },
  };
  // The host's one admission per request.
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
  return { call, stored };
}

const token = "secret-bearer-value";

test("the owner connects, lists and removes an Agent's MCP server", async () => {
  const { call, stored } = fixture();
  const added = await call("/api/agent-mcp-servers/agent_1", {
    method: "POST",
    body: JSON.stringify({
      name: "linear",
      url: "https://mcp.example.com/mcp",
      bearer: token,
    }),
  });
  assert.equal(added.status, 201);
  const body = await added.text();
  assert.ok(!body.includes(token), "the bearer never comes back");
  assert.deepEqual(JSON.parse(body), {
    serverId: "mcp_1",
    name: "linear",
    url: "https://mcp.example.com/mcp",
    hasBearer: true,
  });
  assert.equal(stored.get("agent_1")[0].bearer, token);

  const listed = await call("/api/agent-mcp-servers");
  assert.equal(listed.status, 200);
  const listedBody = await listed.text();
  assert.ok(!listedBody.includes(token));
  assert.deepEqual(JSON.parse(listedBody), {
    agents: [
      {
        agentId: "agent_1",
        name: "Helper",
        servers: [
          {
            serverId: "mcp_1",
            name: "linear",
            url: "https://mcp.example.com/mcp",
            hasBearer: true,
          },
        ],
      },
    ],
  });

  const duplicate = await call("/api/agent-mcp-servers/agent_1", {
    method: "POST",
    body: JSON.stringify({
      name: "linear",
      url: "https://other.example.com/mcp",
      bearer: null,
    }),
  });
  assert.equal(duplicate.status, 409);

  const removed = await call("/api/agent-mcp-servers/agent_1/mcp_1", {
    method: "DELETE",
  });
  assert.equal(removed.status, 204);
  assert.deepEqual(stored.get("agent_1"), []);
  const gone = await call("/api/agent-mcp-servers/agent_1/mcp_1", {
    method: "DELETE",
  });
  assert.equal(gone.status, 404);
});

test("only the owner, directly, reaches MCP server custody", async () => {
  const { call, stored } = fixture();
  const add = (agentId, init = {}, who = "owner") =>
    call(
      `/api/agent-mcp-servers/${agentId}`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "linear",
          url: "https://mcp.example.com/mcp",
          bearer: null,
        }),
        ...init,
      },
      who,
    );
  assert.equal((await call("/api/agent-mcp-servers", {}, null)).status, 403);
  assert.equal((await call("/api/agent-mcp-servers", {}, "key")).status, 403);
  assert.equal((await add("agent_1", {}, null)).status, 403);
  assert.equal((await add("agent_1", {}, "key")).status, 403);
  const installed = await add("agent_1", {
    headers: { "X-Oyster-Installation": "app" },
  });
  assert.equal(installed.status, 403);
  assert.equal((await add("agent_9")).status, 404);
  assert.deepEqual(stored.get("agent_1"), []);
});

test("endpoint, name and bearer are parsed before custody", async () => {
  const { call, stored } = fixture();
  const refused = [
    { name: "linear", url: "http://mcp.example.com/mcp", bearer: null },
    {
      name: "linear",
      url: "https://user:pw@mcp.example.com/mcp",
      bearer: null,
    },
    { name: "linear", url: "not a url", bearer: null },
    { name: "Linear-MCP", url: "https://mcp.example.com/mcp", bearer: null },
    { name: "linear", url: "https://mcp.example.com/mcp", bearer: "a b" },
    { name: "linear", url: "https://mcp.example.com/mcp" },
    {
      name: "linear",
      url: "https://mcp.example.com/mcp",
      bearer: null,
      extra: true,
    },
  ];
  for (const input of refused) {
    const response = await call("/api/agent-mcp-servers/agent_1", {
      method: "POST",
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 400, JSON.stringify(input));
  }
  assert.deepEqual(stored.get("agent_1"), []);
});
