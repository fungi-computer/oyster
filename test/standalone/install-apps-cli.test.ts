import { expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { Cli } from "@fungi.computer/lantern";
import type {
  InstalledStarterApp,
  StarterAppSetResult,
} from "../../src/standalone/app-set.js";

it("importing the CLI module does not dispatch a command", () => {
  const cli = resolve(
    import.meta.dirname,
    "../../src/standalone/install-apps-cli.ts",
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== "OYSTER_URL" &&
        name !== "OYSTER_OWNER_KEY" &&
        name !== "NODE_PATH",
    ),
  );
  const finished = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(cli)})`,
    ],
    { cwd: resolve(import.meta.dirname, "../.."), env, encoding: "utf8" },
  );
  expect(finished.status).toBe(0);
  expect(finished.stdout).toBe("");
  expect(finished.stderr).toBe("");
});

it("the import-safe handler prints failed Apps and sets a non-zero exit code", async () => {
  const record = (
    installationId: string,
    jobId: string,
  ): InstalledStarterApp => ({
    installationId,
    jobId,
    published: "recorded",
    seedRevision: "git:seed",
    sourceRevision: "git:source",
    installed: "installed",
    release: null,
    timings: {
      fetch: 0,
      publish: 0,
      queue: 0,
      build: 0,
      install: 0,
      computer: null,
    },
  });
  const result: StarterAppSetResult = {
    installed: [record("tourtois", "build_1"), record("shed", "build_3")],
    failed: [
      { installationId: "bonsai", reason: "bonsai build failed: compile" },
    ],
  };
  const originalCode = process.exitCode;
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const ui = new Cli({ brand: "fungi", output: stream, interactive: false });
  try {
    vi.stubEnv("OYSTER_URL", "https://oyster.test");
    vi.stubEnv("OYSTER_OWNER_KEY", "key");
    const { installApps: installAppsCommand } =
      await import("../../src/standalone/install-apps-cli.js");
    await installAppsCommand([], () => Promise.resolve(result), ui);
    expect(chunks.join("")).toContain("tourtois  installed");
    expect(chunks.join("")).toContain(
      "bonsai  failed: bonsai build failed: compile",
    );
    expect(chunks.join("")).toContain("shed  installed");
    expect(chunks.join("")).toContain("Installed 2 Apps; failed 1");
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = originalCode;
    vi.unstubAllEnvs();
  }
});
