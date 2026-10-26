/* global URL, fetch, AbortSignal, console */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(join(root, ".botanical"), { recursive: true });
const work = await mkdtemp(join(root, ".botanical", "onbox-context-"));
const privateHome = await mkdtemp("/tmp/botanical-onbox-home-");
async function port() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const value = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return value;
}
const debugPort = await port();
const pagePort = await port();
const workerPort = await port();
let child;
let browser;
let stopped;
const page = createHttpServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<title>onbox-adapter</title>");
});
try {
  await new Promise((resolve) => page.listen(pagePort, "127.0.0.1", resolve));
  const launch = () =>
    chromium.launch({
      headless: true,
      args: [
        `--remote-debugging-port=${debugPort}`,
        "--remote-debugging-address=127.0.0.1",
      ],
    });
  browser = await launch();
  await writeFile(
    join(work, "wrangler-onbox.json"),
    JSON.stringify({
      name: "staging-browser-onbox-seam",
      main: join(root, "test/browser/onbox-context.fixture.mjs"),
      compatibility_date: "2026-09-04",
      vars: {
        ONBOX_BROWSER_ORIGIN: `http://127.0.0.1:${debugPort}`,
        PAGE_ORIGIN: `http://127.0.0.1:${pagePort}/`,
      },
    }),
  );
  let output = "";
  stopped = new Promise((resolve) => {
    child = spawn(
      join(root, "node_modules/.bin/wrangler"),
      [
        "dev",
        "--config",
        join(work, "wrangler-onbox.json"),
        "--ip",
        "127.0.0.1",
        "--port",
        String(workerPort),
        "--persist-to",
        join(work, "state-onbox"),
      ],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: privateHome,
          XDG_CONFIG_HOME: join(privateHome, "config"),
          HEAVY: "/tmp/botanical-absent-heavy",
        },
      },
    );
    child.once("exit", resolve);
  });
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  async function call(path) {
    const response = await fetch(`http://127.0.0.1:${workerPort}${path}`, {
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(
      response.status,
      200,
      `celld Worker returned ${response.status}: ${output.slice(-2_000)}`,
    );
    return response.json();
  }
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null)
      throw new Error(
        `Worker exited ${child.exitCode}: ${output.slice(-2_000)}`,
      );
    try {
      const response = await fetch(
        `http://127.0.0.1:${workerPort}/?mode=ready`,
        { signal: AbortSignal.timeout(2_000) },
      );
      assert.equal(response.status, 200, output.slice(-2_000));
      ready = true;
      break;
    } catch (cause) {
      if (attempt === 59) throw cause;
    }
    if (child.exitCode !== null)
      throw new Error(
        `Worker exited ${child.exitCode}: ${output.slice(-2_000)}`,
      );
    await delay(250);
  }
  assert.equal(ready, true, output.slice(-2_000));
  const first = await call("/");
  assert.equal(first.separate, true);
  for (const record of [
    first.firstCookies,
    first.secondCookies,
    first.firstAgain,
  ])
    assert.equal(record.title, "onbox-adapter");
  assert.deepEqual(first.firstCookies.cookies, ["first"]);
  assert.deepEqual(first.secondCookies.cookies, ["second"]);
  assert.deepEqual(first.firstAgain.cookies, ["first"]);
  await browser.close();
  browser = undefined;
  assert.deepEqual(await call("/?mode=absent"), { refused: true });
  browser = await launch();
  assert.deepEqual(
    await call(`/?mode=restart&stale=${encodeURIComponent(first.stale)}`),
    { staleRejected: true, closed: "closed", fresh: true },
  );
  console.log(
    "On-box celld browser: two isolated contexts, navigate/read/close, absent and restart refusal PASS",
  );
} finally {
  if (child) {
    child.kill("SIGTERM");
    await stopped;
  }
  if (browser) await browser.close();
  await new Promise((resolve) => page.close(resolve));
  await rm(work, { recursive: true, force: true });
  await rm(privateHome, { recursive: true, force: true });
}
