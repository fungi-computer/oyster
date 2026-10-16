import {
  assetBuildPolicySchema,
  assetBaseSchema,
} from "@fungi.computer/puffball/assets";
import { boundedBundlePolicy, bundledHtmlRecipe } from "./html-recipe.js";
import { workspaceBuildPolicy } from "./build-policy.js";
import * as crypto from "node:crypto";
import {
  backendJsonSchema,
  durableBackendSchema,
} from "@fungi.computer/puffball/backend";
import {
  parseSha256Digest,
  type AppId,
  type ArtifactRef,
  type AppReleaseCatalog,
  type Release,
  type ReleaseId,
  type Sha256Digest,
  type SourceRevision,
} from "@fungi.computer/puffball";
import type { AppDeclaration } from "@fungi.computer/puffball";
import { appIdSchema } from "@fungi.computer/puffball/effect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type {
  CandidateObject,
  CandidateOutputManifest,
} from "./submission-contract.js";

const relativeEntrySchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(
    Schema.makeFilter((entry: string) => {
      if (entry.startsWith("/") || entry.includes("\\")) return false;
      return entry
        .split("/")
        .every((part: string) => part !== "" && part !== "." && part !== "..");
    }),
  ),
);

/** Canonical recipe policy shared by core and the local adapter. */
export const pinnedRecipeSchema = Schema.Struct({
  kind: Schema.optional(Schema.Literals(["bundled-html", "source-html"])),
  entry: relativeEntrySchema,
  assets: Schema.optional(assetBuildPolicySchema),
  assetBase: Schema.optionalKey(assetBaseSchema),
  backend: Schema.Union([
    Schema.Null,
    Schema.Struct({
      entry: Schema.optional(relativeEntrySchema),
      runtime: durableBackendSchema.fields.runtime,
      compatibilityDate: durableBackendSchema.fields.compatibilityDate,
      exportName: durableBackendSchema.fields.exportName,
    }),
  ]),
  maxOutputBytes: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.makeFilter((value: number) => Number.isFinite(value))),
    Schema.check(Schema.isGreaterThan(0)),
  ),
});

/** Core configuration contains only immutable App identity and recipe policy. */
export const AppPublisherCoreConfigSchema = Schema.Struct({
  appId: appIdSchema,
  recipe: pinnedRecipeSchema,
});

/** App identity and caller-selected recipe inputs before normalization. */
export type AppPublisherCoreConfigInput = Schema.Codec.Encoded<
  typeof AppPublisherCoreConfigSchema
>;

const esmToolchain = Object.freeze({ esbuild: "0.28.2" as const });
const sourceHtmlToolchain = Object.freeze({
  ...esmToolchain,
  node: "24.20.0",
  npm: "11.19.0",
  vite: "8.2.2",
  pluginReact: "6.1.1",
  recipe: "captured-npm-source-html-v1",
  packageResolution: "captured-browser-module-main-v1",
});
/**
 * The one pinned toolchain for an App page captured with its pnpm workspace.
 * The App's own manifest declares its page policy and the package graph
 * orders its dependency builds, so both are pinned by the source tree digest.
 */
const workspaceHtmlToolchain = Object.freeze({
  node: "24.20.0",
  pnpm: "11.24.0",
  vite: "8.2.2",
  pluginReact: "6.1.1",
  singlefile: "2.3.3",
  react: "18.3.1",
  typescript: "5.9.3",
  tailwindcss: "4.2.1",
  tailwindNode: "4.2.1",
  tailwindOxide: "4.2.1",
  tailwindResolver: "5.24.5",
  typography: "0.5.19",
  buildPolicy: workspaceBuildPolicy,
  recipe: "captured-workspace-html-v1",
});
const workspaceHtmlBackendToolchain = Object.freeze({
  ...workspaceHtmlToolchain,
  ...esmToolchain,
  packageResolution: "captured-browser-module-main-v1",
});
/** Package-export conditions used by the pinned Workers builder. */
export const appBackendExportConditions = Object.freeze([
  "workerd",
  "worker",
  "browser",
]);
/** Persisted, fully resolved recipe including its code-owned toolchain. */
export const capturedPinnedRecipeSchema = Schema.Struct({
  kind: pinnedRecipeSchema.fields.kind,
  bundle: Schema.Literal(true),
  entry: relativeEntrySchema,
  format: Schema.Literals(["html", "esm", "assets"]),
  assets: Schema.optional(assetBuildPolicySchema),
  assetBase: Schema.optionalKey(assetBaseSchema),
  toolchain: Schema.Record(Schema.String, Schema.String),
  maxOutputBytes: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
  platform: Schema.Literals(["browser", "neutral"]),
  backend: pinnedRecipeSchema.fields.backend,
  target: Schema.Tuple([Schema.Literal("es2022")]),
});
/** Fully resolved recipe with its pinned toolchain. */
export type PinnedRecipe = Schema.Schema.Type<
  typeof capturedPinnedRecipeSchema
