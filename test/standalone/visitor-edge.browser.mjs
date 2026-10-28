/* global Buffer, ReadableStream, Request, TextEncoder, fetch, process */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Hono } from "hono";
import { chromium } from "playwright";
import { channelIds } from "../../dist/channels/ids.js";
import { createVisitorEdge } from "../../dist/channels/visitor-edge.js";

// Serve the built edge to a real browser without running a Fungi service.
const siteKey = channelIds.site.generate();
const bindingId = channelIds.binding.generate();
const tokens = {
  fern: `vt_${"A".repeat(43)}`,
  moss: `vt_${"B".repeat(43)}`,
};
const calls = [];
const edge = createVisitorEdge({
  resolveSite: (_context, key) =>
    Promise.resolve(key === siteKey ? { bindingId } : null),
  openSite: () => {
    throw new Error("Conversation browser proof must not open the site owner");
  },
  authenticateVisitor: (_context, _site, token) => {
    calls.push("authenticate");
    const visitorId = Object.entries(tokens).find(
      ([, bearer]) => bearer === token,
    )?.[0];
    return Promise.resolve(visitorId === undefined ? null : { visitorId });
  },
  openChannel: (_context, _site, visitor) => {
    calls.push(`agent:${visitor.visitorId}`);
    return Promise.resolve({
      [Symbol.dispose]() {
        return undefined;
      },
      openVisitorSession: () =>
        Promise.resolve({
          kind: "session",
          snapshot: JSON.stringify({ agent: visitor.visitorId }),
        }),
      watchAsChannelVisitor: () =>
        Promise.resolve({
          kind: "stream",
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `event: agent\ndata: ${visitor.visitorId}\n\n`,
                ),
              );
              controller.close();
            },
          }),
        }),
    });
  },
  addressHash: () => Promise.resolve("not used"),
  assetPath: (kind) => `/${kind}`,
  onError: (error) => {
    throw error;
  },
});
const app = new Hono().route("/", edge);
const server = createServer(async (request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Visitor edge browser proof</title>");
    return;
  }
  const url = `http://127.0.0.1:${server.address().port}${request.url}`;
  const incoming = new Request(
    url,
    request.method === "POST"
      ? {
          method: request.method,
          headers: request.headers,
          body: request,
          duplex: "half",
        }
      : { method: request.method, headers: request.headers },
  );
  const outgoing = await app.fetch(incoming);
  response.writeHead(
    outgoing.status,
    Object.fromEntries(outgoing.headers.entries()),
  );
  response.end(Buffer.from(await outgoing.arrayBuffer()));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const observed = await page.evaluate(
    async ({ key, bearers }) => {
      const endpoint = `/api/embed/v1/sites/${key}`;
      const fetchVisitor = async (token) => {
        const headers = { authorization: `Bearer ${token}` };
        const document = await fetch(`${endpoint}/session`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: "{}",
        });
        if (!document.ok) return { status: document.status };
        const events = await fetch(`${endpoint}/conversation/events`, {
          headers,
        });
        return { snapshot: await document.json(), events: await events.text() };
      };
      return {
        fern: await fetchVisitor(bearers.fern),
        moss: await fetchVisitor(bearers.moss),
        invalid: await fetchVisitor(`vt_${"C".repeat(43)}`),
      };
    },
    { key: siteKey, bearers: tokens },
  );
  assert.deepEqual(observed, {
    fern: {
      snapshot: { agent: "fern" },
      events: "event: agent\ndata: fern\n\n",
    },
    moss: {
      snapshot: { agent: "moss" },
      events: "event: agent\ndata: moss\n\n",
    },
    invalid: { status: 401 },
  });
  assert.deepEqual(calls, [
    "authenticate",
    "agent:fern",
    "authenticate",
    "agent:fern",
    "authenticate",
    "agent:moss",
    "authenticate",
    "agent:moss",
    "authenticate",
  ]);
  process.stdout.write(
    "Browser reached visitor-aware document and SSE edge; invalid bearer opened no Agent.\n",
  );
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
