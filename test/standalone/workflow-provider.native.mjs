import process from "node:process";
import { log, error } from "node:console";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { parse as parseJsonc } from "jsonc-parser";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { sha256 } from "@fungi.computer/oyster/host";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";
import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend as bonsaiBackend } from "../../../../apps/bonsai/backend/methods.ts";
import bonsaiMetadata from "../../../../apps/bonsai/package.json" with { type: "json" };
const bonsaiDeclaration = buildAppDeclaration(
  bonsaiBackend,
  bonsaiMetadata.fungi.app,
);

const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/workflows-native-`);
const config = parseJsonc(
  await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = `${root}test/standalone/workflows-root.fixture.ts`;
config.vars = {
  ...config.vars,
  WORKFLOW_CODE_LOCAL_DEV: process.env.CELLD_PLATFORM_CELLD ? "false" : "true",
};
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
const key = randomBytes(24).toString("hex");
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";
const provider = await workflowGitProvider();
const port = await new Promise((resolve) => {
  const socket = createServer().listen(0, "127.0.0.1", () => {
    const { port: free } = socket.address();
    socket.close(() => resolve(free));
  });
});
const origin = `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${key}` };
const worker = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    `${root}test/standalone/workflows-root.fixture.ts`,
    "--config",
    `${work}/wrangler.json`,
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
    `GIT_ORIGIN:${provider.origin}`,
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
let output = "";
worker.stdout.on("data", (chunk) => {
  output += chunk;
});
worker.stderr.on("data", (chunk) => {
  output += chunk;
});
const stopped = new Promise((resolve) => worker.once("exit", resolve));

async function call(installation, method, input) {
  const response = await globalThis.fetch(
    `${origin}/apps/${installation}/methods/${method}`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: globalThis.AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, `${installation}.${method}: ${text}`);
  return JSON.parse(text);
}
async function persist(value) {
  const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
  const digest = await sha256(bytes);
  const artifactRef = `artifact:sha256-${digest.slice(7)}`;
  const response = await globalThis.fetch(
    `${origin}/api/artifacts/${artifactRef}?digest=${digest}`,
    {
      method: "PUT",
      headers: auth,
      body: bytes,
    },
  );
  assert.equal(response.status, 204, await response.text());
  return { artifactRef, digest, byteLength: bytes.length, version: digest };
}
async function install(installationId, entry, exportName, declaration) {
  // These are digest-verified test Releases of the real backend source. App
  // publication tooling is not under test; Workflow publication below is.
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    write: false,
    minify: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*"],
    target: "es2022",
  });
  const backend = {
    ...(await persist({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName,
      code: bundled.outputFiles[0].text,
    })),
    mediaType: backendMediaType,
  };
  const artifact = await persist(createAppBuild(null, backend, declaration));
  const release = {
    appId: `app_${installationId}`,
    releaseId: `rel_${installationId}`,
    artifact: {
      artifactRef: artifact.artifactRef,
      artifactDigest: artifact.digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: artifact.digest,
        buildRecipeDigest: artifact.digest,
      },
    },
  };
  const response = await globalThis.fetch(`${origin}/api/installations`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ installationId, release }),
  });
  assert.equal(response.status, 201, await response.text());
}
async function until(read, accepts, label) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await delay(100);
  }
}
try {
  await until(
    async () =>
      globalThis
        .fetch(`${origin}/login`, {
          signal: globalThis.AbortSignal.timeout(1000),
        })
        .then(
          (r) => r.ok,
          () => false,
        ),
    (ready) => ready,
    "standalone root readiness",
  );
  await install(
    "bonsai",
    "../../../../apps/bonsai/backend/index.ts",
    "BonsaiApp",
    bonsaiDeclaration,
  );
  assert.deepEqual(await call("bonsai", "repos.list", {}), { repos: [] });
  const before = provider.requests.length;
  const created = await call("bonsai", "repos.create", {
    name: "pond",
    description: "Native provider proof",
  });
  assert.equal(created.name, "pond");
  assert.ok(
    provider.requests.length > before,
    "the native command path reaches the local provider",
  );
  const repos = await call("bonsai", "repos.list", {});
  assert.equal(repos.repos[0].name, "pond");
  log(
    `PASS ${runtime}: native Bonsai repos.create reaches local provider and persists its result`,
  );
} catch (cause) {
  error(output.replaceAll(key, "[redacted]"));
  error(provider.requests);
  throw cause;
} finally {
  worker.kill("SIGTERM");
  await stopped;
  await provider.close();
  await rm(work, { recursive: true, force: true });
}
