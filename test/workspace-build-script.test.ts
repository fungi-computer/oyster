import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  parseSha256Digest,
  parseSourceRevision,
} from "@fungi.computer/puffball";
import {
  resolveWorkspaceBuild,
  workspaceProjectsArguments,
} from "../src/build/workspace-build.js";
import { normalizeAppPublisherRecipe } from "../src/build/effect.js";
import { workspaceBuildPolicy } from "../src/build/build-policy.js";
import { createLocalBuildExecutor } from "../src/build/local-build.js";
import { packageScriptArguments } from "../src/build/snapshot-package-store.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workspace-build-script-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The package.json fields these fixtures write, including a build field
 * the policy does not know (`command`). */
type FixtureManifest = Readonly<{
  name?: string;
  private?: boolean;
  packageManager?: string;
  keywords?: readonly string[];
  scripts?: Readonly<Record<string, string>>;
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  fungi?: Readonly<{
    app?: Readonly<{ displayName: string }>;
    build?: Readonly<{
      script?: string;
      typescript?: readonly string[];
      command?: string;
    }>;
  }>;
}>;

const json = (value: FixtureManifest) => `${JSON.stringify(value, null, 2)}\n`;

/** A pnpm workspace: App `apps/page` depending on package `packages/dep`. */
async function workspace(dependency: FixtureManifest) {
  await writeFile(
    join(root, "package.json"),
    json({
      name: "fixture-root",
      private: true,
      packageManager: "pnpm@11.24.0",
      devDependencies: { typescript: "5.9.3" },
    }),
  );
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - apps/*\n  - packages/*\n",
  );
  await mkdir(join(root, "apps/page"), { recursive: true });
  await mkdir(join(root, "packages/dep"), { recursive: true });
  await writeFile(
    join(root, "apps/page/package.json"),
    json({
      name: "@fixture/page",
      dependencies: { "@fixture/dep": "workspace:*" },
      devDependencies: { vite: "8.2.2", "vite-plugin-singlefile": "2.3.3" },
    }),
  );
  await writeFile(join(root, "apps/page/index.html"), "<!doctype html>");
  await writeFile(
    join(root, "packages/dep/package.json"),
    json({ name: "@fixture/dep", ...dependency }),
  );
  await writeFile(join(root, "packages/dep/tsconfig.build.json"), "{}");
  return resolveWorkspaceBuild({
    root,
    entry: "apps/page/index.html",
    projects: execFileSync("pnpm", [...workspaceProjectsArguments], {
      cwd: root,
      encoding: "utf8",
    }),
  });
}

const scripted = {
  scripts: {
    prebuild: "node -e \"require('fs').writeFileSync('pre','')\"",
    build: "node -e \"require('fs').writeFileSync('built','')\"",
    postinstall: "node -e \"require('fs').writeFileSync('installed','')\"",
  },
  fungi: { build: { script: "build" } },
};

it("builds a dependency that names its package script with that script, in order", async () => {
  const build = await workspace(scripted);
  expect(build.steps).toEqual([
    { kind: "script", directory: "packages/dep", script: "build" },
  ]);
});

it("selects any name its manifest's own scripts define, literally", async () => {
  // Any name the manifest's own scripts define is selectable literally.
  for (const script of ["-x", "/^b/", "build:shell bundle"]) {
    const build = await workspace({
      scripts: { [script]: "true" },
      fungi: { build: { script } },
    });
    expect(build.steps).toEqual([
      { kind: "script", directory: "packages/dep", script },
    ]);
  }
});

it("keeps the inferred TypeScript step for a dependency without a script", async () => {
  const build = await workspace({});
  expect(build.steps).toEqual([
    { kind: "typescript", config: "packages/dep/tsconfig.build.json" },
  ]);
});

it.each([
  [
    "a script missing from its scripts",
    { scripts: { other: "true" }, fungi: { build: { script: "build" } } },
    "has no script named build",
  ],
  [
    "both a script and TypeScript configs",
    {
      scripts: { build: "true" },
      fungi: { build: { script: "build", typescript: ["tsconfig.x.json"] } },
    },
    "declares both a build script and TypeScript configs",
  ],
  [
    "a script the manifest lacks",
    { fungi: { build: { script: "build" } } },
    "has no script named build",
  ],
  [
    "an unknown build field",
    { fungi: { build: { command: "make" } } },
    "command",
  ],
])("refuses a dependency declaring %s", async (_, dependency, message) => {
  await expect(workspace(dependency)).rejects.toThrow(message);
});

it("leaves other package.json and fungi fields alone", async () => {
  const build = await workspace({
    ...scripted,
    keywords: ["x"],
    fungi: { ...scripted.fungi, app: { displayName: "Dep" } },
  });
  expect(build.steps).toHaveLength(1);
});

it("refuses a source that needs a package script outside a Computer build, before installing", async () => {
  await workspace(scripted);
  const { recipe } = normalizeAppPublisherRecipe({
    appId: "app_page",
    recipe: {
      entry: "apps/page/index.html",
      backend: null,
      maxOutputBytes: 8192,
    },
  });
  const source = {
    sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
    sourceTreeDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`),
    snapshotPath: root,
  };
  await expect(
    Effect.runPromise(
      Effect.scoped(createLocalBuildExecutor().build(source, recipe)),
    ),
  ).rejects.toThrow("only a Computer build runs");
  // Nothing was installed and no script ran.
  for (const path of [
    "node_modules",
    "packages/dep/pre",
    "packages/dep/built",
    "packages/dep/installed",
  ])
    await expect(access(join(root, path))).rejects.toThrow();
});

it("refuses a recipe pinned under another build policy before building", async () => {
  await workspace(scripted);
  const current = normalizeAppPublisherRecipe({
    appId: "app_page",
    recipe: {
      entry: "apps/page/index.html",
      backend: null,
      maxOutputBytes: 8192,
    },
  }).recipe;
  expect(current.toolchain.buildPolicy).toBe(workspaceBuildPolicy);
  const pinnedBefore = {
    ...current,
    toolchain: {
      ...current.toolchain,
      buildPolicy: "package-json-fungi-build-v1",
    },
  };
  const source = {
    sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
    sourceTreeDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`),
    snapshotPath: root,
  };
  await expect(
    Effect.runPromise(
      Effect.scoped(
        createLocalBuildExecutor({ packageScripts: "run" }).build(
          source,
          pinnedBefore,
        ),
      ),
    ),
  ).rejects.toThrow("Recipe pins another build toolchain or policy");
  await expect(access(join(root, "node_modules"))).rejects.toThrow();
});

it("runs exactly the named script: no pre/post hooks, no implicit install", async () => {
  // A package whose dependency is not installed, so pnpm 11 would install it
  // (running its postinstall) before the script unless told not to.
  await mkdir(join(root, "dep"), { recursive: true });
  const mark = (name: string) =>
    `node -e "require('fs').writeFileSync('${join(root, name)}','')"`;
  await writeFile(
    join(root, "dep/package.json"),
    JSON.stringify({
      name: "dep",
      version: "1.0.0",
      scripts: { postinstall: mark("installed") },
    }),
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "scripted",
      dependencies: { dep: "file:./dep" },
      scripts: {
        prebuild: mark("pre"),
        build: mark("built"),
        postbuild: mark("post"),
        "-x": mark("dashed"),
      },
    }),
  );
  // The captured repository asks for hooks; the command line wins.
  await writeFile(join(root, ".npmrc"), "enable-pre-post-scripts=true\n");
  for (const script of ["build", "-x"])
    execFileSync("pnpm", [...packageScriptArguments, script], {
      cwd: root,
      stdio: "ignore",
    });
  await access(join(root, "built"));
  await access(join(root, "dashed"));
  for (const path of ["pre", "post", "installed", "node_modules"])
    await expect(access(join(root, path))).rejects.toThrow();
});

it("builds an App's own repository, the App at its root, with registry packages", async () => {
  await writeFile(
    join(root, "package.json"),
    json({
      name: "@fixture/own-repository",
      packageManager: "pnpm@11.24.0",
      dependencies: { "@fungi.computer/caps": "0.0.1" },
      devDependencies: { typescript: "5.9.3", "@tailwindcss/cli": "4.2.1" },
      fungi: { app: { displayName: "Own repository" } },
    }),
  );
  await mkdir(join(root, "web"));
  await writeFile(join(root, "web", "index.html"), "<!doctype html>\n");
  const build = await resolveWorkspaceBuild({
    root,
    entry: "web/index.html",
    projects: JSON.stringify([{ name: "@fixture/own-repository", path: root }]),
  });
  expect(build).toEqual({
    directory: "",
    packageName: "@fixture/own-repository",
    react: false,
    dependencies: [],
    steps: [],
  });
});

it("keeps a registry package's built stylesheet and compiles only workspace ones", async () => {
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "@fixture/own-repository",
        dependencies: { "@fungi.computer/caps": "0.0.1" },
        fungi: {
          build: {
            packageStylesheets: ["@fungi.computer/caps"],
            stylesheets: ["app.css"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const build = await resolveWorkspaceBuild({
    root,
    entry: "index.html",
    projects: JSON.stringify([{ name: "@fixture/own-repository", path: root }]),
  });
  // Caps ships dist/styles.css from the registry; the App's own sheet compiles.
  expect(build.steps).toEqual([
    { kind: "tailwind", input: "app.css", output: "app.css" },
  ]);
});

it("still refuses a stylesheet package that is neither a workspace nor a dependency", async () => {
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "@fixture/own-repository",
        fungi: { build: { packageStylesheets: ["@fungi.computer/caps"] } },
      },
      null,
      2,
    )}\n`,
  );
  await expect(
    resolveWorkspaceBuild({
      root,
      entry: "index.html",
      projects: JSON.stringify([
        { name: "@fixture/own-repository", path: root },
      ]),
    }),
  ).rejects.toThrow(
    "Stylesheet package @fungi.computer/caps is not a workspace dependency",
  );
});