>;
/** A source tree captured into a scoped local snapshot directory. */
export type CapturedSource = Readonly<{
  readonly sourceRevision: SourceRevision;
  readonly sourceTreeDigest: Sha256Digest;
  readonly snapshotPath: string;
}>;

/** Compiler bytes or a bounded collection of emitted UI assets. */
export type RawBuildOutput =
  | Readonly<{
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
    }>
  | Readonly<{
      readonly kind: "assets";
      readonly base: string;
      readonly assets: readonly {
        readonly path: string;
        readonly bytes: Uint8Array;
      }[];
    }>;

/** A complete HTML document or an asset collection. */
export type UiBuildOutput =
  | Readonly<{ readonly kind: "html"; readonly bytes: Uint8Array }>
  | Extract<RawBuildOutput, { readonly kind: "assets" }>;

/** Raw executor result before the recipe owner assigns App surface meaning. */
export type BuildExecutorOutput =
  | RawBuildOutput
  | Readonly<{
      readonly kind: "app";
      readonly ui: PreparedUiOutput | null;
      readonly backend: Uint8Array | null;
    }>;

/** UI output paired with its immutable artifact media type. */
export type PreparedUiOutput =
  | Readonly<{
      readonly content: Extract<UiBuildOutput, { readonly kind: "html" }>;
      readonly mediaType: "text/html; charset=utf-8";
    }>
  | Readonly<{
      readonly content: Extract<UiBuildOutput, { readonly kind: "assets" }>;
      readonly mediaType: "application/vnd.fungi.app-assets+json";
    }>;

/** Complete, non-empty App content accepted by immutable artifact writers. */
export type BuildOutput = (
  | Readonly<{ readonly kind: "ui"; readonly ui: PreparedUiOutput }>
  | Readonly<{ readonly kind: "backend"; readonly backend: Uint8Array }>
  | Readonly<{
      readonly kind: "app";
      readonly ui: PreparedUiOutput;
      readonly backend: Uint8Array;
    }>
) &
  Readonly<{
    /** The source's declared request; absent means the App asks for nothing. */
    readonly declaration?: AppDeclaration;
  }>;

/** Reference and digest of the persisted App build root. */
export type StoredArtifact = Readonly<{
  readonly artifactRef: ArtifactRef;
  readonly artifactDigest: Sha256Digest;
}>;

/** A locally captured and built candidate awaiting native artifact/catalog custody. */
export type PreparedCandidate = Readonly<{
  readonly appId: AppId;
  readonly releaseId: ReleaseId;
  readonly output: BuildOutput;
  readonly provenance: Readonly<{
    readonly sourceRevision: SourceRevision;
    readonly sourceTreeDigest: Sha256Digest;
    readonly buildRecipeDigest: Sha256Digest;
  }>;
}>;

/** Four structural roles used by the private composition. */
export type SourceCapture = {
  /** Acquire a snapshot whose cleanup follows the Effect scope. */
  readonly capture: () => Effect.Effect<CapturedSource, unknown, Scope.Scope>;
};

/** Compiles captured source and reads its matching declaration. */
export type BuildExecutor = {
  /** Compile only the captured source under its pinned recipe. */
  readonly build: (
    source: CapturedSource,
    recipe: PinnedRecipe,
  ) => Effect.Effect<BuildExecutorOutput, unknown, Scope.Scope>;
  /**
   * Read the App's declaration from the same captured tree. Every App, a fork
   * included, declares through its own source; there is no other source.
   */
  readonly declaration?: (
    source: CapturedSource,
    recipe: PinnedRecipe,
  ) => Effect.Effect<AppDeclaration, unknown>;
};

/** Persists one complete App build as immutable artifacts. */
export type ArtifactWriter = {
  /** Persist the App root and return its reference and digest. */
  readonly write: (
    output: BuildOutput,
  ) => Effect.Effect<StoredArtifact, unknown>;
};

