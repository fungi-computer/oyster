import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };

const packageRoot = resolve(import.meta.dirname, "../..");
const oysterBin = packageJson.bin.oyster;
const builtBin = resolve(packageRoot, oysterBin);

function runSymlinkedBin(args: readonly string[]) {
  const directory = mkdtempSync(join(tmpdir(), "oyster-bin-proof-"));
  const home = join(directory, "home");
  const executable = join(directory, "oyster");
  mkdirSync(home);
  symlinkSync(relative(directory, builtBin), executable);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== "OYSTER_URL" &&
        name !== "OYSTER_OWNER_KEY" &&
        name !== "NODE_PATH",
    ),
  );
  try {
    return spawnSync(process.execPath, [executable, ...args], {
      cwd: packageRoot,
      env: {
        ...env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
      },
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("built Oyster npm bin symlink", () => {
  it("dispatches top-level help", () => {
    const finished = runSymlinkedBin(["--help"]);
    expect(finished.status).toBe(0);
    expect(finished.stderr).toBe("");
    expect(finished.stdout).toContain("oyster install-apps");
    expect(finished.stdout).toContain(
      "oyster install <directory|release.json>",
    );
  });

  it("dispatches install-apps and fails clearly when credentials are missing", () => {
    const finished = runSymlinkedBin(["install-apps"]);
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain("OYSTER_URL is not set");
    expect(finished.stderr).toContain("OYSTER_OWNER_KEY is not set");
    expect(finished.stderr).toContain("oyster install-apps --help");
  });

  it("reaches the install-apps handler's help without credentials", () => {
    const finished = runSymlinkedBin(["install-apps", "--help"]);
    expect(finished.status).toBe(0);
    expect(finished.stderr).toBe("");
    expect(finished.stdout).toContain("Usage: oyster install-apps");
    expect(finished.stdout).toContain("OYSTER_URL");
    expect(finished.stdout).toContain("seven starter Apps");
  });
});
