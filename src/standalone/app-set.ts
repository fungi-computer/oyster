import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { olderOysterStoreCode } from "../older-oyster-store.js";
import { publishSource, type PackOptions } from "../pack.js";
import { appBuildRecipe, readBuildManifest } from "../build/workspace-build.js";
import { parseSourceRevision } from "@fungi.computer/puffball";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import {
  grantCommandSchema,
  installationSchema,
  type Installation,
} from "../apps/installation.js";
import { appPermissionPageSchema } from "../apps/permissions.js";
import {
  installOnOyster,
  InstallationObservationError,
} from "../installation-client.js";

/** One starter App's identity and source; its manifest owns the build recipe. */
export type StarterApp = Readonly<{
  /** Selecting this configured dashboard approves its declared shell authority only. */
  dashboard?: true;
  installationId: string;
  appId: string;
  /** The App's directory in a Botanical checkout; its recipe is rooted there. */
  directory: string;
  /** Its own public source repository's name, the App at that repository's root. */
  repository: string;
}>;

export const standaloneAppSet: readonly StarterApp[] = [
  {
    installationId: "tourtois",
    dashboard: true,
    directory: "apps/tourtois",
    repository: "tourtois",
    appId: "app_tourtois",
  },
  {
    installationId: "bonsai",
    directory: "apps/bonsai",
    repository: "bonsai",
    appId: "app_bonsai",
  },
  {
    installationId: "shed",
    directory: "apps/shed",
    repository: "shed",
    appId: "app_shed",
  },
  {
    installationId: "inkcap",
    directory: "apps/inkcap",
    repository: "inkcap",
    appId: "app_inkcap",
  },
  {
    installationId: "trellis",
    directory: "apps/trellis",
    repository: "trellis",
    appId: "app_trellis",
  },
  {
    installationId: "prints",
    directory: "apps/prints",
    repository: "prints",
    appId: "app_prints",
  },
  {
    installationId: "grove",
    directory: "apps/grove",
    repository: "grove",
    appId: "app_grove",
  },
];

/** The host's refusal of a store written by Oyster 0.2 or earlier. */
const olderOysterStoreRefusal = Schema.Struct({
  error: Schema.Literal(olderOysterStoreCode),
  message: Schema.String,
});
const publishedSchema = Schema.Struct({
  kind: Schema.Literals(["recorded", "existing"]),
  receipt: Schema.Struct({
    seedRevision: Schema.String,
    /** The upstream commit this distribution was projected from. */
    sourceRevision: Schema.String,
  }),
});
const buildSchema = Schema.Struct({
  jobId: Schema.String,
  status: Schema.Literals(["running", "succeeded", "failed", "revoked"]),
  detail: Schema.NullOr(Schema.String),
  /** Installed exactly as the host encoded it. */
  release: Schema.NullOr(Schema.Json),
});
/** The phases a Computer build reports in its success detail. */
const computerPhasesSchema = Schema.fromJsonString(
  Schema.Struct({
    phasesMs: Schema.Struct({
      clone: Schema.Number,
      install: Schema.Number,
      build: Schema.Number,
      upload: Schema.Number,
    }),
  }),
);

/** Where the starter Apps' sources come from. */
export type StarterAppSource =
  | Readonly<{
      /** A Botanical checkout at one exact commit; each App is its directory. */
      kind: "checkout";
      directory: string;
      revision: string;
    }>
  | Readonly<{
      /**
       * Each App's own repository, `${base}/${app.repository}.git`, at `ref`
       * (a branch or tag): the App at the repository's root.
       */
      kind: "repositories";
      base: string;
      ref: string;
      /** A scratch directory the installer clones into; it removes each clone. */
      scratch: string;
    }>;

/** Wall-clock milliseconds one App spent in each install phase. */
export type StarterAppTimings = Readonly<{
  /** Cloning its repository on this machine; zero for a checkout. */
  fetch: number;
  /** Seeding its template on the Oyster by git push. */
  publish: number;
  /** Waiting for a build slot on the Computer. */
  queue: number;
  /** From starting its build to the build's terminal state. */
  build: number;
  /** Installing the built Release. */
  install: number;
  /** The Computer's own report of its build, when it gives one. */
  computer: Readonly<{
    clone: number;
    install: number;
    build: number;
    upload: number;
  }> | null;
}>;