/** Release catalog role needed to record a built candidate. */
export type ReleaseCreator = Pick<AppReleaseCatalog, "createRelease">;

/** Captured build inputs and the resource owners used to publish a candidate. */
export type AppPublisherOptions = Readonly<{
  readonly config: AppPublisherCoreConfigInput;
  readonly releaseCatalog: ReleaseCreator;
  readonly sourceCapture: SourceCapture;
  readonly buildExecutor: BuildExecutor;
  readonly artifactWriter: ArtifactWriter;
}>;

/** Builds and records immutable App Release candidates. */
export type AppPublisher = Readonly<{
  /** Capture, build, store, attest, and create exactly one candidate. */
  readonly createCandidate: (
    releaseId: ReleaseId,
  ) => Effect.Effect<Release, AppPublisherError>;
}>;

/** Builds a candidate before artifact storage and catalog publication. */
export type AppCandidatePreparer = Readonly<{
  /** Capture and build once; persistence remains with the resource-native host. */
  readonly prepareCandidate: (
    releaseId: ReleaseId,
  ) => Effect.Effect<PreparedCandidate, AppPublisherError>;
}>;

/** The bounded stages reported by AppPublisherError. */
export type AppPublisherStage =
  "configuration" | "source" | "build" | "artifact" | "release";

/** Closed failure boundary for the four private composition stages. */
export class AppPublisherError extends Error {
  readonly _tag = "AppPublisherError" as const;

  constructor(
    readonly stage: AppPublisherStage,
    options?: ErrorOptions,
  ) {
    super(`App Publisher ${stage} stage failed`, options);
    this.name = this._tag;
  }
}

/** App identity and normalized recipe with its digest. */
export type CapturedConfig = Readonly<{
  readonly appId: AppId;
  readonly recipe: PinnedRecipe;
  readonly buildRecipeDigest: Sha256Digest;
}>;

function sha256Digest(value: string): Sha256Digest {
  return parseSha256Digest(
    `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`,
  );
}

/** The toolchain this Publisher pins for a recipe of this kind, entry and backend. */
function currentToolchain(
  recipe: Pick<PinnedRecipe, "kind" | "entry" | "backend">,
): Readonly<Record<string, string>> {
  if (recipe.kind === "source-html") return sourceHtmlToolchain;
  if (recipe.kind === bundledHtmlRecipe.kind)
    return recipe.backend === null
      ? bundledHtmlRecipe.toolchain
      : { ...bundledHtmlRecipe.toolchain, ...esmToolchain, pnpm: "11.24.0" };
  if (recipe.entry.endsWith(".html"))
    return recipe.backend === null
      ? workspaceHtmlToolchain
      : workspaceHtmlBackendToolchain;
  return esmToolchain;
}

/**
 * Whether a pinned recipe pins this Publisher's current toolchain (its build
 * policy included). An executor refuses any other: a recipe pinned under
 * another policy describes a build this code does not perform.
 */
export function pinsCurrentToolchain(recipe: PinnedRecipe): boolean {
  const entries = (toolchain: Readonly<Record<string, string>>) =>
    JSON.stringify(
      Object.entries(toolchain).sort(([a], [b]) => a.localeCompare(b)),
    );
  return entries(currentToolchain(recipe)) === entries(recipe.toolchain);
}

