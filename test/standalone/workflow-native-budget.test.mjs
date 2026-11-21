import assert from "node:assert/strict";
import test from "node:test";
import { loadScaledMs } from "./workflow-native.fixture.mjs";
import { createWorkflowHostTrace } from "./workflow-host-trace.fixture.ts";

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

test("a pending dispatch records liveness and stops heartbeat at the existing maximum request limit", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const events = [];
  const trace = createWorkflowHostTrace((event) => events.push(event));
  let finish;
  const pending = trace(
    "workflow-runs",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  context.mock.timers.tick(1000);
  assert.equal(events.at(-1).phase, "heartbeat");
  assert.equal(events.at(-1).elapsedMs, 1000);
  context.mock.timers.tick(119_000);
  assert.equal(events.at(-1).phase, "observation-ended");
  const bounded = events.length;
  context.mock.timers.tick(120_000);
  assert.equal(events.length, bounded);
  finish("unchanged result");
  assert.equal(await pending, "unchanged result");
  assert.equal(events.at(-1).phase, "return");
  context.mock.timers.tick(1000);
  assert.equal(events.length, bounded + 1);
});

test("failure preserves the original cause without logging its payload", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const events = [];
  const trace = createWorkflowHostTrace((event) => events.push(event));
  const cause = new Error("fixture payload must stay private");
  await assert.rejects(
    trace("workflow-alarm", async () => {
      throw cause;
    }),
    (error) => error === cause,
  );
  assert.deepEqual(
    events.map(({ phase }) => phase),
    ["enter", "throw"],
  );
  assert.ok(!JSON.stringify(events).includes(cause.message));
  context.mock.timers.tick(10_000);
  assert.equal(events.length, 2);
});

test("concurrent root and DO calls have distinct timing identities", async () => {
  const events = [];
  const trace = createWorkflowHostTrace((event) => events.push(event));
  assert.equal(
    await trace("list-runs-request", () =>
      trace("workflow-runs", async () => 7),
    ),
    7,
  );
  assert.deepEqual(
    events.map(({ id, operation, phase }) => [id, operation, phase]),
    [
      [1, "list-runs-request", "enter"],
      [2, "workflow-runs", "enter"],
      [2, "workflow-runs", "return"],
      [1, "list-runs-request", "return"],
    ],
  );
});

test("a delayed native heartbeat reports the gap rather than claiming continuous liveness", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const events = [];
  const trace = createWorkflowHostTrace((event) => events.push(event));
  let finish;
  const pending = trace(
    "workflow-runs",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  context.mock.timers.setTime(4000);
  context.mock.timers.tick(1000);
  assert.equal(Math.max(...events.map(({ lateByMs }) => lateByMs)), 3000);
  finish();
  await pending;
});
