// Captured-dependency build program. Oyster bundles this file into a string,
// writes it beside the selected App in a captured snapshot and runs it with the
// snapshot's own pinned Node toolchain. Every filesystem access is guarded so no
// input outside the captured snapshot can reach a compiler.
//
// argv: snapshot, App directory, format, one JSON array of steps (either
// consecutive TypeScript configs sharing a compiler, or one stylesheet), and
// the directory whose dependencies hold the pinned Tailwind compiler.
import fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import type * as TypeScript from "typescript";
import * as Schema from "effect/Schema";
import {
  enhancedResolveModule,
  tailwindModule,
  tailwindNodeModule,
  tailwindOxideModule,
  typeScriptModule,
  type FileSystemEntries,
  type SnapshotFileSystem,
} from "./pinned-modules.js";
import { isInsideSnapshot } from "./snapshot-path.js";
import {
  workspaceBuildStepsJsonSchema,
  type WorkspaceBuildStep,
} from "../build-step.js";

function programArguments() {
  const [snapshot, appDirectory, format, steps, toolchain, ...rest] =
    process.argv.slice(2);
  if (
    snapshot === undefined ||
    appDirectory === undefined ||
    format === undefined ||
    steps === undefined ||
    toolchain === undefined ||
    rest.length > 0
  )
    throw new Error(
      "Dependency build requires a snapshot, App directory, format, steps and toolchain directory",
    );
  return {
    snapshot,
    appDirectory,
    format,
    steps: Schema.decodeUnknownSync(workspaceBuildStepsJsonSchema)(steps),
    toolchain,
  };
}
const { snapshot, appDirectory, format, steps, toolchain } = programArguments();

function inSnapshot(path: string): boolean {
  return isInsideSnapshot(snapshot, path);
}

/** Resolve `path` through every symbolic link, rejecting any escape. */
function contained(path: string, links = 0): string {
  const candidate = resolve(path);
  if (!inSnapshot(candidate)) {
    throw new Error(
      `Dependency build input escapes captured snapshot: ${path}`,
    );
  }
  if (links > 40)
    throw new Error("Captured dependency has too many symbolic links");
  const parts = relative(snapshot, candidate).split(sep).filter(Boolean);
  let current = snapshot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current, { throwIfNoEntry: false });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOTDIR")
        return candidate;
      throw error;
    }
    if (!stat) return candidate;
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(current), fs.readlinkSync(current));
      return contained(join(target, ...parts.slice(index + 1)), links + 1);
    }
  }
  return candidate;
}

// Fixed files from the pinned, captured package graph. Node receives an already
// contained absolute file, never a bare package lookup that can climb out.
const require = createRequire(import.meta.url);
function loadPinned<Module>(
  module: Schema.Decoder<Module>,
  path: string,
): Module {
  const loaded: unknown = require(contained(require.resolve(contained(path))));
  return Schema.decodeUnknownSync(module)(loaded);
}

