// Standalone acceptance path, based on mesh-task-reconnect.e2e.mjs.
// Run from the repository root through maintained proof admission:
// node --import tsx --test packages/oyster/test/standalone/machine-link.native.mjs
// A first-boundary RED does not qualify the later assertions.
// Only the hosted and Local models are deterministic. No fake enrollment,
// machine authority, mail, Accepted identity, replay store or settlement.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createTlsServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import { EventSource } from "eventsource";
import { build } from "esbuild";
import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { sha256 } from "@fungi.computer/oyster/host";
import { seamHeader } from "@fungi.computer/seam";
import { appBackend as groveBackend } from "../../../../apps/grove/backend/methods.ts";
import groveMetadata from "../../../../apps/grove/package.json" with { type: "json" };
import {
  messageAuthor,
  messageDelegationReply,
} from "@fungi.computer/agar/agents";
import {
  createShiitakeClient,
  parseAccepted,
  parseSessionSnapshot,
} from "@fungi.computer/shiitake/client";
import { createPrivateLocalServiceManager } from "../../../../runtimes/local/dist/private-local-service.js";
import { readServiceRecord } from "../../../../runtimes/local/dist/private-local-service-discovery.js";
import { capturePrivateLocalConfigRoot } from "../../../../runtimes/local/dist/private-local-config-root.js";
import {
  createLocalMachineEnrollmentAccount,
  signOutFungiAccount,
} from "../../../../runtimes/local/dist/private-fungi-account.js";
import { meshNetwork } from "../../../../apps/hub/test/mesh-network.fixture.mjs";
import { waitForNativeWorker } from "../../../../apps/hub/test/native-worker-ready.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const { AbortSignal, fetch, Headers, Request, TextEncoder } = globalThis;
// Reuse the dev platform's maintained HTTP/WebSocket proxy, with this
// worktree's dependency installation. No protocol framing is owned here.
const { createProxyMiddleware } = createRequire(
  new URL("../../../../tooling/celld-platform/package.json", import.meta.url),
)("http-proxy-middleware");
process.env.CELLD_PLATFORM_CELLD = execFileSync(
  "bash",
  [resolve(root, "tooling/celld-platform/runtime/pinned-celld.sh")],
  { encoding: "utf8", env: { ...process.env, CELLD: "" } },
).trim();
await import("../../../../tooling/celld-platform/runtime/wrangler-on-celld.mjs");

async function until(label, read, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const { port } = z.object({ port: z.number() }).parse(server.address());
  await new Promise((done, fail) =>
    server.close((error) => (error ? fail(error) : done())),
  );
  return port;
}

