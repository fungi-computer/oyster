import assert from "node:assert/strict";
import test from "node:test";
import { loadScaledMs } from "./workflow-native.fixture.mjs";

// A proof request limit is wall time on a shared host. On a host running two
// to three proofs per core, one Worker request took 33.8 s (11-20) and a fixed
// 30 s limit reported it as a stall of the host. Limits stretch with host load.
test("a request or wait limit keeps its base on an idle host", () => {
  assert.equal(loadScaledMs(30_000, { load1: 1, nproc: 32 }), 30_000);
});

test("a request or wait limit stretches with host load, capped at four times", () => {
  const loaded = loadScaledMs(30_000, { load1: 64, nproc: 32 });
  assert.ok(loaded >= 60_000 && loaded <= 120_000, String(loaded));
  assert.equal(loadScaledMs(30_000, { load1: 3200, nproc: 32 }), 120_000);
});
