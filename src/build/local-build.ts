import { Buffer } from "node:buffer";
import {
  appBackendPackageMainFields,
  createDefinitionEmission,
  type DefinitionEmission,
} from "./definition-emission.js";
function logEvent(operation: string, cause: unknown): void {
  console.error(
    JSON.stringify({
      source: "app-publisher",
      operation,
      failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
    }),
  );
}
import { frozenSnapshotInstallArguments } from "./snapshot-package-store.js";
import mime from "mime";
import {
  assetPathSchema,
  assetBuildJsonSchema,
  decodeAssetBuild,
  type AssetBuildPolicy,
} from "@fungi.computer/puffball/assets";
import {
  resolveWorkspaceBuild,
  workspaceProjectsArguments,
  type WorkspaceBuild,
} from "./workspace-build.js";
import type { WorkspaceBuildStep } from "./build-step.js";
import { readBundledHtml } from "./bundled-html.js";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, mkdtempSync, realpathSync } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  parseArtifactRef,
  parseSha256Digest,
  parseSourceRevision,
  type AppDeclaration,
  type AppId,
  type SourceRevision,
} from "@fungi.computer/puffball";
import { appIdSchema } from "@fungi.computer/puffball/effect";
import {
  appBuildJsonSchema,
  createAppBuild,
} from "@fungi.computer/puffball/app";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as esbuild from "esbuild";
import { readWantedLockfile, writeWantedLockfile } from "@pnpm/lockfile.fs";
import { pruneSharedLockfile } from "@pnpm/lockfile.pruner";

import {
  AppPublisherError,
  appBackendExportConditions,
  createAppPublisher,
  pinnedRecipeSchema,
  type AppPublisher,
  type ArtifactWriter,
  type BuildExecutor,
  type BuildExecutorOutput,
  type BuildOutput,
  type CapturedSource,
  type PinnedRecipe,
  type ReleaseCreator,
  type SourceCapture,
  type StoredArtifact,
} from "./effect.js";
import {
  artifactsGitEnvironment,
  repositoryEnvironment,
} from "./git-environment.js";

const localConfigSchema = Schema.Struct({
  appId: appIdSchema,
  source: Schema.Struct({
    repositoryPath: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  }),
  recipe: pinnedRecipeSchema,
  artifactRoot: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

type LocalConfig = Schema.Schema.Type<typeof localConfigSchema>;

const ACCEPTED_BRANCH = "main" as const;

function localRepositoryPath(input: string): string {
  if (isAbsolute(input) && !input.startsWith("//")) return input;
  throw new AppPublisherError("configuration");
}

function sha256(bytes: Uint8Array): ReturnType<typeof parseSha256Digest> {
  return parseSha256Digest(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );
}

async function sha256File(
  path: string,
  signal: AbortSignal,
): Promise<ReturnType<typeof parseSha256Digest>> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash, { signal });
  return parseSha256Digest(`sha256:${hash.digest("hex")}`);
}

function runGit(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv = repositoryEnvironment(),
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env: environment,
      shell: false,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let spawnError: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error: Error) => {
      spawnError = error;
    });
    child.once("close", (code, terminationSignal) => {
      if (code === 0 && spawnError === undefined) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        spawnError ??
          new Error(
            detail.length > 0
              ? `git exited unsuccessfully: ${detail}`
              : `git exited unsuccessfully (${String(code)} ${String(terminationSignal)})`,
          ),
      );
    });
  });
}

function extractTar(
  archivePath: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "tar",
      [
        "--extract",
        "--file",
        archivePath,
        "--directory",
        destination,
        "--no-same-owner",
      ],
      { shell: false, signal, stdio: ["ignore", "ignore", "pipe"] },
    );
    const stderr: Buffer[] = [];
    let spawnError: Error | undefined;
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error: Error) => {
      spawnError = error;
    });
    child.once("close", (code, terminationSignal) => {
      if (code === 0 && spawnError === undefined) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        spawnError ??
          new Error(
            detail.length > 0
              ? `tar exited unsuccessfully: ${detail}`
              : `tar exited unsuccessfully (${String(code)} ${String(terminationSignal)})`,
          ),
      );
    });
  });
}

async function rejectSymbolicLinks(
  snapshotPath: string,
  signal: AbortSignal,
): Promise<void> {
  const directories = [snapshotPath];
  while (directories.length > 0) {
    signal.throwIfAborted();
    const directory = directories.pop();
    if (directory === undefined) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        throw new Error("Symbolic links are not accepted in source snapshots");
      }
      if (stats.isDirectory()) directories.push(path);
    }
  }
}

async function captureGitSnapshot(
  workdir: string,
  repositoryPath: string,
  reference: string,
  expectedRevision: SourceRevision | undefined,
  signal: AbortSignal,
  fetchEnvironment: NodeJS.ProcessEnv = repositoryEnvironment(),
): Promise<CapturedSource> {
  const snapshotPath = join(workdir, "snapshot");
  const archivePath = join(workdir, "snapshot.tar");
  await mkdir(snapshotPath);
  await runGit(["init", "--quiet"], workdir, signal);
  await runGit(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--depth=1",
      "--",
      repositoryPath,
      reference,
    ],
    workdir,
    signal,
    fetchEnvironment,
  );
  const sourceRevision = parseSourceRevision(
    `git:${Buffer.from(
      await runGit(
        ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        workdir,
        signal,
      ),
    )
      .toString("utf8")
      .trim()}`,
  );
  if (expectedRevision !== undefined && sourceRevision !== expectedRevision)
    throw new Error(
      "Captured Git commit differs from requested source revision",
    );
  await runGit(
    [
      "archive",
      "--format=tar",
      // Git's @0 date spelling means "now" in the maintained local Git
      // version; this equivalent absolute spelling keeps the tar bytes fixed.
      "--mtime=1970-01-01T00:00:00Z",
      "--output",
      archivePath,
      "FETCH_HEAD^{tree}",
    ],
    workdir,
    signal,
  );
  const sourceTreeDigest = await sha256File(archivePath, signal);
  await extractTar(archivePath, snapshotPath, signal);
  await rejectSymbolicLinks(snapshotPath, signal);
  return Object.freeze({
    sourceRevision,
    sourceTreeDigest,
    snapshotPath,
  });
}

