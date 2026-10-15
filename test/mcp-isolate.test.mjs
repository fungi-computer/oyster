// Simulated isolate boundary: two real Oyster/MCP servers share host data and
// authentication, but have independent module memory. No protocol is mocked.
/* global Request, URL */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcp, createMcpCatalog } from "@fungi.computer/mycelium/mcp";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { ownerFrontends } from "./mcp-owner.fixture.mjs";
import { createOyster } from "../dist/host.js";
import { oysterMcpCatalogLoad } from "../dist/mcp.js";

const authenticate = (request) =>
  Promise.resolve(
    request.headers.get("Authorization") === "Bearer fixture-key"
      ? {
          kind: "admitted",
          principal: { actor: { kind: "team-key", keyId: "fixture" } },
        }
      : { kind: "refused", status: 401 },
  );
const data = {
  installations: { list: () => Promise.resolve([]) },
  artifacts: { get: () => Promise.resolve(null) },
  instances: {
    get: () => {
      throw new Error("No App is installed in this transport proof");
    },
  },
};

function isolate() {
  const mcp = createMcp({
    catalog: createMcpCatalog({
      load: oysterMcpCatalogLoad(data),
      sandbox: directSandbox(() => Promise.resolve(null)),
    }),
    authenticate,
  });
  return { app: createOyster({ ...data, auth: { authenticate }, mcp }), mcp };
}

test("a client re-initializes cleanly after its old MCP session returns 404", async () => {
  const first = isolate();
  const cold = isolate();
  let current = first;
  const client = new Client({ name: "eviction recovery proof", version: "1" });
  const connection = () =>
    new StreamableHTTPClientTransport(new URL("https://oyster.test/mcp"), {
      requestInit: { headers: { Authorization: "Bearer fixture-key" } },
      fetch: (input, init) => current.app.fetch(new Request(input, init)),
    });
  const original = connection();
  try {
    await client.connect(original);
    assert.deepEqual(
      (await client.listTools()).tools.map(({ name }) => name),
      ["execute"],
    );
    const oldId = original.sessionId;
    assert.ok(oldId, "the first connection has an established session");
    current = cold;
    await assert.rejects(
      client.listTools(),
      (cause) => cause instanceof SdkHttpError && cause.status === 404,
      "a cold owner refuses the expired session",
    );
    await client.close();
    const fresh = connection();
    await client.connect(fresh);
    assert.ok(fresh.sessionId, "the SDK initializes a new session");
    assert.ok(fresh.sessionId !== oldId, "the expired ID is not resurrected");
    assert.deepEqual(
      (await client.listTools()).tools.map(({ name }) => name),
      ["execute"],
    );
    const result = await client.callTool({
      name: "execute",
      arguments: { code: "return null" },
    });
    assert.notEqual(result.isError, true);
    await fresh.terminateSession();
  } finally {
    await client.close();
    await Promise.all([first.mcp.close(), cold.mcp.close()]);
  }
});

for (const crossing of [false, true]) {
  test(
    crossing
      ? "an established MCP session survives the next POST reaching another isolate"
      : "an established MCP session accepts its next POST in the same isolate",
    async () => {
      const frontends = ownerFrontends();
      const first = frontends.first;
      const second = crossing ? frontends.second : first;
      let sessionId;
      let posts = 0;
      const client = new Client({ name: "isolate proof", version: "1" });
      const transport = new StreamableHTTPClientTransport(
        new URL("https://oyster.test/mcp"),
        {
          requestInit: { headers: { Authorization: "Bearer fixture-key" } },
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const id = request.headers.get("Mcp-Session-Id");
            const response = await (
              sessionId === undefined ? first : second
            ).app.fetch(request);
            if (request.method === "POST") {
              posts++;
              if (posts === 1) {
                assert.equal(response.status, 200);
                sessionId = response.headers.get("Mcp-Session-Id");
                assert.ok(sessionId, "initialization established a session");
              } else if (posts === 2) {
                assert.ok(id === sessionId, "the SDK sends the established ID");
                assert.equal(
                  response.status,
                  202,
                  "the initialized notification retains the established session",
                );
              }
            }
            return response;
          },
        },
      );
      try {
        await client.connect(transport);
        assert.deepEqual(
          (await client.listTools()).tools.map(({ name }) => name),
          ["execute"],
        );
        await transport.terminateSession();
      } finally {
        await client.close();
        frontends.close();
      }
    },
  );
}
