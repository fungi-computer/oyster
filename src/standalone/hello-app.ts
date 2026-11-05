// The starter Hello App for a local Oyster: a one-page bundled-html App,
// committed to git, packed into a Release and installed as `hello`. The
// quick start and `oyster try` install the same App through this module;
// `try` keeps its source at `<project>/hello-app` for the person to edit.
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helloAppScript } from "#hello-app-script";
import { installRelease, packRelease } from "../pack.js";

const manifest = {
  name: "hello-app",
  private: true,
  fungi: { app: { displayName: "Hello", icon: "fungi", capabilities: [] } },
};

// The script announces the page to Oyster; without it the window never opens.
export const helloPage =
  '<!doctype html>\n<title>Hello</title>\n<h1>Hello from my first Oyster App</h1>\n<script type="module" src="./main.js"></script>\n';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const git = (directory: string, args: readonly string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      directory,
      "-c",
      "user.name=Oyster",
      "-c",
      "user.email=oyster@example.invalid",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

// Write `hello-app/` under `directory` and commit it; answers the commit.
async function writeHelloApp(directory: string): Promise<string> {
  const source = join(directory, "hello-app");
  await mkdir(join(source, "bundle"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(join(source, "bundle", "index.html"), helloPage);
  await writeFile(join(source, "bundle", "main.js"), helloAppScript);
  git(source, ["init", "-q"]);
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "Hello App"]);
  return git(source, ["rev-parse", "HEAD"]);
}

/** Pack the Hello App kept at `<directory>/hello-app` and install it as
 * `hello`; answers the HTTP status (201 new, 200 when already installed).
 * The first call writes and commits the source; later calls pack its current
 * `HEAD`, so a committed edit followed by `oyster try` shows the change. */
export async function installHelloApp(
  input: Readonly<{ directory: string; url: string; key: string }>,
): Promise<number> {
  const source = join(input.directory, "hello-app");
  const commit = (await exists(join(source, ".git")))
    ? git(source, ["rev-parse", "HEAD"])
    : await writeHelloApp(input.directory);
  const scratch = await mkdtemp(join(tmpdir(), "oyster-hello-"));
  try {
    await packRelease({
      appId: "app_hello",
      sourceDirectory: source,
      sourceRevision: `git:${commit}`,
      recipe: {
        kind: "bundled-html",
        entry: "bundle/index.html",
        assets: {
          maxManifestBytes: 65_536,
          maxObjects: 16,
          maxObjectBytes: 1_048_576,
          maxTotalBytes: 4_194_304,
        },
        assetBase: "./",
        backend: null,
        maxOutputBytes: 4_194_304,
      },
      outDirectory: join(scratch, "release"),
    });
    const response = await installRelease({
      directory: join(scratch, "release"),
      url: input.url,
      key: input.key,
      installationId: "hello",
    });
    return response.status;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
