import process from "node:process";
import { existsSync } from "node:fs";
import * as Schema from "effect/Schema";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { log, error } from "node:console";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseJsonc } from "jsonc-parser";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";
import { packRelease, installRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";

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
async function installWorkflows() {
  const repository = fileURLToPath(new URL("../../../../", import.meta.url));
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const app = standaloneAppSet.find(
    (candidate) => candidate.installationId === "trellis",
  );
  assert.ok(app);
  const directory = `${root}.botanical/workflows-copy-release/${revision}`;
  if (!existsSync(`${directory}/release.json`))
    await packRelease({
      appId: app.appId,
      sourceDirectory: repository,
      sourceRevision: `git:${revision}`,
      packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      recipe: app.recipe,
      outDirectory: directory,
    });
  const release = Schema.decodeUnknownSync(
    Schema.fromJsonString(releaseSchema),
  )(await readFile(`${directory}/release.json`, "utf8"));
  assert.equal(release.artifact.provenance.sourceRevision, `git:${revision}`);
  const response = await installRelease({
    directory,
    url: origin,
    key,
    installationId: "trellis",
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
  await installWorkflows();
  const draft = {
    definition: {
      format: "fungi.workflow/v1",
      title: "Native saved copy",
      apps: {},
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [],
      edges: [],
      output: {},
    },
    layout: {},
  };
  const saved = await call("trellis", "saveDraft", {
    workflowId: "pond",
    expectedRevision: 0,
    draft,
  });
  assert.equal(saved.kind, "saved");
  const published = await call("trellis", "publishWorkflow", {
    workflowId: "pond",
    expectedRevision: saved.revision,
  });
  assert.equal(published.kind, "published");
  await delay(1500);
  // Force the counted native RPC path even though the saved screen copies exist.
  let cursor = null;
  for (let page = 0; ; page++) {
    assert.ok(page < 1024, "foreground reconstruction remains bounded");
    const rebuilt = await call("trellis", "rebuildCopies", { cursor });
    if (rebuilt.done) break;
    cursor = rebuilt.cursor;
  }
  const before = provider.requests.length;
  for (let repeat = 0; repeat < 2; repeat++) {
    const document = await call("trellis", "loadWorkflow", {
      workflowId: "pond",
      at: "draft",
    });
    assert.equal(document.definition.title, draft.definition.title);
    const versions = await call("trellis", "listVersions", {
      workflowId: "pond",
    });
    assert.equal(versions.length, 1);
    const listings = await call("trellis", "listWorkflows", { limit: 100 });
    assert.equal(listings.items.length, 1);
    assert.equal(listings.items[0].title, draft.definition.title);
  }
  assert.equal(
    provider.requests.length - before,
    0,
    "warm screens make zero provider calls across native facets",
  );
  log(
    `PASS saved Workflows ${runtime}: native Loader, durable SQLite, warm document/versions/list provider calls 0`,
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
