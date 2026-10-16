// Bundle the Computer's App candidate builder into one file. The Computer
// image runs it as /opt/fungi/team-candidate-builder.mjs for every build job
// (`teamAppBuildCommand`); @fungi.computer/computer's image assembly copies it.
import { build } from "esbuild";
import { fileURLToPath, URL } from "node:url";

await build({
  entryPoints: [
    fileURLToPath(new URL("../src/build/candidate-cli.ts", import.meta.url)),
  ],
  outfile: fileURLToPath(
    new URL("../dist/build/candidate-cli.mjs", import.meta.url),
  ),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["esbuild"],
  // Node ESM has no global `require`; bundled CommonJS dependencies (e.g.
  // js-yaml, pulled in through the local build via @pnpm/lockfile.fs) still
  // call it to reach builtins like "process". Give the bundle a real one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  logLevel: "warning",
});
