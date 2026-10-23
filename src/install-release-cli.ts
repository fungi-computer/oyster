/** Local Release installation uses the ordinary pack uploader and owner API. */
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { installRelease } from "./pack.js";

export const installReleaseUsage =
  "Usage: oyster install <directory|release.json> [--installation-id <name>]";

export async function installReleaseCommand(
  args: readonly string[],
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "installation-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(
      installReleaseUsage +
        "\nUpload a built Release and install it using OYSTER_URL and OYSTER_OWNER_KEY.\n",
    );
    return;
  }
  const [source] = positionals;
  if (positionals.length !== 1 || source === undefined)
    throw new Error(installReleaseUsage);
  const url = process.env.OYSTER_URL;
  const key = process.env.OYSTER_OWNER_KEY;
  if (!url || !key)
    throw new Error(
      "Set OYSTER_URL and OYSTER_OWNER_KEY for the target Oyster. " +
        installReleaseUsage,
    );
  const path = resolve(source);
  const info = await stat(path);
  if (
    !info.isDirectory() &&
    (!info.isFile() || basename(path) !== "release.json")
  )
    throw new Error("Expected a Release directory or release.json");
  const response = await installRelease({
    directory: info.isDirectory() ? path : dirname(path),
    url,
    key,
    installationId: values["installation-id"],
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(
      "Installation failed (" + String(response.status) + "): " + body,
    );
  process.stdout.write(body + "\n");
}
