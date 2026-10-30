import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { sha256 } from "../dist/host.js";
import { installOnOyster } from "../dist/installation-client.js";
import { TextEncoder } from "node:util";
import { grantConsentConfig } from "./grant-consent-config.fixture.mjs";

assert.ok(process.env.CELLD_PLATFORM_CELLD, "Actual pinned celld is required");
assert.deepEqual(
  JSON.parse(execFileSync("ip", ["-json", "link"], { encoding: "utf8" })).map(
    (link) => link.ifname,
  ),
  ["lo"],
  "Run through the disposable native wrapper, never the host network",
);
assert.deepEqual(
  JSON.parse(execFileSync("ip", ["-json", "route"], { encoding: "utf8" })),
  [],
  "The native proof must have no external route",
);

const root = new globalThis.URL("../", import.meta.url).pathname;
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/grant-rpc-`);
const key = randomBytes(24).toString("hex");
const socket = createServer();
await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", resolve);
});
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const config = `${work}/wrangler.json`;
await writeFile(config, JSON.stringify(grantConsentConfig(root, origin)));
const worker = spawn(
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
  { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
worker.stdout.on("data", (data) => (output += data));
worker.stderr.on("data", (data) => (output += data));
const stopped = new Promise((resolve) => worker.once("exit", resolve));
try {
  for (let attempt = 0; ; attempt++) {
    const ready = await globalThis.fetch(`${origin}/login`).then(
      (reply) => reply.ok,
      (cause) => ({ notListening: cause }),
    );
    if (ready === true) break;
    if (attempt > 120)
      throw new Error(
        `Native host failed to start: ${output.replaceAll(key, "[redacted]")}`,
      );
    await delay(250);
  }
  const ui = new TextEncoder().encode(
    "<!doctype html><title>Grant proof</title><main>Grant proof</main>",
  );
  const build = createAppBuild(
    {
      artifactRef: "artifact:grant-ui",
      digest: await sha256(ui),
      version: "1",
      byteLength: ui.length,
      mediaType: "text/html; charset=utf-8",
    },
    null,
    {
      capabilities: ["app.events.emit"],
      handlers: [],
      roles: [],
      commands: [],
      gills: [],
    },
  );
  const bytes = new TextEncoder().encode(JSON.stringify(build));
  const digest = await sha256(bytes);
  const release = {
    appId: "app_grants",
    releaseId: "rel_grants",
    artifact: {
      artifactRef: "artifact:grant-root",
      artifactDigest: digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: digest,
        buildRecipeDigest: digest,
      },
    },
  };
  const auth = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  for (const [ref, value] of [
    ["artifact:grant-ui", ui],
    ["artifact:grant-root", bytes],
  ]) {
    assert.equal(
      (
        await globalThis.fetch(
          `${origin}/api/artifacts/${encodeURIComponent(ref)}?digest=${encodeURIComponent(await sha256(value))}`,
          { method: "PUT", headers: auth, body: value },
        )
      ).status,
      204,
    );
  }
  const installed = await installOnOyster({
    url: origin,
    key,
    installationId: "proof",
    release,
  });
  assert.equal(installed.state, "succeeded", JSON.stringify(installed));
  assert.equal(installed.creation, "fresh");
  const current = installed.installation;
  assert.equal(
    (
      await globalThis.fetch(`${origin}/other/api/installations/proof/grants`, {
        headers: auth,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await globalThis.fetch(`${origin}/api/installations/proof/grants`, {
        method: "PUT",
        headers: auth,
        body: " ".repeat(65537),
      })
    ).status,
    413,
  );
  const pins = await (
    await globalThis.fetch(origin + "/api/installations/proof/grants", {
      headers: { ...auth, Accept: "application/json" },
    })
  ).json();
  const request = (grants) =>
    globalThis.fetch(`${origin}/api/installations/proof/grants`, {
      method: "PUT",
      headers: { ...auth, "X-Proof-Race": "pair" },
      body: JSON.stringify({
        storeGeneration: pins.storeGeneration,
        authorityVersion: current.authority.authorityVersion,
        artifactDigest: digest,
        command: {
          kind: "change-grants",
          changes: [
            {
              capability: "app.events.emit",
              grant:
                grants[0] === undefined
                  ? null
                  : {
                      operations: grants[0].operations,
                      resources: grants[0].resources,
                    },
            },
          ],
        },
      }),
    });
  const replies = await Promise.all([
    request([
      {
        capability: "app.events.emit",
        operations: [],
        resources: "tenant-scope",
      },
    ]),
    request([]),
  ]);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
  const records = await (
    await globalThis.fetch(`${origin}/api/installations`, { headers: auth })
  ).json();
  assert.equal(
    records[0].authority.authorityVersion,
    current.authority.authorityVersion + 1,
  );
  assert.deepEqual(records[0].release, release);
  const seeded = await globalThis.fetch(`${origin}/__storage-proof`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(seeded.status, 200);
  assert.deepEqual(await seeded.json(), [{ value: '{"retained":true}' }]);
  const listing = await globalThis.fetch(`${origin}/api/installations`, {
    headers: auth,
  });
  assert.equal(listing.status, 200);
  assert.deepEqual(await listing.json(), records);
  const view = await globalThis.fetch(
    `${origin}/api/installations/proof/grants`,
    { headers: { ...auth, Accept: "application/json" } },
  );
  assert.equal(view.status, 200);
  assert.deepEqual(
    (await view.json()).permissions.authority,
    records[0].authority,
  );
  assert.equal(
    (
      await globalThis.fetch(`${origin}/api/installations/proof`, {
        method: "DELETE",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await globalThis.fetch(`${origin}/api/installations/proof`, {
        method: "DELETE",
        headers: auth,
      })
    ).status,
    204,
  );
  const deleted = await (
    await globalThis.fetch(`${origin}/api/installations`, { headers: auth })
  ).json();
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].installationId, "proof");
  assert.equal(deleted[0].status, "deleted");
  assert.deepEqual(deleted[0].authority.approvedGrants, []);
  assert.deepEqual(
    await (
      await globalThis.fetch(`${origin}/__storage-proof`, { headers: auth })
    ).json(),
    [],
  );
  // The deleted id is retired; a reinstall takes a new installation id.
  const retired = await installOnOyster({
    url: origin,
    key,
    installationId: "proof",
    release,
  });
  assert.equal(retired.state, "succeeded");
  assert.equal(retired.creation, "reminted");
  const fresh = retired.installation;
  assert.match(fresh.installationId, /^proof-[a-z0-9]{21}$/u);
  assert.equal(fresh.authority.authorityVersion, 1);
  // Fresh-install defaults, not the winning grant edit made above.
  assert.deepEqual(
    fresh.authority.approvedGrants,
    current.authority.approvedGrants,
  );
  assert.equal(
    (
      await globalThis.fetch(
        `${origin}/api/installations/${fresh.installationId}`,
        {
          method: "DELETE",
          headers: auth,
        },
      )
    ).status,
    204,
  );
  assert.deepEqual(
    await (
      await globalThis.fetch(`${origin}/__storage-proof`, { headers: auth })
    ).json(),
    [],
  );
  globalThis.console.log(
    `Current installation native RPC PASS: embedded authority projection, owner-only delete, reinstall mints a new id with fresh authority; normal delete purges hub_app_storage rows`,
  );
  globalThis.console.log(
    "Owner grant RPC concurrent approval PASS (celld):200/409",
  );
} finally {
  try {
    worker.kill("SIGTERM");
    await stopped;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
