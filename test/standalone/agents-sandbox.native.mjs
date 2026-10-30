// Real StandaloneAgent -> execute -> Worker Loader -> installed App methods.
// Run with node, or pinned celld through wrangler-on-celld.mjs. No provider.
/* global fetch, AbortSignal, Request, setTimeout */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { installRelease, packRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { appAgentSchema } from "@fungi.computer/agar/agents";
import { createShiitakeClient } from "@fungi.computer/shiitake/client";
import * as Schema from "effect/Schema";
import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
import {
  nativeAppClient,
  nativeWorkflowRoot,
  until,
} from "./workflow-native.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const sourceRevision = `git:${execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim()}`;
// node:test continues through both existing and new cases and returns nonzero
// for any failure; a Notes failure must not hide the Shed first-reply result.
await test("standalone Agent executes the installed Notes App", async () => {
  await mkdir(`${root}.botanical`, { recursive: true });
  const work = await mkdtemp(`${root}.botanical/agents-sandbox-`);
  const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";
  const key = "local-sandbox-proof-owner";
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let stopped;
  let output = "";

  try {
    await packRelease({
      appId: "app_notes",
      releaseId: "rel_sandboxproof",
      sourceDirectory: repository,
      sourceRevision,
      packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      recipe: {
        entry: "packages/oyster/examples/notes-app/ui/index.html",
        assets: {
          maxManifestBytes: 1_048_576,
          maxObjects: 1024,
          maxObjectBytes: 16_777_216,
          maxTotalBytes: 67_108_864,
        },
        assetBase: "./",
        maxOutputBytes: 67_108_864,
        backend: {
          entry: "packages/oyster/examples/notes-app/backend/index.ts",
          exportName: "Notes",
          compatibilityDate: "2026-09-04",
          runtime: { kind: "durable-facet", stateSchema: 1 },
        },
      },
      outDirectory: `${work}/release`,
    });
    await writeFile(
      `${work}/wrangler.json`,
      JSON.stringify({
        name: "oyster-agent-sandbox-proof",
        main: `${root}test/standalone/agents-sandbox.fixture.ts`,
        compatibility_date: "2026-09-04",
        compatibility_flags: ["nodejs_compat"],
        worker_loaders: [{ binding: "LOADER" }],
        r2_buckets: [{ binding: "RELEASES", bucket_name: "sandbox-proof" }],
        vars: {
          OYSTER_OWNER_KEY: key,
          OYSTER_ORIGIN: "https://oyster.test",
          OYSTER_COMPUTER_ID: "agent-workspace",
          AI_GATEWAY_AUTH_TOKEN: "fixture-not-a-provider-credential",
          AI_GATEWAY_ACCOUNT_ID: "fixture-account",
          AI_GATEWAY_ID: "fixture-gateway",
        },
        durable_objects: {
          bindings: [
            { name: "REGISTRY", class_name: "OysterRegistry" },
            { name: "INSTANCES", class_name: "StandaloneInstance" },
            { name: "AGENT_DIRECTORY", class_name: "AgentDirectory" },
            { name: "TENANTS", class_name: "StandaloneTenants" },
            { name: "KEYS", class_name: "OysterKeys" },
            { name: "AGENTS", class_name: "SandboxAgent" },
            { name: "PROBE", class_name: "SandboxAgent" },
            { name: "LUNA", class_name: "LunaAgent" },
          ],
        },
        migrations: [
          {
            tag: "v1",
            new_sqlite_classes: [
              "OysterRegistry",
              "StandaloneInstance",
              "SandboxAgent",
              "AgentDirectory",
              "StandaloneTenants",
              "OysterKeys",
              "LunaAgent",
            ],
          },
        ],
      }),
    );
    child = spawn(
      `${root}node_modules/.bin/wrangler`,
      [
        "dev",
        "--config",
        `${work}/wrangler.json`,
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        // The root admits only its configured origin, as in production.
        "--local-upstream",
        "oyster.test",
        "--upstream-protocol",
        "https",
        "--persist-to",
        `${work}/state`,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    stopped = new Promise((resolve) => child.once("exit", resolve));
    for (let attempt = 0; ; attempt += 1) {
      const ready = await fetch(`${origin}/login`, {
        signal: AbortSignal.timeout(1_000),
      }).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) break;
      if (
        child.exitCode !== null ||
        output.includes("Build failed") ||
        attempt >= 120
      )
        throw new Error(
          `Oyster did not start:\n${output.replaceAll(key, "[redacted]")}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const createSession = () =>
      fetch(`${origin}/luna/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestId: "owner-luna-session" }),
      });
    const created = await createSession();
    assert.equal(created.status, 201, await created.clone().text());
    const session = await created.json();
    assert.deepEqual(await (await createSession()).json(), session);
    const read = await fetch(`${origin}/luna/sessions/${session.sessionId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    assert.equal(read.status, 200, await read.clone().text());
    assert.equal((await read.json()).messages.length, 0);
    console.log(
      `Luna owner Session create/replay/read on ${runtime}, no inference: PASS`,
    );
    const installed = await installRelease({
      directory: `${work}/release`,
      url: origin,
      key,
      installationId: "notes",
    });
    assert.equal(installed.status, 201, await installed.text());
    const response = await fetch(`${origin}/probe`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(
      response.status,
      200,
      (await response.clone().text()).replaceAll(key, "[redacted]"),
    );
    const { probe, policy, owner } = await response.json();
    const { terminal, results } = JSON.parse(probe);
    assert.equal(
      policy.grantedBy,
      owner.actor.memberId,
      "grantor comes from the seeded canonical owner membership",
    );
    assert.notEqual(policy.grantedBy, "owner");
    assert.ok(owner.membershipVersion > 0);
    assert.equal(policy.level, "write");
    assert.ok(policy.revision.length > 0);
    assert.equal(terminal.outcome, "completed");
    assert.equal(results.length, 1);
    assert.equal(results[0].toolName, "execute");
    assert.equal(results[0].isError, false, JSON.stringify(results[0].content));
    assert.deepEqual(results[0].content, [
      { type: "text", text: '{"text":"from the agent sandbox"}' },
    ]);
    const note = await fetch(`${origin}/apps/notes/methods/readNote`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(note.status, 200);
    assert.deepEqual(await note.json(), { text: "from the agent sandbox" });
    console.log(
      `Oyster agent sandbox on ${runtime}: real execute tool saved and read the installed App; PASS`,
    );
  } finally {
    if (child) {
      child.kill("SIGTERM");
      await stopped;
    }
    await rm(work, { recursive: true, force: true });
  }
});

await test("standalone Agent first reply uses real native Shed runCommand", async (t) => {
  const host = await nativeWorkflowRoot({
    root,
    prefix: "agents-first-shed-",
    main: "agents-sandbox.fixture.ts",
    artifactBucket: "agent-first-shed-artifacts",
    computer: "platform-container",
  });
  let client;
  try {
    await host.ready();
    const { approve } = nativeAppClient(host.origin, host.auth, {
      key: host.key,
    });
    const packageStoreDirectory = execFileSync("pnpm", ["store", "path"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    for (const installationId of ["shed", "grove"]) {
      const app = standaloneAppSet.find(
        (item) => item.installationId === installationId,
      );
      assert.ok(app, `the maintained App set includes ${installationId}`);
      const directory = `${host.work}/${installationId}-release`;
      await packRelease({
        appId: app.appId,
        releaseId: `rel_firstreply${installationId}`,
        sourceDirectory: repository,
        sourceRevision,
        packageStoreDirectory,
        recipe: committedAppRecipe(repository, app, sourceRevision.slice(4)),
        outDirectory: directory,
      });
      const installed = await installRelease({
        directory,
        url: host.origin,
        key: host.key,
        installationId,
      });
      assert.equal(installed.status, 201, `${installationId} installation`);
      await approve(installationId);
    }
    const headers = {
      ...host.auth,
      "Content-Type": "application/json",
      "X-Oyster-Installation": "grove",
    };
    const created = await fetch(`${host.origin}/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "First Shed reply",
        requestId: "first-shed-agent",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(created.status, 200, "ordinary owner Agent creation");
    const { agentId } = Schema.decodeUnknownSync(appAgentSchema)(
      await created.json(),
    );
    client = createShiitakeClient({
      baseUrl: `${host.origin}/agents/${agentId}`,
      fetch: (input, init) => {
        const request = new Request(input, init);
        for (const [name, value] of Object.entries(headers))
          request.headers.set(name, value);
        return fetch(request);
      },
    });
    const sessionId = await client.createSession("first-shed-session");
    const session = client.session(sessionId);
    await t.test(
      "Session is created and empty before its first message",
      async () => {
        const before = await session.read();
        assert.equal(before.messages.length, 0);
        assert.equal(before.terminals.length, 0);
      },
    );
    const accepted = await session.send(
      "Use the installed Shed runCommand once, then reply with its result.",
    );
    const settled = await until(
      () => session.read(),
      (read) =>
        read.terminals.some(
          ({ commandId }) => commandId === accepted.commandId,
        ),
      "the first standalone Agent command settles",
    );
    const terminal = settled.terminals.find(
      ({ commandId }) => commandId === accepted.commandId,
    );
    const messages = settled.messages.map(({ value }) => value);
    const results = messages.filter((value) => value.role === "toolResult");
    const toolLeaseAcquired =
      results.length === 1 &&
      results[0].toolName === "execute" &&
      results[0].isError === false;
    let runCommandOutput = null;
    await t.test("the actual Shed runCommand result is decoded", () => {
      assert.ok(toolLeaseAcquired);
      runCommandOutput = JSON.parse(results[0].content[0].text);
    });
    await t.test("first command has no Tool lease failed diagnostic", () => {
      assert.equal(
        JSON.stringify(settled).includes("Tool lease failed"),
        false,
      );
    });
    await t.test("first command completes", () => {
      assert.equal(terminal.outcome, "completed");
    });
    await t.test("first message receives an assistant reply", () => {
      assert.equal(messages.filter((value) => value.role === "user").length, 1);
      assert.ok(
        messages.some(
          (value) =>
            value.role === "assistant" &&
            value.content.some(
              (part) =>
                part.type === "text" &&
                part.text === "Shed first reply completed.",
            ),
        ),
      );
    });
    await t.test("ordinary tool lease discovers and executes Shed", () => {
      assert.equal(toolLeaseAcquired, true);
    });
    await t.test(
      "one real native runCommand returns its stdout and exit status",
      () => {
        assert.deepEqual(runCommandOutput, {
          stdout: "oyster-first-shed\n",
          stderr: "",
          exitCode: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    );
    await t.test(
      "owner archive refuses new Shiitake work and restore reopens it",
      async () => {
        const archive = await fetch(
          `${host.origin}/agents/${agentId}/archive`,
          {
            method: "POST",
            headers,
          },
        );
        assert.equal(archive.status, 200, await archive.text());
        const visible = await fetch(`${host.origin}/agents`, { headers });
        assert.equal(
          (await visible.json()).some((item) => item.agentId === agentId),
          false,
        );
        const hidden = await fetch(`${host.origin}/agents?archived=true`, {
          headers,
        });
        assert.equal(
          (await hidden.json()).some((item) => item.agentId === agentId),
          true,
        );
        await assert.rejects(
          client.createSession("archived-first-session"),
          (error) =>
            error?.boundary === "contract" && error?.cause === "archived",
        );
        assert.ok((await session.read()).terminals.length > 0);
        await assert.rejects(
          session.send("New work after archive"),
          (error) =>
            error?.boundary === "contract" && error?.cause === "archived",
        );
        assert.equal(
          await client.createSession("first-shed-session"),
          sessionId,
          "the already-admitted request is a replay, not new work",
        );
        const restore = await fetch(
          `${host.origin}/agents/${agentId}/unarchive`,
          {
            method: "POST",
            headers,
          },
        );
        assert.equal(restore.status, 200, await restore.text());
        assert.ok(await client.createSession("restored-new-session"));
      },
    );
    console.log(
      JSON.stringify({
        proof: "standalone-agent-first-shed",
        runtime: host.runtime,
        sourceRevision,
        agentId,
        sessionId,
        commandId: accepted.commandId,
        terminal: terminal.outcome,
        // A successful execute result can exist only after its production
        // lease, real forage.describe and SHED.runCommand have all returned.
        toolLease: {
          operation: "SHED.runCommand",
          acquired: toolLeaseAcquired,
        },
        runCommandOutput,
      }),
    );
  } finally {
    try {
      await client?.close();
    } finally {
      await host.close();
    }
  }
});
