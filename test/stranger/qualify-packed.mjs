// Keep the repository's exact inventory/install/Node/strict-type proof and add
// Worker assertions inside that SAME freshly installed tarball consumer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";
import { provePackageStranger } from "../../../../tooling/repository/src/artifacts/stranger.ts";
import {
  runCommand,
  commandSucceeded,
} from "../../../../tooling/repository/src/core/command-runner.ts";

const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = resolve(packageDirectory, "../..");
let nativeProof;
let portableStatus = "not-run";
let nativeStatus = "not-run";
let declarationsStatus = "not-run";

async function freePort() {
  const socket = createServer();
  await new Promise((done, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", done);
  });
  const address = socket.address();
  assert.ok(address);
  assert.equal(address.family, "IPv4");
  await new Promise((done, reject) =>
    socket.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

async function nativeConsumer(directory) {
  const celldExample = join(
    directory,
    "node_modules/@fungi.computer/oyster/examples/standalone/wrangler.celld.jsonc",
  );
  assert.match(
    await readFile(celldExample, "utf8"),
    /"main": "worker.ts"/u,
    "The celld example must be present in the installed tarball beside worker.ts",
  );
  const nodeTypesVersion = JSON.parse(
    await readFile(
      join(directory, "node_modules/@types/node/package.json"),
      "utf8",
    ),
  ).version;
  const types = join(directory, "native-consumer.mts");
  await copyFile(new URL("./native-consumer.mts", import.meta.url), types);
  const fixture = join(directory, "native-runtime.mjs");
  await copyFile(new URL("./native-runtime.mjs", import.meta.url), fixture);
  const config = join(directory, "wrangler.json");
  await writeFile(
    config,
    JSON.stringify({
      name: "packed-oyster-proof",
      main: "native-runtime.mjs",
      compatibility_date: "2026-09-04",
      compatibility_flags: ["nodejs_compat"],
      worker_loaders: [{ binding: "LOADER" }],
      durable_objects: {
        bindings: [{ name: "PROOF", class_name: "PackedOysterProof" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["PackedOysterProof"] }],
    }),
  );
  const runtimeTypes = join(directory, "native-worker-runtime.d.ts");
  const runtimeTypesCommand = [
    process.execPath,
    resolve(repositoryRoot, "node_modules/wrangler/bin/wrangler.js"),
    "types",
    "--include-runtime",
    "--config",
    config,
    runtimeTypes,
  ];
  const generated = await runCommand(runtimeTypesCommand, { cwd: directory });
  assert.ok(commandSucceeded(generated), generated.stdout + generated.stderr);
  const typeCommand = [
    process.execPath,
    resolve(repositoryRoot, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--target",
    "ES2024",
    "--lib",
    "ES2024,ESNext.Disposable,DOM,DOM.Iterable",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--types",
    "node",
    "--skipLibCheck",
    "true",
    types,
    runtimeTypes,
  ];
  const typed = await runCommand(typeCommand, { cwd: directory });
  assert.ok(commandSucceeded(typed), typed.stdout + typed.stderr);
  const port = await freePort();
  const command = [
    resolve(repositoryRoot, "node_modules/.bin/wrangler"),
    "dev",
    "--config",
    config,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    join(directory, "state"),
  ];
  process.stderr.write(`[packed-native] start ${command.join(" ")}\n`);
  const worker = spawn(command[0], command.slice(1), {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  worker.stdout.on("data", (chunk) => {
    output += chunk;
  });
  worker.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const stopped = new Promise((done, reject) => {
    worker.once("error", reject);
    worker.once("exit", done);
  });
  const started = Date.now();
  try {
    const deadline = started + 60_000;
    let response;
    let probeFailure;
    while (response === undefined) {
      assert.equal(
        worker.exitCode,
        null,
        `Packed Worker exited before proof: ${output}`,
      );
      if (Date.now() >= deadline)
        throw new Error(`Packed Worker did not become ready: ${output}`, {
          cause: probeFailure,
        });
      const probe = await globalThis
        .fetch(`http://127.0.0.1:${port}/`, {
          signal: globalThis.AbortSignal.timeout(2000),
        })
        .then((response) => ({ kind: "ready", response }))
        .catch((cause) => ({ kind: "waiting", cause }));
      if (probe.kind === "ready") response = probe.response;
      else probeFailure = probe.cause;
      if (response === undefined) await delay(100);
    }
    const body = await response.text();
    assert.equal(
      response.status,
      200,
      `Native packed assertions failed: ${body}\n${output}`,
    );
    const proof = JSON.parse(body);
    assert.deepEqual(proof, {
      runtime: "workerd",
      cloudflareAssertions: "pass",
      sqlite: "native",
      loaderCalls: 0,
    });
    return {
      command,
      typeCommand,
      runtimeTypesCommand,
      nodeTypesVersion,
      workerTypecheck: "pass",
      proof,
      durationMs: Date.now() - started,
    };
  } finally {
    worker.kill("SIGTERM");
    await stopped;
    process.stderr.write(
      "[packed-native] Worker stopped; fresh consumer cleanup remains repository-owned\n",
    );
  }
}

const evidence = await provePackageStranger(packageDirectory, {
  repositoryRoot,
  runner: async (command, options) => {
    const result = await runCommand(command, options);
    const isPortable =
      command.length === 2 &&
      command[0] === process.execPath &&
      basename(command[1]) === "stranger-runtime.mjs";
    // One compiler run per declared typecheck; every one must pass.
    const isDeclarations =
      command[0] === process.execPath && basename(command[1]) === "tsc";
    if (isDeclarations)
      declarationsStatus =
        commandSucceeded(result) && declarationsStatus !== "fail"
          ? "pass"
          : "fail";
    if (isPortable) portableStatus = commandSucceeded(result) ? "pass" : "fail";
    if (!commandSucceeded(result)) return result;
    if (isPortable) {
      assert.ok(
        options?.cwd,
        "The repository runtime command must name its fresh consumer",
      );
      nativeStatus = "fail";
      nativeProof = await nativeConsumer(options.cwd);
      nativeStatus = "pass";
    }
    return result;
  },
});
if (evidence.status === "pass")
  assert.ok(
    nativeProof,
    "Native assertions must run, not merely portable assertions",
  );
process.stdout.write(
  JSON.stringify(
    {
      ...evidence,
      native: nativeProof,
      proofs: {
        portableNode: portableStatus,
        nativeWorkerd: nativeStatus,
        strictDeclarations: declarationsStatus,
      },
    },
    null,
    2,
  ) + "\n",
);
if (evidence.status !== "pass") process.exitCode = 1;
