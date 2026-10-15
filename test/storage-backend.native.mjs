// Real standalone storage proof: bundle the SDK fixture, install its Release
// over HTTP, and call declared methods through the native frame into the same
// storage owner and watch stream as the UI. No Publisher or browser proof.
/* global URL, fetch, setTimeout, console, process, AbortController, AbortSignal */
import { Buffer } from "node:buffer";
import { TextEncoder, TextDecoder } from "node:util";
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
const work = await mkdtemp(`${root}.botanical/standalone-`);
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
  entryPoints: [`${root}test/storage-app/backend/index.ts`],
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
  entryPoints: [`${root}test/storage-app/backend/declaration.ts`],
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
  "<!doctype html><title>Storage proof</title>",
);
const bytes = new TextEncoder().encode(
  JSON.stringify({
    runtime: { kind: "durable-facet", stateSchema: 1 },
    compatibilityDate: "2026-09-04",
    exportName: "StorageProof",
    code: backend.outputFiles[0].text,
  }),
);
const app = createAppBuild(
  {
    artifactRef: "artifact:storage-ui",
    digest: await sha256(ui),
    version: "1",
    byteLength: ui.byteLength,
    mediaType: "text/html; charset=utf-8",
  },
  {
    artifactRef: "artifact:storage-backend",
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
  releaseId: "rel_storage",
  artifact: {
    artifactRef: "artifact:storage-root",
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
  ["storage-ui", ui],
  ["storage-backend", bytes],
  ["storage-root", rootBytes],
])
  await writeFile(`${work}/release/artifacts/${name}`, value);

// 2. Start the standalone Oyster.
const config = `${work}/wrangler.json`;
await writeFile(
  config,
  JSON.stringify({
    name: "oyster-storage-proof",
    main: `${root}test/storage-worker.fixture.ts`,
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    worker_loaders: [{ binding: "LOADER" }],
    r2_buckets: [{ binding: "RELEASES", bucket_name: "oyster-releases" }],
    durable_objects: {
      bindings: [
        { name: "REGISTRY", class_name: "OysterRegistry" },
        { name: "INSTANCES", class_name: "OysterInstance" },
        { name: "AGENT_DIRECTORY", class_name: "StorageAgentDirectory" },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: [
          "OysterRegistry",
          "OysterInstance",
          "StorageAgentDirectory",
        ],
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

  const call = async (name, input, fixture, agentId) => {
    const headers = { ...auth, "Content-Type": "application/json" };
    if (fixture !== undefined) headers["X-Storage-Fixture"] = fixture;
    if (agentId !== undefined) headers["X-Storage-Agent"] = agentId;
    const response = await fetch(`${origin}/apps/notes/methods/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body);
  };
  const unapproved = await fetch(`${origin}/apps/notes/methods/read`, {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json",
      "X-Storage-Agent": "no-policy-agent",
    },
    body: "{}",
  });
  assert.equal(unapproved.status, 403);
  assert.deepEqual(await unapproved.json(), { error: "not_approved" });
  const initial = await call("read", {});
  assert.equal(initial.kind, "accepted");
  assert.equal(initial.value.source, "none");
  assert.equal(initial.value.canWriteTeam, true);
  for (const actor of ["member", "agent", "key"])
    for (const [name, input] of [
      ["read", {}],
      ["write", { basedOn: null, value: { layout: "not-owner" } }],
      ["reset", { basedOn: null }],
    ])
      assert.deepEqual(await call(name, input, actor), {
        kind: "rejected",
        code: "owner_required",
      });
  assert.equal((await call("read", {})).value.source, "none");
  const seeded = await fetch(`${origin}/__storage_fixture/agents`, {
    headers: auth,
  });
  assert.equal(seeded.status, 200);
  const agents = await seeded.json();
  assert.equal(
    (await call("read", {}, undefined, agents.owned)).kind,
    "accepted",
  );
  assert.deepEqual(
    await call(
      "write",
      { basedOn: null, value: { layout: "Owner Agent" } },
      undefined,
      agents.owned,
    ),
    { kind: "accepted", value: { revision: 1 } },
  );
  assert.deepEqual(
    (await call("read", {}, undefined, agents.owned)).value.value,
    { layout: "Owner Agent" },
  );
  for (const agentId of [agents.foreign, agents.missing])
    for (const [name, input] of [
      ["read", {}],
      ["write", { basedOn: 1, value: { layout: "forbidden" } }],
      ["reset", { basedOn: 1 }],
    ])
      assert.deepEqual(await call(name, input, undefined, agentId), {
        kind: "rejected",
        code: "owner_required",
      });
  assert.deepEqual((await call("read", {})).value.value, {
    layout: "Owner Agent",
  });
  assert.equal(
    (await call("reset", { basedOn: 1 }, undefined, agents.owned)).kind,
    "accepted",
  );
  const readonlyAttempt = await fetch(
    `${origin}/apps/notes/methods/tryWriteFromRead`,
    {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        "X-Storage-Agent": agents.owned,
      },
      body: "{}",
    },
  );
  assert.equal(
    readonlyAttempt.status,
    502,
    "a read method must not obtain a write binding",
  );
  assert.equal(
    (await call("read", {}, undefined, agents.owned)).value.source,
    "none",
  );
  const catalog = await call("catalog", {}, undefined, agents.owned);
  assert.equal(catalog.apps.length, 1);
  assert.equal(catalog.apps[0].appId, "app_notes");
  assert.equal(catalog.apps[0].surfaceId, "installation:notes");
  assert.deepEqual(catalog.apps[0].gills, [
    { id: "inbox", title: "Inbox", desktop: { sizes: ["S", "M"] } },
  ]);
  assert.deepEqual(catalog.roles, {});
  const watchAbort = new AbortController();
  const watch = await fetch(
    `${origin}/api/workbench/storage/notes/events?key=desktop`,
    {
      headers: auth,
      signal: AbortSignal.any([watchAbort.signal, AbortSignal.timeout(10000)]),
    },
  );
  assert.equal(watch.status, 200);
  const notices = watch.body.getReader();
  assert.match(
    new TextDecoder().decode((await notices.read()).value),
    /event: ready/,
  );
  const written = await call("write", {
    basedOn: null,
    value: { layout: "from backend" },
  });
  assert.equal(written.kind, "accepted");
  assert.match(
    new TextDecoder().decode((await notices.read()).value),
    /event: changed/,
  );
  watchAbort.abort();
  await notices.cancel().catch((cause) => {
    if (cause.name !== "AbortError") throw cause;
  });
  const read = await call("read", {});
  assert.equal(read.value.source, "team");
  assert.deepEqual(read.value.value, { layout: "from backend" });
  assert.deepEqual(
    await call("write", { basedOn: null, value: { layout: "stale" } }),
    { kind: "rejected", code: "conflict" },
  );
  assert.deepEqual((await call("read", {})).value.value, {
    layout: "from backend",
  });
  assert.equal(
    (await call("reset", { basedOn: written.value.revision })).kind,
    "accepted",
  );
  assert.equal((await call("read", {})).value.source, "none");
  console.log(
    `PASS standalone backend APP_STORAGE read/write/reset/CAS on ${runtime}`,
  );
} catch (cause) {
  console.error(output);
  throw cause;
} finally {
  wrangler.kill("SIGTERM");
  await stopped;
  await rm(work, { recursive: true, force: true });
}
