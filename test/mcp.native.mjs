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
  // A headless client cancels every elicitation. Grants bound its authority;
  // the durable home owns auto-approve, not a transport pre-approval list.
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
    // One execute has two intended writes, not one repeated intended effect.
    // The native App readback must observe both, even though their outer SDK
    // tool call and host execution identity are shared.
    const sequence = await headless.client.callTool({
      name: "execute",
      arguments: {
        code: "await env.NOTES.saveNote({text: 'native ordinal first'}); const first = await env.NOTES.readNote({}); await env.NOTES.saveNote({text: 'via mcp'}); return {first, second: await env.NOTES.readNote({})};",
      },
    });
    assert.notEqual(sequence.isError, true, JSON.stringify(sequence));
    assert.match(JSON.stringify(sequence.content), /native ordinal first/);
    assert.deepEqual(
      await readNote(),
      { text: "via mcp" },
      "the second intended write in one actual native execution must dispatch",
    );
    assert.equal(
      asked,
      0,
      "the MCP transport adds no outer write confirmation",
    );
  } finally {
    await headless.transport.terminateSession();
    await headless.client.close();
  }
}
