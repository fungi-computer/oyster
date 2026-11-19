import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { storageWatchStream } from "../src/storage-watch-stream.js";

// Plain `http://` hosts speak HTTP/1.1, where a browser opens at most six
// connections per host: `oyster try` (workerd under wrangler) is one. Nine
// open Apps must still leave room for ordinary requests.
const bundle = await build({
  entryPoints: [
    fileURLToPath(
      new globalThis.URL("../src/page/storage-events.ts", import.meta.url),
    ),
  ],
  bundle: true,
  format: "iife",
  globalName: "events",
  write: false,
  platform: "browser",
});
const script = bundle.outputFiles[0].text;

let upstream = 0;
const keyStream = () =>
  Stream.unwrap(
    Effect.sync(() => {
      upstream++;
      return Stream.make(null).pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(
          Effect.sync(() => {
            upstream--;
          }),
        ),
      );
    }),
  );

const server = createServer(async (request, response) => {
  const url = new globalThis.URL(request.url ?? "/", "http://host");
  if (url.pathname === "/") {
    response
      .writeHead(200, { "Content-Type": "text/html" })
      .end(`<!doctype html><title>h1</title><script>${script}</script>`);
    return;
  }
  if (url.pathname === "/api/workbench/storage-events") {
    const watches = url.searchParams
      .getAll("watch")
      .map((raw) => JSON.parse(raw));
    const reader = storageWatchStream(watches, () =>
      Promise.resolve({ kind: "accepted", value: keyStream() }),
    ).getReader();
    request.on("close", () => {
      void reader.cancel();
    });
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    });
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      response.write(value);
    }
    response.end();
    return;
  }
  if (url.pathname.startsWith("/legacy-events")) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("event: ready\ndata: {}\n\n");
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${String(server.address().port)}`;
const browser = await chromium.launch();

async function outcome(open) {
  const page = await browser.newPage();
  try {
    await page.goto(base);
    return await page.evaluate(async (mode) => {
      const apps = 9;
      if (mode === "shared") {
        const shared = new globalThis.events.SharedStorageEvents();
        let ready = 0;
        for (let index = 0; index < apps; index++)
          shared.subscribe(`app-${String(index)}`, "state", ({ kind }) => {
            if (kind === "ready") ready++;
          });
        const deadline = Date.now() + 3000;
        while (ready < apps && Date.now() < deadline)
          await new Promise((wake) => globalThis.setTimeout(wake, 25));
        if (ready < apps)
          return `only ${String(ready)} of ${String(apps)} watches ready`;
      } else {
        for (let index = 0; index < apps; index++)
          new globalThis.EventSource(`/legacy-events?key=${String(index)}`);
        await new Promise((wake) => globalThis.setTimeout(wake, 300));
      }
      return await Promise.race([
        globalThis.fetch("/api/ping").then(() => "fetch ok"),
        new Promise((wake) =>
          globalThis.setTimeout(() => wake("fetch hung"), 3000),
        ),
      ]);
    }, open);
  } finally {
    await page.close();
  }
}

test("nine dedicated App streams starve an HTTP/1.1 host (the old behaviour)", async () => {
  assert.equal(await outcome("legacy"), "fetch hung");
});

test("nine App watches on the shared stream leave the host responsive and release on disconnect", async () => {
  assert.equal(await outcome("shared"), "fetch ok");
  // Closing the page cancels the one stream, and every key subscription with it.
  for (let wait = 0; upstream > 0 && wait < 100; wait++)
    await new Promise((done) => globalThis.setTimeout(done, 50));
  assert.equal(upstream, 0);
});

test.after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});
