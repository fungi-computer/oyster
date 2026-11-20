/* global process */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { dependencyBuildProgram } from "#snapshot-program-scripts";

// The captured-dependency compiler keeps every diagnostic on a package's
// TypeScript sources but does not re-check declaration files (skipLibCheck),
// which roughly doubled the compile of each App's shared dependency chain.
const require = createRequire(import.meta.url);
const typescriptLibrary = dirname(
  require.resolve("typescript/lib/typescript.js"),
);
const root = mkdtempSync(join(tmpdir(), "dependency-build-lib-"));
after(() => rmSync(root, { recursive: true, force: true }));

function snapshot(name, files) {
  const directory = join(root, name);
  const app = join(directory, "app");
  mkdirSync(join(app, "node_modules/typescript"), { recursive: true });
  cpSync(typescriptLibrary, join(app, "node_modules/typescript/lib"), {
    recursive: true,
  });
  mkdirSync(join(directory, "pkg/src"), { recursive: true });
  writeFileSync(
    join(directory, "pkg/tsconfig.build.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: false,
        types: [],
        lib: ["ES2022"],
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src"],
    }),
  );
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  writeFileSync(
    join(app, ".publisher-dependencies.mjs"),
    dependencyBuildProgram,
  );
  return directory;
}

function compile(directory) {
  return spawnSync(
    process.execPath,
    [
      join(directory, "app/.publisher-dependencies.mjs"),
      directory,
      "app",
      "assets",
      JSON.stringify([
        { kind: "typescript", config: "pkg/tsconfig.build.json" },
      ]),
      "app",
    ],
    { encoding: "utf8" },
  );
}

test("a type error in a captured package's TypeScript source still fails the build", () => {
  const directory = snapshot("own-error", {
    "pkg/src/index.ts": 'export const value: number = "text";\n',
  });
  const result = compile(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not assignable to type 'number'/u);
});

test("a type error inside a declaration file is not re-checked", () => {
  const directory = snapshot("library-error", {
    "pkg/src/index.ts":
      'export const value = 1;\nexport type { Broken } from "./vendor.js";\n',
    "pkg/src/vendor.d.ts": "export interface Broken extends Missing {}\n",
  });
  const result = compile(directory);
  assert.equal(result.status, 0, result.stderr);
});
