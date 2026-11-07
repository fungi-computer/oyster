// Real pnpm boundary qualification; manifest decisions stay in the unit suite.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  parseSha256Digest,
  parseSourceRevision,
} from "@fungi.computer/puffball";
import {
  readBuildManifest,
  resolveWorkspaceBuild,
  workspaceProjectsArguments,
} from "../src/build/workspace-build.js";
import { normalizeAppPublisherRecipe } from "../src/build/effect.js";
import { createLocalBuildExecutor } from "../src/build/local-build.js";
import { packageScriptArguments } from "../src/build/snapshot-package-store.js";

const run = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workspace-build-native-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Package metadata for the pnpm adapter fixture. */
type FixtureManifest = Readonly<{
  name?: string;
  private?: boolean;
  packageManager?: string;
  scripts?: Readonly<Record<string, string>>;
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  fungi?: Readonly<{
    build?: Readonly<{
      script?: string;
    }>;
  }>;
}>;

const json = (value: FixtureManifest) => `${JSON.stringify(value, null, 2)}\n`;

/** The three projects written by workspace(), in pnpm's inventory shape. */
const fixtureProjects = () =>
  JSON.stringify([
    { name: "fixture-root", path: root },
    { name: "@fixture/page", path: join(root, "apps/page") },
    { name: "@fixture/dep", path: join(root, "packages/dep") },
  ]);

/** Write the captured workspace used to qualify pnpm discovery and refusal. */
async function workspace(
  dependency: FixtureManifest,
  projects: () => Promise<string> | string = fixtureProjects,
) {
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
  await writeFile(
    join(root, "apps/page/index.html"),
    '<!doctype html><script type="module" src="./main.ts"></script>',
  );
  await writeFile(join(root, "apps/page/main.ts"), 'import "@fixture/dep";');
  await writeFile(
    join(root, "packages/dep/package.json"),
    json({ name: "@fixture/dep", ...dependency }),
  );
  await writeFile(join(root, "packages/dep/tsconfig.build.json"), "{}");
  return resolveWorkspaceBuild({
    root,
    entry: "apps/page/index.html",
    projects: await projects(),
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

await it("resolves the fixture inventory exactly as the real pnpm workspace listing", async () => {
  const decodeProjects = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
    ),
  );
  const normalizedProjects = (projects: string) =>
    decodeProjects(projects)
      .map(({ name, path }) => ({ name, path: normalize(path) }))
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.name.localeCompare(right.name),
      );
  const fromPnpm = await workspace(scripted, async () => {
    const { stdout: projects } = await run(
      "pnpm",
      [...workspaceProjectsArguments],
      { cwd: root },
    );
    assert.deepEqual(
      normalizedProjects(projects),
      normalizedProjects(fixtureProjects()),
    );
    return projects;
  });
  assert.deepEqual(fromPnpm, await workspace(scripted));
});

await it("refuses a source that needs a package script outside a Computer build, before installing", async () => {
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
  await assert.rejects(
    Effect.runPromise(
      Effect.scoped(createLocalBuildExecutor().build(source, recipe)),
    ),
    /only a Computer build runs/,
  );
  // Nothing was installed and no script ran.
  for (const path of [
    "node_modules",
    "packages/dep/pre",
    "packages/dep/built",
    "packages/dep/installed",
  ])
    await assert.rejects(access(join(root, path)));
});

await it("runs exactly the named script: no pre/post hooks, no implicit install", async () => {
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
    await run("pnpm", [...packageScriptArguments, script], {
      cwd: root,
    });
  await access(join(root, "built"));
  await access(join(root, "dashed"));
  for (const path of ["pre", "post", "installed", "node_modules"])
    await assert.rejects(access(join(root, path)));
});

await it("resolves the real Notes SDK dependencies and pinned UI toolchain without Oyster's host runtime", async () => {
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const directory = "packages/oyster/examples/notes-app";
  const notes = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        dependencies: Schema.Record(Schema.String, Schema.String),
        devDependencies: Schema.Record(Schema.String, Schema.String),
      }),
    ),
  )(await readFile(join(repository, directory, "package.json"), "utf8"));
  assert.equal(notes.dependencies["@fungi.computer/agar"], "workspace:*");
  assert.ok(Object.hasOwn(notes.dependencies, "zod"));
  assert.equal(notes.devDependencies.vite, "8.2.2");
  assert.equal(notes.devDependencies.typescript, "5.9.3");
  const build = await resolveWorkspaceBuild({
    root: repository,
    entry: `${directory}/ui/index.html`,
    projects: (
      await run("pnpm", [...workspaceProjectsArguments], { cwd: repository })
    ).stdout,
  });
  assert.equal(build.directory, directory);
  assert.equal(build.packageName, "oyster-notes-example");
  assert.ok(build.dependencies.includes("packages/agar"));
  for (const host of [
    "packages/oyster",
    "packages/computer",
    "forks/cloudflare-computer",
  ])
    assert.ok(!build.dependencies.includes(host));
  assert.deepEqual(
    build.steps.filter((step) => step.kind === "script"),
    [],
  );
});

await it("builds Bonsai's App closure without compiling Oyster's standalone Computer host", async () => {
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const build = await resolveWorkspaceBuild({
    root: repository,
    entry: "apps/bonsai/web/index.html",
    projects: (
      await run("pnpm", [...workspaceProjectsArguments], { cwd: repository })
    ).stdout,
  });
  assert.deepEqual(
    build.steps.filter((step) => step.kind === "script"),
    [],
  );
  assert.ok(build.dependencies.includes("packages/agar"));
  assert.ok(build.dependencies.includes("packages/caps"));
  assert.ok(!build.dependencies.includes("packages/oyster"));
  assert.ok(!build.dependencies.includes("packages/computer"));
  const oyster = readBuildManifest(
    await readFile(join(repository, "packages/oyster/package.json"), "utf8"),
  );
  const computer = readBuildManifest(
    await readFile(join(repository, "packages/computer/package.json"), "utf8"),
  );
  assert.equal(
    oyster.dependencies?.["@fungi.computer/computer"],
    "workspace:*",
  );
  assert.equal(
    computer.dependencies?.["@fungi.computer/cloudflare-computer"],
    "workspace:*",
  );
});

await it("plans Games' runtime imports while leaving its WebP assets to Vite", async () => {
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const build = await resolveWorkspaceBuild({
    root: repository,
    entry: "apps/games/index.html",
    projects: (
      await run("pnpm", [...workspaceProjectsArguments], { cwd: repository })
    ).stdout,
  });
  assert.ok(build.dependencies.includes("packages/agar"));
  assert.ok(build.dependencies.includes("packages/caps"));
  assert.deepEqual(
    build.steps.filter((step) => step.kind === "script"),
    [],
  );
});