/** One App the installer published, built and installed. */
export type InstalledStarterApp = Readonly<{
  installationId: string;
  published: "recorded" | "existing";
  seedRevision: string;
  sourceRevision: string;
  jobId: string;
  installed: "installed" | "replaced";
  release: Schema.Json;
  timings: StarterAppTimings;
}>;

/** How long one App's build may run before the installer gives up: the
 * host's whole-build budget plus queueing on the one Computer. */
const appBuildWaitMs = 20 * 60_000;
/**
 * Builds the installer runs at once by default. A build's compiler may take a
 * 4 GB heap, so two fit the platform's 12 GiB Computer (standard-4) with room
 * for pnpm and esbuild; a third is the most it will run.
 */
export const defaultStarterBuildConcurrency = 2;
/** The most builds at once on the 12 GiB Computer. */
const maxStarterBuildConcurrency = 3;

const run = (command: string, args: readonly string[], cwd?: string) =>
  new Promise<string>((resolveRun, reject) => {
    execFile(
      command,
      args,
      { cwd, encoding: "utf8", maxBuffer: 1_048_576 },
      (error, stdout) => {
        if (error)
          reject(
            new Error(`${command} ${args[0] ?? ""} failed`, { cause: error }),
          );
        else resolveRun(stdout);
      },
    );
  });

/**
 * Install the standalone App set, each App built on the Oyster's own
 * Computer. Each App's editable source is published as its template; the host
 * builds that seed revision and the installer installs the exact Release the
 * build recorded. Builds run `concurrency` at a time on the one Computer,
 * Tourtois first; each App installs as soon as its own build succeeds. No App
 * is compiled on this machine and no installed App is needed to build.
 */
