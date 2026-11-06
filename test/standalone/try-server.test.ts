import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Cli } from "@fungi.computer/lantern";
import { afterEach, beforeEach, expect, it } from "vitest";
import { tryOyster } from "../../src/standalone/try-cli.js";

let directory: string;
const executable = process.execPath;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "oyster-server-failure-"));
  await mkdir(join(directory, "node_modules/wrangler/bin"), {
    recursive: true,
  });
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
