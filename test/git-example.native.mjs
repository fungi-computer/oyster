// Ordinary `git push` and `git clone` through the git root (test/git-root.fixture.ts) on workerd: owner
// key and named key sign in, the App's push policy refuses a non-member with
// Git's own `ng`, and the accepted push reaches the App's `onGitPush`.
/* global URL, fetch, setTimeout, console, process, AbortSignal */
import { Buffer } from "node:buffer";
import { TextEncoder } from "node:util";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { installRelease } from "../dist/pack.js";
import { parseRelease, sha256 } from "../dist/host.js";
import { artifactsProvider } from "./artifacts-provider.fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRevision = `git:${execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim()}`;
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/git-example-`);
const key = randomBytes(24).toString("hex");
const provider = await artifactsProvider();

async function freePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// 1. A real App Release: push policy, onGitPush and one read method.
const backend = await build({
  entryPoints: [`${root}test/git-app/backend/index.ts`],
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
  entryPoints: [`${root}test/git-app/backend/declaration.ts`],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2024",
});
const { appDeclaration } = await import(
  `data:text/javascript;base64,${Buffer.from(declaration.outputFiles[0].contents).toString("base64")}`
);
const ui = new TextEncoder().encode("<!doctype html><title>Git proof</title>");
const bytes = new TextEncoder().encode(
  JSON.stringify({
    runtime: { kind: "durable-facet", stateSchema: 1 },
    compatibilityDate: "2026-09-04",
    exportName: "GitProof",
    code: backend.outputFiles[0].text,
  }),
);
const app = createAppBuild(
  {
    artifactRef: "artifact:git-ui",
    digest: await sha256(ui),
    version: "1",
    byteLength: ui.byteLength,
    mediaType: "text/html; charset=utf-8",
  },
  {
    artifactRef: "artifact:git-backend",
    digest: await sha256(bytes),
    version: "1",
    byteLength: bytes.byteLength,
    mediaType: "application/vnd.fungi.app-backend+json",
  },
  appDeclaration,
);
const rootBytes = new TextEncoder().encode(JSON.stringify(app));
const release = parseRelease({
  appId: "app_gitdoor",
  releaseId: "rel_gitdoor",
  artifact: {
    artifactRef: "artifact:git-root",
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
  ["git-ui", ui],
  ["git-backend", bytes],
  ["git-root", rootBytes],
])
  await writeFile(`${work}/release/artifacts/${name}`, value);

// 2. The git root's bindings, with Artifacts on the local provider.
const classes = [
  "OysterMcp",
  "OysterRegistry",
  "OysterInstance",
  "OysterKeys",
  "OysterWebhooks",
];
const config = `${work}/wrangler.json`;
await writeFile(
  config,
  JSON.stringify({
    name: "oyster-git-door-proof",
    main: `${root}test/git-example.fixture.ts`,
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    worker_loaders: [{ binding: "LOADER" }],
    r2_buckets: [{ binding: "RELEASES", bucket_name: "oyster-releases" }],
    durable_objects: {
      bindings: [
        { name: "MCP", class_name: "OysterMcp" },
        { name: "REGISTRY", class_name: "OysterRegistry" },
        { name: "INSTANCES", class_name: "OysterInstance" },
        { name: "KEYS", class_name: "OysterKeys" },
        { name: "WEBHOOKS", class_name: "OysterWebhooks" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: classes }],
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
    "--var",
    `GIT_PROVIDER:${provider.origin}`,
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
let output = "";
wrangler.stdout.on("data", (chunk) => (output += chunk));
wrangler.stderr.on("data", (chunk) => (output += chunk));
const stopped = new Promise((resolve) => wrangler.once("exit", resolve));
const redact = (text) => text.replaceAll(key, "[redacted]");

const gitEnvironment = Object.fromEntries(
  Object.entries({ ...process.env, GIT_TERMINAL_PROMPT: "0" }).filter(
    ([name]) => !name.startsWith("GIT_TRACE") && name !== "GIT_CURL_VERBOSE",
  ),
);
// Async: the provider answers from this same process while git runs.
async function git(cwd, authorization, ...args) {
  const child = spawn(
    "git",
    [
      "-c",
      `http.extraHeader=Authorization: ${authorization}`,
      "-c",
      "user.name=Ada",
      "-c",
      "user.email=ada@example.test",
      ...args,
    ],
    { cwd, env: gitEnvironment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let text = "";
  child.stdout.on("data", (chunk) => (text += chunk));
  child.stderr.on("data", (chunk) => (text += chunk));
  const [status] = await once(child, "close");
  return { status, output: redact(text) };
}

try {
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${origin}/login`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (attempt > 240)
      throw new Error(`Oyster did not start:\n${redact(output)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const owner = `Bearer ${key}`;

  // 3. Install the App; its provider repository is `<installation>--<repo>`.
  const installed = await installRelease({
    directory: `${work}/release`,
    url: origin,
    key,
    installationId: "proof",
  });
  assert.equal(installed.status, 201, await installed.clone().text());
  provider.create("proof--pond");
  const remote = `${origin}/git/proof/pond.git`;

  // 4. Anonymous reads of a private installation are refused.
  const anonymous = await fetch(`${remote}/info/refs?service=git-upload-pack`);
  assert.equal(anonymous.status, 401);

  // 5. The owner pushes with ordinary git.
  const source = `${work}/source`;
  await mkdir(source);
  // The pack exceeds git's default 1 MiB http.postBuffer, so git sends a
  // lone-flush probe and then the pack as a chunked POST with no length.
  await writeFile(`${source}/pond.bin`, randomBytes(3 * 1024 * 1024));
  for (const args of [
    ["init", "--quiet", "--initial-branch=main"],
    ["add", "pond.bin"],
    ["commit", "--quiet", "-m", "Plant the pond"],
  ])
    assert.equal((await git(source, owner, ...args)).status, 0);
  const pushed = await git(source, owner, "push", remote, "main");
  assert.equal(pushed.status, 0, pushed.output);

  // 6. A named key is never a member: git push refuses it on its role alone,
  // whatever its own App grants are.
  const minted = await fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: { Authorization: owner, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "ada",
      grants: [{ capability: "apps.use", targets: { kind: "all" } }],
    }),
  });
  assert.equal(minted.status, 201);
  const { plaintext } = await minted.json();
  const agent = `Basic ${Buffer.from(`ada:${plaintext}`).toString("base64")}`;
  const agentCommit = await git(
    source,
    agent,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Agent",
  );
  assert.equal(agentCommit.status, 0);
  const refused = await git(source, agent, "push", remote, "main");
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /only members push here/u);

  // 7. Both keys clone the owner's accepted commit.
  for (const [name, authorization] of [
    ["owner", owner],
    ["agent", agent],
  ]) {
    const cloned = await git(
      work,
      authorization,
      "clone",
      "--quiet",
      remote,
      name,
    );
    assert.equal(cloned.status, 0, cloned.output);
    assert.equal(
      (
        await git(`${work}/${name}`, authorization, "log", "-1", "--format=%s")
      ).output.trim(),
      "Plant the pond",
    );
  }

  // 8. The accepted push reaches the App's onGitPush exactly once.
  let pushes = [];
  for (let attempt = 0; attempt < 120 && pushes.length === 0; attempt += 1) {
    const response = await fetch(`${origin}/apps/proof/methods/pushes`, {
      method: "POST",
      headers: { Authorization: owner, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    pushes = await response.json();
    if (pushes.length === 0) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].repository, "pond");
  assert.deepEqual(pushes[0].refs, ["refs/heads/main"]);
  console.log(
    "PASS git root on workerd: owner git push, agent push refused by App policy, clone, onGitPush delivered",
  );
} catch (cause) {
  console.error(redact(output));
  throw cause;
} finally {
  wrangler.kill("SIGTERM");
  await stopped;
  await provider.close();
  await rm(work, { recursive: true, force: true });
}