function captureConfig(input: AppPublisherCoreConfigInput): CapturedConfig {
  let decoded: Schema.Schema.Type<typeof AppPublisherCoreConfigSchema>;
  try {
    decoded = Schema.decodeUnknownSync(AppPublisherCoreConfigSchema)(input);
  } catch {
    throw new AppPublisherError("configuration");
  }
  const bundled = decoded.recipe.kind === bundledHtmlRecipe.kind;
  const sourceHtml = decoded.recipe.kind === "source-html";
  // Any other HTML entry is a page built with its own pnpm workspace; the
  // App's manifest, read from the captured source, declares how.
  const workspaceHtml =
    decoded.recipe.kind === undefined && decoded.recipe.entry.endsWith(".html");
  const html = workspaceHtml || bundled || sourceHtml;
  if (
    sourceHtml &&
    (!decoded.recipe.entry.endsWith(".html") ||
      !decoded.recipe.assets ||
      !boundedBundlePolicy(
        decoded.recipe.assets,
        decoded.recipe.maxOutputBytes,
      ))
  )
    throw new AppPublisherError("configuration");
  if (bundled) {
    const policy = decoded.recipe.assets;
    if (
      !policy ||
      !decoded.recipe.entry.endsWith("/index.html") ||
      !boundedBundlePolicy(policy, decoded.recipe.maxOutputBytes)
    )
      throw new AppPublisherError("configuration");
  }
  if (
    (html &&
      decoded.recipe.backend !== null &&
      decoded.recipe.backend.entry === undefined) ||
    (!html && decoded.recipe.backend?.entry !== undefined)
  )
    throw new AppPublisherError("configuration");
  if (decoded.recipe.assets && !html)
    throw new AppPublisherError("configuration");
  if (
    Boolean(decoded.recipe.assets) !==
    (decoded.recipe.assetBase !== undefined)
  )
    throw new AppPublisherError("configuration");
  const recipeBase = {
    bundle: true as const,
    entry: decoded.recipe.entry,
    format: decoded.recipe.assets
      ? ("assets" as const)
      : workspaceHtml
        ? ("html" as const)
        : ("esm" as const),
    toolchain: currentToolchain(decoded.recipe),
    maxOutputBytes: decoded.recipe.maxOutputBytes,
    platform:
      decoded.recipe.backend === null
        ? ("browser" as const)
        : ("neutral" as const),
    backend: decoded.recipe.backend,
    target: ["es2022"] as const,
  };
  const resolvedBase =
    decoded.recipe.kind !== undefined
      ? { ...recipeBase, kind: decoded.recipe.kind }
      : recipeBase;
  const recipe: PinnedRecipe = Object.freeze(
    decoded.recipe.assets && decoded.recipe.assetBase !== undefined
      ? {
          ...resolvedBase,
          assets: Object.freeze({ ...decoded.recipe.assets }),
          assetBase: decoded.recipe.assetBase,
        }
      : resolvedBase,
  );
  return Object.freeze({
    appId: decoded.appId,
    recipe,
    buildRecipeDigest: digestPinnedRecipe(recipe),
  });
}

/** Hash every captured build and output-policy input in the Publisher recipe. */
export function digestPinnedRecipe(recipe: PinnedRecipe): Sha256Digest {
  const buildMaterial = {
    bundle: recipe.bundle,
    entry: recipe.entry,
    format: recipe.format,
    toolchain: recipe.toolchain,
  };
  const outputPolicy = {
    maxOutputBytes: recipe.maxOutputBytes,
    backendMinify: recipe.backend !== null,
    platform: recipe.platform,
    backend: recipe.backend,
    target: recipe.target,
  };
  const outputMaterial =
    recipe.backend === null
      ? outputPolicy
      : { ...outputPolicy, conditions: appBackendExportConditions };
  const vite = {
    configFile: false,
    envDir: false,
    envPrefix: [],
    cssCodeSplit: recipe.format === "assets",
    inlineDynamicImports: recipe.format !== "assets",
    assetsInlineLimit: recipe.format === "assets" ? 0 : recipe.maxOutputBytes,
    output:
      recipe.format === "assets"
        ? "immutable-asset-build"
        : "one-complete-html",
    css: "compiled-public-caps-stipe",
    dependencyInputs:
      "contained-before-probe-typescript-host-tailwind-core-loaders",
    subprocesses: "owned-process-group-term-kill-5-seconds",
  };
  const recipeVite = recipe.assets
    ? {
        ...vite,
        assetPolicy: recipe.assets,
        base: recipe.assetBase,
        cssUrls: "tailwind-node-4.2.1-after-contained-root-check",
      }
    : vite;
  const recipeMaterial = JSON.stringify(
    recipe.kind === bundledHtmlRecipe.kind
      ? {
          ...buildMaterial,
          ...outputMaterial,
          bundledHtmlRecipe,
          assetPolicy: recipe.assets,
          base: recipe.assetBase,
        }
      : recipe.format !== "esm"
        ? {
            ...buildMaterial,
            hydration: {
              frozenLockfile: true,
              ignoreScripts: true,
              ignorePnpmfile: true,
              packageImportMethod: "auto",
              store: "snapshot-local",
              virtualStore: "snapshot-local",
              environment:
                "tool-path-only-snapshot-home-no-user-or-global-npmrc",
            },
            vite: recipeVite,
            ...outputMaterial,
          }
        : { ...buildMaterial, ...outputMaterial },
  );

  return sha256Digest(recipeMaterial);
}