async function captureCommit(
  workdir: string,
  repositoryPath: string,
  sourceRevision: SourceRevision,
  signal: AbortSignal,
): Promise<CapturedSource> {
  const commit = sourceRevision.slice("git:".length);
  return captureGitSnapshot(
    workdir,
    repositoryPath,
    commit,
    sourceRevision,
    signal,
  );
}

function scopedSourceCapture(
  capture: (workdir: string, signal: AbortSignal) => Promise<CapturedSource>,
  failureMessage: string,
): SourceCapture {
  return {
    capture: () =>
      Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "app-publisher-"))),
        (workdir) =>
          Effect.tryPromise({
            try: () => rm(workdir, { recursive: true, force: true }),
            catch: () => new Error("Local source cleanup failed"),
          }).pipe(
            Effect.catch((cause: unknown) => {
              logEvent("services/app-publisher/src/local.ts:289", cause);
              return Effect.void;
            }),
          ),
      ).pipe(
        Effect.flatMap((workdir) =>
          Effect.tryPromise({
            try: (signal) => capture(workdir, signal),
            catch: () => new Error(failureMessage),
          }),
        ),
      ),
  };
}

function artifactsFetchEnvironment(token: string): NodeJS.ProcessEnv {
  if (token.length === 0 || /[\r\n]/.test(token))
    throw new AppPublisherError("configuration");
  // Keep credentials in the Git environment, never argv or the remote URL.
  return artifactsGitEnvironment(token);
}

/** Local proving adapter; accepted source policy is intentionally fixed to main. */
export function createLocalSourceCapture(
  repositoryPath: string,
): SourceCapture {
  const localPath = localRepositoryPath(repositoryPath);
  return scopedSourceCapture(
    (workdir, signal) =>
      captureGitSnapshot(
        workdir,
        localPath,
        `refs/heads/${ACCEPTED_BRANCH}`,
        undefined,
        signal,
      ),
    "Local Git source capture failed",
  );
}

/** Capture saved App files for local authoring without modifying the customer's
 * repository. Provenance names the exact temporary Git snapshot, not an existing
 * customer commit. Dependencies and local credentials are not source inputs.
 */
