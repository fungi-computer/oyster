/** Local Release installation uses the ordinary pack uploader and owner API. */
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Cli } from "@fungi.computer/lantern";
import { installConfirmation, permissionCatalog } from "./apps/index.js";
import { installRelease, previewRelease } from "./pack.js";

export const installReleaseUsage =
  "Usage: oyster install <directory|release.json>... [--installation-id <name>] [--yes]";

export async function installReleaseCommand(
  args: readonly string[],
  // Progress goes to stderr so stdout stays the installation result.
  ui: Cli = new Cli({ brand: "fungi", output: process.stderr }),
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "installation-id": { type: "string" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(
      installReleaseUsage +
        "\nUpload built Releases and install them using OYSTER_URL and OYSTER_OWNER_KEY.\nYou confirm the Apps' permissions once for the whole install; --yes confirms without asking.\n",
    );
    return;
  }
  if (
    positionals.length === 0 ||
    (positionals.length > 1 && values["installation-id"] !== undefined)
  )
    throw new Error(installReleaseUsage);
  const url = process.env.OYSTER_URL;
  const key = process.env.OYSTER_OWNER_KEY;
  if (!url || !key)
    throw new Error(
      "Set OYSTER_URL and OYSTER_OWNER_KEY for the target Oyster. " +
        installReleaseUsage,
    );
  const directories = await Promise.all(
    positionals.map(async (source) => {
      const path = resolve(source);
      const info = await stat(path);
      if (
        !info.isDirectory() &&
        (!info.isFile() || basename(path) !== "release.json")
      )
        throw new Error("Expected a Release directory or release.json");
      return info.isDirectory() ? path : dirname(path);
    }),
  );
  ui.welcome("Oyster: install Releases");
  // One list for the whole install, from the rule the install itself applies.
  const previews = await ui.task("Checking what the Apps ask for", async () => {
    const found = [];
    for (const directory of directories)
      found.push({
        directory,
        ...(await previewRelease({
          directory,
          url,
          key,
          installationId: values["installation-id"],
        })),
      });
    return found;
  });
  // A fresh install grants by the shared rule; an update keeps its current
  // grants, so it lists only what newly waits for approval.
  const confirmation = installConfirmation(
    "owner",
    previews.filter(({ update }) => update === null),
  );
  const lines = (rows: typeof confirmation.granted) =>
    rows.map(
      (row) =>
        `${row.label}: ${row.description}${row.warning === null ? "" : ` ${row.warning}`} (${row.apps.join(", ")})`,
    );
  if (confirmation.granted.length > 0)
    ui.note(
      `Installing ${previews
        .filter(({ update }) => update === null)
        .map(({ name }) => name)
        .join(", ")} lets them:`,
      lines(confirmation.granted),
    );
  if (confirmation.needsApproval.length > 0)
    ui.note(
      "Not granted by installing; approve in Settings > Permissions:",
      lines(confirmation.needsApproval),
    );
  for (const { name, update } of previews)
    if (update !== null)
      ui.note(
        `Updating ${update.installationId} (${name}) keeps its current permissions:`,
        update.needsApproval.length === 0
          ? ["Nothing new is requested."]
          : [
              "Newly requested, waiting for approval in Settings > Permissions:",
              ...update.needsApproval.map(
                (capability) => permissionCatalog[capability].label,
              ),
            ],
      );
  if (values.yes !== true) {
    const answer = await ui.confirm({
      message: `Install ${String(previews.length)} App${previews.length === 1 ? "" : "s"} with these permissions?`,
    });
    if (answer !== true)
      throw new Error(
        "Install cancelled; nothing was installed. Run with --yes to confirm without asking.",
      );
  }
  for (const { directory, release } of previews) {
    const body = await ui.task(
      `Installing ${basename(directory)}`,
      async () => {
        const response = await installRelease({
          directory,
          uploaded: release,
          url,
          key,
          installationId: values["installation-id"],
        });
        const text = await response.text();
        if (!response.ok)
          throw new Error(
            "Installation failed (" + String(response.status) + "): " + text,
          );
        return text;
      },
    );
    process.stdout.write(body.trim() + "\n");
  }
  ui.outro(`Open ${url}/ to use ${directories.length === 1 ? "it" : "them"}.`);
}
