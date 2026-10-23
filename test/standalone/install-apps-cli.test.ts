import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");
const cli = resolve(packageRoot, "src/standalone/install-apps-cli.ts");

type Finished = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function cliCommand(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Finished {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== "OYSTER_URL" && name !== "OYSTER_OWNER_KEY",
    ),
  );
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: packageRoot,
    env: { ...base, ...environment },
    encoding: "utf8",
  });
}

function installApps(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Finished {
  return cliCommand(["install-apps", ...args], environment);
}

it("top-level help discovers both starter and local Release installation without credentials", () => {
  const finished = cliCommand(["--help"], {});
  expect(finished.status).toBe(0);
  expect(finished.stderr).toBe("");
  expect(finished.stdout).toContain("oyster install-apps");
  expect(finished.stdout).toContain("oyster install <directory|release.json>");
});

describe("oyster install-apps", () => {
  it.each(["--help", "-h"])(
    "%s prints usage, where OYSTER_URL and OYSTER_OWNER_KEY come from, and exits 0",
    (flag) => {
      const finished = installApps([flag], {});
      expect(finished.status).toBe(0);
      expect(finished.stderr).toBe("");
      expect(finished.stdout).toContain("Usage: oyster install-apps");
      expect(finished.stdout).toContain("OYSTER_URL");
      expect(finished.stdout).toContain("OYSTER_OWNER_KEY");
      expect(finished.stdout).toContain("deployed Oyster");
      expect(finished.stdout).toContain("seven starter Apps");
    },
  );

  it("names OYSTER_URL when only the owner key is set and exits non-zero", () => {
    const finished = installApps([], {
      OYSTER_OWNER_KEY: "k".repeat(24),
    });
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain("OYSTER_URL is not set");
    expect(finished.stderr).not.toContain("OYSTER_OWNER_KEY is not set");
    expect(finished.stderr).toContain("oyster install-apps --help");
  });

  it("names OYSTER_OWNER_KEY when only the URL is set and exits non-zero", () => {
    const finished = installApps([], {
      OYSTER_URL: "https://oyster.example.workers.dev",
    });
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain("OYSTER_OWNER_KEY is not set");
    expect(finished.stderr).not.toContain("OYSTER_URL is not set");
    expect(finished.stderr).toContain("openssl rand -hex 24");
  });
});