export function createLocalDirectorySourceCapture(
  directory: string,
): SourceCapture {
  const sourceDirectory = resolve(directory);
  const excluded = new Set([
    ".git",
    "node_modules",
    ".botanical",
    ".wrangler",
    "dist",
    ".npmrc",
  ]);
  return scopedSourceCapture(async (workdir, signal) => {
    const repository = join(workdir, "working");
    await cp(sourceDirectory, repository, {
      recursive: true,
      filter: (path) => {
        const parts = relative(sourceDirectory, path).split(sep);
        return !parts.some(
          (part) =>
            excluded.has(part) ||
            part.startsWith(".env") ||
            part.startsWith(".dev.vars"),
        );
      },
    });
    await rejectSymbolicLinks(repository, signal);
    const environment = {
      ...repositoryEnvironment(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
    };
    await runGit(["init", "--quiet"], repository, signal, environment);
    await runGit(["add", "."], repository, signal, environment);
    await runGit(
      [
        "-c",
        "user.name=Fungi App builder",
        "-c",
        "user.email=app-builder@localhost",
        "commit",
        "--quiet",
        "-m",
        "Capture local App source",
      ],
      repository,
      signal,
      environment,
    );
    return captureGitSnapshot(
      workdir,
      repository,
      "HEAD",
      undefined,
      signal,
      environment,
    );
  }, "Local App source capture failed");
}

/** Capture an exact Artifacts commit through a trusted host's credential-free Git URL. */
export function createArtifactsSourceCapture(options: {
  readonly remote: string;
  readonly token: string;
  readonly sourceRevision: SourceRevision;
}): SourceCapture {
  let remote: URL;
  let revision: SourceRevision;
  let fetchEnvironment: NodeJS.ProcessEnv;
  try {
    remote = new URL(options.remote);
    const localHttp =
      remote.protocol === "http:" &&
      (remote.hostname === "localhost" || remote.hostname === "127.0.0.1");
    if (
      (remote.protocol !== "https:" && !localHttp) ||
      remote.username ||
      remote.password ||
      remote.search ||
      remote.hash
    )
      throw new Error("Invalid Artifacts remote");
    revision = parseSourceRevision(options.sourceRevision);
    fetchEnvironment = artifactsFetchEnvironment(options.token);
  } catch {
    throw new AppPublisherError("configuration");
  }
  return scopedSourceCapture(
    (workdir, signal) =>
      captureGitSnapshot(
        workdir,
        remote.toString(),
        revision.slice("git:".length),
        revision,
        signal,
        fetchEnvironment,
      ),
    "Artifacts Git source capture failed",
  );
}

/** Capture one explicit committed revision without manufacturing a branch. */
export function createLocalCommitSourceCapture(
  repositoryPath: string,
  sourceRevision: SourceRevision,
): SourceCapture {
  const localPath = localRepositoryPath(repositoryPath);
  const revision = parseSourceRevision(sourceRevision);
  return scopedSourceCapture(
    (workdir, signal) => captureCommit(workdir, localPath, revision, signal),
    "Local Git source capture failed",
  );
}

const workspacePackageSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  path: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

/** Hydrate the App workspace and its runtime workspace dependency closure. */
function productionWorkspaceSelectors(
  build: WorkspaceBuild,
): readonly string[] {
  return ["--filter-prod", `${build.packageName}...`];
}

/** Derive the App's page build from the captured tree's own manifests. */
function capturedWorkspaceBuild(
  snapshot: string,
  entry: string,
  run: (args: readonly string[]) => Effect.Effect<string, unknown>,
): Effect.Effect<WorkspaceBuild, unknown> {
  return Effect.flatMap(run(workspaceProjectsArguments), (projects) =>
    Effect.tryPromise({
      try: () => resolveWorkspaceBuild({ root: snapshot, entry, projects }),
      catch: (error) => error,
    }),
  );
}

const sourceDistributionRootFiles = [
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.build.json",
] as const;

/**
 * Keep only the pinned dependency graph the editable template's included
 * workspaces actually resolve. pnpm-lock.yaml tracks every workspace member
 * in the repository; copying it whole makes every captured App's upload grow
 * with dependency churn anywhere in the monorepo, including unrelated Apps,
 * packages and docs tooling outside this App's build. `isIncludedPath`
 * reports whether a workspace importer path (its `package.json` directory)
 * is among the files already selected for this distribution.
 *
 * The read, the importer-closure graph walk and the write are pnpm's own
 * maintained lockfile packages (`@pnpm/lockfile.fs`, `@pnpm/lockfile.pruner`),
 * not a hand-rolled parse of pnpm's lockfile grammar. Only the choice of
 * which importers to keep is this distribution's own decision.
 */
async function prunePnpmLockfile(
  snapshotPath: string,
  isIncludedPath: (importerPath: string) => boolean,
): Promise<Uint8Array> {
  const lockfile = await readWantedLockfile(snapshotPath, {
    ignoreIncompatible: false,
  });
  if (lockfile === null)
    throw new Error("Source distribution is missing its pnpm-lock.yaml");
  const importers = Object.fromEntries(
    Object.entries(lockfile.importers).filter(
      ([path]) => path === "." || isIncludedPath(path),
    ),
  );
  const pruned = pruneSharedLockfile(
    { ...lockfile, importers },
    {
      warn: (message) => {
        throw new Error(
          `pnpm-lock.yaml pruning hit an unresolved dependency: ${message}`,
        );
      },
    },
  );
  const scratch = mkdtempSync(join(tmpdir(), "oyster-lockfile-prune-"));
  try {
    await writeWantedLockfile(scratch, pruned);
    return await readFile(join(scratch, "pnpm-lock.yaml"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A first-party editable source tree ready to seed into an Artifacts template. */
export type FirstPartyAppSourceDistribution = Readonly<{
  readonly appId: AppId;
  readonly sourceRevision: SourceRevision;
  readonly sourceTreeDigest: ReturnType<typeof parseSha256Digest>;
  readonly appDirectory: string;
  readonly files: readonly Readonly<{
    readonly path: string;
    readonly contents: Uint8Array;
  }>[];
}>;

/**
 * Project one pinned first-party App and its pnpm workspace dependency graph
 * without changing upstream files or manufacturing Git history. The caller
 * records the returned provenance on the Artifacts template seed commit.
 */
export function createFirstPartyAppSourceDistribution(options: {
  readonly appId: string;
  readonly source: CapturedSource;
  readonly entry: string;
}): Effect.Effect<FirstPartyAppSourceDistribution, unknown> {
  const appId = Schema.decodeUnknownSync(appIdSchema)(options.appId);
  if (!options.entry.endsWith(".html"))
    return Effect.fail(new AppPublisherError("configuration"));

  const snapshot = realpathSync(resolve(options.source.snapshotPath));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(snapshot, ".publisher-source-home"),
    NODE_ENV: "production",
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null",
  };

  return Effect.gen(function* () {
    const recipe = yield* capturedWorkspaceBuild(
      snapshot,
      options.entry,
      (args) => runHtmlCommand(args, snapshot, env),
    );
    const appDirectory = recipe.directory;
    const listed = yield* runHtmlCommand(
      [
        ...productionWorkspaceSelectors(recipe),
        "list",
        "--depth",
        "-1",
        "--prod",
        "--json",
      ],
      snapshot,
      env,
    );
    const workspaces = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Array(workspacePackageSchema)),
    )(listed);
    const selectedApp = workspaces.filter(
      (workspace) => workspace.name === recipe.packageName,
    );
    const selectedAppWorkspace = selectedApp[0];
    if (
      selectedApp.length !== 1 ||
      !selectedAppWorkspace ||
      realpathSync(selectedAppWorkspace.path) !==
        realpathSync(resolve(snapshot, recipe.directory))
    )
      return yield* Effect.fail(new AppPublisherError("source"));

    const selectedPaths = new Set<string>();
    const packageNames = new Set<string>();
    for (const workspace of workspaces) {
      if (packageNames.has(workspace.name))
        return yield* Effect.fail(new AppPublisherError("source"));
      packageNames.add(workspace.name);
      const path = resolve(workspace.path);
      const relativePath = relative(snapshot, path);
      if (
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath) ||
        (!relativePath.startsWith("apps/") &&
          !relativePath.startsWith("forks/") &&
          !relativePath.startsWith("packages/") &&
          !relativePath.startsWith("runtimes/"))
      )
        return yield* Effect.fail(new AppPublisherError("source"));
      selectedPaths.add(relativePath);
    }

    const files = yield* Effect.tryPromise({
      try: async () => {
        const collected = new Map<string, Uint8Array>();
        const collect = async (relativePath: string): Promise<void> => {
          const sourcePath = join(snapshot, relativePath);
          const stats = await lstat(sourcePath);
          if (stats.isSymbolicLink())
            throw new Error(
              "Source distribution cannot contain symbolic links",
            );
          if (stats.isFile()) {
            collected.set(relativePath, await readFile(sourcePath));
            return;
          }
          if (!stats.isDirectory())
            throw new Error("Source distribution contains a non-file entry");
          const entries = await readdir(sourcePath, { withFileTypes: true });
          entries.sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            // Design workbenches are outside the editable production build.
            if (
              selectedPaths.has(relativePath) &&
              entry.name === "workbench" &&
              entry.isDirectory()
            )
              continue;
            // A dependency's own tests are not App build inputs; the App keeps its tests.
            if (
              selectedPaths.has(relativePath) &&
              relativePath !== appDirectory &&
              entry.name === "test" &&
              entry.isDirectory()
            )
              continue;
            // Generated API docs and documentation media are not App build inputs.
            if (
              relativePath.startsWith("packages/") &&
              basename(relativePath) === "docs" &&
              selectedPaths.has(dirname(relativePath)) &&
              (entry.name === "media" || entry.name === "api") &&
              entry.isDirectory()
            )
              continue;
            await collect(join(relativePath, entry.name));
          }
        };
        for (const relativePath of [...selectedPaths].sort())
          await collect(relativePath);
        for (const relativePath of sourceDistributionRootFiles)
          await collect(relativePath);
        await collect("patches");
        if (collected.has("pnpm-lock.yaml"))
          collected.set(
            "pnpm-lock.yaml",
            await prunePnpmLockfile(snapshot, (importerPath) =>
              collected.has(join(importerPath, "package.json")),
            ),
          );
        if (collected.has("botanical-app-source.json"))
          throw new Error("Source distribution reserves its provenance path");
        collected.set(
          "botanical-app-source.json",
          new TextEncoder().encode(
            JSON.stringify(
              {
                appId,
                sourceRevision: options.source.sourceRevision,
                sourceTreeDigest: options.source.sourceTreeDigest,
              },
              null,
              2,
            ) + "\n",
          ),
        );
        return [...collected]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, contents]) => Object.freeze({ path, contents }));
      },
      catch: (error) => error,
    });
    return Object.freeze({
      appId,
      sourceRevision: options.source.sourceRevision,
      sourceTreeDigest: options.source.sourceTreeDigest,
      appDirectory,
      files,
    });
  });
}

