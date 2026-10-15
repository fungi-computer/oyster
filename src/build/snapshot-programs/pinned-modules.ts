// The dependency program loads its compilers from contained absolute files in
// the captured snapshot, so Node returns them untyped. Each module is decoded
// here, at that boundary, into exactly the members the program calls, typed by
// the pinned release's own declarations wherever those describe the call.
import type fs from "node:fs";
import type * as TailwindNode from "@tailwindcss/node";
import type * as TailwindOxide from "@tailwindcss/oxide";
import type * as Tailwind from "tailwindcss";
import type * as TypeScript from "typescript";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** Entries the pinned compiler's matcher enumerates through guarded reads. */
export type FileSystemEntries = Readonly<{
  files: readonly string[];
  directories: readonly string[];
}>;

/**
 * TypeScript 5.9.3's internal glob matcher, which `tsc` itself uses for
 * `readDirectory`. It is exported at runtime but absent from the published
 * declarations, so this program owns its signature.
 */
type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => FileSystemEntries,
  realpath: (path: string) => string,
) => string[];

/**
 * The sync filesystem enhanced-resolve 5.24.5 reads with
 * `useSyncFileSystemCalls`. Its published `ResolveOptions` still demand the
 * async `FileSystem`, which that mode never calls, so this program owns the
 * resolver surface it uses.
 */
export type SnapshotFileSystem = Readonly<{
  statSync: (
    path: string,
    ...options: [fs.StatSyncOptions?]
  ) => fs.Stats | fs.BigIntStats | undefined;
  lstatSync: (
    path: string,
    ...options: [fs.StatSyncOptions?]
  ) => fs.Stats | fs.BigIntStats | undefined;
  readFileSync: (
    path: string,
    ...options: [
      (BufferEncoding | (fs.ObjectEncodingOptions & { flag?: string }) | null)?,
    ]
  ) => string | Buffer;
  readdirSync: (
    path: string,
    ...options: [
      (
        | BufferEncoding
        | (fs.ObjectEncodingOptions & {
            withFileTypes?: false;
            recursive?: boolean;
          })
        | null
      )?,
    ]
  ) => string[] | Buffer[];
  readlinkSync: (
    path: string,
    ...options: [fs.EncodingOption?]
  ) => string | Buffer;
}>;

/** enhanced-resolve's per-request context; this program always passes none. */
type ResolveContext = Readonly<Record<never, never>>;

/** One enhanced-resolve resolver over the guarded sync filesystem. */
type SyncResolver = Readonly<{
  resolveSync: (
    context: ResolveContext,
    path: string,
    request: string,
  ) => string | false;
}>;

/** The enhanced-resolve options this program passes. */
type SyncResolverOptions = Readonly<{
  fileSystem: SnapshotFileSystem;
  useSyncFileSystemCalls: true;
  extensions: string[];
  mainFields?: string[];
  conditionNames: string[];
  modules: string[];
}>;

const system = Schema.declare<TypeScript.System>(
  (input): input is TypeScript.System => Predicate.isObject(input),
);

/** TypeScript 5.9.3, pinned by the snapshot's root devDependency. */
export const typeScriptModule = Schema.Struct({
  sys: system,
  matchFiles: Schema.declare<MatchFiles>((input): input is MatchFiles =>
    Predicate.isFunction(input),
  ),
  createCompilerHost: Schema.declare<typeof TypeScript.createCompilerHost>(
    (input): input is typeof TypeScript.createCompilerHost =>
      Predicate.isFunction(input),
  ),
  createProgram: Schema.declare<typeof TypeScript.createProgram>(
    (input): input is typeof TypeScript.createProgram =>
      Predicate.isFunction(input),
  ),
  flattenDiagnosticMessageText: Schema.declare<
    typeof TypeScript.flattenDiagnosticMessageText
  >((input): input is typeof TypeScript.flattenDiagnosticMessageText =>
    Predicate.isFunction(input),
  ),
  formatDiagnosticsWithColorAndContext: Schema.declare<
    typeof TypeScript.formatDiagnosticsWithColorAndContext
  >((input): input is typeof TypeScript.formatDiagnosticsWithColorAndContext =>
    Predicate.isFunction(input),
  ),
  getParsedCommandLineOfConfigFile: Schema.declare<
    typeof TypeScript.getParsedCommandLineOfConfigFile
  >((input): input is typeof TypeScript.getParsedCommandLineOfConfigFile =>
    Predicate.isFunction(input),
  ),
  getPreEmitDiagnostics: Schema.declare<
    typeof TypeScript.getPreEmitDiagnostics
  >((input): input is typeof TypeScript.getPreEmitDiagnostics =>
    Predicate.isFunction(input),
  ),
});

/**
 * tailwindcss 4.2.1, pinned by \@tailwindcss/cli 4.2.1. Its CommonJS entry is
 * the PostCSS warning function, carrying `compile` as a property.
 */
type TailwindModule = Readonly<{ compile: typeof Tailwind.compile }>;
export const tailwindModule = Schema.declare<TailwindModule>(
  (input): input is TailwindModule =>
    Predicate.hasProperty(input, "compile") &&
    Predicate.isFunction(input.compile),
);

/** \@tailwindcss/node 4.2.1, pinned by \@tailwindcss/cli 4.2.1. */
export const tailwindNodeModule = Schema.Struct({
  compile: Schema.declare<typeof TailwindNode.compile>(
    (input): input is typeof TailwindNode.compile =>
      Predicate.isFunction(input),
  ),
  optimize: Schema.declare<typeof TailwindNode.optimize>(
    (input): input is typeof TailwindNode.optimize =>
      Predicate.isFunction(input),
  ),
  loadModule: Schema.declare<typeof TailwindNode.loadModule>(
    (input): input is typeof TailwindNode.loadModule =>
      Predicate.isFunction(input),
  ),
});

/** \@tailwindcss/oxide 4.2.1, pinned by \@tailwindcss/cli 4.2.1. */
export const tailwindOxideModule = Schema.Struct({
  Scanner: Schema.declare<typeof TailwindOxide.Scanner>(
    (input): input is typeof TailwindOxide.Scanner =>
      Predicate.isFunction(input),
  ),
});

type CreateResolver = (options: SyncResolverOptions) => SyncResolver;

/**
 * enhanced-resolve 5.24.5, pinned by \@tailwindcss/cli 4.2.1. Its entry is the
 * default resolve function, carrying `ResolverFactory` as a property.
 */
type EnhancedResolveModule = Readonly<{
  ResolverFactory: Readonly<{ createResolver: CreateResolver }>;
}>;
export const enhancedResolveModule = Schema.declare<EnhancedResolveModule>(
  (input): input is EnhancedResolveModule =>
    Predicate.hasProperty(input, "ResolverFactory") &&
    Predicate.hasProperty(input.ResolverFactory, "createResolver") &&
    Predicate.isFunction(input.ResolverFactory.createResolver),
);
