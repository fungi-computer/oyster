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
        OYSTER_AGENT_MODEL: "@fungi/luna",
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
} finally {
  if (child) {
    child.kill("SIGTERM");
    await stopped;
  }
  await rm(work, { recursive: true, force: true });
}
