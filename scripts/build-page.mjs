// Bundle the App page script into a module exporting its source text, so the
// Oyster host can serve it from any runtime without an asset pipeline.
import { build } from "esbuild";
import { URL } from "node:url";
import { copyFile, mkdir, writeFile } from "node:fs/promises";

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
const [styles, fonts] = await Promise.all([
  stylesheet("@fungi.computer/caps/styles.css"),
  stylesheet("@fungi.computer/caps/fonts.css"),
]);

const result = await build({
  entryPoints: [new URL("../src/page/main.ts", import.meta.url).pathname],
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
await writeFile(
  new URL("build/snapshot-program-scripts.js", dist),
  `export const dependencyBuildProgram = ${JSON.stringify(dependencyBuildProgram)};\nexport const htmlBuildProgram = ${JSON.stringify(htmlBuildProgram)};\n`,
);
await copyFile(
  new URL("../src/build/snapshot-program-scripts.d.ts", import.meta.url),
  new URL("build/snapshot-program-scripts.d.ts", dist),
);
const publicHome = await build({
  entryPoints: [
    new URL("../src/page/public-home.tsx", import.meta.url).pathname,
  ],
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
const [publicHomeOutput] = publicHome.outputFiles;
if (publicHomeOutput === undefined)
  throw new Error("Public home bundle produced no output");
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
  `export const pageScript = ${JSON.stringify(output.text)};\nexport const publicHomeScript = ${JSON.stringify(publicHomeOutput.text)};\nexport const grantConsentScript = ${JSON.stringify(consentOutput.text)};\nexport const fontStyles = ${JSON.stringify(fonts)};\nexport const shellStyles = ${JSON.stringify(styles)};\n`,
);
await copyFile(
  new URL("../src/page-script.d.ts", import.meta.url),
  new URL("page-script.d.ts", dist),
);
