import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { URL } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { repoDetail } from "../../../../apps/bonsai/shared/contract.ts";

/** A shipping Bonsai operation, using the real Oyster MCP and installed UI. */
export async function proveMcpFork({
  origin,
  agentKey,
  ownerKey,
  browser,
  shots,
}) {
  assert.ok(browser, "The shipping MCP proof requires its real App browser");
  const directory = `${shots}/mcp`;
  await mkdir(directory, { recursive: true });
  const read = async () => {
    const response = await globalThis.fetch(
      `${origin}/apps/bonsai/methods/repos.get`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repo: "koi-pond" }),
      },
    );
    assert.equal(response.status, 200);
    return repoDetail.parse(await response.json());
  };
  const capture = async (phase) => {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        await page.goto(`${origin}/login`);
        await page.getByLabel("Owner key").fill(ownerKey);
        await page.getByRole("button", { name: /sign in/i }).click();
        await page.goto(`${origin}/apps/bonsai/`);
        const app = page.frameLocator("#oyster-app");
        await app
          .getByRole("link", { name: "koi-pond", exact: true })
          .first()
          .click();
        const network = app.locator('[data-tile="network"]');
        await network
          .getByRole("button", { name: "Fit history", exact: true })
          .waitFor();
        const lane = network.getByRole("button", { name: /morel \/ main/ });
        if (phase === "after") {
          await lane.waitFor();
          await app
            .getByText("morel forked koi-pond", { exact: true })
            .waitFor();
        } else assert.equal(await lane.count(), 0);
        await page.evaluate(() => globalThis.document.fonts.ready);
        await app
          .locator("html")
          .evaluate((element) => element.ownerDocument.fonts.ready);
        await page.screenshot({
          path: `${directory}/${phase}-${width}.png`,
          animations: "disabled",
          fullPage: true,
        });
      } finally {
        await page.close();
      }
    }
  };
  const before = await read();
  assert.ok(!before.repo.forks.includes("koi-pond--morel"));
  await capture("before");
  // Like `claude -p`: a bare elicitation capability, and every elicitation is
  // cancelled because no person is there to answer it.
  const client = new Client(
    { name: "Bonsai contest Agent", version: "1" },
    { capabilities: { elicitation: {} } },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${agentKey}` } },
    },
  );
  let asked = 0;
  client.setRequestHandler("elicitation/create", () => {
    asked += 1;
    return { action: "cancel" };
  });
  try {
    await client.connect(transport);
    const list = await client.callTool({
      name: "execute",
      arguments: { code: "return await env.BONSAI.repos.list({})" },
    });
    assert.notEqual(list.isError, true);
    assert.match(JSON.stringify(list.content), /koi-pond/);
    const result = await client.callTool({
      name: "execute",
      arguments: {
        code: 'return await env.BONSAI.repos.fork({repo:"koi-pond"})',
      },
    });
    assert.notEqual(result.isError, true);
    assert.equal(asked, 0, "The owner's key approval is the confirmation");
    assert.match(JSON.stringify(result.content), /koi-pond--morel/);
    const after = await read();
    assert.ok(after.repo.forks.includes("koi-pond--morel"));
    await capture("after");
  } finally {
    await transport.terminateSession();
    await client.close();
  }
}
