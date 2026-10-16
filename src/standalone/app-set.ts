import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as Schema from "effect/Schema";
import { publishSource, type PackOptions } from "../pack.js";
import { parseSourceRevision } from "@fungi.computer/puffball";

// Existing closed source recipes, shared by the standalone install command and
// its real-root proof. The canonical Oyster builder owns every compilation, on
// the Oyster's own Computer.
const assets = {
  maxManifestBytes: 1_048_576,
  maxObjects: 1024,
  maxObjectBytes: 16_777_216,
  maxTotalBytes: 67_108_864,
};
const facet = { kind: "durable-facet", stateSchema: 1 } as const;

/** One starter App: where its source lives and how the Computer builds it. */
export type StarterApp = Readonly<{
  installationId: string;
  appId: string;
  /** The App's directory in a Botanical checkout; its recipe is rooted there. */
  directory: string;
  /** Its own public source repository's name, the App at that repository's root. */
  repository: string;
  recipe: PackOptions["recipe"];
}>;

export const standaloneAppSet: readonly StarterApp[] = [
  {
    installationId: "tourtois",
    directory: "apps/tourtois",
    repository: "tourtois",
    appId: "app_tourtois",
    recipe: {
      entry: "apps/tourtois/index.html",
      assets,
      assetBase: "./",
      backend: {
        entry: "apps/tourtois/backend/index.ts",
        exportName: "Tourtois",
        compatibilityDate: "2026-09-04",
        runtime: facet,
      },
      maxOutputBytes: 67_108_864,
    },
  },
  {
    installationId: "bonsai",
    directory: "apps/bonsai",
    repository: "bonsai",
    appId: "app_bonsai",
    recipe: {
      entry: "apps/bonsai/web/index.html",
      assets,
      assetBase: "./",
      maxOutputBytes: 67_108_864,
      backend: {
        entry: "apps/bonsai/backend/index.ts",
        exportName: "BonsaiApp",
        compatibilityDate: "2026-09-04",
        runtime: facet,
      },
    },
  },
  {
    installationId: "shed",
    directory: "apps/shed",
    repository: "shed",
    appId: "app_shed",
    recipe: {
      entry: "apps/shed/index.html",
      assets: {
        maxManifestBytes: 1_048_576,
        maxObjects: 512,
        maxObjectBytes: 4_194_304,
        maxTotalBytes: 16_777_216,
      },
      assetBase: "./",
      maxOutputBytes: 16_777_216,
      backend: {
        entry: "apps/shed/backend/index.ts",
        exportName: "Shed",
        compatibilityDate: "2026-09-25",
        runtime: facet,
      },
    },
  },
  {
    installationId: "inkcap",
    directory: "apps/inkcap",
    repository: "inkcap",
    appId: "app_inkcap",
    recipe: {
      entry: "apps/inkcap/index.html",
      assets,
      assetBase: "./",
      maxOutputBytes: 16_777_216,
      backend: {
        entry: "apps/inkcap/backend/index.ts",
        exportName: "Inkcap",
        compatibilityDate: "2026-09-25",
        runtime: facet,
      },
    },
  },
  {
    installationId: "trellis",
    directory: "apps/trellis",
    repository: "trellis",
    appId: "app_trellis",
    recipe: {
      entry: "apps/trellis/index.html",
      maxOutputBytes: 16_777_216,
      backend: {
        entry: "apps/trellis/backend/index.ts",
        exportName: "Trellis",
        compatibilityDate: "2026-09-04",
        runtime: facet,
      },
    },
  },
  {
    installationId: "prints",
    directory: "apps/prints",
    repository: "prints",
    appId: "app_prints",
    recipe: {
      entry: "apps/prints/index.html",
      assets,
      assetBase: "./",
      maxOutputBytes: 16_777_216,
      backend: {
        entry: "apps/prints/backend/index.ts",
        exportName: "Prints",
        compatibilityDate: "2026-09-04",
        runtime: facet,
      },
    },
  },
  {
    installationId: "grove",
    directory: "apps/grove",
    repository: "grove",
    appId: "app_grove",
    recipe: {
      entry: "apps/grove/index.html",
      assets,
      assetBase: "./",
      maxOutputBytes: 67_108_864,
      backend: {
        entry: "apps/grove/backend/index.ts",
        exportName: "Grove",
        compatibilityDate: "2026-09-04",
        runtime: facet,
      },
    },
  },
];

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