const json = (body, headers = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

await test("standalone owner enrolls Local once; lost ACK preserves Accepted and execution; idle logout closes in 3s; restart refuses captured dial", async (t) => {
  await mkdir(resolve(root, ".botanical"), { recursive: true });
  const work = await mkdtemp(resolve(root, ".botanical/oyster-machine-link-"));
  const home = resolve(work, "local-home");
  const directory = resolve(home, "service");
  const project = resolve(home, "project");
  const executions = resolve(work, "executions");
  const release = resolve(work, "release");
  await mkdir(directory, { recursive: true });
  await mkdir(project, { recursive: true });
  let child;
  let closed;
  let connection;
  let worker;
  let network;
  let secureEdge;
  const edgeSockets = new Set();
  let joins = 0;
  let bearerJoins = 0;
  const dials = [];
  const restarted = Promise.withResolvers();
  const localOutput = [];
  const ownerKey = randomBytes(24).toString("hex");
  let enrollmentKey;
  const redact = (text) => {
    let safe = text.replaceAll(ownerKey, "[owner key]");
    if (enrollmentKey)
      safe = safe.replaceAll(enrollmentKey, "[enrollment key]");
    return safe;
  };
  const diagnostic = (text) => {
    process.stderr.write(`${redact(text)}\n`);
    t.diagnostic(redact(text));
  };

  try {
    const keyPath = resolve(work, "edge-key.pem");
    const certPath = resolve(work, "edge-cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { stdio: "ignore" },
    );
    child = spawn(
      "bun",
      [
        resolve(root, "apps/hub/test/mesh-task-local.fixture.mjs"),
        directory,
        executions,
        release,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: home,
          TMPDIR: tmpdir(),
          NODE_EXTRA_CA_CERTS: certPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    closed = once(child, "close");
    child.stdout.on("data", (chunk) => localOutput.push(String(chunk)));
    child.stderr.on("data", (chunk) => localOutput.push(String(chunk)));
    const local = await until("real Local service registration", async () => {
      assert.equal(child.exitCode, null, redact(localOutput.join("")));
      const record = await readServiceRecord(directory);
      return record?.pid === child.pid ? record : undefined;
    });
    const manager = createPrivateLocalServiceManager({ home, directory });
    connection = await manager.connect({
      invocationRoot: project,
      sessionId: "main",
    });
    assert.equal(connection.service.pid, child.pid);
    t.diagnostic("Real Local listener and Agent store opened");

    const port = await freePort();
    network = await meshNetwork(`http://127.0.0.1:${String(port)}`);
    const proxy = createProxyMiddleware({
      target: network.origin,
      on: {
        proxyReq: (_forwarded, incoming) => {
          if (
            incoming.method === "POST" &&
            incoming.url === "/local/mesh/join"
          ) {
            joins += 1;
            if (incoming.headers.authorization === `Bearer ${enrollmentKey}`)
              bearerJoins += 1;
          }
        },
        proxyReqWs: (_forwarded, incoming) => {
          dials.push({
            path: incoming.url,
            bearer: incoming.headers.authorization !== undefined,
            signed: incoming.headers[seamHeader] !== undefined,
          });
        },
      },
    });
    secureEdge = createTlsServer(
      {
        key: await readFile(keyPath),
        cert: await readFile(certPath),
      },
      proxy,
    );
    secureEdge.on("upgrade", proxy.upgrade);
    secureEdge.on("connection", (socket) => {
      edgeSockets.add(socket);
      socket.once("close", () => edgeSockets.delete(socket));
    });
    await new Promise((done, fail) => {
      secureEdge.once("error", fail);
      secureEdge.listen(0, "127.0.0.1", done);
    });
    const securePort = z
      .object({ port: z.number() })
      .parse(secureEdge.address()).port;
    // Registry tenant origins require HTTPS. Match mcp-workflows.native.mjs:
    // --local-upstream and --upstream-protocol supply the canonical authority
    // through the maintained, certificate-verifying dev transport. Do not seed
    // an HTTP loopback origin or weaken the registry's origin policy.
    // Local signs the real public HTTPS URL; the Worker sees that exact
    // authority too. Bun verifies the generated certificate via its extra CA.
    const tenantHost = `127.0.0.1:${String(securePort)}`;
    const tenantOrigin = `https://${tenantHost}`;
    // The generated entry changes only model inference, following the retained
    // standalone agents-sandbox fixture. All routes and host composition remain
    // the real standalone Worker. No Hub Team or auth fixture is composed here.
    const source = (path) => JSON.stringify(resolve(root, path));
    const entrypoint = resolve(work, "worker.ts");
    await writeFile(
      entrypoint,
      `
import { StandaloneAgent as ProductionAgent } from ${source("packages/oyster/src/standalone/worker.ts")};
export * from ${source("packages/oyster/src/standalone/worker.ts")};
export { default } from ${source("packages/oyster/src/standalone/worker.ts")};
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
export class StandaloneAgent extends ProductionAgent {
  protected override modelSource() {
    const faux = fauxProvider();
    return { acquire: () => Promise.resolve({
      retryable: () => false,
      model: faux.getModel(),
      stream: (model, context, options) => {
        const last = context.messages.at(-1);
        const text = last?.role === "user" && typeof last.content === "string"
          ? last.content : "";
        const prefix = "Machine-link proof: ";
        faux.setResponses([text.startsWith(prefix)
          ? fauxAssistantMessage(fauxToolCall("execute", {
              code: text.slice(prefix.length),
            }), { stopReason: "toolUse" })
          : fauxAssistantMessage("Creator awake")]);
        return faux.provider.streamSimple(model, context, options);
      },
      release: () => Promise.resolve(),
    }) };
  }
}
`,
    );
    const config = parseJsonc(
      await readFile(
        resolve(root, "packages/oyster/deploy/wrangler.celld.jsonc"),
        "utf8",
      ),
    );
    config.main = entrypoint;
    config.vars = {
      ...config.vars,
      OYSTER_ORIGIN: tenantOrigin,
      OYSTER_OWNER_KEY: ownerKey,
    };
    const configPath = resolve(work, "wrangler.json");
    await writeFile(configPath, JSON.stringify(config));
    let processOutput = "";
    let oysterProcess;
    let oysterClosed;
    worker = {
      output: () => processOutput,
      start: async () => {
        oysterProcess = spawn(
          process.execPath,
          [
            resolve(root, "node_modules/wrangler/bin/wrangler.js"),
            "dev",
            "--config",
            configPath,
            "--local",
            "--ip",
            "127.0.0.1",
            "--port",
            String(port),
            "--persist-to",
            resolve(work, "state"),
            "--local-upstream",
            tenantHost,
            "--upstream-protocol",
            "https",
            "--show-interactive-dev-session=false",
          ],
          {
            cwd: root,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              HOME: work,
              XDG_CONFIG_HOME: work,
              CI: "true",
              WRANGLER_SEND_METRICS: "false",
              CELLD_PLATFORM_LOGS: "1",
            },
          },
        );
        oysterClosed = once(oysterProcess, "close");
        await waitForNativeWorker(oysterProcess, `${network.origin}/login`, {
          appendOutput: (chunk) => {
            processOutput += String(chunk);
          },
          output: () => redact(processOutput),
          timeoutMs: 30_000,
        });
      },
      stop: async () => {
        if (!oysterProcess) return;
        try {
          if (
            oysterProcess.exitCode === null &&
            oysterProcess.signalCode === null
          ) {
            process.kill(-oysterProcess.pid, "SIGTERM");
            await Promise.race([oysterClosed, delay(5_000)]);
            try {
              process.kill(-oysterProcess.pid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
          }
          await oysterClosed;
        } finally {
          oysterProcess = undefined;
        }
      },
    };
    await worker.start();

    const request = async (path, init = {}, status = 200) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${ownerKey}`);
      if (path.startsWith("/agents"))
        headers.set("X-Oyster-Installation", "grove");
      const response = await fetch(`${network.origin}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      assert.equal(
        response.status,
        status,
        `${path}: ${redact(body)}\n${redact(worker.output().slice(-3000))}`,
      );
      return body === "" ? undefined : JSON.parse(body);
    };
    // Backend-only App installation follows mcp-workflows.native.mjs. Use the
    // real Grove backend/declaration for fleet and Session admission; this
    // headless proof needs no UI or Browser Rendering binding.
    const persist = async (value) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const digest = await sha256(bytes);
      const artifactRef = `artifact:sha256-${digest.slice(7)}`;
      await request(
        `/api/artifacts/${artifactRef}?digest=${digest}`,
        {
          method: "PUT",
          body: bytes,
        },
        204,
      );
      return { artifactRef, digest, byteLength: bytes.length, version: digest };
    };
    const recipe = {
      entryPoints: [resolve(root, "apps/grove/backend/index.ts")],
      bundle: true,
      write: false,
      minify: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*"],
      target: "es2022",
    };
    const bundled = await build(recipe);
    const backend = {
      ...(await persist({
        runtime: { kind: "durable-facet", stateSchema: 1 },
        compatibilityDate: "2026-09-04",
        exportName: "Grove",
        code: bundled.outputFiles[0].text,
      })),
      mediaType: backendMediaType,
    };
    const declaration = buildAppDeclaration(
      groveBackend,
      groveMetadata.fungi.app,
    );
    const artifact = await persist(createAppBuild(null, backend, declaration));
    await request(
      "/api/installations",
      json(
        {
          installationId: "grove",
          release: {
            appId: "app_grove",
            releaseId: "rel_machinelinkproof",
            artifact: {
              artifactRef: artifact.artifactRef,
              artifactDigest: artifact.digest,
              provenance: {
                sourceRevision: `git:${execFileSync(
                  "git",
                  ["rev-parse", "HEAD"],
                  {
                    cwd: root,
                    encoding: "utf8",
                  },
                ).trim()}`,
                // Fixture inputs are the actual bundled backend plus declaration,
                // not a claim that this is a production App-set publication.
                sourceTreeDigest: await sha256(
                  new TextEncoder().encode(
                    JSON.stringify({
                      code: bundled.outputFiles[0].text,
                      declaration,
                    }),
                  ),
                ),
                buildRecipeDigest: await sha256(
                  new TextEncoder().encode(JSON.stringify(recipe)),
                ),
              },
            },
          },
        },
        // The durable installation owner identifies each install request.
        { "Idempotency-Key": "machine-link-proof-grove" },
      ),
      // The durable installation owner admits the request, then installs it.
      202,
    );
    await until("Grove installation succeeded", async () => {
      const operation = z
        .object({ state: z.string() })
        .parse(
          await request(
            "/api/installations/grove/status?requestId=machine-link-proof-grove",
          ),
        );
      assert.ok(
        operation.state === "pending" ||
          operation.state === "queued" ||
          operation.state === "succeeded",
        `Grove installation ended ${operation.state}`,
      );
      return operation.state === "succeeded";
    });
    diagnostic("Backend-only Grove installed through the real owner route");
    const issued = z
      .object({
        plaintext: z.string().startsWith("oyk_"),
      })
      .parse(
        await request(
          "/api/keys",
          json({
            name: "laptop-enrollment",
            grants: [
              { capability: "machine.enroll", targets: { kind: "all" } },
            ],
          }),
          201,
        ),
      );
    enrollmentKey = issued.plaintext;
    t.diagnostic("Owner minted the real machine.enroll key");

    // Exactly one real Local service join spends the ephemeral key. There is
    // no direct Oyster enrollment probe and no OAuth-shaped fixture credential.
    const credentialPath = capturePrivateLocalConfigRoot(home).credentialPath;
    const response = await fetch(
      `${local.baseUrl}/service/${local.serviceId}/mesh/join`,
      {
        ...json({
          kind: "oyster-key",
          origin: tenantOrigin,
          key: enrollmentKey,
          invocationRoot: project,
          agents: [connection.agentId],
          machineLabel: "Laptop",
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const joinBody = await response.text();
    assert.equal(response.status, 202, `Local /mesh/join: ${redact(joinBody)}`);
    const joined = z
      .object({
        state: z.literal("enrolled"),
        deviceId: z.string(),
        agents: z
          .array(z.object({ selection: z.number(), agentId: z.string() }))
          .length(1),
      })
      .parse(JSON.parse(joinBody));
    const saved =
      await createLocalMachineEnrollmentAccount(credentialPath).read();
    const sourceRecord = saved.find(
      (record) => record.kind === "oyster" && record.origin === tenantOrigin,
    );
    assert.ok(sourceRecord);
    const enrolled = sourceRecord.enrollments[0];
    assert.equal(saved.length, 1);
    assert.equal(sourceRecord.enrollments.length, 1);
    assert.equal(enrolled?.state, "enrolled");
    assert.deepEqual(enrolled.target, { kind: "oyster" });
    assert.equal(enrolled.deviceId, joined.deviceId);
    assert.ok(enrolled.scopeId);
    assert.deepEqual(enrolled.bindings, joined.agents);
    assert.equal(joins, 1, "Local makes exactly one enrollment POST");
    assert.equal(bearerJoins, 1, "only enrollment uses the machine.enroll key");
    assert.equal(
      (await readFile(credentialPath, "utf8")).includes(enrollmentKey),
      false,
    );
    diagnostic(
      `Local enrolled ${joined.deviceId} in scope ${enrolled.scopeId}; key not persisted`,
    );
    await until("authenticated outbound upgrade", () => network.upgrades() > 0);
    diagnostic("Authenticated device-key upgrade observed");

    const creator = z
      .object({ agentId: z.string() })
      .parse(
        await request(
          "/agents",
          json({ name: "Hosted creator", requestId: "machine-link-creator" }),
        ),
      );
    const callerSession = z
      .object({ sessionId: z.string() })
      .parse(
        await request(
          `/agents/${creator.agentId}/sessions`,
          json({ requestId: "machine-link-creator-session" }),
          201,
        ),
      );
    const readSnapshot = async () =>
      parseSessionSnapshot(
        JSON.stringify(
          await request(
            `/agents/${creator.agentId}/sessions/${callerSession.sessionId}`,
          ),
        ),
      );
    const ownerFetch = (input, init) => {
      const outgoing = new Request(input, init);
      assert.equal(new URL(outgoing.url).origin, network.origin);
      outgoing.headers.set("authorization", `Bearer ${ownerKey}`);
      outgoing.headers.set("X-Oyster-Installation", "grove");
      return fetch(outgoing);
    };
    class OwnerEventSource extends EventSource {
      constructor(url, init) {
        super(url, { ...init, fetch: ownerFetch });
      }
    }
    // Retained watch/reconnect pattern. The actual creator's restart must
    // report UNKNOWN, not fabricate a successful send or replay arbitrary code.
    const prompt = async (
      code,
      requestId,
      observeAfter = Promise.resolve(),
    ) => {
      const accepted = parseAccepted(
        JSON.stringify(
          await request(
            `/agents/${creator.agentId}/sessions/${callerSession.sessionId}/command`,
            json({
              command: {
                requestId,
                type: "prompt",
                delivery: "followUp",
                text: `Machine-link proof: ${code}`,
              },
            }),
          ),
        ),
      );
      // For the deliberately interrupted command, open a fresh ordinary
      // Session watch after process restart. The old HTTP stream dies with
      // that process; its liveness is not the persisted command's outcome.
      await observeAfter;
      const client = createShiitakeClient({
        baseUrl: `${network.origin}/agents/${creator.agentId}`,
        eventSource: OwnerEventSource,
        fetch: ownerFetch,
      });
      const deadline = AbortSignal.timeout(30_000);
      const close = () => void client.close();
      deadline.addEventListener("abort", close, { once: true });
      let result;
      let terminal;
      const inspect = (snapshot) => {
        result =
          snapshot.messages.find(
            ({ commandId, value }) =>
              commandId === accepted.commandId && value.role === "toolResult",
          )?.value ?? result;
        terminal =
          snapshot.terminals.find(
            ({ commandId }) => commandId === accepted.commandId,
          ) ?? terminal;
        if (terminal && terminal.outcome !== "completed")
          throw new Error(`Creator failed: ${terminal.outcome}`);
        return terminal?.outcome === "completed" ? result : undefined;
      };
      try {
        const watch = await client.session(callerSession.sessionId).watch();
        const initial = inspect(watch.snapshot);
        if (initial) return initial;
        for await (const frame of watch.changes) {
          if (frame.kind !== "update" && frame.kind !== "reset") continue;
          if (frame.kind === "reset") {
            result = undefined;
            terminal = undefined;
          }
          const settled = inspect(
            frame.kind === "reset" ? frame.baseline : frame,
          );
          if (settled) return settled;
        }
        throw new Error("Creator watch ended without settlement");
      } catch (error) {
        const { messages, terminals, activity } = await readSnapshot();
        diagnostic(
          `Creator snapshot for ${accepted.commandId}: ${JSON.stringify({ messages, terminals, activity })}`,
        );
        throw error;
      } finally {
        deadline.removeEventListener("abort", close);
        await client.close();
      }
    };
    const payload = (result) => {
      assert.equal(result.isError, false, JSON.stringify(result));
      return JSON.parse(
        z
          .string()
          .parse(result.content.find((part) => part.type === "text")?.text),
      );
    };
    const agentId = joined.agents[0].agentId;
    const localSession = z.object({ sessionId: z.string() }).parse(
      payload(
        await prompt(
          `return await agents.createSession(${JSON.stringify({
            agentId,
            requestId: "machine-link-local-session",
          })});`,
          "local-session",
        ),
      ),
    );
    const task = {
      agentId,
      sessionId: localSession.sessionId,
      requestId: "machine-link-execute-once",
      text: "Return Local mesh result",
      delivery: "followUp",
    };
    let sequence = 0;
    const send = (observeAfter) =>
      prompt(
        `return await agents.send(${JSON.stringify(task)});`,
        `send-${String(sequence++)}`,
        observeAfter,
      );
    network.holdReplies();
    const sending = send(restarted.promise);
    const outcome = Promise.allSettled([sending]);
    t.after(async () => {
      for (const result of await outcome)
        if (result.status === "rejected") throw result.reason;
    });
    await until("Local begins the task", async () => {
      try {
        return (await readFile(executions, "utf8")) === "executed\n";
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return false;
      }
    });
    const admitted = await connection.client
      .session(localSession.sessionId)
      .read();
    const delivered = admitted.messages.filter(
      ({ value }) => value.role === "user",
    );
    assert.equal(delivered.length, 1);
    const commandId = z.string().min(1).parse(delivered[0]?.commandId);
    const upgrades = network.upgrades();
    // Same-process creator and receiver: restart interrupts execute. Retain the
    // exact warning from the real model runtime instead of inventing an ACK.
    await worker.stop();
    network.disconnect();
    await worker.start();
    assert.equal(await network.replayFirstDial(), 403);
    diagnostic("Captured old signed dial refused with HTTP 403 after restart");
    await until(
      "fresh automatic reconnect",
      () => network.upgrades() > upgrades,
    );
    restarted.resolve();
    const interrupted = await sending;
    assert.equal(interrupted.isError, true);
    assert.deepEqual(interrupted.content, [
      {
        type: "text",
        text: "Interrupted by a restart; it may or may not have completed; check before retrying.",
      },
    ]);
    const first = payload(await send());
    assert.equal(first.status, "accepted");
    assert.equal(first.commandId, commandId);
    assert.deepEqual(payload(await send()), first);
    diagnostic(
      `Lost-ACK replay preserved original Accepted commandId ${commandId}`,
    );
    await writeFile(release, "finish");
    await until("settlement wakes the creator", async () => {
      const snapshot = await readSnapshot();
      const reply = snapshot.messages.find(({ value, meta }) => {
        const author = messageAuthor(meta);
        const facts = messageDelegationReply(meta);
        return (
          value.role === "user" &&
          author?.kind === "agent" &&
          author.id === agentId &&
          facts?.agentId === agentId &&
          facts.sessionId === localSession.sessionId &&
          facts.commandId === commandId &&
          facts.outcome === "completed" &&
          JSON.stringify(value).includes("Local mesh result")
        );
      });
      return (
        reply &&
        snapshot.terminals.some(
          (row) =>
            row.commandId === reply.commandId && row.outcome === "completed",
        )
      );
    });
    assert.equal(await readFile(executions, "utf8"), "executed\n");
    diagnostic(
      "Local executed once; matching settlement woke and completed the creator turn",
    );
    const finished = await connection.client
      .session(localSession.sessionId)
      .read();
    assert.equal(
      finished.terminals.filter(({ outcome: value }) => value === "completed")
        .length,
      1,
    );
    // No task/frame is sent after this point to provoke socket closure. Measure
    // from the logout invocation, including credential removal and invalidation.
    assert.equal(network.connections(), 1, "logout starts with an idle socket");
    const logoutStart = performance.now();
    const logout = await signOutFungiAccount(tenantOrigin, {
      credentialPath,
      serviceDirectory: directory,
    });
    assert.equal(logout.kind, "removed");
    await until(
      "idle logout closes without a next frame",
      () => network.connections() === 0,
      Math.max(1, 3_000 - (performance.now() - logoutStart)),
    );
    const elapsed = performance.now() - logoutStart;
    assert.ok(elapsed <= 3_000, `idle logout took ${String(elapsed)}ms`);
    t.diagnostic(`Idle socket closed ${String(elapsed)}ms after logout`);
    assert.equal((await manager.status())?.pid, child.pid);
    assert.deepEqual(
      await createLocalMachineEnrollmentAccount(credentialPath).read(),
      [],
    );
    await delay(1_100);
    assert.equal(network.connections(), 0);
    assert.equal(await readFile(executions, "utf8"), "executed\n");
    assert.equal(
      joins,
      1,
      "restart/reconnect/logout never reuse enrollment bearer",
    );
    assert.ok(
      dials.length >= 2,
      "initial dial and automatic reconnect observed",
    );
    for (const dial of dials) {
      assert.equal(
        dial.path,
        `/api/teams/${encodeURIComponent(enrolled.scopeId)}/local/mesh/${encodeURIComponent(joined.deviceId)}/connect`,
      );
      assert.equal(
        dial.bearer,
        false,
        "device dials carry no enrollment bearer",
      );
      assert.equal(dial.signed, true, "device dials carry the Seam signature");
    }
  } catch (error) {
    diagnostic(error.stack ?? String(error));
    diagnostic(worker?.output().slice(-5000) ?? "Oyster not started");
    diagnostic(JSON.stringify(network?.lastHTTPFailure() ?? null));
    diagnostic(localOutput.join("").slice(-5000));
    throw error;
  } finally {
    restarted.resolve();
    await writeFile(release, "finish");
    await connection?.close();
    if (child?.exitCode === null) child.kill("SIGTERM");
    await closed;
    await network?.close();
    if (secureEdge) {
      for (const socket of edgeSockets) socket.destroy();
      secureEdge.closeAllConnections();
      await new Promise((done, fail) =>
        secureEdge.close((error) => (error ? fail(error) : done())),
      );
    }
    await worker?.stop();
    await rm(work, { recursive: true, force: true });
  }
});
