import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { watch, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Cli } from "@fungi.computer/lantern";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tryOyster } from "../../src/standalone/try-cli.js";

let directory: string;
const executable = process.execPath;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "oyster-server-failure-"));
  // Let the real CLI write its current generated files, stopping at install.
  const controller = new AbortController();
  const unexpected = () => {
    throw new Error("fixture went beyond installation");
  };
  await tryOyster(
    [directory, "--no-open"],
    {
      installDependencies: () => {
        controller.abort();
        return Promise.resolve();
      },
      portFree: () => Promise.resolve(true),
      startServer: unexpected,
      installHello: unexpected,
      installDesktop: unexpected,
      installStarter: unexpected,
      reportStarters: unexpected,
      takeRetries: unexpected,
      startComputer: unexpected,
      modelSetup: unexpected,
      signInLink: unexpected,
      open: unexpected,
    },
    new Cli({ brand: "fungi", output: new PassThrough(), interactive: false }),
    controller.signal,
  );
  await rm(join(directory, ".oyster/install.pending"));
  await mkdir(join(directory, "node_modules/wrangler/bin"), {
    recursive: true,
  });
  await mkdir(join(directory, "node_modules/@fungi.computer"));
  await symlink(
    join(import.meta.dirname, "../../node_modules/@fungi.computer/computer"),
    join(directory, "node_modules/@fungi.computer/computer"),
  );
  await writeFile(join(directory, ".oyster-owner"), "test-owner");
});
afterEach(async () => {
  process.execPath = executable;
  await rm(directory, { recursive: true, force: true });
});
it.each(["signal", "exit", "spawn-error"] as const)(
  "reports real child %s before readiness without waiting for timeout",
  async (kind) => {
    await writeFile(
      join(directory, "node_modules/wrangler/bin/wrangler.js"),
      kind === "signal"
        ? 'process.kill(process.pid, "SIGTERM");'
        : "process.exit(7);",
    );
    if (kind === "spawn-error")
      process.execPath = join(directory, "missing-node");
    const ui = new Cli({
      brand: "fungi",
      output: new PassThrough(),
      interactive: false,
    });
    await expect(
      tryOyster([directory, "--port", "18983", "--no-open"], undefined, ui),
    ).rejects.toThrow(
      kind === "signal"
        ? "signal SIGTERM"
        : kind === "exit"
          ? "exit 7"
          : "could not launch its server process",
    );
  },
);

it("preserves an early log-stream failure through cancellation and child cleanup", async () => {
  await mkdir(join(directory, ".oyster/wrangler.log"), { recursive: true });
  await writeFile(
    join(directory, "node_modules/wrangler/bin/wrangler.js"),
    'require("node:fs").writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1000);',
  );
  const entered = Promise.withResolvers<undefined>();
  const watcher = watch(directory, { encoding: "utf8" }, (event, name) => {
    if (event === "change" && name === "child.pid") entered.resolve(undefined);
  });
  const controller = new AbortController();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (bytes: Buffer) => {
    transcript += bytes.toString();
  });
  const ui = new Cli({ brand: "fungi", output, interactive: false });
  const running = tryOyster(
    [directory, "--port", "18983", "--no-open"],
    undefined,
    ui,
    controller.signal,
  ).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  try {
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Fixture child did not start");
      }),
    ]);
    const pid = Number(await readFile(join(directory, "child.pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    expect(String(await running)).toContain("EISDIR");
    expect(transcript).not.toContain("Stopped.");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    watcher.close();
    controller.abort();
    await running;
  }
});

it("retains the startup diagnosis when signaling its own child group is refused", async () => {
  await writeFile(
    join(directory, "node_modules/wrangler/bin/wrangler.js"),
    'require("node:fs").writeFileSync("worker.pid", String(process.pid)); console.error("[ERROR] Tenant origin must be HTTPS"); setInterval(() => {}, 1000);',
  );
  const kill = process.kill.bind(process);
  let ownedGroup: number | undefined;
  const stopOwnedGroup = () => {
    if (ownedGroup === undefined) return;
    try {
      kill(ownedGroup, "SIGKILL");
    } catch (cause) {
      if (!(
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ESRCH"
      ))
        throw cause;
    }
  };
  const refused = vi
    .spyOn(process, "kill")
    .mockImplementation((pid, signal) => {
      if (
        signal === 0 &&
        existsSync(join(directory, "worker.pid")) &&
        pid === -Number(readFileSync(join(directory, "worker.pid"), "utf8"))
      ) {
        ownedGroup = pid;
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      }
      return kill(pid, signal);
    });
  try {
    await expect(
      tryOyster(
        [directory, "--port", "18983", "--no-open"],
        undefined,
        new Cli({
          brand: "fungi",
          output: new PassThrough(),
          interactive: false,
        }),
      ),
    ).rejects.toThrow(
      /Tenant origin must be HTTPS.*Cleanup also failed: kill EPERM/u,
    );
  } finally {
    refused.mockRestore();
    stopOwnedGroup();
  }
});
