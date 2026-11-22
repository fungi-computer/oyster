import { expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { Cli } from "@fungi.computer/lantern";
import type {
  InstalledStarterApp,
  StarterAppSetResult,
} from "../../src/standalone/app-set.js";

const installedRecord = (
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
  const record = installedRecord;
  const result: StarterAppSetResult = {
    declined: false,
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

it("shows what built, what failed and why, and the permissions, then asks once", async () => {
  const originalCode = process.exitCode;
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const ui = new Cli({ brand: "fungi", output: stream, interactive: false });
  let answer: boolean | undefined;
  try {
    vi.stubEnv("OYSTER_URL", "https://oyster.test");
    vi.stubEnv("OYSTER_OWNER_KEY", "key");
    const { installApps: installAppsCommand } =
      await import("../../src/standalone/install-apps-cli.js");
    const install = async (
      options: Parameters<
        typeof import("../../src/standalone/app-set.js").installStandaloneAppSet
      >[0],
    ): Promise<StarterAppSetResult> => {
      answer = await options.confirm({
        previews: [
          {
            installationId: "tourtois",
            name: "app_tourtois",
            capabilities: ["app.storage", "agent.list"],
            update: null,
          },
        ],
        failed: [
          { installationId: "bonsai", reason: "bonsai build failed: compile" },
        ],
      });
      return { declined: !answer, installed: [], failed: [] };
    };
    // No terminal and no --yes: nothing is installed.
    await expect(installAppsCommand([], install, ui)).rejects.toThrow(
      "Install cancelled; nothing was installed",
    );
    expect(answer).toBe(false);
    const shown = chunks.join("");
    expect(shown).toContain("Built");
    expect(shown).toContain("bonsai: bonsai build failed: compile");
    expect(shown).toContain("Store App data");
    expect(shown).toContain("List Agents");
    // --yes confirms the same review without asking.
    await installAppsCommand(["--yes"], install, ui);
    expect(answer).toBe(true);
  } finally {
    process.exitCode = originalCode;
    vi.unstubAllEnvs();
  }
});

it("--yes with one failed App installs the rest and exits 1", async () => {
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
    const failed = [
      { installationId: "bonsai", reason: "bonsai build failed: compile" },
    ];
    let confirmed: boolean | undefined;
    await installAppsCommand(
      ["--yes"],
      async (options) => {
        confirmed = await options.confirm({
          previews: [
            {
              installationId: "tourtois",
              name: "app_tourtois",
              capabilities: ["app.storage"],
              update: null,
            },
          ],
          failed,
        });
        return {
          declined: !confirmed,
          installed: confirmed ? [installedRecord("tourtois", "build_1")] : [],
          failed,
        };
      },
      ui,
    );
    expect(confirmed).toBe(true);
    const shown = chunks.join("");
    expect(shown).toContain("tourtois  installed");
    expect(shown).toContain("bonsai  failed: bonsai build failed: compile");
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = originalCode;
    vi.unstubAllEnvs();
  }
});

it("records a checkout with uncommitted edits as a commit no release tag has", async () => {
  const { checkoutRevision } =
    await import("../../src/standalone/install-apps-cli.js");
  const root = mkdtempSync(join(tmpdir(), "checkout-revision-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "--quiet", "-m", "tagged");
    const tagged = git("rev-parse", "HEAD");
    expect(checkoutRevision(root)).toBe(tagged);
    writeFileSync(join(root, "a.txt"), "edited\n");
    const edited = checkoutRevision(root);
    expect(edited).toMatch(/^[a-f0-9]{40}$/u);
    expect(edited).not.toBe(tagged);
    expect(git("show", `${edited}:a.txt`)).toBe("edited");
    expect(git("status", "--porcelain")).toBe("M a.txt");
    // Another git process holding the checkout's index must not fail the
    // install: `git stash create` exits 1 silently in exactly this state.
    writeFileSync(join(root, ".git", "index.lock"), "");
    writeFileSync(join(root, "a.txt"), "edited again\n");
    expect(git("show", `${checkoutRevision(root)}:a.txt`)).toBe("edited again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
