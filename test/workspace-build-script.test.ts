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
  WorkspaceBuildError,
} from "../src/build/workspace-build.js";
import { normalizeAppPublisherRecipe } from "../src/build/effect.js";
import { workspaceBuildPolicy } from "../src/build/build-policy.js";
import { createLocalBuildExecutor } from "../src/build/local-build.js";

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

/** The three projects written by workspace(), in pnpm's inventory shape. */
const fixtureProjects = () =>
  JSON.stringify([
    { name: "fixture-root", path: root },
    { name: "@fixture/page", path: join(root, "apps/page") },
    { name: "@fixture/dep", path: join(root, "packages/dep") },
  ]);

/**
 * Write a real workspace; manifest-policy cases do not need a CLI bootstrap.
 * workspace-build-script.native.ts qualifies the inventory and execution with pnpm.
 */
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
    projects: fixtureProjects(),
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

it("ignores erased types and authoring imports, but retains inline and selected backend runtime imports", async () => {
  await workspace(scripted);
  await writeFile(
    join(root, "apps/page/main.ts"),
    'import type { Host } from "@fixture/dep"; export type Local = Host;',
  );
  await writeFile(join(root, "apps/page/release.ts"), 'import "@fixture/dep";');
  const options = {
    root,
    entry: "apps/page/index.html",
    projects: fixtureProjects(),
  };
  expect((await resolveWorkspaceBuild(options)).steps).toEqual([]);
  await writeFile(join(root, "apps/page/backend.ts"), 'import "@fixture/dep";');
  const backend = await resolveWorkspaceBuild({
    ...options,
    backendEntry: "apps/page/backend.ts",
  });
  expect(backend.steps).toEqual([
    { kind: "script", directory: "packages/dep", script: "build" },
  ]);
  await writeFile(
    join(root, "apps/page/index.html"),
    '<script type="module">import "@fixture/dep";</script>',
  );
  expect((await resolveWorkspaceBuild(options)).steps).toEqual(backend.steps);
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

it.each([false, true])(
  "refuses a nested non-workspace package instead of inheriting its host closure (declared dependencies: %s)",
  async (declaresDependencies) => {
    await workspace(scripted);
    const directory = "apps/page/examples/notes";
    await mkdir(join(root, directory, "ui"), { recursive: true });
    await writeFile(
      join(root, directory, "package.json"),
      json(
        declaresDependencies
          ? { name: "@fixture/notes", dependencies: {} }
          : { name: "@fixture/notes" },
      ),
    );
    await writeFile(join(root, directory, "ui/index.html"), "<!doctype html>");
    const build = resolveWorkspaceBuild({
      root,
      entry: `${directory}/ui/index.html`,
      projects: fixtureProjects(),
    });
    try {
      await build;
      expect.fail(
        "A nested non-workspace package must refuse the host closure",
      );
    } catch (error) {
      if (!(error instanceof WorkspaceBuildError)) throw error;
      expect(error.code).toBe("non_workspace_package");
      expect(error).toMatchObject({
        name: "WorkspaceBuildError",
        directory,
        ownerDirectory: "apps/page",
      });
    }
  },
);

it("uses a nested workspace package's own dependencies, not its parent workspace's", async () => {
  await workspace(scripted);
  const directory = "apps/page/examples/notes";
  await mkdir(join(root, directory, "ui"), { recursive: true });
  await writeFile(
    join(root, directory, "package.json"),
    json({ name: "@fixture/notes", dependencies: {} }),
  );
  await writeFile(join(root, directory, "ui/index.html"), "<!doctype html>");
  const build = await resolveWorkspaceBuild({
    root,
    entry: `${directory}/ui/index.html`,
    projects: JSON.stringify([
      { name: "fixture-root", path: root },
      { name: "@fixture/page", path: join(root, "apps/page") },
      { name: "@fixture/dep", path: join(root, "packages/dep") },
      { name: "@fixture/notes", path: join(root, directory) },
    ]),
  });
  expect(build).toEqual({
    directory,
    packageName: "@fixture/notes",
    react: false,
    dependencies: [],
    steps: [],
  });
});

it("allows an entry below its workspace manifest when no nested package intervenes", async () => {
  const expected = await workspace(scripted);
  await mkdir(join(root, "apps/page/web"));
  await writeFile(
    join(root, "apps/page/web/index.html"),
    '<!doctype html><script type="module" src="../main.ts"></script>',
  );
  expect(
    await resolveWorkspaceBuild({
      root,
      entry: "apps/page/web/index.html",
      projects: fixtureProjects(),
    }),
  ).toEqual(expected);
});

it("keeps a registry package's built stylesheet and compiles only workspace ones", async () => {
  await writeFile(join(root, "index.html"), "<!doctype html>");
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
  await writeFile(join(root, "index.html"), "<!doctype html>");
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
