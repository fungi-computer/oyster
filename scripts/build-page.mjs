// Bundle the App page script into a module exporting its source text, so the
// Oyster host can serve it from any runtime without an asset pipeline.
import { build } from "esbuild";
import { URL } from "node:url";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

async function stylesheet(...entries) {
  const result = await build({
    stdin: {
      contents: entries
        .map((entry) => `@import ${JSON.stringify(entry)};`)
        .join("\n"),
      loader: "css",
      resolveDir: new URL("../", import.meta.url).pathname,
    },
    bundle: true,
    minify: true,
    loader: { ".woff2": "dataurl" },
    write: false,
    logLevel: "warning",
  });
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error("Page styles produced no output");
  return output.text;
}
const [styles, fonts, loginFonts] = await Promise.all([
  stylesheet("@fungi.computer/caps/styles.css"),
  stylesheet("@fungi.computer/caps/fonts.css"),
  stylesheet("@fungi.computer/caps/fonts-sans.css"),
]);

const result = await build({
  entryPoints: [new URL("../src/page/main.tsx", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: {
    OYSTER_SHELL_STYLES: JSON.stringify(styles),
  },
  write: false,
  legalComments: "none",
  logLevel: "warning",
});
const [output] = result.outputFiles;
if (output === undefined) throw new Error("Shell bundle produced no output");
const dist = new URL("../dist/", import.meta.url);
await mkdir(dist, { recursive: true });
const boot = await build({
  entryPoints: [new URL("../src/page/boot-host.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
  logLevel: "warning",
});
const [bootOutput] = boot.outputFiles;
if (bootOutput === undefined) throw new Error("Boot parent produced no output");
await writeFile(
  new URL("boot-host-script.js", dist),
  `export const bootHostScript = ${JSON.stringify(bootOutput.text)};\n`,
);
await copyFile(
  new URL("../src/boot-host-script.d.ts", import.meta.url),
  new URL("boot-host-script.d.ts", dist),
);
const wire = await build({
  entryPoints: [
    new URL("../src/frame-binding-wire.ts", import.meta.url).pathname,
  ],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
  logLevel: "warning",
});
const [wireOutput] = wire.outputFiles;
if (wireOutput === undefined)
  throw new Error("Frame wire bundle produced no output");
await writeFile(
  new URL("frame-binding-wire-script.js", dist),
  `export const frameBindingWireScript = ${JSON.stringify(wireOutput.text)};\n`,
);
await copyFile(
  new URL("../src/frame-binding-wire-script.d.ts", import.meta.url),
  new URL("frame-binding-wire-script.d.ts", dist),
);

// Snapshot build programs run under a captured snapshot's own Node toolchain,
// so the captured Vite and its plugins stay bare imports for that snapshot.
// Oyster's own boundary decoders (Effect Schema) are bundled in.
async function snapshotProgram(entry) {
  const program = await build({
    entryPoints: [entry.pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    external: ["vite", "@vitejs/plugin-react", "vite-plugin-singlefile"],
    write: false,
    legalComments: "none",
    logLevel: "warning",
  });
  const [programOutput] = program.outputFiles;
  if (programOutput === undefined)
    throw new Error(`Snapshot program ${entry.pathname} produced no output`);
  return programOutput.text;
}
const [dependencyBuildProgram, htmlBuildProgram] = await Promise.all([
  snapshotProgram(
    new URL(
      "../src/build/snapshot-programs/dependency-build.ts",
      import.meta.url,
    ),
  ),
  snapshotProgram(
    new URL("../src/build/snapshot-programs/html-build.ts", import.meta.url),
  ),
]);
// A clean build has no emitted src/build module to create this directory.
await mkdir(new URL("build/", dist), { recursive: true });
await writeFile(
  new URL("build/snapshot-program-scripts.js", dist),
  `export const dependencyBuildProgram = ${JSON.stringify(dependencyBuildProgram)};\nexport const htmlBuildProgram = ${JSON.stringify(htmlBuildProgram)};\n`,
);
await copyFile(
  new URL("../src/build/snapshot-program-scripts.d.ts", import.meta.url),
  new URL("build/snapshot-program-scripts.d.ts", dist),
);
const consent = await build({
  entryPoints: [
    new URL("../src/page/grant-consent.tsx", import.meta.url).pathname,
  ],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: { OYSTER_SHELL_STYLES: JSON.stringify(styles) },
  write: false,
  legalComments: "none",
  logLevel: "warning",
});
const [consentOutput] = consent.outputFiles;
if (consentOutput === undefined)
  throw new Error("Consent bundle produced no output");
await writeFile(
  new URL("page-script.js", dist),
  `export const pageScript = ${JSON.stringify(output.text)};\nexport const grantConsentScript = ${JSON.stringify(consentOutput.text)};\nexport const fontStyles = ${JSON.stringify(fonts)};\nexport const loginFontStyles = ${JSON.stringify(loginFonts)};\nexport const shellStyles = ${JSON.stringify(styles)};\n`,
);
await copyFile(
  new URL("../src/page-script.d.ts", import.meta.url),
  new URL("page-script.d.ts", dist),
);

// The same source serves Hub's public assets and standalone Oyster's iframe.
// Bundle once here; neither host needs a second build or a source checkout.
const embedRoot = new URL("../", import.meta.url).pathname;
const englishOnlyZodLocales = {
  name: "english-only-zod-locales",
  setup(bundle) {
    bundle.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (input) =>
      input.importer.includes("/node_modules/zod/v4/")
        ? { path: "english-only", namespace: "zod-locales" }
        : undefined,
    );
    bundle.onLoad({ filter: /.*/, namespace: "zod-locales" }, () => ({
      contents: 'export { default as en } from "zod/v4/locales/en.js";',
      loader: "js",
      resolveDir: embedRoot,
    }));
  },
};
const embedLoader = await build({
  bundle: true,
  entryPoints: [
    new URL("../src/page/embed-loader.tsx", import.meta.url).pathname,
  ],
  format: "iife",
  platform: "browser",
  minify: true,
  target: "es2020",
  absWorkingDir: embedRoot,
  metafile: true,
  write: false,
  plugins: [englishOnlyZodLocales],
});
const [loaderOutput] = embedLoader.outputFiles;
if (loaderOutput === undefined || embedLoader.outputFiles.length !== 1)
  throw new Error("Embed loader must produce one script");
const embedWidget = await build({
  bundle: true,
  entryPoints: [
    new URL("../src/page/embed-widget.tsx", import.meta.url).pathname,
  ],
  format: "esm",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  target: "es2022",
  absWorkingDir: embedRoot,
  metafile: true,
  write: false,
  plugins: [englishOnlyZodLocales],
});
const [widgetOutput] = embedWidget.outputFiles;
if (widgetOutput === undefined || embedWidget.outputFiles.length !== 1)
  throw new Error("Embed widget must produce one script");
// Tailwind compiles the utilities the two programs use; esbuild then resolves
// the sans font so the sheet is one self-contained response.
const compiledScratch = await mkdtemp(join(tmpdir(), "oyster-embed-"));
const compiledEmbed = join(compiledScratch, "embed.css");
await promisify(execFile)(
  new URL("../node_modules/.bin/tailwindcss", import.meta.url).pathname,
  [
    "-i",
    new URL("../src/page/embed.css", import.meta.url).pathname,
    "-o",
    compiledEmbed,
    "--minify",
  ],
  { cwd: embedRoot },
);
const embedStyles = await stylesheet(
  compiledEmbed,
  "@fungi.computer/stipe/fonts-sans.css",
);
await rm(compiledScratch, { recursive: true, force: true });
// The served bytes only. Every Worker that composes the website channel
// carries this module's source in each isolate heap, so build-time facts
// (the esbuild graphs) live in their own module that no Worker imports.
await writeFile(
  new URL("embed-scripts.js", dist),
  `export const embedStyles = ${JSON.stringify(embedStyles)};\n` +
    `export const embedLoaderScript = ${JSON.stringify(loaderOutput.text)};\n` +
    `export const embedWidgetScript = ${JSON.stringify(widgetOutput.text)};\n`,
);
await writeFile(
  new URL("embed-metafiles.js", dist),
  `export const embedLoaderMetafile = ${JSON.stringify(embedLoader.metafile)};\n` +
    `export const embedWidgetMetafile = ${JSON.stringify(embedWidget.metafile)};\n`,
);
for (const declaration of ["embed-scripts.d.ts", "embed-metafiles.d.ts"])
  await copyFile(
    new URL(`../src/${declaration}`, import.meta.url),
    new URL(declaration, dist),
  );
