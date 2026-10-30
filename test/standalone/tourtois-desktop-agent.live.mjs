/* global fetch, AbortSignal, setTimeout, Request */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { log } from "node:console";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { packRelease, installRelease } from "@fungi.computer/oyster/pack";
import { bundledHtmlRecipe } from "@fungi.computer/oyster/build";
import { createShiitakeClient } from "@fungi.computer/shiitake/client";
import * as Schema from "effect/Schema";
import { appAgentSchema } from "@fungi.computer/agar/agents";
import { desktopSnapshotSchema } from "../../../../apps/tourtois/src/desktop-api.js";
import { parse as parseJsonc } from "jsonc-parser";
import { readFile } from "node:fs/promises";
import { waitForNativeRoot } from "../native-root-readiness.fixture.mjs";
import { approveChosenDashboard } from "../../src/standalone/dashboard-approval.js";
import { installationOperationSchema } from "../../src/installation-operations.js";

async function runProof() {
  // A deliberate live proof, never a fake-provider fallback or an automatic batch leg.
  const runtime = "local standalone (workerd), not hosted";
  const required = [
    "AI_GATEWAY_ACCOUNT_ID",
    "AI_GATEWAY_ID",
    "AI_GATEWAY_AUTH_TOKEN",
  ];
  for (const name of required)
    assert.ok(
      process.env[name],
      `Missing ${name}; source the authorized credential file without printing it`,
    );
  const repository = fileURLToPath(new URL("../../../../", import.meta.url));
  // Consume the ordinary workspace build; proof readers never rebuild shared dist.
  const sourceRevision = `git:${execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim()}`;

  const work = await mkdtemp(join(tmpdir(), "tourtois-agent-live-"));
  // Reuse the maintained local standalone fixture's disposable owner sign-in value.
  const ownerKey = "local-sandbox-proof-owner";
  const tenantHost = "oyster.test";
  let worker, workerStopped, client, session;
  let workerOutput = "";
  try {
    const packApps = async () => {
      const packed = await packRelease({
        appId: "app_tourtois",
        releaseId: "rel_desktopproof",
        sourceDirectory: repository,
        sourceRevision,
        packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
          cwd: repository,
          encoding: "utf8",
        }).trim(),
        recipe: {
          entry: "apps/tourtois/index.html",
          assets: bundledHtmlRecipe.limits,
          assetBase: "./",
          maxOutputBytes: bundledHtmlRecipe.limits.maxTotalBytes,
          backend: {
            entry: "apps/tourtois/backend/index.ts",
            exportName: "Tourtois",
            compatibilityDate: "2026-09-04",
            runtime: { kind: "durable-facet", stateSchema: 1 },
          },
        },
        outDirectory: join(work, "release"),
      });
      log("PASS captured Tourtois source pack");
      // Grove is the maintained declaring App for owner fleet management and
      // Session transport. Tourtois receives no additional Agent permissions.
      await packRelease({
        appId: "app_grove",
        releaseId: "rel_groveproof",
        sourceDirectory: repository,
        sourceRevision,
        packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
          cwd: repository,
          encoding: "utf8",
        }).trim(),
        recipe: {
          entry: "apps/grove/index.html",
          assets: bundledHtmlRecipe.limits,
          assetBase: "./",
          maxOutputBytes: bundledHtmlRecipe.limits.maxTotalBytes,
          backend: {
            entry: "apps/grove/backend/index.ts",
            exportName: "Grove",
            compatibilityDate: "2026-09-04",
            runtime: { kind: "durable-facet", stateSchema: 1 },
          },
        },
        outDirectory: join(work, "grove-release"),
      });
      log("PASS captured declaring Grove source pack");
      return packed;
    };
    const config = join(work, "wrangler.json");
    const configuration = parseJsonc(
      await readFile(
        join(repository, "packages/oyster/deploy/wrangler.celld.jsonc"),
        "utf8",
      ),
    );
    configuration.name = "tourtois-headless-agent-proof";
    configuration.main = fileURLToPath(
      new URL("./tourtois-desktop-agent.worker.ts", import.meta.url),
    );
    configuration.vars = {
      ...configuration.vars,
      OYSTER_OWNER_KEY: ownerKey,
      OYSTER_HOME_INSTALLATION: "tourtois",
      OYSTER_COMPUTER_ID: "agent-workspace",
      OYSTER_ORIGIN: `https://${tenantHost}`,
      AI_GATEWAY_ACCOUNT_ID: process.env.AI_GATEWAY_ACCOUNT_ID,
      AI_GATEWAY_ID: process.env.AI_GATEWAY_ID,
      AI_GATEWAY_AUTH_TOKEN: process.env.AI_GATEWAY_AUTH_TOKEN,
    };
    await writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
    // The maintained standalone native proofs use Wrangler's ordinary CLI.
    const socket = createServer();
    await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const { port } = socket.address();
    await new Promise((resolve) => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    worker = spawn(
      join(repository, "apps/tourtois/node_modules/.bin/wrangler"),
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
        join(work, "state"),
        "--local-upstream",
        tenantHost,
        "--upstream-protocol",
        "https",
      ],
      { cwd: repository, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    worker.stdout.on("data", (chunk) => {
      workerOutput = (workerOutput + chunk.toString()).slice(-1_048_576);
    });
    worker.stderr.on("data", (chunk) => {
      workerOutput = (workerOutput + chunk.toString()).slice(-1_048_576);
    });
    workerStopped = new Promise((resolve) => worker.once("exit", resolve));
    await waitForNativeRoot(worker, origin, {
      milliseconds: 90_000,
      interval: 250,
      requestMilliseconds: 1_000,
      label: "Local production root readiness",
    }).catch((cause) => {
      const diagnostics = stripVTControlCharacters(workerOutput)
        .split("\n")
        .filter((line) => line.includes("[ERROR]") || line.startsWith("Error:"))
        .slice(-10)
        .join("\n");
      throw new Error(
        `Local production root did not become ready: ${diagnostics || cause.message}`,
        { cause },
      );
    });
    log("PASS local standalone root readiness");
    const packed = await packApps();
    const headers = {
      Authorization: `Bearer ${ownerKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    let installationRequestId;
    const installed = await installRelease({
      directory: join(work, "release"),
      url: origin,
      key: ownerKey,
      installationId: "tourtois",
      onAdmitted: (operation) => {
        installationRequestId = operation.requestId;
      },
    });
    assert.equal(
      installed.status,
      201,
      "Actual Tourtois installation must be admitted before any model call",
    );
    await installed.body?.cancel();
    assert.ok(
      installationRequestId,
      "Retain the correlated installation request",
    );
    const status = new URL("/api/installations/tourtois/status", origin);
    status.searchParams.set("requestId", installationRequestId);
    const observed = await fetch(status, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(observed.status, 200);
    const operation = installationOperationSchema.parse(await observed.json());
    assert.equal(operation.requestId, installationRequestId);
    assert.equal(operation.installationId, "tourtois");
    assert.equal(operation.state, "succeeded");
    assert.equal(
      operation.release.artifact.artifactDigest,
      packed.release.artifact.artifactDigest,
    );
    const dashboardApproval = await approveChosenDashboard(
      operation,
      (method, path, body) => {
        /** @type {RequestInit} */
        const request = {
          method,
          headers,
          signal: AbortSignal.timeout(15_000),
        };
        if (body !== undefined) request.body = JSON.stringify(body);
        return fetch(new URL(path, origin), request);
      },
    );
    assert.ok(
      dashboardApproval,
      "Approve only the fresh chosen dashboard's shell",
    );
    const groveInstalled = await installRelease({
      directory: join(work, "grove-release"),
      url: origin,
      key: ownerKey,
      installationId: "grove",
    });
    assert.equal(groveInstalled.status, 201, "Install the real fleet caller");
    const getLayout = async () => {
      const response = await fetch(
        `${origin}/apps/tourtois/methods/layout.get`,
        {
          method: "POST",
          headers,
          body: "{}",
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status !== 200) {
        let detail = await response.clone().text();
        for (const [name, value] of Object.entries(process.env))
          if (value && /TOKEN|SECRET|KEY|PASSWORD|ACCOUNT|GATEWAY/iu.test(name))
            detail = detail.replaceAll(value, "<REDACTED>");
        detail = detail.replaceAll(ownerKey, "<REDACTED>");
        if (process.env.TOURTOIS_AGENT_RECEIPT)
          await writeFile(
            process.env.TOURTOIS_AGENT_RECEIPT + ".preflight.json",
            JSON.stringify(
              {
                runtime,
                sourceRevision,
                phase: "storage/catalog before inference",
                status: response.status,
                detail,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
      }
      assert.equal(
        response.status,
        200,
        `Actual storage/catalog method path returned ${response.status} before inference; inspect the redacted preflight receipt`,
      );
      return desktopSnapshotSchema.parse(await response.json());
    };
    const before = await getLayout();
    assert.equal(before.source, "none");
    log("PASS actual storage/catalog method preflight; inference not started");
    const created = await fetch(`${origin}/agents`, {
      method: "POST",
      headers: { ...headers, "X-Oyster-Installation": "grove" },
      body: JSON.stringify({
        name: "Desktop proof",
        requestId: "desktop-proof-owner-agent",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(
      created.status,
      200,
      `Create the Agent through the real owner fleet directory (${created.status})`,
    );
    const { agentId } = Schema.decodeUnknownSync(appAgentSchema)(
      await created.json(),
    );
    client = createShiitakeClient({
      baseUrl: `${origin}/agents/${agentId}`,
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.set("Authorization", `Bearer ${ownerKey}`);
        request.headers.set("X-Oyster-Installation", "grove");
        return fetch(request);
      },
    });
    const sessionId = await client.createSession("desktop-headless-proof");
    session = client.session(sessionId);
    log("START one local @fungi/luna command");
    const accepted = await session.send(
      `You are running on ${runtime}, using @fungi/luna. No browser tab is open. Use the installed TOURTOIS App's ordinary methods, not a browser command or host endpoint. Discover TOURTOIS.layout.get and TOURTOIS.layout.resize through forage.describe. Read the layout, select its existing Launcher instance, then make ONE member layout.resize to S using that read's memberRevision as basedOn. On any refusal, stop and report it without retrying. Read back the layout and report the Launcher id, size and revision and the runtime name. Do not change the Team default, create any keys, use any other App, or perform additional edits.`,
    );
    const deadline = Date.now() + 120_000;
    let result;
    for (;;) {
      result = await session.read({ limit: 200 });
      const terminal = result.terminals.find(
        (item) => item.commandId === accepted.commandId,
      );
      if (terminal) {
        assert.equal(
          terminal.outcome,
          "completed",
          "The real Luna command must complete",
        );
        break;
      }
      assert.ok(
        Date.now() < deadline,
        "Real Luna proof did not settle within its finite test deadline",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const after = await getLayout();
    assert.equal(after.source, "member");
    assert.equal(after.memberRevision, 1, "Exactly one accepted layout edit");
    assert.equal(
      after.layout.items.find((item) => item.gillId === "launcher")?.size,
      "S",
    );
    const receipt = {
      runtime,
      composition: "maintained Oyster worker host and StandaloneAgent",
      model: "@fungi/luna",
      sourceRevision,
      releaseId: packed.release.releaseId,
      dashboardApproval,
      agentId,
      sessionId,
      commandId: accepted.commandId,
      before,
      after,
      messages: result.messages.map((item) => item.value),
      terminals: result.terminals,
    };
    if (process.env.TOURTOIS_AGENT_RECEIPT) {
      let text = JSON.stringify(receipt, null, 2);
      for (const name of required)
        text = text.replaceAll(process.env[name], "<REDACTED>");
      await writeFile(process.env.TOURTOIS_AGENT_RECEIPT, text + "\n", {
        mode: 0o600,
      });
    }
    log(
      `PASS @fungi/luna changed Tourtois through ordinary methods with no tab; runtime: ${runtime}`,
    );
  } finally {
    try {
      // Addressed Sessions own no observation resource; the client owns cleanup.
      await client?.close();
    } finally {
      try {
        if (worker && worker.exitCode === null) {
          worker.kill("SIGTERM");
          await Promise.race([
            workerStopped,
            new Promise((resolve) => setTimeout(resolve, 3_000)),
          ]);
          if (worker.exitCode === null && worker.pid !== undefined) {
            // A detached child owns its process group; no other lane is in it.
            process.kill(-worker.pid, "SIGKILL");
            await workerStopped;
          }
        }
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
  }
}

await runProof().catch((cause) => {
  let message =
    cause instanceof Error ? cause.message : "Tourtois Agent proof failed";
  // Captured-source build errors retain the compiler cause; keep it visible
  // without expanding runtime/model errors or dumping their payloads.
  if (cause instanceof Error && cause.message.startsWith("App Publisher ")) {
    let compilerCause = cause.cause;
    for (let depth = 0; depth < 8 && compilerCause instanceof Error; depth++) {
      message += `\nBuild cause: ${compilerCause.message}`;
      compilerCause = compilerCause.cause;
    }
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      value.length >= 8 &&
      /TOKEN|SECRET|KEY|PASSWORD|ACCOUNT|GATEWAY/iu.test(name)
    )
      message = message.replaceAll(value, "<REDACTED>");
  }
  log(`FAIL local standalone (workerd), not hosted: ${message.slice(0, 8000)}`);
  process.exitCode = 1;
});
