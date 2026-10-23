import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

function requestOptions(milliseconds, deadline, boundToDeadline) {
  if (milliseconds === null) return {};
  return {
    signal: globalThis.AbortSignal.timeout(
      boundToDeadline
        ? Math.max(1, Math.min(milliseconds, deadline - Date.now()))
        : milliseconds,
    ),
  };
}

/** Preserve each caller's polling window and its separate per-fetch budget. */
export async function waitForNativeRoot(
  worker,
  origin,
  {
    milliseconds = 60_000,
    interval = 100,
    label = "standalone root readiness",
    requestMilliseconds = null,
    boundRequestToDeadline = false,
  },
) {
  const deadline = Date.now() + milliseconds;
  while (
    !(await globalThis
      .fetch(
        `${origin}/login`,
        requestOptions(requestMilliseconds, deadline, boundRequestToDeadline),
      )
      .then(
        (response) => response.ok,
        () => false,
      ))
  ) {
    assert.equal(worker.exitCode, null, "Standalone Oyster exited");
    assert.ok(Date.now() < deadline, label);
    await delay(interval);
  }
}