function htmlGroupExists(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

// Narrow adaptation of Caps' workbench-process process-group teardown. The
// Effect finalizer waits for cleanup before the source snapshot can be removed.
async function stopHtmlGroup(child: ChildProcess): Promise<void> {
  if (!htmlGroupExists(child)) return;
  const deadline = Date.now() + 5_000;
  for (const [signal, until] of [
    ["SIGTERM", deadline - 1_000],
    ["SIGKILL", deadline],
  ] as const) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
    while (htmlGroupExists(child) && Date.now() < until) await delay(25);
    if (!htmlGroupExists(child)) return;
  }
  throw new Error("HTML process group survived its five-second cleanup bound");
}

function runHtmlCommand(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  command = "pnpm",
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      if (process.platform === "win32")
        throw new Error("HTML builds require POSIX process groups");
      const child = spawn(command, [...args], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const completion = new Promise<string>((resolveResult, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (Buffer.byteLength(stdout) > 1024 * 1024)
            reject(new Error("HTML command output exceeded its bound"));
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          if (Buffer.byteLength(stderr) > 1024 * 1024)
            reject(new Error("HTML command diagnostics exceeded their bound"));
        });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolveResult(stdout);
          else
            reject(
              new Error(
                stderr || stdout || `HTML command exited ${String(code)}`,
              ),
            );
        });
      });
      return { child, completion };
    }),
    ({ completion }) =>
      Effect.tryPromise({ try: () => completion, catch: (error) => error }),
    ({ child }) => Effect.promise(() => stopHtmlGroup(child)),
  );
}

/** Load the bundled snapshot programs only when a snapshot build writes them,
 * so source-level importers of this module do not need the package build. */
function snapshotPrograms() {
  return import("#snapshot-program-scripts");
}

/** Compiler heap ceiling: fits a 6 GB Computer with room for pnpm and esbuild. */
const snapshotBuildHeapMegabytes = 4096;

function snapshotBuildEnvironment(
  sourceSnapshotPath: string,
): NodeJS.ProcessEnv {
  // PATH locates pinned executables; the Computer's CA files authenticate
  // its egress gateway. Credentials and package-manager settings stay out.
  // V8 sizes its default heap from the machine, about 2 GB in a 6 GB
  // standard-2 Computer, where compiling Bonsai runs out; the build owns one
  // fixed ceiling instead.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(sourceSnapshotPath, ".publisher-home"),
    NODE_ENV: "production",
    NODE_OPTIONS: `--max-old-space-size=${String(snapshotBuildHeapMegabytes)}`,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null",
  };
  return env;
}

