import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Cloudflare refuses a deploy whose Worker startup (evaluating everything the
// entry imports eagerly) exceeds its CPU limit. Wall-clock startup varies with
// the machine, so this law pins the deterministic cause instead: what the
// standalone example's worker.ts imports statically when `wrangler deploy`
// bundles it. Heavy SDKs that only some requests need are loaded on first use.

const oyster = fileURLToPath(new URL("..", import.meta.url));
const wrangler = join(oyster, "node_modules/wrangler/bin/wrangler.js");
// Bundles examples/standalone/worker.ts; the example's own config names the
// Computer image as an installed package path that exists only for strangers.
const config = join(oyster, "deploy/wrangler.jsonc");

/** Loaded on first use, never at startup: [module path pattern, first-use owner]. */
const deferred = [
  [/\/@modelcontextprotocol\/server\//, "the MCP owner's first request"],
  [/\/@modelcontextprotocol\/core\//, "the MCP owner's first request"],
  [
    /\/@earendil-works\/pi-ai\/dist\/compat\.js$/,
    "an Agent's model acquisition",
  ],
  [
    /\/@earendil-works\/pi-ai\/dist\/index\.js$/,
    "nothing; import Pi leaf utils",
  ],
  [/\/@earendil-works\/pi-ai\/dist\/providers\/all\.js$/, "Pi compat"],
  [/\/typebox\/build\/compile\//, "Pi validation"],
  [/\/xmlbuilder2\//, "the first provenance embed"],
  [/\/node-webpmux\//, "the first WebP provenance embed"],
  [/\/@nangohq\/node\//, "the first Nango webhook"],
];

/**
 * Bundled bytes the standalone Worker reaches through static imports (about
 * 13.5 MB, a third of it the browser page script as a string). Raise it only
 * with a startup profile (`pnpm run check:startup`) showing the cost is paid
 * for; prefer deferring the new import to the request that needs it.
 */
const eagerBytesBudget = 14_000_000;

test("the standalone Worker defers heavy SDKs and stays within its eager code budget", async () => {
  const out = await mkdtemp(join(tmpdir(), "oyster-startup-graph-"));
  try {
    const metafile = join(out, "meta.json");
    await promisify(execFile)(
      process.execPath,
      [
        wrangler,
        "deploy",
        "--dry-run",
        "--containers-rollout=none",
        "--config",
        config,
        "--outdir",
        join(out, "bundle"),
        "--metafile",
        metafile,
      ],
      { cwd: oyster, maxBuffer: 16 * 1024 * 1024 },
    );
    const { inputs, outputs } = JSON.parse(await readFile(metafile, "utf8"));
    const entry = Object.keys(inputs).find((path) =>
      path.endsWith("examples/standalone/worker.ts"),
    );
    assert.ok(entry, "the bundle starts at the standalone example");

    // Breadth-first over static imports only: a dynamic import() stays a lazy
    // initializer in the bundle and runs on first use.
    const via = new Map([[entry, null]]);
    const queue = [entry];
    for (const path of queue)
      for (const edge of inputs[path].imports ?? [])
        if (
          edge.kind !== "dynamic-import" &&
          inputs[edge.path] !== undefined &&
          !via.has(edge.path)
        ) {
          via.set(edge.path, path);
          queue.push(edge.path);
        }
    const chain = (path) => {
      const steps = [];
      for (let step = path; step !== null; step = via.get(step))
        steps.unshift(step.replace(/^.*node_modules\//, ""));
      return steps.join("\n  -> ");
    };
    for (const [pattern, owner] of deferred) {
      const eager = [...via.keys()].find((path) => pattern.test(path));
      assert.equal(
        eager,
        undefined,
        `${pattern} must load on ${owner}, not at startup:\n  ${eager && chain(eager)}`,
      );
    }

    const [bundle] = Object.values(outputs).filter(
      (output) => output.entryPoint,
    );
    const eagerBytes = [...via.keys()].reduce(
      (total, path) => total + (bundle.inputs[path]?.bytesInOutput ?? 0),
      0,
    );
    assert.ok(
      eagerBytes <= eagerBytesBudget,
      `startup evaluates ${eagerBytes} bytes; the budget is ${eagerBytesBudget}`,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
