// Proof, not a gate: Prints priced by a real Oyster `/media/quote` route.
// Serve the Prints workbench (`pnpm --dir apps/prints workbench`), then run
// PRINTS_WORKBENCH_URL=<its url> PRINTS_QUOTE_SHOTS=<dir> pnpm proof:oyster-quote
import assert from "node:assert/strict";
import console from "node:console";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { chromium } from "playwright";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: import.meta
          .resolve("@fungi.computer/oyster/testing/workers-runtime"),
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { capabilityFixture } = await import("../../src/testing/index.ts");
const { r2FileSource } = await import("@fungi.computer/oyster/workers");
const { workersMedia } = await import("../../src/standalone/media.ts");
hooks.deregister();

const adapters = workersMedia(
  {
    OYSTER_ORIGIN: "https://oyster.example",
    AI: { run: () => assert.fail("pricing must not call a provider") },
    MEDIA_OPERATION: {
      getByName: () => assert.fail("pricing must not create an operation"),
    },
  },
  { computerId: "computer-media", files: r2FileSource({}, "unused/") },
);
const oyster = await capabilityFixture({
  capabilities: ["media.generation"],
  adapters,
});
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, cors).end();
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name,
        String(value),
      ]),
    );
    void oyster.app
      .request(`https://oyster.test${request.url ?? "/"}`, {
        method: request.method,
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      })
      .then(async (reply) => {
        response.writeHead(reply.status, {
          ...cors,
          "Content-Type": reply.headers.get("Content-Type") ?? "text/plain",
        });
        response.end(Buffer.from(await reply.arrayBuffer()));
      });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const quoteUrl = `http://127.0.0.1:${String(address.port)}/media/quote`;
const base = process.env.PRINTS_WORKBENCH_URL ?? "http://127.0.0.1:61002";
const output = process.env.PRINTS_QUOTE_SHOTS;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: theme,
      });
      try {
        await page.goto(
          `${base}/?story=prints--oyster-quote&mode=preview&theme=${theme}&oysterQuote=${encodeURIComponent(quoteUrl)}`,
        );
        const prompt = page.getByLabel("Image prompt", { exact: true });
        await prompt.waitFor();
        await prompt.fill("fern fronds unfurling in a greenhouse");
        const price = page.locator("[data-generation-price]");
        await price.waitFor();
        assert.match(
          (await price.textContent()) ?? "",
          /^(<\$0\.01|≈ \$\d+\.\d{2})$/u,
        );
        if (output)
          await page.screenshot({
            path: `${output}/oyster-composer-price-${String(width)}-${theme}.png`,
          });
        console.log(
          `PASS: ${String(width)}-${theme} Oyster price ${(await price.textContent()) ?? ""}`,
        );
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
