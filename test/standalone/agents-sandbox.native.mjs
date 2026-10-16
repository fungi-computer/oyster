// Real StandaloneAgent -> execute -> Worker Loader -> installed App methods.
// Run with node, or pinned celld through wrangler-on-celld.mjs. No provider.
/* global fetch, AbortSignal, setTimeout */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { installRelease, packRelease } from "@fungi.computer/oyster/pack";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const sourceRevision = `git:${execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim()}`;
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/agents-sandbox-`);
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";
const key = "local-sandbox-proof-owner";
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const { port } = socket.address();
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let child;
let stopped;
let output = "";

try {
  await packRelease({
    appId: "app_notes",
    releaseId: "rel_sandboxproof",
    sourceDirectory: repository,
    sourceRevision,
    packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    recipe: {
      entry: "packages/oyster/examples/notes-app/ui/index.html",
      assets: {
        maxManifestBytes: 1_048_576,
        maxObjects: 1024,
        maxObjectBytes: 16_777_216,
        maxTotalBytes: 67_108_864,
      },
      assetBase: "./",
      maxOutputBytes: 67_108_864,
      backend: {
        entry: "packages/oyster/examples/notes-app/backend/index.ts",
        exportName: "Notes",
        compatibilityDate: "2026-09-04",
        runtime: { kind: "durable-facet", stateSchema: 1 },
      },
    },
    outDirectory: `${work}/release`,
  });
  await writeFile(
    `${work}/wrangler.json`,
    JSON.stringify({
      name: "oyster-agent-sandbox-proof",
      main: `${root}test/standalone/agents-sandbox.fixture.ts`,
      compatibility_date: "2026-09-04",
      compatibility_flags: ["nodejs_compat"],
      worker_loaders: [{ binding: "LOADER" }],
      r2_buckets: [{ binding: "RELEASES", bucket_name: "sandbox-proof" }],
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
          { name: "INSTANCES", class_name: "OysterInstance" },
          { name: "AGENT_DIRECTORY", class_name: "AgentDirectory" },
          { name: "TENANTS", class_name: "StandaloneTenants" },
          { name: "KEYS", class_name: "OysterKeys" },
          { name: "AGENTS", class_name: "SandboxAgent" },
          { name: "PROBE", class_name: "SandboxAgent" },
          { name: "LUNA", class_name: "LunaAgent" },
        ],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: [
            "OysterRegistry",
            "OysterInstance",
            "SandboxAgent",
            "AgentDirectory",
            "StandaloneTenants",
            "OysterKeys",
            "LunaAgent",
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
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      // The root admits only its configured origin, as in production.
      "--local-upstream",
      "oyster.test",
      "--upstream-protocol",
      "https",
      "--persist-to",
      `${work}/state`,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
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
      throw new Error(
        `Oyster did not start:\n${output.replaceAll(key, "[redacted]")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const createSession = () =>
    fetch(`${origin}/luna/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requestId: "owner-luna-session" }),
    });
  const created = await createSession();
  assert.equal(created.status, 201, await created.clone().text());
  const session = await created.json();
  assert.deepEqual(await (await createSession()).json(), session);
  const read = await fetch(`${origin}/luna/sessions/${session.sessionId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(read.status, 200, await read.clone().text());
  assert.equal((await read.json()).messages.length, 0);
  console.log(
    `Luna owner Session create/replay/read on ${runtime}, no inference: PASS`,
  );
  const installed = await installRelease({
    directory: `${work}/release`,
    url: origin,
    key,
    installationId: "notes",
  });
  assert.equal(installed.status, 201, await installed.text());
  const response = await fetch(`${origin}/probe`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(
    response.status,
    200,
    (await response.clone().text()).replaceAll(key, "[redacted]"),
  );
  const { probe, policy, owner } = await response.json();
  const { terminal, results } = JSON.parse(probe);
  assert.equal(
    policy.grantedBy,
    owner.actor.memberId,
    "grantor comes from the seeded canonical owner membership",
  );
  assert.notEqual(policy.grantedBy, "owner");
  assert.ok(owner.membershipVersion > 0);
  assert.equal(policy.level, "write");
  assert.ok(policy.revision.length > 0);
  assert.equal(terminal.outcome, "completed");
  assert.equal(results.length, 1);
  assert.equal(results[0].toolName, "execute");
  assert.equal(results[0].isError, false, JSON.stringify(results[0].content));
  assert.deepEqual(results[0].content, [
    { type: "text", text: '{"text":"from the agent sandbox"}' },
  ]);
  const note = await fetch(`${origin}/apps/notes/methods/readNote`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(note.status, 200);
  assert.deepEqual(await note.json(), { text: "from the agent sandbox" });
  console.log(
    `Oyster agent sandbox on ${runtime}: real execute tool saved and read the installed App; PASS`,
  );
} finally {
  if (child) {
    child.kill("SIGTERM");
    await stopped;
  }
  await rm(work, { recursive: true, force: true });
}
