import assert from "node:assert/strict";
import { log } from "node:console";
const { fetch, Request } = globalThis;
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";
import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(join(root, ".botanical"), { recursive: true });
const work = await mkdtemp(join(root, ".botanical/mcp-owner-"));
const key = randomBytes(24).toString("hex");
let otherCredential;
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";
async function port() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = z.object({ port: z.number() }).parse(socket.address());
  await new Promise((resolve) => socket.close(resolve));
  return address.port;
}
const listenPort = await port();
const config = join(work, "wrangler.json");
const name = "mcp-owner-proof";
const classes = ["OysterMcp", "OysterRegistry", "OysterInstance", "OysterKeys"];
const bindings = ["MCP", "REGISTRY", "INSTANCES", "KEYS"];
// A trusted local proof entry may compose the owning consumer's TENANTS kit.
const consumerEntry = process.env.OYSTER_MCP_PROOF_ENTRY;
if (consumerEntry !== undefined) {
  classes.push("StandaloneTenants");
  bindings.push("TENANTS");
}
await writeFile(
  config,
  JSON.stringify({
    name,
    main: consumerEntry ?? join(root, "test/mcp-owner.native.fixture.ts"),
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      OYSTER_ORIGIN: "https://oyster.test",
      OYSTER_OWNER_KEY: key,
      ARTIFACTS_ORIGIN: "https://artifacts.test",
    },
    worker_loaders: [{ binding: "LOADER" }],
    r2_buckets: [{ binding: "RELEASES", bucket_name: "mcp-proof-releases" }],
    services: [
      { binding: "FRONT_A", service: name, entrypoint: "McpFrontendA" },
      { binding: "FRONT_B", service: name, entrypoint: "McpFrontendB" },
    ],
    durable_objects: {
      bindings: classes.map((class_name, at) => ({
        name: bindings[at],
        class_name,
      })),
    },
    migrations: [{ tag: "v1", new_sqlite_classes: classes }],
  }),
);
let processHandle;
async function start() {
  let output = "";
  const child = spawn(
    join(root, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--config",
      config,
      "--port",
      String(listenPort),
      "--ip",
      "127.0.0.1",
      "--local",
      "--persist-to",
      join(work, "state"),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  processHandle = { child, exited };
  for (let attempt = 0; attempt < 240; attempt++) {
    const ready = await fetch(`http://127.0.0.1:${listenPort}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return;
    if (child.exitCode !== null) break;
    await delay(250);
  }
  throw new Error(
    `MCP ${runtime} did not start: ${output.replaceAll(key, "[redacted]").replaceAll(otherCredential ?? key, "[redacted]")}`,
  );
}
async function stop() {
  if (processHandle === undefined) return;
  processHandle.child.kill("SIGTERM");
  await processHandle.exited;
  processHandle = undefined;
}
let turn = 0;
let notification = false;
let postCount = 0;
const client = new Client({
  name: "native cross-frontend proof",
  version: "1",
});
const transport = (credential = key) =>
  new StreamableHTTPClientTransport(new URL("https://oyster.test/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${credential}` } },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const target = new URL(request.url);
      target.protocol = "http:";
      target.host = `127.0.0.1:${listenPort}`;
      const front = request.method === "POST" ? postCount++ % 2 : turn++ % 2;
      target.pathname = `/front-${front === 0 ? "a" : "b"}${target.pathname}`;
      const response = await fetch(new Request(target, request));
      if (request.method === "POST" && response.status === 202) {
        assert.equal(front, 1, "notification reaches the second HTTP frontend");
        notification = true;
      }
      if (request.method === "DELETE")
        assert.equal(response.status, 200, "SDK termination response");
      return response;
    },
  });
try {
  await start();
  const first = transport();
  await client.connect(first);
  assert.equal(
    notification,
    true,
    "another HTTP frontend accepts the SDK notification",
  );
  assert.deepEqual(
    (await client.listTools()).tools.map(({ name }) => name),
    ["execute"],
  );
  const result = await client.callTool({
    name: "execute",
    arguments: { code: "return 25" },
  });
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result.content), /25/u);
  const oldId = first.sessionId;
  assert.ok(oldId);
  const createdKey = await fetch(
    `http://127.0.0.1:${listenPort}/front-a/api/keys`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "native-other-principal" }),
    },
  );
  assert.equal(createdKey.status, 201);
  otherCredential = z
    .object({ plaintext: z.string() })
    .parse(await createdKey.json()).plaintext;
  const foreign = await fetch(`http://127.0.0.1:${listenPort}/front-b/mcp`, {
    headers: {
      Authorization: `Bearer ${otherCredential}`,
      "Mcp-Session-Id": oldId,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
  });
  assert.equal(
    foreign.status,
    404,
    "another admitted key cannot reuse the owner's live session",
  );
  const keyClient = new Client({ name: "Native named key", version: "1" });
  const keyTransport = transport(otherCredential);
  try {
    await keyClient.connect(keyTransport);
    assert.deepEqual(
      (await keyClient.listTools()).tools.map(({ name }) => name),
      ["execute"],
    );
    await keyTransport.terminateSession();
  } finally {
    await keyClient.close();
  }
  await stop();
  await start();
  await assert.rejects(
    client.listTools(),
    (error) => error instanceof SdkHttpError && error.status === 404,
  );
  await client.close();
  postCount = 0;
  const fresh = transport();
  await client.connect(fresh);
  const newId = fresh.sessionId;
  assert.ok(newId && newId !== oldId);
  await Promise.all([client.listTools(), client.listTools()]);
  await fresh.terminateSession();
  const ended = await fetch(`http://127.0.0.1:${listenPort}/front-b/mcp`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Mcp-Session-Id": newId,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
  });
  assert.equal(ended.status, 404);
  log(
    `MCP owner ${runtime}: two HTTP frontends, notification202, list/call, admitted named-key foreign-session404 + own-session control, retained-storage cold404, SAME-client new-ID reinit, concurrency, SDK DELETE and old-ID404 PASS`,
  );
} finally {
  await client.close();
  await stop();
  await rm(work, { recursive: true, force: true });
}
