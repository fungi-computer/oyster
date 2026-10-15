// Stale-row reinstall proof on the native runtime: an owner deletes a stale
// registry row and reinstalls the same installationId. APP_STORAGE rows and the
// Artifacts repository prefix reconnect; a frame still live in the OLD Instance
// is refused by the per-binding registry re-check. Facet SQLite does not
// survive: the reinstall mints a new instanceId (accepted loss, D1).
/* global URL, fetch, setTimeout, console, process */
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
import { defaultTenant, tenantScope } from "../dist/tenant.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRevision = `git:${execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim()}`;
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/reinstall-`);
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

// 1. Build the storage fixture App Release.
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
const ui = new TextEncoder().encode("<!doctype html><title>Reinstall</title>");
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

// 2. Start the standalone Oyster with the stale-row fixture registry.
const config = `${work}/wrangler.json`;
await writeFile(
  config,
  JSON.stringify({
    name: "oyster-reinstall-proof",
    main: `${root}test/reinstall-worker.fixture.ts`,
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    worker_loaders: [{ binding: "LOADER" }],
    r2_buckets: [{ binding: "RELEASES", bucket_name: "oyster-releases" }],
    durable_objects: {
      bindings: [
        { name: "REGISTRY", class_name: "OysterRegistry" },
        { name: "STALE_ROWS", class_name: "OysterRegistry" },
        { name: "INSTANCES", class_name: "OysterInstance" },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["OysterRegistry", "OysterInstance"],
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
  const install = async () => {
    const response = await installRelease({
      directory: `${work}/release`,
      url: origin,
      key,
      installationId: "notes",
    });
    assert.equal(response.status, 201, await response.clone().text());
    const installation = await response.json();
    assert.equal(installation.status, "enabled");
    return installation;
  };
  const call = async (name, input) => {
    const response = await fetch(`${origin}/apps/notes/methods/${name}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body);
  };

  // 3. First installation writes host-owned APP_STORAGE.
  const first = await install();
  assert.deepEqual(
    await call("write", {
      basedOn: null,
      value: { layout: "before reinstall" },
    }),
    { kind: "accepted", value: { revision: 1 } },
  );

  // 4. A frame stays live in the OLD Instance across the stale delete and reinstall.
  const held = call("holdThenWrite", {
    holdMs: 10000,
    basedOn: 1,
    value: { layout: "old Instance" },
  }).then(
    (value) => ({ value, settledAt: Date.now() }),
    (failure) => ({ failure }),
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // 5. Reproduce an undecodable pre-release row; the owner removes it by id.
  const staled = await fetch(`${origin}/__reinstall_fixture/stale/notes`, {
    headers: auth,
  });
  assert.equal(staled.status, 200);
  assert.deepEqual(await staled.json(), { rowsWritten: 1 });
  const listed = await fetch(`${origin}/api/installations`, { headers: auth });
  assert.deepEqual(await listed.json(), [
    { kind: "refused", code: "installation_stale", installationId: "notes" },
  ]);
  const deleted = await fetch(`${origin}/api/installations/notes`, {
    method: "DELETE",
    headers: auth,
  });
  assert.equal(deleted.status, 204, await deleted.text());

  // 6. Reinstall under the SAME installationId: a fresh Instance, same storage address.
  const second = await install();
  const reinstalledAt = Date.now();
  assert.equal(second.installationId, first.installationId);
  // Same Release and authority version: only the instanceId check can fence the old frame.
  assert.equal(second.authorityVersion, first.authorityVersion);
  assert.equal(second.release.releaseId, first.release.releaseId);
  assert.notEqual(
    second.instanceId,
    first.instanceId,
    "reinstall mints a new instanceId, so facet SQLite starts empty",
  );
  const reconnected = await call("read", {});
  assert.equal(reconnected.kind, "accepted");
  assert.equal(reconnected.value.source, "team");
  assert.equal(reconnected.value.team?.revision, 1);
  assert.deepEqual(reconnected.value.value, { layout: "before reinstall" });
  const prefix = tenantScope(defaultTenant, origin).repositoryPrefix;
  assert.equal(prefix(second.installationId), prefix(first.installationId));
  assert.equal(prefix(second.installationId), "notes--");
  console.log(
    `PASS reconnect: APP_STORAGE revision 1 and repository prefix notes-- survive stale delete + same-id reinstall on ${runtime}`,
  );

  // 7. The OLD Instance's live frame cannot act once the registry names the new Instance.
  const outcome = await held;
  if ("failure" in outcome) throw outcome.failure;
  assert.deepEqual(outcome.value, { refused: "revoked" });
  assert.ok(
    outcome.settledAt > reinstalledAt,
    "the old frame's write ran after the reinstall",
  );
  const after = await call("read", {});
  assert.equal(after.value.team?.revision, 1);
  assert.deepEqual(after.value.value, { layout: "before reinstall" });
  assert.deepEqual(
    await call("write", { basedOn: 1, value: { layout: "new Instance" } }),
    { kind: "accepted", value: { revision: 2 } },
  );
  console.log(
    `PASS fence: old Instance ${first.instanceId} binding refused (revoked); new Instance ${second.instanceId} owns APP_STORAGE on ${runtime}`,
  );
} catch (cause) {
  console.error(output.replaceAll(key, "[redacted]"));
  throw cause;
} finally {
  wrangler.kill("SIGTERM");
  await stopped;
  await rm(work, { recursive: true, force: true });
}