/** Decode and normalize Publisher-owned recipe policy for durable seed proof. */
export function normalizeAppPublisherRecipe(input: {
  appId: string;
  recipe: AppPublisherCoreConfigInput["recipe"];
}): Readonly<{
  recipe: PinnedRecipe;
  buildRecipeDigest: Sha256Digest;
}> {
  const captured = captureConfig(input);
  return Object.freeze({
    recipe: captured.recipe,
    buildRecipeDigest: captured.buildRecipeDigest,
  });
}

function createReleaseBoundary(
  catalog: ReleaseCreator,
  release: Release,
): Effect.Effect<Release, AppPublisherError> {
  return Effect.tryPromise({
    try: () => catalog.createRelease(release),
    catch: () => new AppPublisherError("release"),
  });
}

function stageFailure(stage: AppPublisherStage): AppPublisherError {
  return new AppPublisherError(stage);
}

function prepareUiOutput(
  output: RawBuildOutput,
  recipe: PinnedRecipe,
): PreparedUiOutput | undefined {
  switch (output.kind) {
    case "bytes":
      return recipe.format === "html" &&
        output.bytes.byteLength <= recipe.maxOutputBytes
        ? {
            content: { kind: "html", bytes: output.bytes },
            mediaType: "text/html; charset=utf-8",
          }
        : undefined;
    case "assets":
      return recipe.format === "assets" && output.base === recipe.assetBase
        ? {
            content: output,
            mediaType: "application/vnd.fungi.app-assets+json",
          }
        : undefined;
  }
}

function validPreparedUiOutput(
  ui: PreparedUiOutput,
  recipe: PinnedRecipe,
): boolean {
  switch (ui.content.kind) {
    case "html":
      return (
        ui.mediaType === "text/html; charset=utf-8" &&
        ui.content.bytes.byteLength <= recipe.maxOutputBytes
      );
    case "assets":
      return (
        ui.mediaType === "application/vnd.fungi.app-assets+json" &&
        recipe.assets !== undefined &&
        ui.content.base === recipe.assetBase
      );
  }
}

function encodeBackendOutput(
  bytes: Uint8Array,
  recipe: PinnedRecipe,
): Effect.Effect<Uint8Array, AppPublisherError> {
  if (recipe.backend === null) return Effect.fail(stageFailure("build"));
  return Schema.encodeEffect(backendJsonSchema)({
    ...recipe.backend,
    code: new TextDecoder().decode(bytes),
  }).pipe(
    Effect.map((encoded) => new TextEncoder().encode(encoded)),
    Effect.filterOrFail(
      (encoded) => encoded.byteLength <= recipe.maxOutputBytes,
      () => stageFailure("build"),
    ),
    Effect.mapError(() => stageFailure("build")),
  );
}

/**
 * The largest single object a build under this recipe may upload: no larger
 * than the largest output bound the recipe could assign it under.
 */
export function pinnedRecipeObjectBound(recipe: PinnedRecipe): number {
  return Math.max(recipe.maxOutputBytes, recipe.assets?.maxObjectBytes ?? 0);
}

/**
 * Whether output built elsewhere (a Computer's candidate manifest) is one
 * this recipe could assign: the same surfaces and `maxOutputBytes` bound the
 * preparer applies here. Asset sizes stay the artifact writer's policy.
 */
export function fitsPinnedRecipe(
  output: CandidateOutputManifest,
  recipe: PinnedRecipe,
): boolean {
  const uiFits = (
    ui: Extract<CandidateOutputManifest, { kind: "ui" }>["ui"],
  ) =>
    ui.content.kind === "html"
      ? ui.content.byteLength <= recipe.maxOutputBytes
      : recipe.assets !== undefined && ui.content.base === recipe.assetBase;
  const backendFits = (backend: CandidateObject) =>
    recipe.backend !== null && backend.byteLength <= recipe.maxOutputBytes;
  switch (output.kind) {
    case "ui":
      return recipe.backend === null && uiFits(output.ui);
    case "backend":
      return backendFits(output.backend);
    case "app":
      return uiFits(output.ui) && backendFits(output.backend);
  }
}

function assignAppOutput(
  built: BuildExecutorOutput,
  recipe: PinnedRecipe,
): Effect.Effect<BuildOutput, AppPublisherError> {
  switch (built.kind) {
    case "bytes":
    case "assets":
      return assignRawOutput(built, recipe);
    case "app":
      return assignJoinedOutput(built, recipe);
  }
}