function rebuildViteSnapshot(
  sourceSnapshotPath: string,
  recipe: import("./effect.js").PinnedRecipe,
  packageStoreDirectory: string | undefined,
): Effect.Effect<BuildExecutorOutput, unknown> {
  if (recipe.kind === "source-html")
    return rebuildNpmSnapshot(sourceSnapshotPath, recipe);
  return Effect.gen(function* () {
    const env = snapshotBuildEnvironment(sourceSnapshotPath);
    const run = (args: readonly string[], cwd = sourceSnapshotPath) =>
      runHtmlCommand(args, cwd, env);
    if ((yield* run(["--version"])).trim() !== "11.24.0") {
      return yield* Effect.fail(new Error("Publisher requires pnpm 11.24.0"));
    }
    const html = yield* capturedWorkspaceBuild(
      sourceSnapshotPath,
      recipe.entry,
      run,
    );
    yield* Effect.tryPromise({
      try: () =>
        checkPinnedWorkspaceToolchain(sourceSnapshotPath, html, recipe),
      catch: (error) => error,
    });
    yield* run([
      ...productionWorkspaceSelectors(html),
      ...frozenSnapshotInstallArguments(packageStoreDirectory),
    ]);
    const appDirectory = join(sourceSnapshotPath, html.directory);
    const dependencies = join(appDirectory, ".publisher-dependencies.mjs");
    const program = join(appDirectory, ".publisher-build.mjs");
    yield* Effect.tryPromise({
      try: async () => {
        const { dependencyBuildProgram, htmlBuildProgram } =
          await snapshotPrograms();
        await writeFile(dependencies, dependencyBuildProgram, { flag: "wx" });
        await writeFile(program, htmlBuildProgram, { flag: "wx" });
      },
      catch: (error) => error,
    });
    // Keep the derived order and every diagnostic/emit check. Consecutive
    // projects share one warmed compiler; stylesheet steps stay separate.
    const groups: WorkspaceBuildStep[][] = [];
    for (const step of html.steps) {
      const last = groups.at(-1);
      if (
        step.kind === "typescript" &&
        last?.every((member) => member.kind === "typescript")
      )
        last.push(step);
      else groups.push([step]);
    }
    for (const group of groups)
      yield* run(
        [
          "exec",
          "node",
          dependencies,
          sourceSnapshotPath,
          html.directory,
          recipe.format,
          JSON.stringify(group),
        ],
        appDirectory,
      );
    yield* run(
      [
        "exec",
        "node",
        program,
        sourceSnapshotPath,
        String(recipe.maxOutputBytes),
        html.directory,
        recipe.format,
        recipe.assetBase ?? "/",
        dirname(recipe.entry),
        String(html.react),
        html.shellEntry ?? "",
      ],
      appDirectory,
    );
    return yield* readHtmlBuildOutput(sourceSnapshotPath, recipe);
  });
}

const pinnedVersionsSchema = Schema.Record(Schema.String, Schema.String);
const pinnedManifestSchema = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(pinnedVersionsSchema),
    devDependencies: Schema.optional(pinnedVersionsSchema),
  }),
);

/**
 * Refuse a captured tree whose declared toolchain differs from the pinned
 * one before any of its dependencies hydrate.
 */
async function checkPinnedWorkspaceToolchain(
  sourceSnapshotPath: string,
  html: WorkspaceBuild,
  recipe: PinnedRecipe,
): Promise<void> {
  const manifest = async (directory: string) =>
    Schema.decodeUnknownSync(pinnedManifestSchema)(
      await readFile(
        join(sourceSnapshotPath, directory, "package.json"),
        "utf8",
      ),
    );
  const pinned = (
    directory: string,
    versions: Readonly<Record<string, string>> | undefined,
    name: string,
    version: string,
  ) => {
    if (versions?.[name] !== version)
      throw new Error(`${directory} must pin ${name} ${version}`);
  };
  const root = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        packageManager: Schema.Literal("pnpm@11.24.0"),
        devDependencies: Schema.Struct({
          typescript: Schema.Literal("5.9.3"),
        }),
      }),
    ),
  );
  root(await readFile(join(sourceSnapshotPath, "package.json"), "utf8"));
  const app = await manifest(html.directory);
  pinned(html.directory, app.devDependencies, "vite", "8.2.2");
  if (html.react) {
    pinned(html.directory, app.dependencies, "react-dom", "18.3.1");
    pinned(
      html.directory,
      app.devDependencies,
      "@vitejs/plugin-react",
      "6.1.1",
    );
    pinned(
      html.directory,
      app.dependencies?.react === undefined
        ? app.devDependencies
        : app.dependencies,
      "react",
      "18.3.1",
    );
  }
  if (recipe.format === "html")
    pinned(
      html.directory,
      app.devDependencies,
      "vite-plugin-singlefile",
      "2.3.3",
    );
  const stylesheets = html.steps.filter((step) => step.kind === "tailwind");
  if (stylesheets.length === 0) return;
  // The captured Tailwind compiler and its typography plugin come from Caps.
  const caps = await manifest("packages/caps");
  pinned("packages/caps", caps.devDependencies, "@tailwindcss/cli", "4.2.1");
  pinned(
    "packages/caps",
    caps.dependencies,
    "@tailwindcss/typography",
    "0.5.19",
  );
  for (const directory of html.dependencies) {
    if (!stylesheets.some((step) => step.input.startsWith(`${directory}/`)))
      continue;
    const owner = await manifest(directory);
    for (const versions of [owner.dependencies, owner.devDependencies])
      if (versions?.["@tailwindcss/typography"] !== undefined)
        pinned(directory, versions, "@tailwindcss/typography", "0.5.19");
  }
}

