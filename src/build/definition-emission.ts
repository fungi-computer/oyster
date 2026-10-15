import { execFile } from "node:child_process";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as Schema from "effect/Schema";
import type * as esbuild from "esbuild";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";
import { emptyAppDeclaration } from "@fungi.computer/puffball";
import type { AppDeclaration } from "@fungi.computer/puffball";
import type { CapturedSource, PinnedRecipe } from "./effect.js";

const packageSchema = Schema.fromJsonString(
  Schema.Struct({
    fungi: Schema.optional(
      Schema.Struct({
        app: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        backendDefinition: Schema.optional(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        ),
      }),
    ),
  }),
);

// The Computer VM is the customer-code sandbox. These rules enforce the SDK's
// runtime-neutral definition convention; they are not a Node security sandbox.
const evaluateDefinition = `
import { registerHooks } from 'node:module';
const entry = process.argv[1];
const write = process.stdout.write.bind(process.stdout);
const writeError = process.stderr.write.bind(process.stderr);
const exit = process.exit.bind(process);
registerHooks({ resolve(specifier, context, next) {
  if (specifier !== entry) throw new Error('App backend definition imports ' + specifier + '. Move runtime-specific imports into the Worker composition; keep the definition runtime-neutral.');
  return next(specifier, context);
}});
globalThis.fetch = () => { throw new Error('App backend definition attempted network access. Move network calls into method handlers; evaluation must be runtime-neutral.'); };
globalThis.WebSocket = undefined;
globalThis.process = undefined;
try {
const { appDeclaration } = await import(entry);
write(JSON.stringify(appDeclaration));
} catch (error) {
  writeError((error instanceof Error ? error.message : "App definition evaluation failed").split("\\n")[0] + "\\n");
  exit(1);
}
`;

const evaluationFailureSchema = Schema.Struct({ stderr: Schema.String });

const evaluationFailure = (cause: unknown) => {
  if (Schema.is(evaluationFailureSchema)(cause)) {
    const message = cause.stderr.trim().split("\n")[0];
    if (message) return new Error(message);
  }
  return new Error(
    "App definition evaluation failed before emitting a declaration",
  );
};

async function appPackage(source: CapturedSource, recipe: PinnedRecipe) {
  let directory = dirname(join(source.snapshotPath, recipe.entry));
  for (;;) {
    const file = join(directory, "package.json");
    const present = await access(file).then(
      () => true,
      () => false,
    );
    if (present)
      return {
        directory,
        metadata: Schema.decodeUnknownSync(packageSchema)(
          await readFile(file, "utf8"),
        ),
      };
    if (directory === source.snapshotPath) return { directory, metadata: {} };
    const parent = dirname(directory);
    const path = relative(source.snapshotPath, parent);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error("App entry is outside its captured source");
    directory = parent;
  }
}

/** Package entry policy pinned only by the captured source recipes that need it. */
export function appBackendPackageMainFields(
  recipe: PinnedRecipe,
): string[] | undefined {
  return recipe.toolchain.packageResolution ===
    "captured-browser-module-main-v1"
    ? ["browser", "module", "main"]
    : undefined;
}

/** Output directory naming the Worker and declaration bundles of one build. */
const backendOutputDirectory = ".fungi-backend";
const declarationEntry = "fungi:app-declaration";
const declarationNamespace = "fungi-app-declaration";
const buildOnlySdk = "@fungi.computer/agar/backend-declaration";
const buildOnlySdkFile =
  /(?:^|\/)agar\/(?:src|dist)\/backend-declaration\.(?:js|ts)$/;

/** Metafile paths are relative to the build's working directory, with `/`. */
const metafilePath = (source: CapturedSource, path: string) =>
  relative(source.snapshotPath, path).split(sep).join("/");

/** The checked Worker output of one App backend build. */
export type AppBackendOutput = Readonly<{
  file: esbuild.OutputFile;
  /** Source inputs contributing to the Worker bundle. */
  inputs: readonly string[];
}>;

/**
 * Build one App backend and derive its declaration from that same build.
 *
 * A declared `fungi.backendDefinition` adds a second, build-only entry that
 * derives the declaration with `buildAppDeclaration(appBackend, fungi.app)`.
 * esbuild loads every path and resolves every import once per build, so the
 * Worker serves exactly the definition bytes and module resolution the
 * declaration describes. The Worker output is then checked to include that
 * definition and no build-only declaration code, and the declaration output to
 * import nothing at runtime.
 */