/** A recipe rooted at `from` (a checkout directory), rooted at `to` instead. */
function relocateRecipe(
  recipe: PackOptions["recipe"],
  from: string,
  to: string,
): PackOptions["recipe"] {
  const move = (path: string) => {
    if (!path.startsWith(`${from}/`))
      throw new Error(`${path} is outside its App directory ${from}`);
    const rest = path.slice(from.length + 1);
    return to === "" ? rest : `${to}/${rest}`;
  };
  const backend = recipe.backend;
  if (backend?.entry === undefined)
    return { ...recipe, entry: move(recipe.entry) };
  return {
    ...recipe,
    entry: move(recipe.entry),
    backend: { ...backend, entry: move(backend.entry) },
  };
}

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
  const authorization = { Authorization: `Bearer ${options.key}` };
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
        await sleep(options.pollMs ?? 5_000, undefined, { signal: budget });
        const read = await owner(
          "GET",
          `/api/builds/${encodeURIComponent(build.jobId)}`,
          undefined,
          budget,
        );
        if (!read.ok)
          throw new Error(`${name} build is missing (${String(read.status)})`);
        build = Schema.decodeUnknownSync(buildSchema)(await read.json());
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
    if (source.kind === "checkout")
      return {
        repositoryPath: source.directory,
        sourceRevision: parseSourceRevision(source.revision),
        recipe: app.recipe,
        release: () => Promise.resolve(),
      };
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
        recipe: relocateRecipe(app.recipe, app.directory, ""),
        release: () => rm(clone, { recursive: true, force: true }),
      };
    } catch (cause) {
      await rm(clone, { recursive: true, force: true });
      throw cause;
    }
  };

  // Seed every template first: a git push each, quick beside a build.
  const seeded: {
    app: StarterApp;
    kind: "recorded" | "existing";
    seedRevision: string;
    sourceRevision: string;
    fetch: number;
    publish: number;
    ready: number;
  }[] = [];
  for (const app of standaloneAppSet) {
    const name = app.installationId;
    const fetchStarted = performance.now();
    const located = await locate(app);
    const publishStarted = performance.now();
    try {
      const published = await publish(app, located);
      if (!published.ok)
        throw new Error(
          `${name} source publish failed (${String(published.status)})`,
        );
      const { kind, receipt } = Schema.decodeUnknownSync(publishedSchema)(
        await published.json(),
      );
      options.report(`${name} source ${kind} at ${receipt.seedRevision}`);
      const ready = performance.now();
      seeded.push({
        app,
        kind,
        seedRevision: receipt.seedRevision,
        sourceRevision: receipt.sourceRevision,
        fetch: publishStarted - fetchStarted,
        publish: ready - publishStarted,
        ready,
      });
    } finally {
      await located.release();
    }
  }

  // Then build `concurrency` at a time, in set order, installing each as its
  // build succeeds. The first failure rejects the install and starts no
  // further build; builds already running finish and install.
  const installed = new Map<string, InstalledStarterApp>();
  const pending = [...seeded];
  /** Set by the first failure, so no further build starts. */
  const stop = { requested: false };
  const slot = async () => {
    for (
      let next = stop.requested ? undefined : pending.shift();
      next !== undefined;
      next = stop.requested ? undefined : pending.shift()
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
        const installStarted = performance.now();
        const installation = await owner("POST", "/api/installations", {
          release: build.release,
          installationId: name,
        });
        if (!installation.ok)
          throw new Error(
            `${name} installation failed (${String(installation.status)})`,
          );
        options.report(
          `${installation.status === 201 ? "Installed" : "Replaced"} ${name} from its build ${build.jobId}`,
        );
        const phases =
          build.detail === null
            ? undefined
            : Schema.decodeUnknownOption(computerPhasesSchema)(build.detail);
        installed.set(name, {
          installationId: name,
          published: next.kind,
          seedRevision: next.seedRevision,
          sourceRevision: next.sourceRevision,
          jobId: build.jobId,
          installed: installation.status === 201 ? "installed" : "replaced",
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
        throw cause;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, slot));
  return standaloneAppSet.flatMap((app) => {
    const result = installed.get(app.installationId);
    return result === undefined ? [] : [result];
  });
}