export async function installStandaloneAppSet(
  options: Readonly<{
    source: StarterAppSource;
    url: string;
    key: string;
    report: (message: string) => void;
    /** Builds at once on the Computer, 1 to 3; one by default. */
    concurrency?: number;
    /** Publishes one App's source; the real installer uses `publishSource`. */
    publish?: (
      app: StarterApp,
      located: Readonly<{
        repositoryPath: string;
        sourceRevision: string;
        recipe: PackOptions["recipe"];
      }>,
    ) => Promise<Response>;
    pollMs?: number;
    /** The idle wait between build status reads; the real timer by default. */
    idle?: (ms: number, signal: AbortSignal) => Promise<void>;
    waitMs?: number;
  }>,
): Promise<readonly InstalledStarterApp[]> {
  const concurrency = options.concurrency ?? defaultStarterBuildConcurrency;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > maxStarterBuildConcurrency
  )
    throw new Error(
      `Starter builds run 1 to ${String(maxStarterBuildConcurrency)} at a time`,
    );
  const authorization = {
    Authorization: `Bearer ${options.key}`,
    Accept: "application/json",
  };
  const owner = async (
    method: string,
    path: string,
    body?: Schema.Json,
    signal?: AbortSignal,
  ) => {
    const init: RequestInit =
      body === undefined
        ? { method, headers: authorization }
        : {
            method,
            headers: { ...authorization, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          };
    if (signal !== undefined) init.signal = signal;
    return fetch(new URL(path, options.url), init);
  };
  const approveChosenDashboard = async (
    installed: Installation,
    generation: string,
  ) => {
    const name = installed.installationId;
    const path = `/api/installations/${encodeURIComponent(name)}/grants`;
    const projectionResponse = await owner("GET", path);
    if (!projectionResponse.ok)
      throw new Error(
        `${name} approval read failed (${String(projectionResponse.status)})`,
      );
    const projection = appPermissionPageSchema.parse(
      await projectionResponse.json(),
    );
    const { permissions } = projection;
    const digest = installed.release.artifact.artifactDigest;
    if (
      projection.storeGeneration !== generation ||
      projection.installationId !== name ||
      projection.artifactDigest !== digest ||
      permissions.declaredOperations.artifactDigest !== digest ||
      permissions.authority.authorityVersion !==
        installed.authority.authorityVersion ||
      permissions.authority.declaredOperationsDigest !==
        installed.authority.declaredOperationsDigest ||
      permissions.declaredOperations.digest !==
        installed.authority.declaredOperationsDigest
    )
      throw new Error(`${name} approval snapshot changed`);
    const shell = permissions.declaredOperations.capabilities.find(
      (row) => row.capability === "team.workbenchHost",
    );
    if (shell === undefined) return;
    const command = grantCommandSchema.parse({
      kind: "change-grants",
      changes: [
        {
          capability: shell.capability,
          grant: { operations: shell.operations, resources: "tenant-scope" },
        },
      ],
    });
    const saved = await owner(
      "PUT",
      path,
      Schema.decodeUnknownSync(Schema.Json)({
        storeGeneration: projection.storeGeneration,
        authorityVersion: installed.authority.authorityVersion,
        artifactDigest: digest,
        command,
      }),
    );
    if (!saved.ok)
      throw new Error(`${name} approval failed (${String(saved.status)})`);
    const receipt = installationSchema.parse(await saved.json());
    if (
      receipt.installationId !== name ||
      receipt.instanceId !== installed.instanceId ||
      receipt.release.artifact.artifactDigest !== digest ||
      receipt.authority.authorityVersion !==
        installed.authority.authorityVersion + 1 ||
      !receipt.authority.approvedGrants.some(
        (grant) =>
          grant.capability === "team.workbenchHost" &&
          grant.resources === "tenant-scope" &&
          shell.operations.every((operation) =>
            grant.operations.includes(operation),
          ),
      )
    )
      throw new Error(`${name} approval incomplete`);
  };
  const idle =
    options.idle ??
    ((ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }));
  /** Start one build and wait for its terminal outcome within the build
   * budget; the budget cancels every request and body read it covers. */
  const buildOnComputer = async (
    name: string,
    appId: string,
    seedRevision: string,
  ) => {
    const budget = AbortSignal.timeout(options.waitMs ?? appBuildWaitMs);
    let jobId: string | null = null;
    try {
      const started = await owner(
        "POST",
        "/api/builds",
        { appId, sourceRevision: seedRevision },
        budget,
      );
      if (started.status !== 202)
        throw new Error(`${name} build refused (${String(started.status)})`);
      let build = Schema.decodeUnknownSync(buildSchema)(await started.json());
      jobId = build.jobId;
      options.report(`Building ${name} on the Computer (${build.jobId})`);
      while (build.status === "running") {
        const read = await owner(
          "GET",
          `/api/builds/${encodeURIComponent(build.jobId)}`,
          undefined,
          budget,
        );
        if (!read.ok)
          throw new Error(`${name} build is missing (${String(read.status)})`);
        build = Schema.decodeUnknownSync(buildSchema)(await read.json());
        // Read first: a build already finished costs no idle wait.
        if (build.status === "running")
          await idle(options.pollMs ?? 5_000, budget);
      }
      return build;
    } catch (cause) {
      if (budget.aborted)
        throw new Error(
          `${name} build did not finish (${jobId ?? "not started"})`,
          {
            cause,
          },
        );
      throw cause;
    }
  };
  const publish =
    options.publish ??
    ((
      app: StarterApp,
      located: Readonly<{
        repositoryPath: string;
        sourceRevision: string;
        recipe: PackOptions["recipe"];
      }>,
    ) =>
      publishSource({
        appId: app.appId,
        entry: located.recipe.entry,
        repositoryPath: located.repositoryPath,
        sourceRevision: located.sourceRevision,
        recipe: located.recipe,
        url: options.url,
        key: options.key,
      }));
  /** Locate one App's source at an exact commit, cloning it when it has its
   * own repository; `release` removes a clone once its template is seeded. */
  const locate = async (app: StarterApp) => {
    const source = options.source;
    if (source.kind === "checkout") {
      const sourceRevision = parseSourceRevision(source.revision);
      const metadata = await run(
        "git",
        [
          "show",
          sourceRevision.slice(4) + ":" + app.directory + "/package.json",
        ],
        source.directory,
      );
      return {
        repositoryPath: source.directory,
        sourceRevision,
        recipe: appBuildRecipe(readBuildManifest(metadata), app.directory),
        release: () => Promise.resolve(),
      };
    }
    const clone = await mkdtemp(join(source.scratch, `${app.repository}-`));
    try {
      await run("git", [
        "clone",
        "--quiet",
        "--depth=1",
        `--branch=${source.ref}`,
        "--",
        `${source.base}/${app.repository}.git`,
        clone,
      ]);
      const head = (await run("git", ["rev-parse", "HEAD"], clone)).trim();
      return {
        repositoryPath: clone,
        sourceRevision: parseSourceRevision(`git:${head}`),
        recipe: appBuildRecipe(
          readBuildManifest(
            await run("git", ["show", head + ":package.json"], clone),
          ),
          "",
        ),
        release: () => rm(clone, { recursive: true, force: true }),
      };
    } catch (cause) {
      await rm(clone, { recursive: true, force: true });
      throw cause;
    }
  };

  // Seed templates one at a time in set order (a git push each, quick beside
  // a build); a build slot takes each App the moment its own source is
  // seeded, so Tourtois builds while the rest publish. Builds start in set
  // order. The first failure, in a seed or a build, starts no further seed or
  // build; builds already running finish and install, every seed and clone
  // cleanup settles, and only then does the install reject with that failure.
  type Seeded = {
    app: StarterApp;
    kind: "recorded" | "existing";
    seedRevision: string;
    sourceRevision: string;
    fetch: number;
    publish: number;
    ready: number;
  };
  const installed = new Map<string, InstalledStarterApp>();
  /** Set by the first failure, so no further seed or build starts. */
  const stop = { requested: false };
  /** Every failure, in the order it happened; the first is the one thrown. */
  const failures: unknown[] = [];
  const seededQueue: Seeded[] = [];
  const waiting: ((next: Seeded | undefined) => void)[] = [];
  const seeding = { finished: false };
  const takeSeeded = () =>
    new Promise<Seeded | undefined>((resolveTake) => {
      const next = seededQueue.shift();
      if (next !== undefined || seeding.finished) resolveTake(next);
      else waiting.push(resolveTake);
    });
  const seedApp = async (app: StarterApp): Promise<Seeded> => {
    const name = app.installationId;
    const fetchStarted = performance.now();
    const located = await locate(app);
    const publishStarted = performance.now();
    try {
      const published = await publish(app, located);
      if (!published.ok) {
        const refusal = Schema.decodeUnknownOption(
          Schema.fromJsonString(olderOysterStoreRefusal),
        )(await published.text());
        if (Option.isSome(refusal)) throw new Error(refusal.value.message);
        throw new Error(
          `${name} source publish failed (${String(published.status)})`,
        );
      }
      const { kind, receipt } = Schema.decodeUnknownSync(publishedSchema)(
        await published.json(),
      );
      options.report(`${name} source ${kind} at ${receipt.seedRevision}`);
      const ready = performance.now();
      return {
        app,
        kind,
        seedRevision: receipt.seedRevision,
        sourceRevision: receipt.sourceRevision,
        fetch: publishStarted - fetchStarted,
        publish: ready - publishStarted,
        ready,
      };
    } finally {
      await located.release();
    }
  };
  const seedAll = async () => {
    try {
      for (const app of standaloneAppSet) {
        if (stop.requested) break;
        const seeded = await seedApp(app);
        const waiter = waiting.shift();
        if (waiter === undefined) seededQueue.push(seeded);
        else waiter(seeded);
      }
    } catch (cause) {
      stop.requested = true;
      failures.push(cause);
      throw cause;
    } finally {
      seeding.finished = true;
      for (const waiter of waiting.splice(0)) waiter(undefined);
    }
  };
  // `concurrency` builds at once, each installing as its build succeeds.
  const slot = async () => {
    for (
      let next = await takeSeeded();
      next !== undefined && !stop.requested;
      next = await takeSeeded()
    ) {
      const name = next.app.installationId;
      try {
        const buildStarted = performance.now();
        const build = await buildOnComputer(
          name,
          next.app.appId,
          next.seedRevision,
        );
        if (build.status !== "succeeded" || build.release === null)
          throw new Error(
            `${name} build ${build.status}: ${build.detail ?? "no Release"}`,
          );
        const release = Schema.decodeUnknownSync(releaseSchema)(build.release, {
          onExcessProperty: "error",
        });
        if (release.appId !== next.app.appId)
          throw new Error(`${name} build belongs to another App`);
        const installStarted = performance.now();
        let installation: Parameters<typeof installOnOyster>[0] = {
          url: options.url,
          key: options.key,
          release,
          installationId: name,
          signal: AbortSignal.timeout(options.waitMs ?? appBuildWaitMs),
          idle,
        };
        if (options.pollMs !== undefined)
          installation = { ...installation, pollMs: options.pollMs };
        const operation = await installOnOyster(installation);
        if (operation.state === "unconfirmed")
          throw new InstallationObservationError(operation.requestId);
        if (operation.state === "refused")
          throw new Error(`${name} installation refused (${operation.code})`);
        const record = operation.installation;
        if (record === null)
          throw new Error(
            `${name} completed installation version is unavailable`,
          );
        if (
          record.appId !== release.appId ||
          record.release.releaseId !== release.releaseId ||
          record.release.artifact.artifactDigest !==
            release.artifact.artifactDigest
        )
          throw new Error(`${name} installation does not match its build`);
        // Only the owner can attest exclusive fresh creation. A replacement or
        // tombstone remint never replays a default grant.
        if (operation.creation === "fresh") {
          if (record.status !== "enabled")
            throw new Error(`${name} fresh installation is not enabled`);
          if (next.app.dashboard === true)
            await approveChosenDashboard(
              record,
              operation.reference.generation,
            );
        }
        options.report(
          `${operation.creation === "replacement" ? "Replaced" : "Installed"} ${name} from its build ${build.jobId}`,
        );
        // Report-only UI check: never blocks, but the owner sees it here.
        const uiCheck = operation.uiCheck;
        if (uiCheck?.kind === "failed")
          options.report(
            `Warning: ${name} is installed, but its UI check failed (${uiCheck.code}${uiCheck.diagnostics === undefined ? "" : `: ${uiCheck.diagnostics.failedPredicate}`}).`,
          );
        else if (uiCheck?.kind === "not_checked")
          options.report(
            `Warning: ${name} is installed, but its UI was not checked (${uiCheck.code}).`,
          );
        const phases =
          build.detail === null
            ? undefined
            : Schema.decodeUnknownOption(computerPhasesSchema)(build.detail);
        installed.set(name, {
          installationId: record.installationId,
          published: next.kind,
          seedRevision: next.seedRevision,
          sourceRevision: next.sourceRevision,
          jobId: build.jobId,
          installed:
            operation.creation === "replacement" ? "replaced" : "installed",
          release: build.release,
          timings: {
            fetch: next.fetch,
            publish: next.publish,
            queue: buildStarted - next.ready,
            build: installStarted - buildStarted,
            install: performance.now() - installStarted,
            computer:
              phases === undefined || phases._tag === "None"
                ? null
                : phases.value.phasesMs,
          },
        });
      } catch (cause) {
        stop.requested = true;
        failures.push(cause);
        throw cause;
      }
    }
  };
  // Wait for every seed and build to settle before reporting: nothing of this
  // call may still run, or install, after it rejects.
  await Promise.allSettled([
    seedAll(),
    ...Array.from({ length: concurrency }, slot),
  ]);
  if (failures.length > 0) throw failures[0];
  return standaloneAppSet.flatMap((app) => {
    const result = installed.get(app.installationId);
    return result === undefined ? [] : [result];
  });
}
