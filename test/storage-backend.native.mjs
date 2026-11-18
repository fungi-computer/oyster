// Real standalone storage proof: bundle the SDK fixture, install its Release
// over HTTP, and call declared methods through the native frame into the same
// storage owner and watch stream as the UI. No Publisher or browser proof.
/* global URL, fetch, setTimeout, console, process, AbortController, AbortSignal, WebSocket */
import { Buffer } from "node:buffer";
import { TextEncoder, TextDecoder } from "node:util";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  launchIsolatedChromium,
  portsOf,
} from "../../../tooling/proof-runner/isolated-chromium.mjs";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { installRelease } from "../dist/pack.js";
import { build } from "esbuild";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { parseRelease, sha256 } from "../dist/host.js";
import { grantDeclaredAppCapabilities } from "./standalone/owner-grants.fixture.mjs";

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

// The neutral Region App: one durable counter, one timed wake, its callers.
const regionBackend = await build({
  entryPoints: [`${root}test/region-app/backend/index.ts`],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker", "browser"],
  target: "es2024",
  external: ["cloudflare:workers"],
  minify: true,
});
const regionDeclarationBuild = await build({
  entryPoints: [`${root}test/region-app/backend/declaration.ts`],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2024",
});
const { appDeclaration: regionDeclaration } = await import(
  `data:text/javascript;base64,${Buffer.from(regionDeclarationBuild.outputFiles[0].contents).toString("base64")}`
);
const regionBytes = new TextEncoder().encode(
  JSON.stringify({
    runtime: { kind: "region", stateSchema: 1 },
    compatibilityDate: "2026-09-04",
    exportName: "RegionProof",
    code: regionBackend.outputFiles[0].text,
  }),
);
// Its UI connects through Agar's appRegion; the host page holds the socket.
const regionScript = await build({
  entryPoints: [`${root}test/region-app/ui/main.ts`],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2024",
  minify: true,
});
const regionUi = new TextEncoder().encode(
  (await readFile(`${root}test/region-app/ui/index.html`, "utf8")) +
    `<script type="module">${regionScript.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`,
);
const regionRootBytes = new TextEncoder().encode(
  JSON.stringify(
    createAppBuild(
      {
        artifactRef: "artifact:region-ui",
        digest: await sha256(regionUi),
        version: "1",
        byteLength: regionUi.byteLength,
        mediaType: "text/html; charset=utf-8",
      },
      {
        artifactRef: "artifact:region-backend",
        digest: await sha256(regionBytes),
        version: "1",
        byteLength: regionBytes.byteLength,
        mediaType: "application/vnd.fungi.app-backend+json",
      },
      regionDeclaration,
    ),
  ),
);
await mkdir(`${work}/region-release/artifacts`, { recursive: true });
await writeFile(
  `${work}/region-release/release.json`,
  JSON.stringify(
    parseRelease({
      appId: "app_region",
      releaseId: "rel_region",
      artifact: {
        artifactRef: "artifact:region-root",
        artifactDigest: await sha256(regionRootBytes),
        provenance: {
          sourceRevision,
          sourceTreeDigest: await sha256(regionRootBytes),
          buildRecipeDigest: await sha256(regionBytes),
        },
      },
    }),
  ),
);
for (const [name, value] of [
  ["region-ui", regionUi],
  ["region-backend", regionBytes],
  ["region-root", regionRootBytes],
])
  await writeFile(`${work}/region-release/artifacts/${name}`, value);

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
let output = "";
/** One wrangler process over the same persisted state; a restart replaces every runtime. */
function startOyster() {
  const child = spawn(
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
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  return {
    child,
    stopped: new Promise((resolve) => child.once("exit", resolve)),
  };
}
async function waitReady() {
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${origin}/login`).then(
      (response) => response.ok,
      (cause) => ({ notListening: cause }),
    );
    if (ready === true) return;
    if (attempt > 240)
      throw new Error(
        `Oyster did not start:\n${output.replaceAll(key, "[redacted]")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
let oyster = startOyster();

try {
  await waitReady();
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
  await grantDeclaredAppCapabilities({
    origin,
    installationId: "notes",
    headers: auth,
  });

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
  const nonOwnerCalls = [
    ["read", {}],
    ["write", { basedOn: null, value: { layout: "not-owner" } }],
    ["reset", { basedOn: null }],
  ];
  for (const actor of ["member", "agent"])
    for (const [name, input] of nonOwnerCalls)
      assert.deepEqual(await call(name, input, actor), {
        kind: "rejected",
        code: "owner_required",
      });
  // A key's App access is its live Ear Tag grants; this fixture key has none,
  // so the App gate refuses it before the storage owner law is reached.
  for (const [name, input] of nonOwnerCalls) {
    const refused = await fetch(`${origin}/apps/notes/methods/${name}`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        "X-Storage-Fixture": "key",
      },
      body: JSON.stringify(input),
    });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "not_approved" });
  }
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
    {
      view: "rows",
      id: "inbox",
      title: "Inbox",
      desktop: { sizes: ["S", "M"] },
    },
  ]);
  assert.deepEqual(catalog.roles, {
    inbox: { surfaceId: null, chosen: false },
  });
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

  // 5. A neutral Region App keeps its Region alive through native sockets
  // and a native alarm, across a browser close and a runtime restart.
  const regionInstalled = await installRelease({
    directory: `${work}/region-release`,
    url: origin,
    key,
    installationId: "region",
  });
  assert.equal(
    regionInstalled.status,
    201,
    await regionInstalled.clone().text(),
  );
  const regionPath = (installationId) => `/apps/${installationId}/region`;
  /** The upgrade's HTTP answer: 101 when the socket opens, else its refusal. */
  const upgradeStatus = (path, headers) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}${path}`, {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          ...headers,
        },
      });
      request.on("upgrade", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode);
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end();
    });
  const connect = (installationId, headers = auth) => {
    const socket = new WebSocket(
      `${origin.replace("http", "ws")}${regionPath(installationId)}`,
      { headers },
    );
    const frames = [];
    let arrived = () => undefined;
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(event.data));
      arrived();
    });
    const closed = new Promise((resolve) =>
      socket.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason }),
      ),
    );
    const opened = new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });
    const next = async () => {
      const deadline = Date.now() + 15_000;
      while (frames.length === 0) {
        if (Date.now() > deadline) throw new Error("No Region frame");
        await new Promise((resolve) => {
          arrived = resolve;
          setTimeout(resolve, 250);
        });
      }
      return frames.shift();
    };
    const send = (command) => socket.send(JSON.stringify(command));
    return { socket, opened, closed, next, send };
  };
  const regionStatus = async (installationId) => {
    const response = await fetch(
      `${origin}/apps/${installationId}/methods/status`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body);
  };
  let negatives = 0;
  // Absent admission, a wrong key and a bearer the browser kept elsewhere
  // (subprotocol or query) never open a Region socket.
  for (const [path, headers] of [
    [regionPath("region"), {}],
    [
      regionPath("region"),
      { Authorization: "Bearer wrong-key-wrong-key-wrong" },
    ],
    [regionPath("region"), { "Sec-WebSocket-Protocol": `bearer.${key}` }],
    [`${regionPath("region")}?token=${key}`, {}],
  ]) {
    assert.equal(await upgradeStatus(path, headers), 401);
    negatives += 1;
  }
  // An admitted session cannot be ridden by a cross-site page.
  assert.equal(
    await upgradeStatus(regionPath("region"), {
      ...auth,
      Origin: "https://attacker.example",
    }),
    403,
  );
  negatives += 1;
  // A durable-facet Release has no Region, even for its admitted owner.
  assert.equal(await upgradeStatus(regionPath("notes"), auth), 403);
  negatives += 1;

  const first = connect("region", {
    ...auth,
    "X-Agar-Tenant": "foreign",
    "X-Agar-Team-Id": "team_foreign",
    "X-Agar-Actor-Id": "forged-actor",
  });
  await first.opened;
  const hello = await first.next();
  assert.equal(hello.callers.length, 1);
  // The scope is the host's tenant pin; no header named it.
  assert.deepEqual(hello.callers[0].scope, {
    kind: "standalone",
    tenant: "default",
  });
  assert.equal(hello.callers[0].actor.kind, "member");
  assert.equal(hello.callers[0].computerId, null);
  assert.notEqual(hello.callers[0].actor.memberId, "forged-actor");
  negatives += 1;
  first.send({ kind: "increment" });
  assert.equal((await first.next()).counter, 1);
  first.send({ kind: "arm", afterMs: 1500 });
  await first.next();
  first.socket.close(1000, "browser closed");
  await first.closed;
  // No client is attached: only the native alarm can advance the counter.
  let afterClose;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    afterClose = await regionStatus("region");
    if (afterClose.ticks > 0) break;
  }
  assert.deepEqual(
    { counter: afterClose.counter, ticks: afterClose.ticks },
    { counter: 2, ticks: 1 },
  );

  // Replace every runtime over the same persisted state, then re-admit.
  oyster.child.kill("SIGTERM");
  await oyster.stopped;
  oyster = startOyster();
  await waitReady();
  const second = connect("region");
  await second.opened;
  const resumed = await second.next();
  assert.equal(resumed.counter, 2);
  assert.equal(resumed.ticks, 1);
  assert.equal(resumed.callers.length, 2);

  // Another Installation of the same Release has its own Region.
  const otherInstalled = await installRelease({
    directory: `${work}/region-release`,
    url: origin,
    key,
    installationId: "region-two",
  });
  assert.equal(otherInstalled.status, 201, await otherInstalled.clone().text());
  const other = connect("region-two");
  await other.opened;
  const otherHello = await other.next();
  assert.deepEqual(
    { counter: otherHello.counter, ticks: otherHello.ticks },
    { counter: 0, ticks: 0 },
  );
  negatives += 1;
  other.socket.close(1000, "done");

  // Removing that Installation closes its socket and fences its wake.
  const doomed = connect("region-two");
  await doomed.opened;
  await doomed.next();
  doomed.send({ kind: "arm", afterMs: 60_000 });
  await doomed.next();
  const removed = await fetch(`${origin}/api/installations/region-two`, {
    method: "DELETE",
    headers: auth,
  });
  assert.equal(removed.status, 204, await removed.text());
  assert.equal((await doomed.closed).code, 4403);
  assert.equal(await upgradeStatus(regionPath("region-two"), auth), 404);
  negatives += 1;

  // A new authority for the kept Installation fences the open socket too,
  // keeps the Region's data, and a reconnect re-admits.
  const reinstalled = await installRelease({
    directory: `${work}/region-release`,
    url: origin,
    key,
    installationId: "region",
  });
  assert.ok(
    [200, 201].includes(reinstalled.status),
    await reinstalled.clone().text(),
  );
  const fenced = await second.closed;
  assert.equal(fenced.code, 4403);
  const third = connect("region");
  await third.opened;
  const kept = await third.next();
  assert.equal(kept.counter, 2);
  assert.equal(kept.ticks, 1);
  third.socket.close(1000, "done");

  // The real Agar path: an admitted browser opens the App, whose sandboxed
  // frame connects through appRegion while the host page holds the socket.
  const browser = await launchIsolatedChromium(chromium, portsOf(origin));
  try {
    // The owner signs in through the ordinary form; from then on only the
    // session cookie admits this browser, the Region upgrade included. No
    // header is injected: a page's WebSocket cannot send one.
    const context = await browser.newContext();
    const page = await context.newPage();
    const sockets = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.goto(`${origin}/login`);
    await page.getByLabel("Owner key", { exact: true }).fill(key);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`${origin}/`);
    const session = (await context.cookies()).find(
      (cookie) => cookie.name === "oyster_session",
    );
    assert.ok(session?.httpOnly, "the sign-in set an HttpOnly session cookie");
    assert.equal(session.value.includes(key), false);
    await page.goto(`${origin}/apps/region/`);
    const app = page.frameLocator("#oyster-app");
    await app.locator("#status").filter({ hasText: "Connected" }).waitFor();
    await app.locator("#counter").filter({ hasText: "2" }).waitFor();
    assert.equal(
      await app.locator("#scope").textContent(),
      JSON.stringify({ kind: "standalone", tenant: "default" }),
    );
    await app.locator("#increment").click();
    await app.locator("#counter").filter({ hasText: "3" }).waitFor();
    assert.equal((await regionStatus("region")).counter, 3);
    assert.deepEqual(sockets, [
      `${origin.replace("http", "ws")}${regionPath("region")}`,
    ]);
  } finally {
    await browser.close();
  }
  console.log(
    `PASS standalone Region on ${runtime}: socket, native alarm after close, restart, isolation, fencing, browser through Agar (${negatives} refusals)`,
  );
} catch (cause) {
  console.error(output);
  throw cause;
} finally {
  oyster.child.kill("SIGTERM");
  await oyster.stopped;
  await rm(work, { recursive: true, force: true });
}
