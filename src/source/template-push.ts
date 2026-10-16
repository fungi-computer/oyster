import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAppId,
  parseSourceRevision,
  type SourceRevision,
} from "@fungi.computer/puffball";
import {
  authenticatedGitEnvironment,
  repositoryEnvironment,
} from "../build/git-environment.js";

/** One projected source tree, as `createFirstPartyAppSourceDistribution` returns it. */
export type TemplateSourceFiles = readonly Readonly<{
  path: string;
  contents: Uint8Array;
}>[];

/** What one template push did: the template's `main` now names `seedRevision`. */
export type TemplatePushResult = Readonly<{
  seedRevision: SourceRevision;
  /** False when `main` already held this exact tree (an exact retry). */
  pushed: boolean;
}>;

/** The fixed identity of every seed commit, so a retry of the same tree on
 * the same parent is the same commit. */
const seedIdentity = {
  GIT_AUTHOR_NAME: "Botanical App Source",
  GIT_AUTHOR_EMAIL: "app-source@botanical.invalid",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "Botanical App Source",
  GIT_COMMITTER_EMAIL: "app-source@botanical.invalid",
  GIT_COMMITTER_DATE: "@0 +0000",
};

/** Artifacts' native fork drops delta-encoded objects, so seed packs carry
 * whole objects only. Every local object is loose (written here, or fetched
 * with an unpack limit no fetch reaches), so no delta exists to reuse; a zero
 * window computes none, `--no-thin` sends none against remote objects and no
 * pack is reused verbatim. */
const wholeObjectPush = [
  "-c",
  "pack.window=0",
  "-c",
  "pack.depth=0",
  "-c",
  "pack.allowPackReuse=false",
] as const;
const looseFetch = ["-c", "fetch.unpackLimit=1000000000"] as const;

const objectId = /^[0-9a-f]{40}$/u;
/** One whole publication (project, fetch, push, confirm) is bounded. */
const TEMPLATE_PUSH_TIMEOUT_MS = 10 * 60_000;

/** The Git subcommand of `args`, past any leading `-c name=value` pairs. */
function command(args: readonly string[]): string {
  let at = 0;
  while (args[at] === "-c") at += 2;
  return args[at] ?? "";
}

function runGit(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  input?: string | Uint8Array,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      env: environment,
      shell: false,
      signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: Error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      if (code === 0 && spawnError === undefined) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim();
      reject(
        spawnError ??
          new Error(
            `git ${command(args)} failed${detail ? `: ${detail}` : ` (${String(code)})`}`,
          ),
      );
    });
    child.stdin.end(input);
  });
}

/** A template path names one regular file below the root: relative, no empty,
 * `.`, `..` or `.git` part, and never both a file and a directory. */
function checkTemplatePaths(files: TemplateSourceFiles): void {
  const paths = new Set<string>();
  for (const { path } of files) {
    const parts = path.split("/");
    if (
      path.length > 4096 ||
      path.includes("\\") ||
      path.includes("\0") ||
      parts.some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
    )
      throw new Error("Template source path is invalid");
    if (paths.has(path)) throw new Error("Duplicate template source path");
    paths.add(path);
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end += 1)
      if (paths.has(parts.slice(0, end).join("/")))
        throw new Error("Template source path is both a file and a directory");
  }
}

function oid(output: string): string {
  const value = output.trim();
  if (!objectId.test(value)) throw new Error("git returned no object id");
  return value;
}

function remoteMain(output: string): string | null {
  for (const line of output.split("\n")) {
    const [hash, ref] = line.split("\t");
    if (ref === "refs/heads/main" && hash !== undefined && objectId.test(hash))
      return hash;
  }
  return null;
}

/**
 * Commit one projected App source tree onto its template repository's `main`
 * with ordinary Git, and push it there over smart HTTP.
 *
 * The tree holds exactly the given bytes (no attributes or filters), each a
 * regular non-executable file. The first seed is a parentless commit; a later
 * different tree is an ordinary fast-forward on the current head; an exact
 * retry pushes nothing and answers the current head. Nothing is forced. The
 * `headers` authenticate every request and reach Git only through its config
 * environment.
 */
