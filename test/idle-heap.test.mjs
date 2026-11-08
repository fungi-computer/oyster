import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as esbuild from "esbuild";
import { z } from "zod";

// A self-hosted Oyster runs every Durable Object in one celld cell isolate on
// a 128 MiB V8 heap, and what its idle module state retains is gone before any
// App installs or builds. celld keeps a Latin-1 bundle's source outside the
// heap, so the idle heap is the bundle's evaluated state: about 50 MB, which
// celld dev measured as 51.5 MB idle. This law catches a creep in that state
// on every change, without the release suite's packed celld install; prefer
// deferring a new import to the request that needs it over raising it.
const evaluatedHeapBudgetBytes = 56 * 1024 * 1024;

const oyster = fileURLToPath(new URL("..", import.meta.url));
const child = fileURLToPath(
  new URL("./idle-heap.fixture.mjs", import.meta.url),
);

// celld's own bundle step (crates/celld/deploy.rs, run_esbuild), so the law
// measures the code celld loads rather than Wrangler's output.
const celldCommonjsBridge = `var require = (id) => {
  const name = String(id);
  const builtin = process.getBuiltinModule(name);
  if (builtin === undefined) {
    const error = new Error(\`Cannot find module '\${name}'\`);
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return builtin;
};`;

const measurement = z.object({
  exports: z.number().int().positive(),
  heapBytes: z.number().int(),
});

test("the standalone Worker's evaluated state stays within its idle heap budget", async () => {
  const out = await mkdtemp(join(tmpdir(), "oyster-idle-heap-"));
  try {
    const bundle = join(out, "index.js");
    await esbuild.build({
      absWorkingDir: oyster,
      entryPoints: ["examples/standalone/worker.ts"],
      outfile: bundle,
      bundle: true,
      minifySyntax: true,
      format: "esm",
      platform: "browser",
      target: "es2024",
      conditions: ["workerd", "worker", "browser"],
      banner: { js: celldCommonjsBridge },
      external: ["node:*", "cloudflare:*", ...builtinModules],
      loader: { ".wasm": "copy" },
      logLevel: "error",
    });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--expose-gc", child, bundle],
      { cwd: oyster, maxBuffer: 1024 * 1024 },
    );
    const { heapBytes } = measurement.parse(JSON.parse(stdout));
    const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    assert.ok(
      heapBytes <= evaluatedHeapBudgetBytes,
      `the standalone Worker retains ${megabytes(heapBytes)} of evaluated state; the budget is ${megabytes(evaluatedHeapBudgetBytes)}`,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