function readHtmlBuildOutput(
  sourceSnapshotPath: string,
  recipe: PinnedRecipe,
): Effect.Effect<BuildExecutorOutput, unknown> {
  return Effect.gen(function* () {
    if (recipe.assets) {
      const policy = recipe.assets;
      const base = recipe.assetBase;
      if (base === undefined)
        return yield* Effect.fail(
          new Error("Asset recipe requires its captured base"),
        );
      return yield* Effect.tryPromise(async () => {
        const root = join(sourceSnapshotPath, ".publisher-output");
        const files = await readdir(root, {
          recursive: true,
          withFileTypes: true,
        });
        const assets: { path: string; bytes: Uint8Array }[] = [];
        let total = 0;
        for (const file of files) {
          if (file.isDirectory()) continue;
          if (!file.isFile() || assets.length >= policy.maxObjects)
            throw new Error("Invalid or excessive build outputs");
          const filename = join(file.parentPath, file.name);
          const path = Schema.decodeUnknownSync(assetPathSchema)(
            "/" + relative(root, filename).split(sep).join("/"),
          );
          const stat = await lstat(filename);
          total += stat.size;
          if (
            stat.size > policy.maxObjectBytes ||
            !Number.isSafeInteger(total) ||
            total > policy.maxTotalBytes
          )
            throw new Error("Split output exceeds asset policy");
          const bytes = await readFile(filename);
          if (bytes.byteLength !== stat.size)
            throw new Error("Build output changed during capture");
          assets.push({ path, bytes });
        }
        return { kind: "assets" as const, base, assets };
      });
    }
    const bytes = yield* Effect.tryPromise({
      try: (signal) =>
        readFile(join(sourceSnapshotPath, ".publisher.html"), { signal }),
      catch: (error) => error,
    });
    return Object.freeze({ kind: "bytes" as const, bytes });
  });
}

function rebuildNpmSnapshot(
  sourceSnapshotPath: string,
  recipe: PinnedRecipe,
): Effect.Effect<BuildExecutorOutput, unknown> {
  return Effect.gen(function* () {
    const env = snapshotBuildEnvironment(sourceSnapshotPath);
    const home = join(sourceSnapshotPath, ".publisher-home");
    const userConfig = join(home, "user.npmrc");
    const globalConfig = join(home, "global.npmrc");
    env.npm_config_userconfig = userConfig;
    env.npm_config_globalconfig = globalConfig;
    yield* Effect.tryPromise(async () => {
      await mkdir(home, { recursive: true });
      await writeFile(userConfig, "", { flag: "wx" });
      await writeFile(globalConfig, "", { flag: "wx" });
    });
    if (
      (yield* runHtmlCommand(
        ["--version"],
        sourceSnapshotPath,
        env,
        "npm",
      )).trim() !== recipe.toolchain.npm
    )
      return yield* Effect.fail(
        new Error("Captured npm version differs from the recipe"),
      );
    yield* runHtmlCommand(
      ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      sourceSnapshotPath,
      env,
      "npm",
    );
    const program = join(sourceSnapshotPath, ".publisher-build.mjs");
    yield* Effect.tryPromise(async () => {
      const { htmlBuildProgram } = await snapshotPrograms();
      await writeFile(program, htmlBuildProgram, { flag: "wx" });
    });
    yield* runHtmlCommand(
      [
        program,
        sourceSnapshotPath,
        String(recipe.maxOutputBytes),
        ".",
        recipe.format,
        recipe.assetBase ?? "./",
        dirname(recipe.entry),
        "true",
        "",
      ],
      sourceSnapshotPath,
      env,
      "node",
    );
    return yield* readHtmlBuildOutput(sourceSnapshotPath, recipe);
  });
}

async function rebuildSnapshot(
  context: esbuild.BuildContext,
  recipe: import("./effect.js").PinnedRecipe,
  signal: AbortSignal,
  sourceSnapshotPath: string,
  emission: DefinitionEmission,
): Promise<BuildExecutorOutput> {
  signal.throwIfAborted();
  const result = await new Promise<esbuild.BuildResult>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const rejectWithError = (): void => {
      reject(new Error("Local snapshot build was interrupted"));
    };
    const onAbort = (): void => {
      void context.cancel().then(
        () => {
          finish(() => {
            rejectWithError();
          });
        },
        () => {
          finish(() => {
            reject(new Error("Local snapshot build cancellation failed"));
          });
        },
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    context.rebuild().then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (cause: unknown) => {
        finish(() => {
          reject(
            cause instanceof Error
              ? cause
              : new Error("Local snapshot rebuild failed", { cause }),
          );
        });
      },
    );
    if (signal.aborted) onAbort();
  });
  if (result.metafile === undefined) {
    throw new Error(
      "Local snapshot build did not return its requested metafile",
    );
  }
  const escapedInput = Object.keys(result.metafile.inputs).find((input) => {
    const path = resolve(sourceSnapshotPath, input);
    const fromSnapshot = relative(sourceSnapshotPath, path);
    return (
      fromSnapshot === ".." ||
      fromSnapshot.startsWith(`..${sep}`) ||
      isAbsolute(fromSnapshot)
    );
  });
  if (escapedInput !== undefined) {
    throw new Error(
      "Local snapshot build resolved an input outside the captured snapshot",
    );
  }
  const output = emission.worker(result).file;
  if (output.contents.byteLength > recipe.maxOutputBytes) {
    throw new Error("Local build output exceeded its pinned bound");
  }
  return Object.freeze({
    kind: "bytes" as const,
    bytes: output.contents.slice(),
  });
}

