// Shared MCP proof inside the standalone fixture, on both workerd and celld.
/* global URL, fetch */
import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export async function proveMcp(origin, key, readNote) {
  for (const method of ["POST", "GET", "DELETE"]) {
    assert.equal((await fetch(`${origin}/mcp`, { method })).status, 401);
  }
  const connect = async (capabilities = {}) => {
    const client = new Client(
      { name: "Oyster native proof", version: "1" },
      { capabilities },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp`),
      {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      },
    );
    await client.connect(transport);
    return { client, transport };
  };
  const write = (client, text) =>
    client.callTool({
      name: "execute",
      arguments: {
        code: `return await env.NOTES.saveNote({ text: ${JSON.stringify(text)} })`,
      },
    });
  // The demo client (`claude -p`) advertises a bare `elicitation: {}` and
  // cancels every elicitation; the owner's approval of this key's App tools
  // is its confirmation, so it is never asked.
  const headless = await connect({ elicitation: {} });
  let asked = 0;
  headless.client.setRequestHandler("elicitation/create", () => {
    asked += 1;
    return { action: "cancel" };
  });
  try {
    assert.deepEqual(
      (await headless.client.listTools()).tools.map(({ name }) => name),
      ["execute"],
    );
    assert.match(headless.client.getInstructions(), /Installed Apps/);
    const result = await write(headless.client, "via mcp");
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(await readNote(), { text: "via mcp" });
    const read = await headless.client.callTool({
      name: "execute",
      arguments: { code: "return await env.NOTES.readNote({})" },
    });
    assert.notEqual(read.isError, true, JSON.stringify(read));
    assert.match(
      JSON.stringify(read.content),
      /via mcp/,
      "MCP returns the persisted App value",
    );
    assert.equal(asked, 0, "an owner-approved key is never asked");
  } finally {
    await headless.transport.terminateSession();
    await headless.client.close();
  }
}
