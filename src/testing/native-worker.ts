import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, fstatSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

/** One `wrangler dev --local` launch: its config, vars and optional fixed port. */
export type NativeWorkerOptions = Readonly<{
  /** The Worker's wrangler config. */
  configPath: string;
  /** Plain-text vars passed with `--var`. */
  vars: Readonly<Record<string, string>>;
  /** A fixed port; 0 (the default) reserves a free one. */
  port?: number;
  /** Append the Worker's output to this file, which must have mode 0600. */
  logFile?: string;
}>;

/** A ready local Worker; `stop` ends it and removes its persisted state. */
export type NativeWorker = Readonly<{
  port: number;
  stop: () => Promise<void>;
}>;

/** Written by the spawn error event, read by the readiness loop. */
type SpawnState = { error: Error | null };

// The consumer's own wrangler (an optional peer), resolved beside its config.
const wranglerBin = (configPath: string) =>
  join(
    dirname(createRequire(configPath).resolve("wrangler/package.json")),
    "bin/wrangler.js",
  );

/**
 * Start `wrangler dev --local` on 127.0.0.1 with fresh persisted state and
 * resolve once its root answers, or reject after 60 seconds.
 */
export async function startNativeWorker({
  configPath,
  vars,
  port: requestedPort = 0,
  logFile,
}: NativeWorkerOptions): Promise<NativeWorker> {
  const reservation = createServer();
  reservation.listen(requestedPort, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = z
    .object({ port: z.number().int().positive() })
    .parse(reservation.address());
  await new Promise<void>((resolve) => {
    reservation.close(() => {
      resolve();
    });
  });
  const state = await mkdtemp(join(tmpdir(), "oyster-native-worker-"));
  const logDescriptor =
    logFile === undefined ? undefined : openSync(logFile, "a", 0o600);
  const child = (() => {
    try {
      if (
        logDescriptor !== undefined &&
        (fstatSync(logDescriptor).mode & 0o777) !== 0o600
      )
        throw new Error("Worker proof log must have mode 0600");
      return spawn(
        process.execPath,
        [
          wranglerBin(configPath),
          "dev",
          "--config",
          configPath,
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--persist-to",
          state,
          ...Object.entries(vars).flatMap(([name, value]) => [
            "--var",
            `${name}:${value}`,
          ]),
        ],
        {
          stdio:
            logDescriptor === undefined
              ? "ignore"
              : ["ignore", logDescriptor, logDescriptor],
        },
      );
    } finally {
      if (logDescriptor !== undefined) closeSync(logDescriptor);
    }
  })();
  const startup: SpawnState = { error: null };
  child.on("error", (cause) => {
    startup.error = cause;
  });
  const stop = async () => {
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      startup.error === null
    ) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(state, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (startup.error !== null)
        throw new Error("Worker proof startup failed", {
          cause: startup.error,
        });
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Worker proof exited before readiness (${String(child.exitCode ?? child.signalCode)})`,
        );
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        return { port, stop };
      } catch (cause) {
        if (Date.now() >= deadline)
          throw new Error("Worker proof readiness timeout", { cause });
      }
      await delay(100);
    }
    throw new Error("Worker proof readiness timeout");
  } catch (cause) {
    await stop();
    throw cause;
  }
}
