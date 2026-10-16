// Profile the standalone Worker's startup the way Cloudflare's deploy gate
// sees it: bundle exactly as `wrangler deploy` does, then run
// `wrangler check startup` on that bundle and read its CPU profiles.
//
// Wall-clock CPU varies with the machine and its load, so this is a release
// check rather than a test law; test/startup-graph.test.mjs pins the
// deterministic cause (what startup imports). Run it on a quiet machine:
//   pnpm run check:startup [budget-ms]
import { execFile } from "node:child_process";
import console from "node:console";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

const oyster = fileURLToPath(new URL("..", import.meta.url));
const wrangler = join(oyster, "node_modules/wrangler/bin/wrangler.js");
const config = join(oyster, "deploy/wrangler.jsonc");
const runs = 5;
// A local profile window of ~350 ms preceded a refused deploy (code 10021);
// after deferring heavy SDKs it is ~280 ms on botanical-hel1.
const budgetMs = Number(process.argv[2] ?? 320);

const run = (args) =>
  promisify(execFile)(process.execPath, [wrangler, ...args], {
    cwd: oyster,
    maxBuffer: 16 * 1024 * 1024,
  });

/** Profile window and the part of it spent running JavaScript, in ms. */
function measure(profile) {
  const idle = new Set(
    profile.nodes
      .filter((node) => node.callFrame.functionName === "(idle)")
      .map((node) => node.id),
  );
  let active = 0;
  profile.samples.forEach((id, index) => {
    if (!idle.has(id)) active += profile.timeDeltas[index] ?? 0;
  });
  return {
    window: (profile.endTime - profile.startTime) / 1000,
    active: active / 1000,
  };
}

const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const out = await mkdtemp(join(tmpdir(), "oyster-startup-"));
try {
  const bundle = join(out, "worker.bundle");
  await run([
    "deploy",
    "--dry-run",
    "--containers-rollout=none",
    "--config",
    config,
    "--outfile",
    bundle,
  ]);
  const samples = [];
  for (let index = 0; index < runs; index++) {
    const profile = join(out, `startup-${index}.cpuprofile`);
    await run([
      "check",
      "startup",
      "--config",
      config,
      "--workerBundle",
      bundle,
      "--outfile",
      profile,
    ]);
    samples.push(measure(JSON.parse(await readFile(profile, "utf8"))));
  }
  const window = median(samples.map((sample) => sample.window));
  const active = median(samples.map((sample) => sample.active));
  console.log(
    `startup profile (median of ${runs}): window ${window.toFixed(1)} ms, active ${active.toFixed(1)} ms; budget ${budgetMs} ms`,
  );
  if (window > budgetMs) {
    console.error(
      "Startup exceeds its budget: defer the new import to the request that needs it.",
    );
    process.exitCode = 1;
  }
} finally {
  await rm(out, { recursive: true, force: true });
}
