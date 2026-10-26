import { nativeMcpConnector } from "../native-mcp-client.fixture.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import console from "node:console";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { z } from "zod";

/* global fetch */

const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(join(root, ".botanical"), { recursive: true });
const work = await mkdtemp(join(root, ".botanical/mcp-fleet-"));
const key = randomBytes(24).toString("hex");
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const { port } = z.object({ port: z.number() }).parse(socket.address());
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const classes = [
  "OysterMcp",
  "OysterRegistry",
  "StandaloneInstance",
  "AgentDirectory",
  "StandaloneTenants",
  "OysterKeys",
  "ComputerDO",
];
const bindings = [
  "MCP",
  "REGISTRY",
  "INSTANCES",
  "AGENT_DIRECTORY",
  "TENANTS",
  "KEYS",
  "COMPUTER",
];
await writeFile(
  join(work, "wrangler.json"),
  JSON.stringify({
    name: "oyster-mcp-fleet-proof",
    main: join(root, "test/standalone/mcp-fleet.native.fixture.ts"),
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      OYSTER_OWNER_KEY: key,
      OYSTER_ORIGIN: "https://oyster.test",
      OYSTER_COMPUTER_ID: "workspace",
    },
    worker_loaders: [{ binding: "LOADER" }],
    r2_buckets: [{ binding: "RELEASES", bucket_name: "mcp-fleet-proof" }],
    durable_objects: {
      bindings: classes.map((class_name, index) => ({
        name: bindings[index],
        class_name,
      })),
    },
    migrations: [{ tag: "v1", new_sqlite_classes: classes }],
  }),
);

let output = "";
const child = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    "--config",
    join(work, "wrangler.json"),
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--local-upstream",
    "oyster.test",
    "--upstream-protocol",
    "https",
    "--persist-to",
    join(work, "state"),
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const stopped = new Promise((resolve) => child.once("exit", resolve));
try {
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${origin}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (child.exitCode !== null || attempt >= 240)
      throw new Error(
        `Oyster did not start:\n${output.replaceAll(key, "[redacted]")}`,
      );
    await delay(250);
  }
  const login = await fetch(`${origin}/login`);
  assert.equal(login.status, 200, await login.text());
  const owner = await nativeMcpConnector({
    origin,
    name: "Oyster fleet proof",
  })(key);
  try {
    const created = await owner.execute(
      'const a = await env.computers.create({name:"Fleet proof",requestId:"same-request"}); const b = await env.computers.create({name:"Fleet proof",requestId:"same-request"}); const list = await env.computers.list({}); const state = await env.computers.state({computerId:a.computer.computerId}); const start1 = await env.computers.start({computerId:a.computer.computerId}); const start2 = await env.computers.start({computerId:a.computer.computerId}); return {a,b,list,state,start1,start2}',
    );
    assert.notEqual(created.isError, true, created.text);
    const result = z
      .object({
        a: z.object({
          kind: z.literal("created"),
          requestId: z.string(),
          computer: z.object({ computerId: z.string() }),
        }),
        b: z.object({
          kind: z.literal("created"),
          requestId: z.string(),
          computer: z.object({ computerId: z.string() }),
        }),
        list: z.object({
          computers: z.array(z.object({ computerId: z.string() })),
        }),
        state: z.object({ state: z.string() }),
        start1: z.object({ state: z.string() }),
        start2: z.object({ state: z.string() }),
      })
      .parse(
        JSON.parse(
          z.object({ text: z.string() }).parse(created.content[0]).text,
        ),
      );
    assert.equal(result.a.requestId, "same-request");
    assert.deepEqual(result.b, result.a);
    assert.deepEqual(
      result.list.computers.map((entry) => entry.computerId),
      [result.a.computer.computerId],
    );
    assert.equal(result.state.state, "sleeping");
    assert.equal(result.start1.state, "running");
    assert.equal(result.start2.state, "running");
    assert.equal(owner.asked(), 4, "each fleet mutation requires confirmation");
    const page = await fetch(`${origin}/api/computers`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    assert.equal(page.status, 200, await page.clone().text());
    const inventory = z
      .object({
        computers: z.array(z.object({ name: z.string() })),
      })
      .parse(await page.json());
    assert.deepEqual(
      inventory.computers.map((entry) => entry.name),
      ["Fleet proof"],
    );
  } finally {
    await owner.close();
  }
} catch (error) {
  console.error(output.replaceAll(key, "[redacted]"));
  throw error;
} finally {
  child.kill("SIGTERM");
  await stopped;
  await rm(work, { recursive: true, force: true });
}