function compileTypeScript(compilerSteps: readonly WorkspaceBuildStep[]): void {
  const ts = loadPinned(
    typeScriptModule,
    join(snapshot, appDirectory, "node_modules/typescript/lib/typescript.js"),
  );
  const entries = (path: string): FileSystemEntries => {
    const directory = contained(path);
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return { files: [], directories: [] };
      throw error;
    }
    const files: string[] = [];
    const directories: string[] = [];
    for (const entry of names) {
      const entryPath = contained(join(directory, entry.name));
      const stat = entry.isSymbolicLink() ? fs.statSync(entryPath) : entry;
      if (stat.isFile()) files.push(entry.name);
      else if (stat.isDirectory()) directories.push(entry.name);
    }
    return { files: files.sort(), directories: directories.sort() };
  };
  const filesystem = {
    readFile: (path: string) => ts.sys.readFile(contained(path)),
    // Compiler fallback searches may climb ancestors. Outside paths are absent
    // without probing the host; explicit reads/enumerations still reject them.
    fileExists: (path: string) =>
      inSnapshot(path) && ts.sys.fileExists(contained(path)),
    directoryExists: (path: string) =>
      inSnapshot(path) && ts.sys.directoryExists(contained(path)),
    getDirectories: (path: string) => [...entries(path).directories],
    realpath: (path: string) => contained(path),
    createDirectory: (path: string) => {
      ts.sys.createDirectory(contained(path));
    },
    readDirectory: (
      path: string,
      extensions?: readonly string[],
      excludes?: readonly string[],
      includes?: readonly string[],
      depth?: number,
    ) => {
      contained(path);
      for (const pattern of [...(excludes ?? []), ...(includes ?? [])])
        contained(resolve(path, pattern));
      // Reuse the pinned compiler's own matcher; every recursive enumeration
      // and symlink check goes through guarded filesystem callbacks.
      return ts.matchFiles(
        path,
        extensions,
        excludes,
        includes,
        ts.sys.useCaseSensitiveFileNames,
        snapshot,
        depth,
        entries,
        (entry) => contained(entry),
      );
    },
  };
  const diagnosticHost: TypeScript.FormatDiagnosticsHost = {
    getCurrentDirectory: () => snapshot,
    getCanonicalFileName: (path) => path,
    getNewLine: () => "\n",
  };
  let previousProgram: TypeScript.Program | undefined;
  for (const compilerStep of compilerSteps) {
    if (compilerStep.kind !== "typescript")
      throw new Error("Compiler group contains a non-TypeScript step");
    const config = contained(join(snapshot, compilerStep.config));
    const configHost: TypeScript.ParseConfigFileHost = {
      ...ts.sys,
      ...filesystem,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, configHost);
    if (!parsed) throw new Error("Captured TypeScript config is invalid");
    if (parsed.errors.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(parsed.errors, diagnosticHost),
      );
    const host = Object.assign(
      ts.createCompilerHost(parsed.options),
      filesystem,
    );
    const writeFile = host.writeFile;
    host.writeFile = (path, ...rest) => {
      writeFile(contained(path), ...rest);
    };
    const programOptions: TypeScript.CreateProgramOptions = {
      rootNames: parsed.fileNames.map((path) => contained(path)),
      options: parsed.options,
      host,
    };
    if (parsed.projectReferences !== undefined)
      programOptions.projectReferences = parsed.projectReferences;
    if (previousProgram !== undefined)
      programOptions.oldProgram = previousProgram;
    const program = ts.createProgram(programOptions);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost),
      );
    const emitted = program.emit();
    if (emitted.emitSkipped || emitted.diagnostics.length)
      throw new Error("Captured TypeScript emit failed");
    previousProgram = program;
  }
}

// Tailwind's maintained resolver accepts its filesystem at construction; every
// read it makes is checked against the captured snapshot first.
const snapshotFileSystem: SnapshotFileSystem = {
  statSync: (path, ...options) => {
    contained(path);
    return fs.statSync(path, ...options);
  },
  lstatSync: (path, ...options) => {
    contained(path);
    return fs.lstatSync(path, ...options);
  },
  readFileSync: (path, ...options) => {
    contained(path);
    return fs.readFileSync(path, ...options);
  },
  readdirSync: (path, ...options) => {
    contained(path);
    return fs.readdirSync(path, ...options);
  },
  readlinkSync: (path, ...options) => {
    contained(path);
    return fs.readlinkSync(path, ...options);
  },
};

/** Run `compute` as an async callback would: a throw becomes a rejection. */
function settled<Result>(compute: () => Result): Promise<Result> {
  return new Promise((settle) => {
    settle(compute());
  });
}

function resolvedPath(path: string | false, id: string): string {
  if (path === false)
    throw new Error(`Captured stylesheet dependency did not resolve: ${id}`);
  return contained(path);
}

