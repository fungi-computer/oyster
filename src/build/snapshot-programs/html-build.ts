// Fixed HTML build program. Oyster bundles this file into a string and writes
// it beside the selected App's captured, declared dependencies, so `vite` and
// its plugins resolve from that App alone. No config discovery, repository
// scripts, host module links, or inherited VITE values.
//
// argv: snapshot, maximum bytes, App directory, format, asset base, entry
// directory, whether the React plugin is enabled, shell module entry ("" for
// none).
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "vite";
import { isInsideSnapshot } from "./snapshot-path.js";

function programArguments() {
  const [
    snapshot,
    maximum,
    appDirectory,
    format,
    assetBase,
    entryDirectory,
    reactEnabled,
    shellEntry,
  ] = process.argv.slice(2);
  if (
    snapshot === undefined ||
    maximum === undefined ||
    appDirectory === undefined ||
    format === undefined ||
    assetBase === undefined ||
    entryDirectory === undefined ||
    reactEnabled === undefined ||
    shellEntry === undefined
  )
    throw new Error(
      "HTML build requires a snapshot, bound, App directory, format, asset base, entry directory, React flag and shell entry",
    );
  return {
    snapshot,
    maximum,
    appDirectory,
    format,
    assetBase,
    entryDirectory,
    reactEnabled,
    shellEntry,
  };
}
const {
  snapshot,
  maximum,
  appDirectory,
  format,
  assetBase,
  entryDirectory,
  reactEnabled,
  shellEntry,
} = programArguments();
const reactPlugins =
  reactEnabled === "true"
    ? [(await import("@vitejs/plugin-react")).default()]
    : [];
const splitAssets = format === "assets";
// A shell App also emits its shell module as shell.js, keeping its exports.
// Hosts serve a shell from their own origin at their own path: its chunks
// and styles must resolve relative to the module, never to a fixed mount.
if (shellEntry !== "" && (!splitAssets || assetBase !== "./")) {
  throw new Error("A shell module requires split assets with a relative base");
}
const shellModule =
  shellEntry === ""
    ? {}
    : {
        input: {
          index: join(snapshot, entryDirectory, "index.html"),
          shell: join(snapshot, appDirectory, shellEntry),
        },
        preserveEntrySignatures: "exports-only" as const,
      };
const shellOutput =
  shellEntry === ""
    ? {}
    : {
        entryFileNames: (chunk: { isEntry: boolean; name: string }) =>
          chunk.isEntry && chunk.name === "shell"
            ? "shell.js"
            : "assets/[name]-[hash].js",
      };
const singleFilePlugins = splitAssets
  ? []
  : [
      (await import("vite-plugin-singlefile")).viteSingleFile({
        useRecommendedBuildConfig: false,
      }),
    ];
const maxBytes = Number(maximum);
if (process.versions.node !== "24.20.0")
  throw new Error("Publisher requires Node 24.20.0");
if (version !== "8.2.2")
  throw new Error("Captured Vite version differs from the recipe");
const result = await build({
  root: join(snapshot, entryDirectory),
  configFile: false,
  envDir: false,
  base: splitAssets ? assetBase : "/",
  envPrefix: [],
  mode: "production",
  logLevel: "warn",
  resolve: { dedupe: ["react", "react-dom"] },
  css: { postcss: { plugins: [] } },
  plugins: [
    {
      name: "captured-source-only",
      enforce: "pre",
      load(id) {
        if (!isAbsolute(id)) return;
        const path = fileURLToPath(new URL(id, "file:///"));
        if (!isInsideSnapshot(snapshot, path)) {
          throw new Error(
            "HTML build resolved an input outside its captured snapshot",
          );
        }
      },
    },
    ...reactPlugins,
    ...singleFilePlugins,
  ],
  build: {
    target: "es2022",
    write: splitAssets,
    cssCodeSplit: splitAssets,
    outDir: join(snapshot, ".publisher-output"),
    assetsInlineLimit: splitAssets ? 0 : maxBytes,
    sourcemap: false,
    emptyOutDir: false,
    rolldownOptions: {
      ...shellModule,
      output: { inlineDynamicImports: !splitAssets, ...shellOutput },
    },
  },
});
if (
  shellEntry !== "" &&
  !(
    !Array.isArray(result) &&
    "output" in result &&
    result.output.some(
      (chunk) =>
        chunk.type === "chunk" &&
        chunk.isEntry &&
        chunk.fileName === "shell.js",
    )
  )
) {
  throw new Error("Shell build must emit its shell module as shell.js");
}
if (!splitAssets) {
  if (
    Array.isArray(result) ||
    !("output" in result) ||
    result.output.length !== 1
  ) {
    throw new Error("HTML build must emit exactly one complete HTML file");
  }
  const output = result.output.at(0);
  if (output?.type !== "asset" || output.fileName !== "index.html") {
    throw new Error("HTML build must emit exactly one complete HTML file");
  }
  const bytes = Buffer.from(output.source);
  if (bytes.byteLength > maxBytes)
    throw new Error("HTML output exceeded its pinned bound");
  await writeFile(join(snapshot, ".publisher.html"), bytes, { flag: "wx" });
}