export async function pushTemplateSource(
  input: Readonly<{
    appId: string;
    /** The upstream commit the tree was projected from (`git:<sha>`). */
    sourceRevision: string;
    files: TemplateSourceFiles;
    /** The template repository's smart-HTTP URL, without credentials. */
    remote: string;
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }>,
): Promise<TemplatePushResult> {
  const appId = parseAppId(input.appId);
  const sourceRevision = parseSourceRevision(input.sourceRevision);
  const remote = new URL(input.remote);
  if (remote.username || remote.password || remote.search || remote.hash)
    throw new Error("Template remote must not carry credentials or a query");
  if (input.files.length === 0) throw new Error("Template source is empty");
  checkTemplatePaths(input.files);
  const deadline = AbortSignal.timeout(TEMPLATE_PUSH_TIMEOUT_MS);
  const signal =
    input.signal === undefined
      ? deadline
      : AbortSignal.any([input.signal, deadline]);
  const work = await mkdtemp(join(tmpdir(), "oyster-template-push-"));
  try {
    const gitDir = join(work, "repository.git");
    const staging = join(work, "files");
    const local = {
      ...repositoryEnvironment(),
      HOME: work,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_DIR: gitDir,
      GIT_INDEX_FILE: join(work, "index"),
    };
    const network = {
      ...authenticatedGitEnvironment(input.headers),
      HOME: work,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_DIR: gitDir,
    };
    const git = (args: readonly string[], stdin?: string | Uint8Array) =>
      runGit(args, local, signal, stdin);
    const remoteGit = (args: readonly string[]) =>
      runGit(args, network, signal);
    await runGit(
      ["init", "--quiet", "--bare", "--initial-branch=main", gitDir],
      local,
      signal,
    );

    // Blobs: raw bytes, loose objects, no clean/smudge or eol filters.
    await mkdir(staging);
    const paths: string[] = [];
    for (const [at, file] of input.files.entries()) {
      const path = join(staging, String(at));
      await writeFile(path, file.contents);
      paths.push(path);
    }
    const blobs = (
      await git(
        ["hash-object", "-w", "--no-filters", "--stdin-paths"],
        `${paths.join("\n")}\n`,
      )
    )
      .trim()
      .split("\n");
    if (
      blobs.length !== input.files.length ||
      !blobs.every((b) => objectId.test(b))
    )
      throw new Error("git did not write every template blob");
    const index = input.files
      .map((file, at) => `100644 ${blobs[at] ?? ""}\t${file.path}\0`)
      .join("");
    await git(["update-index", "-z", "--add", "--index-info"], index);
    const tree = oid(await git(["write-tree"]));

    const head = remoteMain(
      await remoteGit(["ls-remote", input.remote, "refs/heads/main"]),
    );
    let parents: string[] = [];
    if (head !== null) {
      await remoteGit([
        ...looseFetch,
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        input.remote,
        "refs/heads/main",
      ]);
      if (oid(await git(["rev-parse", `${head}^{tree}`])) === tree)
        return {
          seedRevision: parseSourceRevision(`git:${head}`),
          pushed: false,
        };
      parents = ["-p", head];
    }
    const commit = oid(
      await runGit(
        [
          "commit-tree",
          tree,
          ...parents,
          "-m",
          `Seed ${appId} from ${sourceRevision}`,
        ],
        { ...local, ...seedIdentity },
        signal,
      ),
    );
    await remoteGit([
      ...wholeObjectPush,
      "push",
      "--quiet",
      "--no-thin",
      input.remote,
      `${commit}:refs/heads/main`,
    ]);
    // A successful push is not sufficient: main must now name this commit.
    if (
      remoteMain(
        await remoteGit(["ls-remote", input.remote, "refs/heads/main"]),
      ) !== commit
    )
      throw new Error("Template main moved during the push");
    return { seedRevision: parseSourceRevision(`git:${commit}`), pushed: true };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
