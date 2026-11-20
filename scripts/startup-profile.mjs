// Profile the standalone Worker's startup the way Cloudflare's deploy gate
// sees it: bundle exactly as `wrangler deploy` does, then run
// `wrangler check startup` on that bundle and read its CPU profiles.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

const oyster = fileURLToPath(new URL("..", import.meta.url));
const wrangler = join(oyster, "node_modules/wrangler/bin/wrangler.js");
/** The config behind the live oyster.shiit.app deploy, whose bundle is the published Worker. */
const config = join(oyster, "deploy/wrangler.contest.jsonc");

const run = (args) =>
  promisify(execFile)(process.execPath, [wrangler, ...args], {
    cwd: oyster,
    maxBuffer: 16 * 1024 * 1024,
  });

/** Wrangler's own message when its fixed profiling limit fires. */
const profilerTimedOut = /Worker startup profiling timed out/u;

/** Profile window and the part of it spent running JavaScript, in ms. */
export function measure(profile) {
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

/** The least of several values: contention only ever adds to a measurement. */
export const least = (values) => Math.min(...values);

/** The middle value, for the report beside the gate. */
export const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * Bundle the Worker once and profile its startup `runs` times. A profile the
 * profiler itself abandoned (its limit is fixed, not the Worker's) is taken
 * again; any other failure surfaces.
 */
export async function profileStartup({ runs = 5 } = {}) {
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
    for (let index = 0; samples.length < runs; index++) {
      const profile = join(out, `startup-${String(index)}.cpuprofile`);
      try {
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
      } catch (failure) {
        const text = [failure.stdout, failure.stderr, failure.message].join(
          "\n",
        );
        if (profilerTimedOut.test(text) && index < runs * 3) continue;
        throw failure;
      }
      samples.push(measure(JSON.parse(await readFile(profile, "utf8"))));
    }
    return samples;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
