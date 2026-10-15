// Native R1 host-port proof: the real root alarm re-admits the retained member.
// The fixture persists an origin and observes the shared BACKGROUND port;
// it does not claim App Watchdog scheduling, Git steps, or Publisher qualification.
/* global URL, fetch, setTimeout, console, process, AbortSignal */
import { Buffer } from "node:buffer";
import { TextEncoder } from "node:util";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { installRelease } from "../dist/pack.js";
import { build } from "esbuild";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { parseRelease, sha256 } from "../dist/host.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRevision = `git:${execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim()}`;
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/background-`);
const key = randomBytes(24).toString("hex");
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// Build the real fixture methods locally; this is a host/binding proof, not a Publisher proof.
const backend = await build({
  entryPoints: [`${root}test/background-app/backend/index.ts`],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker", "browser"],
  target: "es2024",
  external: ["cloudflare:workers"],
  minify: true,
});
const declaration = await build({
  entryPoints: [`${root}test/background-app/backend/declaration.ts`],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2024",
});
const { appDeclaration } = await import(
  `data:text/javascript;base64,${Buffer.from(declaration.outputFiles[0].contents).toString("base64")}`
);
const ui = new TextEncoder().encode(
  "<!doctype html><title>Background proof</title>",
);
const bytes = new TextEncoder().encode(
  JSON.stringify({
    runtime: { kind: "durable-facet", stateSchema: 1 },
    compatibilityDate: "2026-09-04",
    exportName: "BackgroundProof",
    code: backend.outputFiles[0].text,
  }),
);
const app = createAppBuild(
  {
    artifactRef: "artifact:background-ui",
    digest: await sha256(ui),
    version: "1",
    byteLength: ui.byteLength,
    mediaType: "text/html; charset=utf-8",
  },
  {
    artifactRef: "artifact:background-backend",
    digest: await sha256(bytes),
    version: "1",
    byteLength: bytes.byteLength,
    mediaType: "application/vnd.fungi.app-backend+json",
  },
  appDeclaration,
);
const rootBytes = new TextEncoder().encode(JSON.stringify(app));
const release = parseRelease({
  appId: "app_notes",
  releaseId: "rel_background",
  artifact: {
    artifactRef: "artifact:background-root",
    artifactDigest: await sha256(rootBytes),
    provenance: {
      sourceRevision,
      sourceTreeDigest: await sha256(rootBytes),
      buildRecipeDigest: await sha256(bytes),
    },
  },
});
await mkdir(`${work}/release/artifacts`, { recursive: true });
await writeFile(`${work}/release/release.json`, JSON.stringify(release));
for (const [name, value] of [
  ["background-ui", ui],
  ["background-backend", bytes],
  ["background-root", rootBytes],
])
  await writeFile(`${work}/release/artifacts/${name}`, value);

// 2. Start the standalone Oyster.
const config = `${work}/wrangler.json`;
await writeFile(
  config,
  JSON.stringify({
    name: "oyster-background-proof",
    main: `${root}examples/standalone/worker.ts`,
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    worker_loaders: [{ binding: "LOADER" }],
    r2_buckets: [{ binding: "RELEASES", bucket_name: "oyster-releases" }],
    durable_objects: {
      bindings: [
        { name: "REGISTRY", class_name: "OysterRegistry" },
        { name: "INSTANCES", class_name: "OysterInstance" },
        { name: "MCP", class_name: "OysterMcp" },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["OysterRegistry", "OysterInstance", "OysterMcp"],
      },
    ],
  }),
);
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const wrangler = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    "--config",
    config,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    `${work}/state`,
    "--var",
    `OYSTER_OWNER_KEY:${key}`,
    "--var",
    `OYSTER_ORIGIN:${origin}`,
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
let output = "";
wrangler.stdout.on("data", (chunk) => (output += chunk));
wrangler.stderr.on("data", (chunk) => (output += chunk));
const stopped = new Promise((resolve) => wrangler.once("exit", resolve));

try {
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${origin}/login`).then(
      (response) => response.ok,
      (cause) => ({ notListening: cause }),
    );
    if (ready === true) break;
    if (attempt > 240)
      throw new Error(
        `Oyster did not start:\n${output.replaceAll(key, "[redacted]")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`standalone Oyster on ${runtime}: server ready`);
  const auth = { Authorization: `Bearer ${key}` };

  // 3. Refusals before install.
  assert.equal((await fetch(`${origin}/api/installations`)).status, 401);
  assert.equal(
    (
      await fetch(`${origin}/api/installations`, {
        headers: { Authorization: "Bearer wrong-key-wrong-key-wrong" },
      })
    ).status,
    401,
  );

  // 4. Install over HTTP.
  const installed = await installRelease({
    directory: `${work}/release`,
    url: origin,
    key,
    installationId: "notes",
  });
  assert.equal(installed.status, 201, await installed.clone().text());
  const installation = await installed.json();
  assert.equal(installation.status, "enabled");

  const call = async (name) => {
    const response = await fetch(`${origin}/apps/notes/methods/${name}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body);
  };
  assert.deepEqual(await call("enqueue"), { queued: true });
  let result;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    result = await call("status");
    if (result !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    result,
    `Alarm did not deliver the retained member: ${output.replaceAll(key, "[redacted]")}`,
  );
  assert.match(result.beforeRefusal, /revoked/u);
  assert.deepEqual(result.decision, { kind: "admitted" });
  assert.deepEqual(result.actor, { kind: "member", memberId: "owner" });
  assert.equal(result.role, "owner");
  assert.equal(result.foregroundLaneAbsent, true);
  assert.equal(result.foregroundOriginAbsent, true);
  assert.equal(result.catalogCount, 1);
  console.log(
    `R1 background host proof on ${runtime}: actual alarm + shared claimed-origin binding PASS`,
  );
} catch (cause) {
  console.error(output);
  throw cause;
} finally {
  wrangler.kill("SIGTERM");
  await stopped;
  await rm(work, { recursive: true, force: true });
}
