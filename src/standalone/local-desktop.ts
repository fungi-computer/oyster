import { CleanupError } from "../build/process-group.js";
// The starter Apps for a local Oyster. The standalone Oyster builds its starter
// Apps on its own Computer, which a laptop does not have, so `oyster try`
// builds each App here from its public source with the ordinary local packer
// and installs it; the Tourtois desktop is the home installation, and its shell
// is approved the same way `install-apps` does.
import { runGit } from "../build/local-build.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import * as z from "zod";
import { installRelease, packRelease } from "../pack.js";
import { appBuildRecipe, readBuildManifest } from "../build/workspace-build.js";
import { installationSchema } from "../apps/installation.js";
import { approveChosenDashboard } from "./dashboard-approval.js";
import { standaloneAppSet, type StarterApp } from "./app-set.js";

const repositoryUrl = (app: StarterApp) =>
  `https://github.com/fungi-computer/${app.repository}.git`;

/** The Tourtois desktop, which `oyster try` installs before anything else. */
export const desktopApp = requireStarter("tourtois");

function requireStarter(installationId: string): StarterApp {
  const found = standaloneAppSet.find(
    (app) => app.installationId === installationId,
  );
  if (found === undefined)
    throw new Error(`${installationId} is not a starter App`);
  return found;
}

const installationRowsSchema = z.array(installationSchema);
export type DesktopReadiness =
  "ready" | "approval-required" | "disabled" | "deleted" | "unavailable";

const git = async (cwd: string, args: readonly string[], signal: AbortSignal) =>
  new TextDecoder().decode(await runGit(args, cwd, signal, process.env)).trim();

/** Whether an installation of this id is saved on the Oyster. Read-only. */
export async function localStarterInstalled(
  input: Readonly<{
    url: string;
    key: string;
    installationId: string;
    signal?: AbortSignal;
  }>,
): Promise<boolean> {
  const request: RequestInit = {
    headers: { Authorization: `Bearer ${input.key}` },
  };
  if (input.signal !== undefined) request.signal = input.signal;
  const response = await fetch(
    new URL("/api/installations", input.url),
    request,
  );
  if (!response.ok)
    throw new Error(
      `Installation read failed (HTTP ${String(response.status)}).`,
    );
  return installationRowsSchema
    .parse(await response.json())
    .some((row) => row.installationId === input.installationId);
}

/** The host-owned entry decides whether the saved desktop may run. Read-only. */
export async function localDesktopState(
  input: Readonly<{ url: string; key: string; signal?: AbortSignal }>,
): Promise<DesktopReadiness | "missing"> {
  const request: RequestInit = {
    headers: { Authorization: `Bearer ${input.key}` },
  };
  if (input.signal !== undefined) request.signal = input.signal;
  const response = await fetch(
    new URL("/api/installations", input.url),
    request,
  );
  if (!response.ok)
    throw new Error(
      `Desktop installation read failed (HTTP ${String(response.status)}).`,
    );
  const rows = installationRowsSchema.parse(await response.json());
  const installed = rows.find((row) => row.installationId === "tourtois");
  if (installed === undefined) return "missing";
  if (installed.status === "disabled") return "disabled";
  if (installed.status === "deleted") return "deleted";
  const entry = await fetch(
    new URL(
      `/ui-entry/tourtois/${encodeURIComponent(installed.release.releaseId)}/shell.js`,
      input.url,
    ),
    input.signal === undefined ? undefined : { signal: input.signal },
  );
  if (entry.ok) return "ready";
  return entry.status === 403 ? "approval-required" : "unavailable";
}

/** Build one starter App from source on this machine and install it. */
export async function installLocalStarter(
  app: StarterApp,
  input: Readonly<{ url: string; key: string; signal?: AbortSignal }>,
): Promise<void> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const scratch = await mkdtemp(join(tmpdir(), `oyster-${app.repository}-`));
  try {
    const canonical = await realpath(scratch);
    signal.throwIfAborted();
    const source = join(canonical, app.repository);
    await git(
      canonical,
      ["clone", "--quiet", "--depth=1", repositoryUrl(app), source],
      signal,
    );
    const commit = await git(source, ["rev-parse", "HEAD"], signal);
    const release = join(scratch, "release");
    await packRelease({
      appId: app.appId,
      sourceDirectory: source,
      sourceRevision: `git:${commit}`,
      recipe: appBuildRecipe(
        readBuildManifest(
          await git(source, ["show", `${commit}:package.json`], signal),
        ),
        "",
      ),
      outDirectory: release,
      signal,
    });
    const owner = (method: "GET" | "PUT", path: string, body?: Schema.Json) => {
      const headers = new Headers({
        Authorization: `Bearer ${input.key}`,
        Accept: "application/json",
      });
      const init: RequestInit = { method, headers, signal };
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
      installationId: app.installationId,
      signal,
      onCompleted: async (operation) => {
        if (operation.state === "succeeded" && app.dashboard === true)
          await approveChosenDashboard(operation, owner);
      },
    });
    if (!response.ok)
      throw new Error(
        `${app.installationId} install failed (${String(response.status)})`,
      );
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(
      (cause: unknown) => {
        throw new CleanupError("App scratch cleanup failed", { cause });
      },
    );
  }
}
