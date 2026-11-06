import { CleanupError } from "../build/process-group.js";
// The starter Hello App for a local Oyster: a one-page bundled-html App,
// committed to git, packed into a Release and installed as `hello`. The
// quick start and `oyster try` install the same App through this module;
// `try` keeps its source at `<project>/hello-app` for the person to edit.
import { GitCommandError, runGit } from "../build/local-build.js";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helloPage, helloLayout } from "./hello-lesson.js";
import { helloAppScript } from "#hello-app-script";
import { installRelease, packRelease } from "../pack.js";

const manifest = {
  name: "hello-app",
  private: true,
  fungi: { app: { displayName: "Hello", icon: "fungi", capabilities: [] } },
};

export { helloPage } from "./hello-lesson.js";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const git = async (
  directory: string,
  args: readonly string[],
  signal: AbortSignal,
) =>
  new TextDecoder()
    .decode(
      await runGit(
        [
          "-c",
          "user.name=Oyster",
          "-c",
          "user.email=oyster@example.invalid",
          ...args,
        ],
        directory,
        signal,
        process.env,
      ),
    )
    .trim();

async function seedHello(source: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  await mkdir(join(source, "bundle"), { recursive: true });
  const { shellStyles, loginFontStyles } = await import("#page-script");
  for (const [name, contents] of [
    ["package.json", JSON.stringify(manifest, null, 2) + "\n"],
    ["bundle/index.html", helloPage],
    ["bundle/main.js", helloAppScript],
    ["bundle/lesson.css", shellStyles + loginFontStyles + helloLayout],
  ] as const) {
    signal.throwIfAborted();
    await writeFile(join(source, name), contents, { flag: "wx" }).catch(
      (cause: unknown) => {
        if (!(
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "EEXIST"
        ))
          throw cause;
      },
    );
  }
  await git(source, ["init", "-q"], signal);
  await git(source, ["add", "."], signal);
  await git(source, ["commit", "-qm", "Hello App"], signal);
  return git(source, ["rev-parse", "HEAD"], signal);
}

/** A first commit, never mere .git existence, makes the editable source ready. */
export async function prepareHelloSource(
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const source = join(directory, "hello-app");
  if (await exists(join(source, ".git"))) {
    try {
      return await git(
        source,
        ["rev-parse", "--verify", "--quiet", "HEAD"],
        signal,
      );
    } catch (cause) {
      if (!(cause instanceof GitCommandError && cause.exitCode === 1))
        throw cause;
      return seedHello(source, signal);
    }
  }
  if ((await exists(source)) && (await readdir(source)).length > 0)
    throw new Error(
      "hello-app already contains files without a Git repository; move that folder before creating the starter App.",
    );
  const stage = await mkdtemp(join(directory, ".hello-app-"));
  try {
    const commit = await seedHello(stage, signal);
    signal.throwIfAborted();
    await rename(stage, source);
    return commit;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(
      (cause: unknown) => {
        throw new CleanupError("Hello staging cleanup failed", { cause });
      },
    );
  }
}

/** Pack the Hello App kept at `<directory>/hello-app` and install it as
 * `hello`; answers the HTTP status (201 new, 200 when already installed).
 * The first call writes and commits the source; later calls pack its current
 * `HEAD`, so a committed edit followed by `oyster try` shows the change. */
export async function installHelloApp(
  input: Readonly<{
    directory: string;
    url: string;
    key: string;
    signal?: AbortSignal;
  }>,
): Promise<number> {
  const signal = input.signal ?? new AbortController().signal;
  const source = join(input.directory, "hello-app");
  const commit = await prepareHelloSource(input.directory, signal);
  signal.throwIfAborted();
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
      signal,
    });
    const response = await installRelease({
      directory: join(scratch, "release"),
      url: input.url,
      key: input.key,
      installationId: "hello",
      signal,
    });
    return response.status;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(
      (cause: unknown) => {
        throw new CleanupError("App scratch cleanup failed", { cause });
      },
    );
  }
}
