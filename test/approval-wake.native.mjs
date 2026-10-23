// Build prerequisites with the maintained Turbo graph before this proof.
// This launches pinned celld directly; outputs and native storage stay ignored.
/* global URL, AbortSignal, fetch, console, process */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

assert.ok(process.env.CELLD_PLATFORM_CELLD, "Pinned celld is required");
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(repository, ".botanical/approvals");
await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(join(artifacts, "native-wake-"));
const fixture = fileURLToPath(
  new URL("./approval-wake.fixture.mjs", import.meta.url),
);
console.log("Native approval wake artifacts: " + output);
const passed = [];

for (const proof of ["admission", "rollback", "expiry"]) {
  const work = join(output, proof);
  await mkdir(work);
  await writeFile(
    join(work, "worker.mjs"),
    "export { NativeApprovalRegistry } from " +
      JSON.stringify(fixture) +
      ";\n" +
      "export { default } from " +
      JSON.stringify(fixture) +
      ";\n",
  );
  await writeFile(
    join(work, "wrangler.json"),
    JSON.stringify({
      name: "approval-wake-" + proof,
      main: "worker.mjs",
      compatibility_date: "2026-09-04",
      compatibility_flags: ["nodejs_compat"],
      vars: {
        OYSTER_OWNER_KEY: "native-wake-proof-owner-key-1234567890",
        OYSTER_ORIGIN: "https://oyster.test",
      },
      durable_objects: {
        bindings: [{ name: "REGISTRY", class_name: "NativeApprovalRegistry" }],
      },
      migrations: [
        { tag: "1", new_sqlite_classes: ["NativeApprovalRegistry"] },
      ],
      r2_buckets: [{ binding: "RELEASES", bucket_name: "native-wake-proof" }],
    }),
  );
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await socket[Symbol.asyncDispose]();
  const origin = "http://127.0.0.1:" + String(port);
  let child;
  let logs = "";
  let readinessFailure;
  const exited = () =>
    child === undefined || child.exitCode !== null || child.signalCode !== null;
  async function stop() {
    if (exited()) return;
    const ended = new Promise((resolve) => child.once("exit", resolve));
    process.kill(-child.pid, "SIGTERM");
    if (
      !(await Promise.race([
        ended.then(() => true),
        delay(5000).then(() => false),
      ]))
    ) {
      process.kill(-child.pid, "SIGKILL");
      await ended;
    }
  }
  const interrupted = () => {
    stop().finally(() => process.exit(143));
  };
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  async function probeReady() {
    try {
      const response = await fetch(origin + "/ready", {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return await response.json();
    } catch (cause) {
      if (exited())
        throw new Error(
          "Native Registry exited during readiness: " + logs.slice(-6000),
          { cause },
        );
      readinessFailure = cause;
    }
    return null;
  }
  async function start() {
    logs = "";
    readinessFailure = undefined;
    child = spawn(
      process.env.CELLD_PLATFORM_CELLD,
      ["dev", work, "--port", String(port)],
      {
        cwd: work,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CELLD_READY_FLEET_GATE_MS: "0",
          CELLD_ESBUILD: join(repository, "node_modules/.bin/esbuild"),
        },
      },
    );
    child.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    child.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    for (let attempt = 0; attempt < 360; attempt++) {
      const ready = await probeReady();
      if (ready !== null) return ready;
      if (exited()) break;
      await delay(250);
    }
    throw new Error(
      "Native Registry did not become ready: " + logs.slice(-6000),
      { cause: readinessFailure },
    );
  }
  const json = async (path) => {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  try {
    const first = await start();
    if (proof === "admission") {
      const admitted = await json("/admit");
      await writeFile(
        join(work, "admitted.json"),
        JSON.stringify(admitted, null, 2),
      );
      assert.equal(admitted.record.state, "pending");
      assert.equal(
        admitted.record.expiresAt - admitted.record.requestedAt,
        86_400_000,
      );
      assert.equal(
        admitted.alarm,
        admitted.record.expiresAt,
        "Ordinary admission must commit its expiry wake",
      );
      await stop();
      await writeFile(join(work, "first-process.log"), logs);
      const second = await start();
      assert.ok(
        second.boots > first.boots,
        "SQL must reopen after a physical process restart",
      );
      const reopened = await json(
        "/admission-state?record=" + admitted.result.recordId,
      );
      assert.equal(reopened.record.state, "pending");
      assert.equal(reopened.alarm, admitted.record.expiresAt);
      await writeFile(
        join(work, "result.json"),
        JSON.stringify({ first, second, reopened }, null, 2),
      );
    } else if (proof === "rollback") {
      const response = await fetch(origin + "/rollback");
      const body = await response.json();
      const state = await json("/stored-state");
      await writeFile(
        join(work, "result.json"),
        JSON.stringify({ status: response.status, body, state }, null, 2),
      );
      assert.equal(
        response.status,
        500,
        "An aborted native commit must fail its caller",
      );
      assert.equal(body.error, "native-admission-commit-failure");
      assert.deepEqual(state, {
        records: 0,
        targets: 0,
        payloads: 0,
        alarm: null,
      });
    } else {
      const prepared = await json("/prepare-expiry");
      let record;
      for (let attempt = 0; attempt < 50; attempt++) {
        record = await json("/expiry-state?record=" + prepared.recordId);
        if (record.state !== "pending") break;
        await delay(100);
      }
      await writeFile(
        join(work, "result.json"),
        JSON.stringify({ prepared, record }, null, 2),
      );
      assert.equal(
        record.state,
        "expired",
        "Native expiry must not depend on a lazy member read",
      );
      assert.equal(record.reason, "expired");
    }
    passed.push(proof);
  } finally {
    await stop();
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
    await writeFile(join(work, "last-process.log"), logs);
  }
}
console.log(
  JSON.stringify(
    {
      passed,
      output,
      scope:
        "Native ordinary pending admission, atomic rollback and restart; alarm expiry uses an accelerated historical deadline. No App effect, human-answer commit, configurable expiry or Session delivery claim.",
    },
    null,
    2,
  ),
);