/** Exact pinned esbuild options shared by local builds and artifact-budget proofs. */
export function localSnapshotBuildOptions(
  source: CapturedSource,
  recipe: PinnedRecipe,
  emission: DefinitionEmission,
): esbuild.BuildOptions {
  const options: esbuild.BuildOptions = {
    absWorkingDir: source.snapshotPath,
    bundle: true,
    minify: recipe.backend !== null,
    entryPoints: emission.entryPoints(`./${recipe.entry}`),
    outdir: emission.outdir,
    format: "esm",
    platform: recipe.platform,
    external: recipe.backend === null ? [] : ["cloudflare:workers"],
    target: ["es2022"],
    write: false,
    metafile: true,
    plugins: [...emission.plugins],
  };
  if (recipe.backend !== null) {
    const mainFields = appBackendPackageMainFields(recipe);
    if (mainFields !== undefined) options.mainFields = mainFields;
    options.conditions = [...appBackendExportConditions];
    options.tsconfigRaw = {};
  }
  return options;
}

/** Local proving adapter; it builds only the captured extracted snapshot. */
export function createLocalBuildExecutor(
  options: Readonly<{ packageStoreDirectory?: string }> = {},
): BuildExecutor {
  const emissions = new WeakMap<
    CapturedSource,
    Awaited<ReturnType<typeof createDefinitionEmission>>
  >();
  const compiler: BuildExecutor = {
    build: (source, recipe) => {
      if (recipe.kind === "bundled-html" && recipe.backend === null)
        return Effect.tryPromise({
          try: () => readBundledHtml(source.snapshotPath, recipe),
          catch: () => new Error("Captured HTML bundle failed validation"),
        });
      if (recipe.format !== "esm" && recipe.backend !== null) {
        const backend = recipe.backend;
        const entry = backend.entry;
        if (entry === undefined)
          return Effect.fail(new Error("Joined App requires a backend entry"));
        return Effect.gen(function* () {
          // Build both facets from the same captured tree. The UI build hydrates
          // that tree's pinned dependencies before the backend resolves them.
          if (recipe.kind === "bundled-html") {
            const hasLockfile = yield* Effect.tryPromise(() =>
              access(join(source.snapshotPath, "pnpm-lock.yaml")).then(
                () => true,
                (error: unknown) => {
                  if (
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "ENOENT"
                  )
                    return false;
                  throw error;
                },
              ),
            );
            if (hasLockfile) {
              yield* Effect.tryPromise(async () => {
                Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.Struct({
                      packageManager: Schema.Literal("pnpm@11.24.0"),
                    }),
                  ),
                )(
                  await readFile(
                    join(source.snapshotPath, "package.json"),
                    "utf8",
                  ),
                );
              });
              const environment = snapshotBuildEnvironment(source.snapshotPath);
              if (
                (yield* runHtmlCommand(
                  ["--version"],
                  source.snapshotPath,
                  environment,
                )).trim() !== "11.24.0"
              )
                return yield* Effect.fail(
                  new Error("Publisher requires pnpm 11.24.0"),
                );
              yield* runHtmlCommand(
                frozenSnapshotInstallArguments(options.packageStoreDirectory),
                source.snapshotPath,
                environment,
              );
            }
          }
          const ui = yield* recipe.kind === "bundled-html"
            ? Effect.tryPromise({
                try: () => readBundledHtml(source.snapshotPath, recipe),
                catch: () =>
                  new Error("Captured HTML bundle failed validation"),
              })
            : rebuildViteSnapshot(
                source.snapshotPath,
                recipe,
                options.packageStoreDirectory,
              );
          const code = yield* compiler.build(source, {
            bundle: true,
            entry,
            format: "esm",
            platform: "neutral",
            toolchain: { ...recipe.toolchain, esbuild: "0.28.2" },
            target: ["es2022"],
            maxOutputBytes: recipe.maxOutputBytes,
            backend,
          });
          if (code.kind !== "bytes" || ui.kind === "app")
            return yield* Effect.fail(new Error("Invalid joined App output"));
          return {
            kind: "app" as const,
            ui:
              ui.kind === "bytes"
                ? {
                    content: { kind: "html" as const, bytes: ui.bytes },
                    mediaType: "text/html; charset=utf-8" as const,
                  }
                : {
                    content: ui,
                    mediaType: "application/vnd.fungi.app-assets+json" as const,
                  },
            backend: code.bytes,
          };
        });
      }
      return recipe.format !== "esm"
        ? rebuildViteSnapshot(
            source.snapshotPath,
            recipe,
            options.packageStoreDirectory,
          )
        : Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () => {
                const emission = emissions.get(source);
                if (emission === undefined)
                  throw new Error(
                    "App backend build requires its definition emission",
                  );
                return esbuild
                  .context(localSnapshotBuildOptions(source, recipe, emission))
                  .then((context) => ({ context, emission }));
              },
              catch: (error) =>
                error instanceof Error
                  ? error
                  : new Error("Local snapshot build failed"),
            }),
            ({ context, emission }) =>
              Effect.tryPromise({
                try: (signal) =>
                  rebuildSnapshot(
                    context,
                    recipe,
                    signal,
                    source.snapshotPath,
                    emission,
                  ),
                catch: (error) =>
                  error instanceof Error
                    ? error
                    : new Error("Local snapshot build failed"),
              }),
            ({ context }) =>
              Effect.tryPromise({
                try: () => context.dispose(),
                catch: () => new Error("Local build cleanup failed"),
              }).pipe(
                Effect.catch((cause: unknown) => {
                  logEvent("services/app-publisher/src/local.ts:1262", cause);
                  return Effect.void;
                }),
              ),
          );
    },
  };
  const declarations = new WeakMap<CapturedSource, AppDeclaration>();
  return {
    build: (source, recipe) =>
      Effect.gen(function* () {
        const emission = yield* Effect.tryPromise({
          try: () => createDefinitionEmission(source, recipe),
          catch: (cause: unknown) =>
            cause instanceof Error
              ? cause
              : new Error("App declaration emission failed", { cause }),
        });
        emissions.set(source, emission);
        const output = yield* compiler.build(source, recipe);
        const declaration = yield* Effect.tryPromise({
          try: (signal) => emission.declare(signal),
          catch: (cause: unknown) =>
            cause instanceof Error
              ? cause
              : new Error("App declaration emission failed", { cause }),
        });
        declarations.set(source, declaration);
        return output;
      }),
    declaration: (source) => {
      const declaration = declarations.get(source);
      return declaration === undefined
        ? Effect.fail(
            new Error("App declaration must be read after the captured build"),
          )
        : Effect.succeed(declaration);
    },
  };
}