function assignRawOutput(
  built: RawBuildOutput,
  recipe: PinnedRecipe,
): Effect.Effect<BuildOutput, AppPublisherError> {
  const ui = prepareUiOutput(built, recipe);
  if (recipe.backend === null)
    return ui === undefined
      ? Effect.fail(stageFailure("build"))
      : Effect.succeed({ kind: "ui", ui });
  if (built.kind !== "bytes") return Effect.fail(stageFailure("build"));
  return encodeBackendOutput(built.bytes, recipe).pipe(
    Effect.map((backend) => ({ kind: "backend", backend })),
  );
}

function assignJoinedOutput(
  built: Extract<BuildExecutorOutput, { readonly kind: "app" }>,
  recipe: PinnedRecipe,
): Effect.Effect<BuildOutput, AppPublisherError> {
  const ui = built.ui;
  if (ui !== null && !validPreparedUiOutput(ui, recipe))
    return Effect.fail(stageFailure("build"));
  if (built.backend === null) {
    if (ui === null || recipe.backend !== null)
      return Effect.fail(stageFailure("build"));
    return Effect.succeed({ kind: "ui", ui });
  }
  return encodeBackendOutput(built.backend, recipe).pipe(
    Effect.map((backend): BuildOutput =>
      ui === null ? { kind: "backend", backend } : { kind: "app", ui, backend },
    ),
  );
}

/** Construct one private App Publisher with copied core configuration and roles. */
export function createAppCandidatePreparer(
  options: Pick<
    AppPublisherOptions,
    "config" | "sourceCapture" | "buildExecutor"
  >,
): AppCandidatePreparer {
  return createCapturedCandidatePreparer(
    captureConfig(options.config),
    options,
  );
}

/** Prepare a candidate from a previously captured recipe. */
export function createCapturedCandidatePreparer(
  config: CapturedConfig,
  options: Pick<AppPublisherOptions, "sourceCapture" | "buildExecutor">,
): AppCandidatePreparer {
  const { sourceCapture, buildExecutor } = options;

  const prepareCandidate = (
    releaseId: ReleaseId,
  ): Effect.Effect<PreparedCandidate, AppPublisherError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* sourceCapture
          .capture()
          .pipe(Effect.mapError(() => stageFailure("source")));
        const built = yield* buildExecutor
          .build(source, config.recipe)
          .pipe(
            Effect.mapError(
              (error) => new AppPublisherError("build", { cause: error }),
            ),
          );
        const assigned = yield* assignAppOutput(built, config.recipe);
        const declaration =
          buildExecutor.declaration === undefined
            ? undefined
            : yield* buildExecutor
                .declaration(source, config.recipe)
                .pipe(
                  Effect.mapError(
                    (error) => new AppPublisherError("build", { cause: error }),
                  ),
                );
        const output: BuildOutput =
          declaration === undefined ? assigned : { ...assigned, declaration };
        return {
          appId: config.appId,
          releaseId,
          output,
          provenance: {
            sourceRevision: source.sourceRevision,
            sourceTreeDigest: source.sourceTreeDigest,
            buildRecipeDigest: config.buildRecipeDigest,
          },
        } satisfies PreparedCandidate;
      }),
    );

  return Object.freeze({ prepareCandidate });
}

/** Persist a prepared build through the native artifact and App Release owners. */
export function commitPreparedCandidate(
  prepared: PreparedCandidate,
  options: Pick<AppPublisherOptions, "artifactWriter" | "releaseCatalog">,
): Effect.Effect<Release, AppPublisherError> {
  return Effect.gen(function* () {
    const stored = yield* options.artifactWriter
      .write(prepared.output)
      .pipe(Effect.mapError(() => stageFailure("artifact")));
    const release: Release = {
      releaseId: prepared.releaseId,
      appId: prepared.appId,
      artifact: {
        artifactRef: stored.artifactRef,
        artifactDigest: stored.artifactDigest,
        provenance: prepared.provenance,
      },
    };
    return yield* createReleaseBoundary(options.releaseCatalog, release);
  });
}

/** Compose capture, compilation, immutable writing and Release recording. */
export function createAppPublisher(options: AppPublisherOptions): AppPublisher {
  const preparer = createAppCandidatePreparer(options);
  const createCandidate = (releaseId: ReleaseId) =>
    preparer.prepareCandidate(releaseId).pipe(
      Effect.flatMap((prepared) =>
        commitPreparedCandidate(prepared, {
          artifactWriter: options.artifactWriter,
          releaseCatalog: options.releaseCatalog,
        }),
      ),
    );
  return Object.freeze({ createCandidate });
}