async function compileTailwind(stylesheet: {
  readonly input: string;
  readonly output: string;
}): Promise<void> {
  // The fixed pnpm virtual store puts CLI dependencies in this node_modules.
  const cli = contained(
    join(snapshot, toolchain, "node_modules/@tailwindcss/cli"),
  );
  const modules = contained(resolve(cli, "../.."));
  // The publisher pins @tailwindcss/cli 4.2.1 before this program runs; these
  // are that release's own captured dependencies.
  const { compile } = loadPinned(
    tailwindModule,
    join(modules, "tailwindcss/dist/lib.js"),
  );
  const {
    compile: compileNode,
    optimize,
    loadModule,
  } = loadPinned(
    tailwindNodeModule,
    join(modules, "@tailwindcss/node/dist/index.js"),
  );
  const { Scanner } = loadPinned(
    tailwindOxideModule,
    join(modules, "@tailwindcss/oxide/index.js"),
  );
  const { ResolverFactory } = loadPinned(
    enhancedResolveModule,
    join(modules, "enhanced-resolve/lib/index.js"),
  );
  const cssResolver = ResolverFactory.createResolver({
    fileSystem: snapshotFileSystem,
    useSyncFileSystemCalls: true,
    extensions: [".css"],
    mainFields: ["style"],
    conditionNames: ["style"],
    modules: ["node_modules"],
  });
  const jsResolver = ResolverFactory.createResolver({
    fileSystem: snapshotFileSystem,
    useSyncFileSystemCalls: true,
    extensions: [".js", ".json", ".node"],
    conditionNames: ["node", "import"],
    modules: ["node_modules"],
  });
  const resolveCss = (id: string, base: string) =>
    resolvedPath(cssResolver.resolveSync({}, contained(base), id), id);
  const resolveJs = (id: string, base: string) =>
    settled(() => {
      contained(base);
      const typography = id === "@tailwindcss/typography";
      if (id !== "daisyui" && id !== "daisyui/theme" && !typography)
        throw new Error("Only the pinned stylesheet plugins are allowed");
      return resolvedPath(jsResolver.resolveSync({}, base, id), id);
    });
  const input = contained(join(snapshot, stylesheet.input));
  // Core compile parses directives without the Node wrapper's eager root stat.
  // All stylesheet/module resolution precedes loading; roots precede scanning.
  let compiled = await compile(fs.readFileSync(input, "utf8"), {
    base: dirname(input),
    from: input,
    loadModule: (id, base) =>
      loadModule(id, contained(base), contained, resolveJs),
    loadStylesheet: (id, base) =>
      settled(() => {
        const path = resolveCss(id, base);
        return {
          path,
          base: dirname(path),
          content: fs.readFileSync(path, "utf8"),
        };
      }),
  });
  const sources = [...compiled.sources];
  if (compiled.root === null)
    sources.push({
      base: join(snapshot, appDirectory),
      pattern: "**/*",
      negated: false,
    });
  else if (compiled.root !== "none")
    sources.push({ ...compiled.root, negated: false });
  for (const source of sources) {
    contained(source.base);
    contained(resolve(source.base, source.pattern));
  }
  if (format === "assets") {
    // Core parsing above checks source roots before the Node wrapper's eager
    // stat. Its maintained URL rebasing then preserves imported font/image paths
    // for Vite's immutable asset emission, using the same guarded resolvers.
    compiled = await compileNode(fs.readFileSync(input, "utf8"), {
      base: dirname(input),
      from: input,
      shouldRewriteUrls: true,
      onDependency: contained,
      customCssResolver: (id, base) => settled(() => resolveCss(id, base)),
      customJsResolver: resolveJs,
    });
  }
  const scanner = new Scanner({ sources });
  const candidates = scanner.scan();
  for (const source of scanner.globs) contained(source.base);
  for (const file of scanner.files) contained(file);
  const css = optimize(compiled.build(candidates), { minify: true }).code;
  // A package's declared stylesheet writes its declared output; an App's
  // own stylesheet compiles in place. No repository build script runs.
  const output = contained(join(snapshot, stylesheet.output));
  fs.writeFileSync(output, css);
}

const [first, ...following] = steps;
if (first === undefined) throw new Error("Dependency build has no steps");
if (first.kind === "typescript") compileTypeScript(steps);
else if (first.kind === "script")
  throw new Error("A package script runs outside the contained build program");
else {
  if (following.length)
    throw new Error("Only TypeScript steps can share a compiler process");
  await compileTailwind(first);
}
