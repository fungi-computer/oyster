import process from "node:process";
import { error } from "node:console";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:net";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { clearInterval, setInterval } from "node:timers";
import { build } from "esbuild";
import { parse as parseJsonc } from "jsonc-parser";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { sha256 } from "@fungi.computer/oyster/host";
import { installOnOyster } from "../../dist/installation-client.js";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";
import { labComputer } from "./lab-computer.fixture.mjs";
import {
  installProofContainerTrap,
  proofContainerDockerfile,
} from "../../../../tooling/proof-containers/proof-janitor.mjs";
import { waitForNativeRoot } from "../native-root-readiness.fixture.mjs";

export async function until(read, accepts, label, milliseconds = 60_000) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await delay(100);
  }
}

export async function nativeFixturePort() {
  return new Promise((resolve) => {
    const socket = createServer().listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

export async function nativeFixtureWorkspace(root, prefix) {
  await mkdir(`${root}.botanical`, { recursive: true });
  return {
    work: await mkdtemp(`${root}.botanical/${prefix}`),
    config: parseJsonc(
      await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
    ),
  };
}

export function nativeArtifactBucket(config, name) {
  config.r2_buckets = config.r2_buckets.map((bucket) =>
    bucket.binding === "APP_ARTIFACTS"
      ? { ...bucket, bucket_name: name }
      : bucket,
  );
}

const firstPartyApps = {
  trellis: {
    entry: new URL(
      "../../../../apps/trellis/backend/index.ts",
      import.meta.url,
    ),
    exportName: "Trellis",
  },
  bonsai: {
    entry: new URL("../../../../apps/bonsai/backend/index.ts", import.meta.url),
    exportName: "BonsaiApp",
  },
};

function observeNativeWorker(worker, onOutput) {
  let output = "";
  const capture = (chunk) => {
    output += chunk;
    onOutput(chunk);
  };
  worker.stdout.setEncoding("utf8").on("data", capture);
  worker.stderr.setEncoding("utf8").on("data", capture);
  return {
    output: () => output,
    stopped: new Promise((resolve) => worker.once("exit", resolve)),
  };
}

const upstreamProxy = fileURLToPath(
  new URL(
    "../../../../tooling/celld-platform/runtime/local-upstream-proxy.mjs",
    import.meta.url,
  ),
);

/** Whether a child of `parent` runs the pinned celld executable. */
function pinnedCelldChild(parent, pinned) {
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/u.test(entry)) continue;
    try {
      const stat = readFileSync("/proc/" + entry + "/stat", "utf8");
      const [, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (
        Number(ppid) === parent &&
        readlinkSync("/proc/" + entry + "/exe") === pinned
      )
        return true;
    } catch (cause) {
      // A process may exit between listing /proc and reading its entries.
      if (cause?.code === "ENOENT" || cause?.code === "ESRCH") continue;
      throw cause;
    }
  }
  return false;
}

/** The proof runs the pinned celld, never in-process Miniflare: either
 * directly, or as the child of the maintained local-upstream proxy that
 * wrangler-on-celld launches for an upstream origin. The proxied child is
 * observed in /proc; a worker that ends without it fails the proof. */
function verifyNativeRuntime(worker, binary) {
  if (worker.spawnfile === binary) return;
  const message =
    "the proof actually launched the pinned celld binary, not in-process Miniflare";
  assert.equal(worker.spawnfile, process.execPath, message);
  assert.equal(
    realpathSync(worker.spawnargs[1]),
    realpathSync(upstreamProxy),
    message,
  );
  assert.equal(JSON.parse(worker.spawnargs[2]).binary, binary, message);
  const pinned = realpathSync(binary);
  let observed = false;
  const poll = setInterval(() => {
    observed = pinnedCelldChild(worker.pid, pinned);
    if (observed) clearInterval(poll);
  }, 100);
  worker.once("exit", () => {
    clearInterval(poll);
    assert.ok(observed, message + " behind the upstream proxy");
  });
}

function nativeWorker({
  root,
  work,
  main,
  port,
  key,
  oysterOrigin,
  gitOrigin,
  localUpstream,
  onOutput,
  variables,
  redact,
  engine,
}) {
  const worker = spawn(
    `${root}node_modules/.bin/wrangler`,
    [
      "dev",
      main,
      "--config",
      `${work}/wrangler.json`,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      `${work}/state`,
      ...localUpstream,
      "--var",
      `OYSTER_OWNER_KEY:${key}`,
      "--var",
      `OYSTER_ORIGIN:${oysterOrigin}`,
      "--var",
      `GIT_ORIGIN:${gitOrigin}`,
      ...Object.entries(variables).flatMap(([name, value]) => [
        "--var",
        `${name}:${value}`,
      ]),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  if (engine.binary !== null) verifyNativeRuntime(worker, engine.binary);
  const { output, stopped } = observeNativeWorker(worker, (chunk) =>
    onOutput?.(redact(chunk)),
  );
  return {
    get exitCode() {
      return worker.exitCode;
    },
    diagnostics: () => redact(output()),
    async stop() {
      worker.kill("SIGTERM");
      await stopped;
    },
  };
}

function nativeEngine() {
  const binary = process.env.CELLD_PLATFORM_CELLD;
  return binary
    ? { name: "celld", localCodeDevelopment: "false", binary }
    : { name: "workerd", localCodeDevelopment: "true", binary: null };
}

/** Async Git keeps the in-process provider able to answer this command. */
export async function runNativeGit(args, { cwd, env }) {
  const child = spawn("git", args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

function nativeGitClient(work, redact) {
  return async (...args) => {
    const result = await runNativeGit(args, { cwd: work });
    assert.equal(result.status, 0, redact(result.stderr));
    return result.stdout.trim();
  };
}

export function nativeAppClient(
  origin,
  auth,
  {
    key,
    requestMilliseconds,
    installationMilliseconds,
    publicationMilliseconds = 60_000,
  } = {},
) {
  const jsonHeaders = { ...auth, "Content-Type": "application/json" };
  const requestOptions = () =>
    requestMilliseconds === undefined
      ? {}
      : { signal: globalThis.AbortSignal.timeout(requestMilliseconds) };
  const call = async (installation, method, input, headers = auth) => {
    const response = await globalThis.fetch(
      `${origin}/apps/${installation}/methods/${method}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: globalThis.AbortSignal.timeout(30_000),
      },
    );
    const text = await response.text();
    assert.equal(response.status, 200, `${installation}.${method}: ${text}`);
    return JSON.parse(text);
  };
  const persistBytes = async (bytes) => {
    const digest = await sha256(bytes);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    const response = await globalThis.fetch(
      `${origin}/api/artifacts/${artifactRef}?digest=${digest}`,
      {
        method: "PUT",
        headers: auth,
        body: bytes,
        ...requestOptions(),
      },
    );
    assert.equal(response.status, 204, await response.text());
    return { artifactRef, digest, byteLength: bytes.length, version: digest };
  };
  const persist = (value) =>
    persistBytes(new globalThis.TextEncoder().encode(JSON.stringify(value)));
  const install = async (
    installationId,
    entry,
    exportName,
    declaration,
    ui = null,
  ) => {
    // Digest-verified test App Releases of actual backend source. App build
    // provenance is fixture data; Workflow publication is exercised by callers.
    const bundled = await build({
      entryPoints: [fileURLToPath(entry)],
      bundle: true,
      write: false,
      minify: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*"],
      target: "es2022",
    });
    const backend = {
      ...(await persist({
        runtime: { kind: "durable-facet", stateSchema: 1 },
        compatibilityDate: "2026-09-04",
        exportName,
        code: bundled.outputFiles[0].text,
      })),
      mediaType: backendMediaType,
    };
    const artifact = await persist(createAppBuild(ui, backend, declaration));
    const release = {
      appId: `app_${installationId}`,
      releaseId: `rel_${installationId}`,
      artifact: {
        artifactRef: artifact.artifactRef,
        artifactDigest: artifact.digest,
        provenance: {
          sourceRevision: `git:${"a".repeat(40)}`,
          sourceTreeDigest: artifact.digest,
          buildRecipeDigest: artifact.digest,
        },
      },
    };
    assert.ok(key, "Native installs need the host owner key");
    const operation = await installOnOyster({
      url: origin,
      key,
      installationId,
      release,
      signal:
        installationMilliseconds === undefined
          ? undefined
          : globalThis.AbortSignal.timeout(installationMilliseconds),
    });
    assert.equal(operation.state, "succeeded", JSON.stringify(operation));
    assert.equal(operation.creation, "fresh");
  };
  const approve = async (installationId) => {
    // Installing is not consent: use the current server-returned pins.
    const url = `${origin}/api/installations/${installationId}/grants`;
    const pageResponse = await globalThis.fetch(url, {
      headers: { ...auth, Accept: "application/json" },
    });
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    const response = await globalThis.fetch(url, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        storeGeneration: page.storeGeneration,
        authorityVersion: page.permissions.authority.authorityVersion,
        artifactDigest: page.artifactDigest,
        command: {
          kind: "change-grants",
          changes: page.permissions.declaredOperations.capabilities.map(
            ({ capability, operations }) => ({
              capability,
              grant: { operations, resources: "tenant-scope" },
            }),
          ),
        },
      }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  const installFirstParty = (app, declaration, ui) => {
    const recipe = firstPartyApps[app];
    return install(app, recipe.entry, recipe.exportName, declaration, ui);
  };
  /** Observe publication in the actual App's background lane, never synthesize it. */
  const publish = async (workflowId, expectedRevision) => {
    const reply = await call("trellis", "publishWorkflow", {
      workflowId,
      expectedRevision,
    });
    if (reply.kind !== "publishing") return reply;
    return until(
      () =>
        call("trellis", "publicationStatus", {
          workflowId,
          publicationId: reply.publicationId,
        }),
      (status) => status.kind !== "publishing",
      `${workflowId} publication`,
      publicationMilliseconds,
    );
  };
  return { call, persistBytes, install, installFirstParty, approve, publish };
}

/** Own the real worker/provider lifetime and restart against its own state. */
export async function nativeWorkflowHost({
  root,
  work,
  config,
  port: requestedPort,
  oysterOrigin,
  workerLog,
  variables = {},
  readiness = {},
}) {
  const engine = nativeEngine();
  if (workerLog !== undefined) await writeFile(workerLog, "", { mode: 0o600 });
  config.vars = {
    ...config.vars,
    WORKFLOW_CODE_LOCAL_DEV: engine.localCodeDevelopment,
  };
  await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
  const key = randomBytes(24).toString("hex");
  const provider = await workflowGitProvider();
  const port = requestedPort ?? (await nativeFixturePort());
  const origin = `http://127.0.0.1:${port}`;
  const selectedOrigin = oysterOrigin;
  const auth = { Authorization: `Bearer ${key}` };
  const redact = (text) =>
    Object.values({
      ...variables,
      OYSTER_OWNER_KEY: key,
      OYSTER_ORIGIN: selectedOrigin,
      GIT_ORIGIN: provider.origin,
    }).reduce(
      (message, value) => message.replaceAll(value, "[REDACTED]"),
      String(text),
    );
  const start = () =>
    nativeWorker({
      root,
      work,
      main: config.main,
      port,
      key,
      oysterOrigin: selectedOrigin,
      gitOrigin: provider.origin,
      localUpstream: [
        "--local-upstream",
        new URL(selectedOrigin).hostname,
        "--upstream-protocol",
        "https",
      ],
      onOutput:
        workerLog === undefined
          ? undefined
          : (chunk) => {
              void appendFile(workerLog, chunk);
            },
      variables,
      redact,
      engine,
    });
  let worker = start();
  const ready = (options = {}) =>
    waitForNativeRoot(worker, origin, { ...readiness, ...options });
  return {
    port,
    origin,
    auth,
    key,
    provider,
    redact,
    git: nativeGitClient(work, redact),
    runtime: engine.name,
    get exitCode() {
      return worker.exitCode;
    },
    output: () => worker.diagnostics(),
    diagnostics: () => ({
      worker: worker.diagnostics(),
      requests: provider.requests,
    }),
    ready,
    async recordFailure({ diagnostic, description }) {
      await mkdir(dirname(diagnostic), { recursive: true, mode: 0o700 });
      await writeFile(diagnostic, worker.diagnostics(), { mode: 0o600 });
      error(`${description}; private Worker diagnostics: ${diagnostic}`);
    },
    async restart() {
      await worker.stop();
      worker = start();
      await ready();
    },
    async close() {
      await worker.stop();
      await provider.close();
      await rm(work, { recursive: true, force: true });
    },
  };
}

/** The two App/egress proofs require an operator-owned, already-running VM. */
export async function nativeLabAppHost(root, name) {
  const { port, vars } = await labComputer();
  const { work, config } = await nativeFixtureWorkspace(root, `${name}-`);
  config.main = `${root}test/standalone/landed-push-root.fixture.ts`;
  const tenantHost = "oyster.test";
  const host = await nativeWorkflowHost({
    root,
    work,
    config,
    port,
    variables: vars,
    oysterOrigin: `https://${tenantHost}`,
    workerLog: `${root}.botanical/${name}.log`,
    readiness: {
      milliseconds: 90_000,
      interval: 200,
      requestMilliseconds: 2_000,
      label: "Standalone Oyster did not start",
    },
  });
  return { ...host, work, tenantHost };
}

/**
 * The local Computer platform container on this box, as the Computer's own
 * native proofs run it: the checked-out packages/computer image under
 * wrangler dev, owned and removed by this proof process.
 */
async function platformContainerComputer(root, work, config) {
  const proof = "oyster-workflows-native";
  const owner = installProofContainerTrap(proof);
  const image = "botanical-oyster-workflows-native:local";
  execFileSync(
    "docker",
    [
      "build",
      "--quiet",
      "--tag",
      image,
      "--file",
      `${root}../../packages/computer/Dockerfile`,
      `${root}../../packages/computer`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  await writeFile(
    `${work}/Dockerfile`,
    proofContainerDockerfile(proof, `FROM ${image}\n`),
  );
  // Container names derive from the Worker name; keep concurrent lanes apart.
  config.name = owner.workerName;
  config.containers = [
    {
      class_name: "ComputerDO",
      image: "./Dockerfile",
      instance_type: "standard-4",
      max_instances: 1,
    },
  ];
}

function computerHostOptions(computer) {
  return computer === null || computer === "platform-container"
    ? {}
    : { port: computer.port, variables: computer.vars };
}

/** Shared production-root boot; each scenario keeps its own readiness oracle. */
export async function nativeWorkflowRoot({
  root,
  prefix,
  main,
  artifactBucket,
  computer,
  ai = false,
}) {
  const { work, config } = await nativeFixtureWorkspace(root, prefix);
  config.main = `${root}test/standalone/${main}`;
  nativeArtifactBucket(config, artifactBucket);
  if (ai) config.ai = { binding: "AI" };
  if (computer === "platform-container")
    await platformContainerComputer(root, work, config);
  const computerOptions = computerHostOptions(computer);
  const tenantHost = "oyster.test";
  const tenantOrigin = `https://${tenantHost}`;
  const host = await nativeWorkflowHost({
    root,
    work,
    config,
    ...computerOptions,
    oysterOrigin: tenantOrigin,
  });
  return {
    ...host,
    work,
    tenantHost,
    tenantOrigin,
    computerVmVars: computerOptions.variables ?? {},
  };
}

/**
 * The two real workflow fixtures share owned process/Git/artifact mechanisms,
 * not their behavior oracles. Restart preserves this fixture's actual state.
 */
export async function workflowNativeFixture({
  main,
  configure,
  oysterOrigin,
  installationMilliseconds,
}) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const { work, config } = await nativeFixtureWorkspace(
    root,
    "workflows-native-",
  );
  const entry = `${root}test/standalone/${main}`;
  config.main = entry;
  configure?.(config);
  const host = await nativeWorkflowHost({
    root,
    work,
    config,
    oysterOrigin,
    readiness: { requestMilliseconds: 1_000 },
  });
  try {
    await host.ready();
  } catch (cause) {
    const diagnostics = host.diagnostics();
    await host.close();
    throw new Error(JSON.stringify(diagnostics), { cause });
  }
  return {
    config,
    ...host,
    ...nativeAppClient(host.origin, host.auth, {
      key: host.key,
      installationMilliseconds,
    }),
  };
}
