// The Tourtois desktop for a local Oyster. The standalone Oyster builds its
// starter Apps on its own Computer, which a laptop does not have, so `oyster
// try` builds Tourtois here from its public source with the ordinary local
// packer and installs it as the home installation, approving its shell the
// same way `install-apps` does.
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import * as z from "zod";
import { installRelease, packRelease } from "../pack.js";
import { appBuildRecipe, readBuildManifest } from "../build/workspace-build.js";
import { approveChosenDashboard } from "./dashboard-approval.js";

const tourtoisRepository = "https://github.com/fungi-computer/tourtois.git";

const installationRowsSchema = z.array(
  z.object({ installationId: z.string() }).loose(),
);

const git = (cwd: string, args: readonly string[]) =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Whether the Oyster already has an installation with this id. */
export async function isInstalled(
  input: Readonly<{ url: string; key: string; installationId: string }>,
): Promise<boolean> {
  const response = await fetch(new URL("/api/installations", input.url), {
    headers: { Authorization: `Bearer ${input.key}` },
  });
  if (!response.ok) return false;
  const rows = installationRowsSchema.parse(await response.json());
  return rows.some((row) => row.installationId === input.installationId);
}

/** Build Tourtois from source on this machine and install it as `tourtois`. */
export async function installLocalDesktop(
  input: Readonly<{ url: string; key: string }>,
): Promise<void> {
  const scratch = await realpath(
    await mkdtemp(join(tmpdir(), "oyster-tourtois-")),
  );
  try {
    const source = join(scratch, "tourtois");
    git(scratch, ["clone", "--quiet", "--depth=1", tourtoisRepository, source]);
    const commit = git(source, ["rev-parse", "HEAD"]);
    const release = join(scratch, "release");
    await packRelease({
      appId: "app_tourtois",
      sourceDirectory: source,
      sourceRevision: `git:${commit}`,
      recipe: appBuildRecipe(
        readBuildManifest(git(source, ["show", `${commit}:package.json`])),
        "",
      ),
      outDirectory: release,
    });
    const owner = (method: "GET" | "PUT", path: string, body?: Schema.Json) => {
      const headers = new Headers({
        Authorization: `Bearer ${input.key}`,
        Accept: "application/json",
      });
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        headers.set("Content-Type", "application/json");
        init.body = JSON.stringify(body);
      }
      return fetch(new URL(path, input.url), init);
    };
    const response = await installRelease({
      directory: release,
      url: input.url,
      key: input.key,
      installationId: "tourtois",
      onCompleted: async (operation) => {
        if (operation.state === "succeeded")
          await approveChosenDashboard(operation, owner);
      },
    });
    if (!response.ok)
      throw new Error(`Tourtois install failed (${String(response.status)})`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
