// A standalone Oyster's Agent browses a real page through its own Workers
// BROWSER binding: StandaloneAgent -> execute -> cloudBrowser -> Browser
// Rendering. Only the model is deterministic. Needs a real Cloudflare account
// for the remote binding: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a
// token with Browser Rendering Edit). Without them this proof fails; it never
// reports a pass it did not run.
/* global fetch, AbortSignal, setTimeout */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import console from "node:console";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken)
  throw new Error(
    "The agent browser proof needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for the remote BROWSER binding",
  );
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/agent-browser-`);
const key = "local-browser-proof-owner-key";
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const { port } = socket.address();
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let child;
let stopped;
let output = "";
const redact = (text) =>
  text
    .replaceAll(key, "[redacted]")
    .replaceAll(apiToken, "[redacted]")
    .replaceAll(accountId, "[account]");

try {
  await writeFile(
    `${work}/wrangler.json`,
    JSON.stringify({
      name: "oyster-agent-browser-proof",
      main: `${root}test/standalone/agent-browser.fixture.ts`,
      compatibility_date: "2026-09-04",
      compatibility_flags: ["nodejs_compat"],
      account_id: accountId,
      browser: { binding: "BROWSER", remote: true },
      worker_loaders: [{ binding: "LOADER" }],
      r2_buckets: [{ binding: "RELEASES", bucket_name: "browser-proof" }],
      vars: {
        OYSTER_OWNER_KEY: key,
        OYSTER_ORIGIN: "https://oyster.test",
        OYSTER_COMPUTER_ID: "agent-workspace",
        AI_GATEWAY_AUTH_TOKEN: "fixture-not-a-provider-credential",
        AI_GATEWAY_ACCOUNT_ID: "fixture-account",
        AI_GATEWAY_ID: "fixture-gateway",
      },
      durable_objects: {
        bindings: [
          { name: "REGISTRY", class_name: "OysterRegistry" },
          { name: "INSTANCES", class_name: "StandaloneInstance" },
          { name: "AGENT_DIRECTORY", class_name: "AgentDirectory" },
          { name: "TENANTS", class_name: "StandaloneTenants" },
          { name: "KEYS", class_name: "OysterKeys" },
          { name: "AGENTS", class_name: "BrowserAgent" },
          { name: "PROBE", class_name: "BrowserAgent" },
        ],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: [
            "OysterRegistry",
            "StandaloneInstance",
            "BrowserAgent",
            "AgentDirectory",
            "StandaloneTenants",
            "OysterKeys",
          ],
        },
      ],
    }),
  );
  child = spawn(
    `${root}node_modules/.bin/wrangler`,
    [
      "dev",
      "--config",
      `${work}/wrangler.json`,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--local-upstream",
      "oyster.test",
      "--upstream-protocol",
      "https",
      "--persist-to",
      `${work}/state`,
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      // Disposable home: the binding authenticates only by the token above.
      env: {
        PATH: process.env.PATH,
        HOME: work,
        XDG_CONFIG_HOME: `${work}/config`,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: apiToken,
      },
    },
  );
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  stopped = new Promise((resolve) => child.once("exit", resolve));
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${origin}/login`, {
      signal: AbortSignal.timeout(1_000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (
      child.exitCode !== null ||
      output.includes("Build failed") ||
      attempt >= 120
    )
      throw new Error(`Oyster did not start:\n${redact(output)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const response = await fetch(`${origin}/probe`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  assert.equal(response.status, 200, redact(body));
  const { terminal, results } = JSON.parse(JSON.parse(body).probe);
  assert.equal(terminal.outcome, "completed");
  assert.equal(results.length, 1);
  assert.equal(results[0].toolName, "execute");
  assert.equal(results[0].isError, false, JSON.stringify(results[0].content));
  const browsed = JSON.parse(results[0].content[0].text);
  // Egress policy runs inside the module on this host too.
  assert.match(browsed.refused, /not a public address/);
  assert.match(browsed.leaseId, /^lease_/);
  assert.match(browsed.url, /^https:\/\/example\.com\/?$/);
  assert.match(browsed.tree, /Example Domain/);
  assert.equal(browsed.closed, true);
  // A BROWSER binding has no Quick Reads; the tool does not offer them.
  assert.equal(browsed.quickReads, "undefined");
  console.log(
    "Standalone Oyster Agent browsed a real page through its BROWSER binding: PASS",
  );

  // The "needs you" handoff: the Agent pauses the lease and gets a live view
  // for the person; the owner views, clicks, types and presses Done.
  const owner = { Authorization: `Bearer ${key}` };
  const handoffResponse = await fetch(`${origin}/probe/handoff`, {
    headers: owner,
    signal: AbortSignal.timeout(120_000),
  });
  const handoffBody = await handoffResponse.text();
  assert.equal(handoffResponse.status, 200, redact(handoffBody));
  const handoffRun = JSON.parse(JSON.parse(handoffBody).probe);
  const { agentId } = JSON.parse(handoffBody);
  assert.equal(handoffRun.terminal.outcome, "completed");
  const [handoffResult] = handoffRun.results;
  assert.equal(
    handoffResult.isError,
    false,
    JSON.stringify(handoffResult.content),
  );
  const handoff = JSON.parse(handoffResult.content[0].text);
  assert.match(handoff.leaseId, /^lease_/);
  const viewPath = `/agents/${agentId}/cloud-browser/${handoff.leaseId}`;
  // Paused, not handed to a channel: the Agent gets the host's view path.
  assert.deepEqual(handoff.handed, { paused: true, view: `${viewPath}/view` });
  // A drive on the paused lease is refused and says what to do.
  assert.match(handoff.whilePaused, /press Done/);

  const view = (path, init = {}, headers = owner) =>
    fetch(`${origin}${viewPath}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      signal: AbortSignal.timeout(60_000),
    });
  const input = (body, headers) =>
    view(
      "/input",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      headers,
    );
  // Anonymous and foreign callers are refused on every view route.
  for (const headers of [{}, { Authorization: "Bearer not-the-owner-key" }]) {
    for (const response of [
      await view("/view", {}, headers),
      await view("/frame", {}, headers),
      await input({ kind: "click", x: 1, y: 1 }, headers),
    ])
      assert.ok(
        response.status === 401 || response.status === 403,
        `view route admitted a non-owner (${String(response.status)})`,
      );
  }
  const page = await view("/view");
  const html = await page.text();
  assert.equal(page.status, 200, redact(html));
  assert.match(html, /Cloud browser/);
  assert.doesNotMatch(html, new RegExp(key));
  const frame = await view("/frame");
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get("content-type"), "image/png");
  const png = new Uint8Array(await frame.arrayBuffer());
  assert.deepEqual(Array.from(png.slice(1, 4)), [80, 78, 71]);
  assert.equal((await input({ kind: "click", x: 20, y: 20 })).status, 200);
  assert.equal((await input({ kind: "type", text: "hello" })).status, 200);
  assert.equal((await input({ kind: "eval", code: "1" })).status, 400);
  // Done resumes the lease, and the Agent's next drive succeeds.
  assert.equal((await input({ kind: "resume" })).status, 200);
  const driveResponse = await fetch(
    `${origin}/probe/drive?agentId=${encodeURIComponent(agentId)}&leaseId=${encodeURIComponent(handoff.leaseId)}`,
    { headers: owner, signal: AbortSignal.timeout(120_000) },
  );
  const driveBody = await driveResponse.text();
  assert.equal(driveResponse.status, 200, redact(driveBody));
  const driven = JSON.parse(JSON.parse(driveBody).probe);
  assert.equal(driven.terminal.outcome, "completed");
  assert.equal(driven.results[0].isError, false);
  const after = JSON.parse(driven.results[0].content[0].text);
  assert.match(after.tree, /Example Domain/);
  assert.equal(after.closed, true);
  console.log(
    "Standalone Oyster Agent handed a page to its owner and resumed it: PASS",
  );
} finally {
  if (child) {
    child.kill("SIGTERM");
    await stopped;
  }
  await rm(work, { recursive: true, force: true });
}
