// Invoke with the maintained wrangler-on-celld preloader and pinned binary.
/* global AbortSignal */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import console from "node:console";
import { z } from "zod";

assert.ok(process.env.CELLD_PLATFORM_CELLD, "Actual pinned celld is required");
assert.ok(
  process.execArgv.some((argument) =>
    argument.endsWith("/wrangler-on-celld.mjs"),
  ),
  "Use the maintained wrangler-on-celld preloader",
);
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/recovery-copy-`);
await mkdir(`${work}/home`);
await mkdir(`${work}/config`);
process.env.HOME = `${work}/home`;
process.env.XDG_CONFIG_HOME = `${work}/config`;
process.env.WRANGLER_SEND_METRICS = "false";
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CLOUDFLARE_API_KEY;
delete process.env.CLOUDFLARE_EMAIL;
await writeFile(
  `${work}/head.txt`,
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
);
await writeFile(
  `${work}/binary.txt`,
  execFileSync(process.env.CELLD_PLATFORM_CELLD, ["--version"], {
    encoding: "utf8",
  }),
);
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
    name: "oyster-recovery-copy",
    main: `${root}test/recovery-copy.fixture.mjs`,
    compatibility_date: "2026-09-04",
    worker_loaders: [{ binding: "LOADER" }],
    durable_objects: {
      bindings: [{ name: "SUPERVISORS", class_name: "RecoverySupervisor" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["RecoverySupervisor"] }],
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
  ],
  { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
worker.stdout.on("data", (chunk) => {
  output += chunk;
});
worker.stderr.on("data", (chunk) => {
  output += chunk;
});
const stopped = new Promise((resolve) => worker.once("exit", resolve));
const resultSchema = z.strictObject({
  requestedFail: z.boolean(),
  requestedSyncFailure: z.boolean(),
  failure: z.enum(["backend_construction_failed"]).nullable(),
  liveAfter: z.literal("S1"),
  candidateAfterCleanup: z.null(),
  supervisor: z
    .array(z.strictObject({ value: z.literal("selected") }))
    .length(1),
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    if (worker.exitCode !== null) throw new Error("Recovery worker exited");
    ready = await globalThis
      .fetch(`${origin}/egress-probe`, {
        signal: AbortSignal.timeout(1000),
      })
      .then(
        (response) => response.ok,
        () => false,
      );
    if (ready) break;
    await delay(500);
  }
  assert.ok(ready, "The real native worker must start");
  const interactive = await globalThis.fetch(`${origin}/probe?interactive=1`, {
    signal: AbortSignal.timeout(20_000),
  });
  const interactiveRaw = await interactive.text();
  await writeFile(`${work}/interactive-response.json`, interactiveRaw);
  assert.equal(interactive.status, 200, interactiveRaw);
  assert.deepEqual(JSON.parse(interactiveRaw), {
    initial: {
      value: "S1",
      supervisorRows: 0,
      bindings: [],
      outboundDenied: true,
    },
    changed: {
      value: "S2",
      supervisorRows: 0,
      bindings: [],
      outboundDenied: true,
    },
    source: "S1",
    afterDiscard: null,
    reopenedValue: null,
    emittedBudgets: [
      { cpuMs: 1000, subRequests: 50 },
      { cpuMs: 250, subRequests: 10 },
    ],
    supervisor: [{ value: "selected" }],
  });
  console.log(
    "Native interactive copy PASS: existing invocation facade, copied reads/writes, source/supervisor isolation, no bindings/outbound, discard and empty reopen",
  );
  for (const { fail, syncFailure, name } of [
    { fail: false, syncFailure: false, name: "copy" },
    { fail: true, syncFailure: true, name: "sync-refusal" },
    { fail: true, syncFailure: false, name: "async-refusal" },
  ]) {
    const response = await globalThis.fetch(
      `${origin}/probe?fail=${fail ? "1" : "0"}&sync=${syncFailure ? "1" : "0"}`,
      {
        signal: AbortSignal.timeout(20_000),
      },
    );
    const raw = await response.text();
    await writeFile(`${work}/${name}-response.json`, raw);
    assert.equal(response.status, 200, raw);
    const result = resultSchema.parse(JSON.parse(raw));
    assert.equal(result.requestedFail, fail);
    assert.equal(result.requestedSyncFailure, syncFailure);
    assert.equal(result.failure, fail ? "backend_construction_failed" : null);
  }
  const concurrent = await globalThis.fetch(`${origin}/concurrent`, {
    signal: AbortSignal.timeout(30_000),
  });
  const concurrentRaw = await concurrent.text();
  await writeFile(`${work}/concurrent-response.json`, concurrentRaw);
  assert.equal(concurrent.status, 200, concurrentRaw);
  assert.deepEqual(
    z
      .object({ failures: z.array(z.string().nullable()) })
      .parse(JSON.parse(concurrentRaw)).failures,
    [null, null, null],
    "Overlapping probes on one host must each construct",
  );
  console.log(
    "Native construction-copy PASS: seed, isolation, denial, refusal, empty reopen and overlapping probes",
  );
  // The real, unchanged five-minute policy is part of this native qualification.
  // No test clock, shortened lifetime or direct call to alarm()/expire().
  const before = Date.now();
  const alarmStart = await globalThis.fetch(`${origin}/probe?alarm=start`, {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(alarmStart.status, 200, await alarmStart.clone().text());
  const alarm = z
    .strictObject({
      instanceId: z.string().min(1),
      expiresAt: z.number().int(),
      scheduledAt: z.number().int(),
      initial: z.literal("S1"),
    })
    .parse(await alarmStart.json());
  assert.ok(alarm.expiresAt >= before + 300_000);
  assert.ok(alarm.expiresAt <= Date.now() + 300_000);
  assert.equal(alarm.scheduledAt, alarm.expiresAt);
  console.log(
    `Waiting for actual native copy expiry at ${new Date(alarm.expiresAt).toISOString()}`,
  );
  await delay(Math.max(0, alarm.expiresAt - Date.now()));
  const deadline = Date.now() + 20_000;
  const statusUrl = new URL("/probe", origin);
  statusUrl.searchParams.set("alarm", "status");
  statusUrl.searchParams.set("instance", alarm.instanceId);
  let receipt = null;
  while (Date.now() < deadline) {
    const status = await globalThis.fetch(statusUrl, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    assert.equal(status.status, 200, await status.clone().text());
    receipt = await status.json();
    if (receipt !== null) break;
    await delay(50);
  }
  assert.deepEqual(
    z
      .strictObject({
        copyValue: z.null(),
        sourceValue: z.literal("S1"),
      })
      .parse(receipt),
    { copyValue: null, sourceValue: "S1" },
  );
  await writeFile(
    `${work}/alarm-response.json`,
    JSON.stringify({ alarm, receipt }),
  );
  console.log(
    "Native alarm copy PASS: actual five-minute delivery, reconstructed owner cleanup, unchanged live data",
  );
  console.log(`Disposable evidence: ${work}`);
} finally {
  worker.kill("SIGTERM");
  await stopped;
  await writeFile(`${work}/worker.log`, output);
}
