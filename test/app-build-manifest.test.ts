import { expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appBuildRecipe,
  readBuildManifest,
  resolveWorkspaceBuild,
} from "../src/build/workspace-build.js";

// The producer is an App repository's package.json, not executable JS objects.
// These recipe fields belong beside the page policy already consumed by the
// workspace builder. The same metadata must work at a standalone repo root.
it("builds an App from its own recipe without losing its page policy", () => {
  const manifest = readBuildManifest(
    JSON.stringify({
      name: "my-app",
      fungi: {
        build: {
          kind: "source-html",
          entry: "index.html",
          react: true,
          stylesheets: ["src/style.css"],
          backend: {
            entry: "src/backend/index.ts",
            exportName: "MyApp",
            compatibilityDate: "2026-09-04",
            runtime: { kind: "durable-facet", stateSchema: 1 },
          },
          maxOutputBytes: 1_048_576,
        },
      },
    }),
  );

  expect(appBuildRecipe(manifest, "")).toEqual({
    kind: "source-html",
    entry: "index.html",
    backend: {
      entry: "src/backend/index.ts",
      exportName: "MyApp",
      compatibilityDate: "2026-09-04",
      runtime: { kind: "durable-facet", stateSchema: 1 },
    },
    maxOutputBytes: 1_048_576,
  });
  expect(manifest.fungi.build?.react).toBe(true);
  expect(manifest.fungi.build?.stylesheets).toEqual(["src/style.css"]);
});

it("keeps dependency-only declarations valid but never invents an App recipe", () => {
  const manifest = readBuildManifest(
    JSON.stringify({ fungi: { build: { typescript: ["src/tsconfig.json"] } } }),
  );
  expect(manifest.fungi.build?.typescript).toEqual(["src/tsconfig.json"]);
  expect(() => appBuildRecipe(manifest, "")).toThrow();
});

it("refuses unknown build fields while allowing unrelated package metadata", () => {
  expect(() =>
    readBuildManifest(
      JSON.stringify({
        description: "Ordinary npm metadata",
        fungi: { app: { displayName: "App" }, build: { command: "make" } },
      }),
    ),
  ).toThrow();
  expect(
    readBuildManifest(
      JSON.stringify({
        description: "Ordinary npm metadata",
        fungi: { build: { react: true } },
      }),
    ).fungi.build?.react,
  ).toBe(true);
});

it("roots App entries in the captured checkout rather than the roster", () => {
  const manifest = readBuildManifest(
    JSON.stringify({
      fungi: {
        build: { entry: "web/index.html", backend: null, maxOutputBytes: 1024 },
      },
    }),
  );
  expect(appBuildRecipe(manifest, "apps/hello").entry).toBe(
    "apps/hello/web/index.html",
  );
  expect(appBuildRecipe(manifest, "").entry).toBe("web/index.html");
});

it.each(["../index.html", "/index.html", "src/../index.html"])(
  "refuses a recipe entry that escapes its App: %s",
  (entry) => {
    expect(() =>
      readBuildManifest(
        JSON.stringify({
          fungi: { build: { entry, backend: null, maxOutputBytes: 1024 } },
        }),
      ),
    ).toThrow();
  },
);

it.each(["{", "null", "[]", '{"fungi":{"build":null}}'])(
  "refuses malformed package metadata: %s",
  (metadata) => {
    expect(() => readBuildManifest(metadata)).toThrow();
  },
);

it("roots the backend entry with the App while preserving its runtime", () => {
  const manifest = readBuildManifest(
    JSON.stringify({
      fungi: {
        build: {
          entry: "index.html",
          maxOutputBytes: 1024,
          backend: {
            entry: "backend/index.ts",
            exportName: "Hello",
            compatibilityDate: "2026-09-04",
            runtime: { kind: "durable-facet", stateSchema: 1 },
          },
        },
      },
    }),
  );
  expect(appBuildRecipe(manifest, "apps/hello").backend).toEqual({
    entry: "apps/hello/backend/index.ts",
    exportName: "Hello",
    compatibilityDate: "2026-09-04",
    runtime: { kind: "durable-facet", stateSchema: 1 },
  });
  expect(() => appBuildRecipe(manifest, "../hello")).toThrow();
});

it("the workspace resolver consumes App recipe metadata beside its page policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-build-manifest-"));
  try {
    const directory = join(root, "apps/hello");
    await mkdir(directory, { recursive: true });
    const packageJson = JSON.stringify({
      name: "hello",
      fungi: {
        build: {
          entry: "index.html",
          backend: null,
          maxOutputBytes: 1024,
          react: true,
          stylesheets: ["style.css"],
        },
      },
    });
    await writeFile(join(directory, "package.json"), packageJson);
    await writeFile(join(directory, "index.html"), "<!doctype html>");
    await writeFile(join(directory, "style.css"), "body { color: green }");
    const recipe = appBuildRecipe(readBuildManifest(packageJson), "apps/hello");
    const build = await resolveWorkspaceBuild({
      root,
      entry: recipe.entry,
      projects: JSON.stringify([{ name: "hello", path: directory }]),
    });
    expect(build.directory).toBe("apps/hello");
    expect(build.react).toBe(true);
    expect(build.steps).toEqual([
      {
        kind: "tailwind",
        input: "apps/hello/style.css",
        output: "apps/hello/style.css",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
