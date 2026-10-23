import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build, type BuildOptions } from "esbuild";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { isInsideSnapshot } from "./snapshot-programs/snapshot-path.js";

// Only code contributes package imports. Vite, not this planning pass, owns
// loading, validating and emitting assets (including extension-specific loaders).
const codeExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".json",
]);

/**
 * Find runtime package imports in the App, not in its authoring tools or in
 * package export siblings. esbuild follows local modules and erases type-only
 * imports; packages stay external until their declared products are compiled.
 * parse5 owns HTML syntax, including inline module scripts.
 */
export async function appRuntimeImports(options: {
  readonly root: string;
  readonly entry: string;
  readonly backendEntry?: string | undefined;
  readonly shellEntry?: string | undefined;
}): Promise<ReadonlySet<string>> {
  const root = await realpath(options.root);
  const contained = async (path: string) => {
    const resolved = await realpath(path);
    if (!isInsideSnapshot(root, resolved))
      throw new Error(`App import escapes the captured source: ${path}`);
    return resolved;
  };
  const entry = await contained(join(root, options.entry));
  const modules: BuildOptions[] = [];
  const document = parse(await readFile(entry, "utf8"));
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ("tagName" in node && node.tagName === "script") {
      const attribute = (name: string) =>
        node.attrs.find((attribute) => attribute.name === name)?.value;
      if (attribute("type") === "module") {
        const src = attribute("src");
        if (src !== undefined) {
          // Vite roots absolute page paths beside the HTML entry.
          const url = new URL(
            src.startsWith("/") && !src.startsWith("//") ? `.${src}` : src,
            pathToFileURL(entry),
          );
          if (url.protocol === "file:")
            modules.push({ entryPoints: [fileURLToPath(url)] });
        } else {
          modules.push({
            stdin: {
              contents: node.childNodes
                .map((child) => ("value" in child ? child.value : ""))
                .join(""),
              resolveDir: dirname(entry),
              sourcefile: entry,
              loader: "js",
            },
          });
        }
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(document);
  for (const path of [options.backendEntry, options.shellEntry])
    if (path !== undefined)
      modules.push({ entryPoints: [await contained(join(root, path))] });

  const imports = new Set<string>();
  for (const module of modules) {
    const result = await build({
      ...module,
      absWorkingDir: root,
      bundle: true,
      write: false,
      metafile: true,
      packages: "external",
      platform: "neutral",
      format: "esm",
      outdir: ".botanical/app-imports",
      logLevel: "silent",
      plugins: [
        {
          name: "captured-app-imports",
          setup(build) {
            build.onLoad({ filter: /.*/ }, async ({ path, suffix }) => {
              await contained(path);
              const query = new URL(suffix, "file:///").searchParams;
              if (
                !codeExtensions.has(extname(path)) ||
                query.has("raw") ||
                query.has("url")
              )
                return { contents: "", loader: "empty" };
              return undefined;
            });
          },
        },
      ],
    });
    for (const output of Object.values(result.metafile.outputs))
      for (const imported of output.imports)
        if (imported.external) imports.add(imported.path);
  }
  return imports;
}
