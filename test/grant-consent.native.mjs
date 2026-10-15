import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { sha256 } from "../dist/host.js";
import { TextEncoder } from "node:util";

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
await writeFile(
  config,
  JSON.stringify({
    name: "oyster-grant-rpc-proof",
    main: `${root}test/grant-consent.worker.fixture.ts`,
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    r2_buckets: [{ binding: "RELEASES", bucket_name: "proof-releases" }],
    durable_objects: {
      bindings: [
        { name: "REGISTRY", class_name: "OysterRegistry" },
        { name: "INSTANCES", class_name: "OysterInstance" },
        { name: "APPROVAL_BARRIER", class_name: "ApprovalBarrier" },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: [
          "OysterRegistry",
          "OysterInstance",
          "ApprovalBarrier",
        ],
      },
    ],
  }),
);
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
    "<!doctype html><title>Grant proof</title>",
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
  const installed = await globalThis.fetch(`${origin}/api/installations`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ installationId: "proof", release }),
  });
  assert.equal(installed.status, 201);
  const current = await installed.json();
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
  const request = (grants) =>
    globalThis.fetch(`${origin}/api/installations/proof/grants`, {
      method: "PUT",
      headers: { ...auth, "X-Proof-Race": "pair" },
      body: JSON.stringify({
        authorityVersion: current.authorityVersion,
        artifactDigest: digest,
        command: { kind: "set-grants", grants },
      }),
    });
  const replies = await Promise.all([request("declared"), request("none")]);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
  const records = await (
    await globalThis.fetch(`${origin}/api/installations`, { headers: auth })
  ).json();
  assert.equal(records[0].authorityVersion, current.authorityVersion + 1);
  assert.deepEqual(records[0].release, release);
  assert.equal(
    (
      await globalThis.fetch(`${origin}/__stale-proof`, {
        method: "POST",
        headers: auth,
      })
    ).status,
    200,
  );
  const stale = {
    kind: "refused",
    code: "installation_stale",
    installationId: "proof",
  };
  const listing = await globalThis.fetch(`${origin}/api/installations`, {
    headers: auth,
  });
  assert.equal(listing.status, 200);
  assert.deepEqual(await listing.json(), [stale]);
  const home = await globalThis.fetch(origin, { headers: auth });
  assert.equal(home.status, 409);
  assert.deepEqual(await home.json(), { error: "installation_stale" });
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
  assert.deepEqual(
    await (
      await globalThis.fetch(`${origin}/api/installations`, { headers: auth })
    ).json(),
    [],
  );
  assert.deepEqual(
    await (
      await globalThis.fetch(`${origin}/__stale-proof`, { headers: auth })
    ).json(),
    [{ value: '{"retained":true}' }],
  );
  assert.equal(
    (
      await globalThis.fetch(`${origin}/api/installations`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ installationId: "proof", release }),
      })
    ).status,
    201,
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
  assert.deepEqual(
    await (
      await globalThis.fetch(`${origin}/__stale-proof`, { headers: auth })
    ).json(),
    [],
  );
  globalThis.console.log(
    `Stale installation native RPC PASS: typed409/list/delete/reinstall; stale delete retains hub_app_storage rows, normal delete purges them`,
  );
  globalThis.console.log(
    `Owner grant RPC concurrent approval PASS (${process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd"}):200/409`,
  );
} finally {
  worker.kill("SIGTERM");
  await stopped;
  await rm(work, { recursive: true, force: true });
}
