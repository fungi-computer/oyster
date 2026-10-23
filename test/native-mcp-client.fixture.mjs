import { URL } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

/** A real SDK session; elicitation and tool results stay visible to each oracle. */
export function nativeMcpConnector({ origin, name }) {
  return async (credential, headless = false) => {
    const client = new Client(
      { name, version: "1" },
      { capabilities: { elicitation: headless ? {} : { form: {} } } },
    );
    let asked = 0;
    client.setRequestHandler("elicitation/create", () => {
      asked++;
      return headless
        ? { action: "cancel" }
        : { action: "accept", content: { approve: true } };
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp`),
      {
        requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      },
    );
    await client.connect(transport);
    return {
      client,
      asked: () => asked,
      execute: async (code) => {
        const result = await client.callTool({
          name: "execute",
          arguments: { code },
        });
        return { ...result, text: JSON.stringify(result.content) };
      },
      close: async () => {
        await transport.terminateSession();
        await client.close();
      },
    };
  };
}
