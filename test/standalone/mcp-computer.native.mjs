// Oyster's shared MCP owner reaches the standalone Computer through Knapsack.
// The real ComputerDO, workspace and MCP owner run under `wrangler dev`
// (workerd); the Worker shell answers `exec`, so no container starts.
/* global fetch, URL, TextEncoder */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import console from "node:console";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";

const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(join(root, ".botanical"), { recursive: true });
const work = await mkdtemp(join(root, ".botanical/mcp-computer-"));
const key = randomBytes(24).toString("hex");
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const { port } = z.object({ port: z.number() }).parse(socket.address());
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const classes = [
  "OysterMcp",
  "OysterRegistry",
  "OysterInstance",
  "OysterKeys",
  "ComputerDO",
];
const bindings = ["MCP", "REGISTRY", "INSTANCES", "KEYS", "COMPUTER"];
await writeFile(
  join(work, "wrangler.json"),
  JSON.stringify({
    name: "oyster-mcp-computer-proof",
    main: join(root, "test/standalone/mcp-computer.native.fixture.ts"),
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      OYSTER_ORIGIN: origin,
      OYSTER_OWNER_KEY: key,
      OYSTER_COMPUTER_ID: "workspace",
    },
    worker_loaders: [{ binding: "LOADER" }],
    r2_buckets: [{ binding: "RELEASES", bucket_name: "mcp-computer-proof" }],
    durable_objects: {
      bindings: classes.map((class_name, at) => ({
        name: bindings[at],
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
    "--persist-to",
    join(work, "state"),
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const stopped = new Promise((resolve) => child.once("exit", resolve));

// `headless` is shaped like `claude -p`: a bare elicitation capability, and
// every elicitation cancelled because no person can answer it.
async function connect(credential, headless = false) {
  const client = new Client(
    { name: "Oyster MCP Computer proof", version: "1" },
    { capabilities: { elicitation: headless ? {} : { form: {} } } },
  );
  let asked = 0;
  client.setRequestHandler("elicitation/create", () => {
    asked += 1;
    return headless
      ? { action: "cancel" }
      : { action: "accept", content: { approve: true } };
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${credential}` } },
    },
  );
  await client.connect(transport);
  const execute = async (code) => {
    const result = await client.callTool({
      name: "execute",
      arguments: { code },
    });
    return { ...result, text: JSON.stringify(result.content) };
  };
  return {
    client,
    execute,
    asked: () => asked,
    close: async () => {
      await transport.terminateSession();
      await client.close();
    },
  };
}

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

  // The owner's catalog lists the Computer beside (zero) installed Apps.
  const owner = await connect(key);
  try {
    assert.match(owner.client.getInstructions(), /env\.computers\.workspace/u);
    const described = await owner.execute(
      'return await forage.describe({ path: "computers.workspace.exec" })',
    );
    assert.notEqual(described.isError, true, described.text);
    assert.match(described.text, /Worker shell/u);
    // Every call runs through the ComputerDO's grant acceptance.
    const written = await owner.execute(
      'await env.computers.workspace.mkdir({ path: "/workspace/proof" }); return await env.computers.workspace.write({ path: "/workspace/proof/note.txt", content: "from mcp" })',
    );
    assert.notEqual(written.isError, true, written.text);
    const read = await owner.execute(
      'return await env.computers.workspace.read({ path: "/workspace/proof/note.txt" })',
    );
    assert.notEqual(read.isError, true, read.text);
    assert.match(read.text, /from mcp/u);
    const shell = await owner.execute(
      'return await env.computers.workspace.exec({ command: "cat note.txt", cwd: "/workspace/proof", timeoutMs: 30000 })',
    );
    assert.notEqual(shell.isError, true, shell.text);
    assert.match(shell.text, /succeeded/u);
    assert.match(shell.text, /from mcp/u);
    assert.ok(owner.asked() >= 4, "every Computer call asks for confirmation");
  } finally {
    await owner.close();
  }

  // A named key with its own computer.use grant holds the same existing
  // Computer access as the HTTP routes; computer.use is off by default.
  const created = await fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "mcp-computer-proof",
      grants: [{ capability: "computer.use", targets: { kind: "all" } }],
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const named = z
    .object({ plaintext: z.string() })
    .parse(await created.json()).plaintext;

  // Without its own computer.use grant, a key never sees the Computer at all.
  const createdNoComputer = await fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "mcp-no-computer-proof",
      grants: [{ capability: "apps.read", targets: { kind: "all" } }],
    }),
  });
  assert.equal(
    createdNoComputer.status,
    201,
    await createdNoComputer.clone().text(),
  );
  const namedNoComputer = z
    .object({ plaintext: z.string() })
    .parse(await createdNoComputer.json()).plaintext;
  const noComputerClient = await connect(namedNoComputer);
  try {
    // The Computer is never in this key's catalog at all (oysterComputerTools
    // omits it outright, the same as an unregistered module to the model),
    // so referencing it is not a normal declared-operation refusal; it fails
    // the MCP tool call itself, the same as every other unexpected sandbox
    // failure (packages/mycelium/test/mcp.test.ts's own mid-call authority
    // checks).
    await assert.rejects(
      noComputerClient.execute(
        'return await env.computers.workspace.read({ path: "/workspace/proof/note.txt" })',
      ),
      /MCP tool call failed/u,
      "a key with no computer.use grant never reaches the Computer",
    );
  } finally {
    await noComputerClient.close();
  }
  const keyed = await connect(named);
  const headless = await connect(named, true);
  try {
    const read = await keyed.execute(
      'return await env.computers.workspace.read({ path: "/workspace/proof/note.txt" })',
    );
    assert.notEqual(read.isError, true, read.text);
    assert.match(read.text, /from mcp/u);
    // The key's App tool approval never covers the Computer: a write still
    // asks, and the headless client's cancel refuses it.
    const refused = await headless.execute(
      'return await env.computers.workspace.write({ path: "/workspace/proof/note.txt", content: "unasked" })',
    );
    assert.match(refused.text, /declined/u);
    assert.equal(headless.asked(), 1, "A Computer write by a key still asks");
    const unchanged = await keyed.execute(
      'return await env.computers.workspace.read({ path: "/workspace/proof/note.txt" })',
    );
    assert.match(unchanged.text, /from mcp/u);
    assert.doesNotMatch(unchanged.text, /unasked/u);
  } finally {
    await headless.close();
    await keyed.close();
  }

  // One request authenticates once: the Computer capability route and the
  // owner's direct Agent policy read run under the host's single admission.
  const persist = async (bytes) => {
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    const stored = await fetch(
      `${origin}/api/artifacts/${artifactRef}?digest=${digest}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${key}` },
        body: bytes,
      },
    );
    assert.equal(stored.status, 204, await stored.text());
    return { artifactRef, digest, byteLength: bytes.length };
  };
  const page = new TextEncoder().encode("<!doctype html><title>Probe</title>");
  const build = await persist(
    new TextEncoder().encode(
      JSON.stringify({
        format: "fungi-app-v1",
        ui: {
          ...(await persist(page)),
          version: "probe",
          mediaType: "text/html; charset=utf-8",
        },
        declaration: {
          capabilities: ["computer.execute"],
          handlers: [],
          roles: [],
        },
      }),
    ),
  );
  const installed = await fetch(`${origin}/api/installations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      installationId: "probe",
      release: {
        appId: "app_probe",
        releaseId: "rel_probe",
        artifact: {
          artifactRef: build.artifactRef,
          artifactDigest: build.digest,
          provenance: {
            sourceRevision: `git:${"a".repeat(40)}`,
            sourceTreeDigest: build.digest,
            buildRecipeDigest: build.digest,
          },
        },
      },
    }),
  });
  assert.equal(installed.status, 201, await installed.text());
  const authentications = async () =>
    z
      .object({ resolve: z.number(), authenticate: z.number() })
      .parse(await (await fetch(`${origin}/proof/authentications`)).json());
  await authentications();
  const processes = await fetch(`${origin}/computer/processes`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "X-Oyster-Installation": "probe",
    },
  });
  assert.equal(processes.status, 200, await processes.text());
  const capabilityCount = await authentications();
  const policy = await fetch(`${origin}/api/agent-policies/amber`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(policy.status, 200, await policy.clone().text());
  assert.deepEqual(await policy.json(), { expectedRevision: null });
  assert.deepEqual(
    { capability: capabilityCount, owner: await authentications() },
    {
      capability: { resolve: 1, authenticate: 1 },
      owner: { resolve: 1, authenticate: 1 },
    },
  );

  // No admitted principal, no Computer.
  assert.equal((await fetch(`${origin}/mcp`, { method: "POST" })).status, 401);
  console.log(
    `Oyster MCP Computer on ${runtime}: owner catalog lists env.computers.workspace; mkdir/write/read/exec through the ComputerDO grant; named key read; a headless key Computer write still asks and is refused; one Computer capability request and one owner Agent policy read each resolve and authenticate once; anonymous 401 PASS`,
  );
} finally {
  child.kill("SIGTERM");
  await stopped;
  await rm(work, { recursive: true, force: true });
}