export async function createDefinitionEmission(
  source: CapturedSource,
  recipe: PinnedRecipe,
) {
  const { directory, metadata } = await appPackage(source, recipe);
  const app = metadata.fungi?.app;
  const packageDeclaration =
    app === undefined
      ? emptyAppDeclaration
      : Schema.decodeUnknownSync(appDeclarationSchema)({
          handlers: [],
          roles: [],
          ...app,
        });
  const definition = metadata.fungi?.backendDefinition;
  let definitionPath: string | null = null;
  if (definition !== undefined) {
    definitionPath = await realpath(join(directory, definition));
    const path = relative(await realpath(source.snapshotPath), definitionPath);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error(
        "App backend definition must be inside its captured source",
      );
    if (recipe.backend === null)
      throw new Error(
        "An App backend definition requires a backend build recipe",
      );
  }
  const workerPath = join(
    source.snapshotPath,
    backendOutputDirectory,
    "worker.js",
  );
  const declarationPath = join(
    source.snapshotPath,
    backendOutputDirectory,
    "declaration.js",
  );
  let declarationCode: string | undefined;

  const declarationPlugin: esbuild.Plugin = {
    name: "derived-app-declaration",
    setup(build) {
      // Only the build's own declaration entry may load the derivation.
      build.onResolve(
        { filter: /^fungi:app-declaration$/ },
        (args): esbuild.OnResolveResult | undefined =>
          args.kind === "entry-point"
            ? { path: "app-declaration.js", namespace: declarationNamespace }
            : undefined,
      );
      build.onLoad(
        { filter: /.*/, namespace: declarationNamespace },
        (): esbuild.OnLoadResult => ({
          contents: `import { appBackend } from ${JSON.stringify(definitionPath)}; import { buildAppDeclaration } from ${JSON.stringify(buildOnlySdk)}; export const appDeclaration = buildAppDeclaration(appBackend, ${JSON.stringify(packageDeclaration)});`,
          resolveDir: directory,
          loader: "js",
        }),
      );
    },
  };

  return {
    /** Entries for the one backend build: the Worker and, if defined, its declaration. */
    entryPoints: (entry: string): Record<string, string> =>
      definitionPath === null
        ? { worker: entry }
        : { worker: entry, declaration: declarationEntry },
    outdir: backendOutputDirectory,
    plugins: definitionPath === null ? [] : [declarationPlugin],
    /** Check one finished backend build and return its Worker output. */
    worker(result: esbuild.BuildResult): AppBackendOutput {
      const metafile = result.metafile;
      if (metafile === undefined)
        throw new Error("App backend build did not return its metafile");
      const outputs = result.outputFiles ?? [];
      const expected =
        definitionPath === null ? [workerPath] : [workerPath, declarationPath];
      const file = outputs.find((output) => output.path === workerPath);
      if (
        file === undefined ||
        outputs.length !== expected.length ||
        !outputs.every((output) => expected.includes(output.path))
      )
        throw new Error(
          "App backend build must emit exactly its Worker and declaration",
        );
      const workerMeta = metafile.outputs[metafilePath(source, workerPath)];
      if (workerMeta === undefined)
        throw new Error("App backend build did not describe its Worker");
      const inputs = Object.keys(workerMeta.inputs);
      if (definitionPath === null) return { file, inputs };
      if (!inputs.includes(metafilePath(source, definitionPath)))
        throw new Error(
          "The Worker must import its declared fungi.backendDefinition; the declaration is derived from the definition it serves",
        );
      if (
        inputs.some(
          (input) =>
            input.startsWith(`${declarationNamespace}:`) ||
            buildOnlySdkFile.test(input) ||
            metafile.inputs[input]?.imports.some(
              (imported) => imported.original === buildOnlySdk,
            ) === true,
        )
      )
        throw new Error(
          "The Worker must not import build-only App declaration code",
        );
      const declaration = outputs.find(
        (output) => output.path === declarationPath,
      );
      const declarationMeta =
        metafile.outputs[metafilePath(source, declarationPath)];
      if (declaration === undefined || declarationMeta === undefined)
        throw new Error("App backend build did not derive its declaration");
      const external = declarationMeta.imports.find(
        (imported) => imported.external === true,
      );
      if (external !== undefined)
        throw new Error(
          `App backend definition imports ${external.path}. Move runtime-specific imports into the Worker composition; keep the definition runtime-neutral.`,
        );
      if (declaration.contents.byteLength > recipe.maxOutputBytes)
        throw new Error(
          "App backend definition exceeds its pinned build bound",
        );
      declarationCode = declaration.text;
      return { file, inputs };
    },
    /** Evaluate the declaration derived in the checked backend build. */
    async declare(signal: AbortSignal): Promise<AppDeclaration> {
      if (definitionPath === null) {
        if (
          packageDeclaration.api &&
          Object.keys(packageDeclaration.api.methods).length > 0
        )
          throw new Error(
            "App API methods require fungi.backendDefinition; the build derives them from its methods instead of a handwritten table",
          );
        return packageDeclaration;
      }
      if (declarationCode === undefined)
        throw new Error(
          "The App declaration is derived from a checked backend build",
        );
      const file = join(source.snapshotPath, ".fungi-built-definition.mjs");
      await writeFile(file, declarationCode, { flag: "wx", mode: 0o600 });
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          evaluateDefinition,
          pathToFileURL(file).href,
        ],
        {
          cwd: source.snapshotPath,
          env: {},
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
          signal,
        },
      ).catch((cause: unknown) => {
        throw evaluationFailure(cause);
      });
      return Schema.decodeUnknownSync(
        Schema.fromJsonString(appDeclarationSchema),
        { onExcessProperty: "error" },
      )(result.stdout);
    },
  };
}

/** One App backend build and the declaration derived from it. */
export type DefinitionEmission = Awaited<
  ReturnType<typeof createDefinitionEmission>
>;
