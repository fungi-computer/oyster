import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const MiB = 1_048_576;
const measurement = z.strictObject({
  mode: z.enum(["apps", "control", "all-writes"]),
  starterMethods: z.array(z.tuple([z.string(), z.number().int().positive()])),
  flags: z.array(z.string()),
  methods: z.number().int().positive(),
  writes: z.number().int().positive(),
  baseline: z.number().nonnegative(),
  peak: z.number().nonnegative(),
  peakDelta: z.number(),
  retained: z.number(),
  allocation: z.number().nonnegative(),
  snapshots: z.number().int().nonnegative(),
  listings: z.number().int().nonnegative(),
});
const fixture = fileURLToPath(
  new URL("./agent-catalog-cap.fixture.mjs", import.meta.url),
);

function run(mode) {
  const text = execFileSync(
    process.execPath,
    ["--max-old-space-size=128", "--expose-gc", fixture, mode],
    { encoding: "utf8", timeout: 60_000, maxBuffer: MiB },
  );
  return measurement.parse(JSON.parse(text));
}

function report(t, value) {
  t.diagnostic(
    `${value.mode}: ${value.starterMethods.length} Apps, ${value.methods} methods, ${value.writes} writes; ` +
      `baseline ${(value.baseline / MiB).toFixed(1)} MiB; ` +
      `peak ${(value.peak / MiB).toFixed(1)} MiB (+${(value.peakDelta / MiB).toFixed(1)}); ` +
      `live retained ${(value.retained / MiB).toFixed(1)} MiB; ` +
      `${value.allocation} allocated bytes; ${value.snapshots} snapshots; ${value.listings} listings`,
  );
}

let control;
for (const mode of ["apps", "all-writes"]) {
  test(`seven starter-sized Apps compile an Agent catalog within a 128 MiB old-space cap (${mode})`, (t) => {
    control ??= run("control");
    const actual = run(mode);
    report(t, control);
    report(t, actual);
    assert.ok(actual.flags.includes("--max-old-space-size=128"));
    assert.ok(actual.flags.includes("--expose-gc"));
    assert.equal(actual.starterMethods.length, 7);
    assert.equal(actual.methods, 102);
    if (mode === "apps") {
      assert.ok(actual.writes / actual.methods >= 0.4);
      assert.ok(actual.writes / actual.methods <= 0.5);
    } else {
      assert.equal(actual.writes, actual.methods);
    }
    // GCProfiler observes synchronous before-GC peaks, not just the heap after
    // acquisition, and the compiled lease is still held for retained bytes.
    assert.ok(
      actual.peakDelta <= 40 * MiB,
      `peak delta ${actual.peakDelta} bytes`,
    );
    assert.ok(
      actual.retained < 8 * MiB,
      `live catalog retained ${actual.retained} bytes`,
    );
    // CTO shipping decision: peak and live retention gate DO reset risk.
    // Keep cumulative allocation visible for the follow-up, not as a gate.
    t.diagnostic(
      `${(actual.allocation / control.allocation).toFixed(2)}x JSON-only allocation (measurement, not a gate)`,
    );
    assert.equal(
      actual.snapshots,
      1,
      "one snapshot for the full turn acquisition",
    );
    assert.equal(
      actual.listings,
      1,
      "the family is listed once during acquisition",
    );
  });
}