async function writeArtifact(
  output: BuildOutput,
  artifactRoot: string,
  signal: AbortSignal,
  assetPolicy: AssetBuildPolicy | undefined,
): Promise<StoredArtifact> {
  signal.throwIfAborted();
  const ui = output.kind === "backend" ? null : output.ui;
  await mkdir(artifactRoot, { recursive: true });
  const persist = async (bytes: Uint8Array, ref?: string) => {
    const digest = sha256(bytes);
    const artifactRef = parseArtifactRef(
      ref ?? `artifact:sha256-${digest.slice("sha256:".length)}`,
    );
    const artifactPath = join(
      artifactRoot,
      artifactRef.slice("artifact:".length),
    );
    try {
      await writeFile(artifactPath, bytes, { flag: "wx", signal });
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST" || sha256(await readFile(artifactPath)) !== digest)
        throw error;
    }
    signal.throwIfAborted();
    return {
      artifactRef,
      digest,
      version: digest,
      byteLength: bytes.byteLength,
    };
  };
  const uiBytes = await (async () => {
    if (ui === null) return null;
    if (ui.content.kind === "html") return ui.content.bytes.slice();
    if (!assetPolicy) throw new Error("Asset writer requires explicit policy");
    const content: Record<string, ArrayBuffer> = {};
    for (const asset of ui.content.assets) {
      const path = Schema.decodeUnknownSync(assetPathSchema)(asset.path);
      if (Object.hasOwn(content, path)) throw new Error("Duplicate build path");
      content[path] = new Uint8Array(asset.bytes).buffer;
    }
    const assets = [];
    for (const path of Object.keys(content).sort()) {
      const bytes = content[path];
      const mediaType = mime.getType(path);
      const contentType = mediaType?.startsWith("text/")
        ? `${mediaType}; charset=utf-8`
        : mediaType;
      if (!bytes || !contentType)
        throw new Error("Build asset has no maintained content type");
      assets.push({
        path,
        ...(await persist(new Uint8Array(bytes))),
        contentType,
      });
    }
    const manifest = new TextEncoder().encode(
      Schema.encodeUnknownSync(assetBuildJsonSchema)({
        format: "fungi-assets-v1",
        base: ui.content.base,
        assets,
      }),
    );
    decodeAssetBuild(manifest, assetPolicy);
    return manifest;
  })();
  const storedUi =
    ui === null || uiBytes === null
      ? null
      : { ...(await persist(uiBytes)), mediaType: ui.mediaType };
  const backendBytes = output.kind === "ui" ? null : output.backend;
  const storedBackend =
    backendBytes === null
      ? null
      : await persist(backendBytes.slice()).then((stored) => ({
          ...stored,
          mediaType: "application/vnd.fungi.app-backend+json" as const,
        }));
  const root = new TextEncoder().encode(
    Schema.encodeUnknownSync(appBuildJsonSchema)(
      createAppBuild(storedUi, storedBackend, output.declaration),
    ),
  );
  const rootRef = `artifact:${Buffer.from(randomBytes(16)).toString("hex")}`;
  const storedRoot = await persist(root, rootRef);
  return Object.freeze({
    artifactRef: storedRoot.artifactRef,
    artifactDigest: storedRoot.digest,
  });
}

/** Local proving adapter; the configured root is private and write-once. */
export function createLocalArtifactWriter(
  artifactRoot: string,
  assetPolicy?: AssetBuildPolicy,
): ArtifactWriter {
  return {
    write: (output) =>
      Effect.tryPromise({
        try: (signal) =>
          writeArtifact(output, artifactRoot, signal, assetPolicy),
        catch: () => new Error("Local immutable artifact write failed"),
      }),
  };
}

/** Local Git, recipe and artifact directory configuration with a Release catalog. */
export type LocalAppPublisherOptions = Readonly<{
  readonly config: unknown;
  readonly releaseCatalog: ReleaseCreator;
}>;

/** Construct the complete local proving adapter around the provider-neutral core. */
export function createLocalAppPublisher(
  options: LocalAppPublisherOptions,
): AppPublisher {
  let decoded: LocalConfig;
  try {
    decoded = Schema.decodeUnknownSync(localConfigSchema)(options.config);
  } catch {
    throw new AppPublisherError("configuration");
  }
  if (decoded.recipe.assets)
    throw new AppPublisherError("configuration", {
      cause: new Error(
        "Asset publication requires the native immutable object writer",
      ),
    });
  const repositoryPath = localRepositoryPath(decoded.source.repositoryPath);
  const artifactRoot = decoded.artifactRoot;
  const recipe = {
    entry: decoded.recipe.entry,
    backend: decoded.recipe.backend,
    maxOutputBytes: decoded.recipe.maxOutputBytes,
  };
  return createAppPublisher({
    config: { appId: decoded.appId, recipe },
    releaseCatalog: options.releaseCatalog,
    sourceCapture: createLocalSourceCapture(repositoryPath),
    buildExecutor: createLocalBuildExecutor(),
    artifactWriter: createLocalArtifactWriter(artifactRoot),
  });
}
