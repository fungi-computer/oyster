import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export class CleanupError extends Error {}

/** Inspect retained outcomes only at the owning cleanup barrier. */
export async function awaitCleanup(
  completion: Promise<readonly PromiseSettledResult<void>[]>,
): Promise<void> {
  for (const outcome of await completion)
    if (outcome.status === "rejected") throw outcome.reason;
}

function processGroupExists(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

// Narrow adaptation of Caps' workbench-process process-group teardown. The
// Effect finalizer waits for cleanup before the source snapshot can be removed.
export async function stopProcessGroup(child: ChildProcess): Promise<void> {
  try {
    if (process.platform === "win32") await stopChild(child);
    else await stopGroup(child);
  } catch (cause) {
    throw new CleanupError("Owned process cleanup did not complete.", {
      cause,
    });
  }
}

async function stopGroup(child: ChildProcess): Promise<void> {
  if (!processGroupExists(child)) return;
  const deadline = Date.now() + 5_000;
  for (const [signal, until] of [
    ["SIGTERM", deadline - 1_000],
    ["SIGKILL", deadline],
  ] as const) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
    while (processGroupExists(child) && Date.now() < until) await delay(25);
    if (!processGroupExists(child)) return;
  }
  throw new Error("Owned process group survived its five-second cleanup bound");
}

// Preserve the CLI's direct-child Windows lifetime. The local build owner and
// the process-group qualification remain POSIX; this is not a Windows tree kill.
async function stopChild(child: ChildProcess): Promise<void> {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  let closed: (() => void) | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      closed = resolve;
      child.once("close", closed);
      child.kill("SIGTERM");
      force = setTimeout(() => {
        child.kill("SIGKILL");
      }, 4_000);
      deadline = setTimeout(() => {
        reject(new Error("Owned child survived its five-second cleanup bound"));
      }, 5_000);
    });
  } finally {
    clearTimeout(force);
    clearTimeout(deadline);
    if (closed !== undefined) child.off("close", closed);
  }
}
