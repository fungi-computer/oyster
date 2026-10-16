import process from "node:process";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseReleaseId, parseSourceRevision } from "@fungi.computer/puffball";
import { appBuildJsonSchema } from "@fungi.computer/puffball/app";
import { assetBuildJsonSchema } from "@fungi.computer/puffball/assets";
import { backendJsonSchema } from "@fungi.computer/puffball/backend";
import {
  createAppCandidatePreparer,
  normalizeAppPublisherRecipe,
  createLocalCommitSourceCapture,
  createLocalBuildExecutor,
  createLocalArtifactWriter,
  commitPreparedCandidate,
} from "../dist/build.js";

test("a joined workspace backend pins browser resolution without changing the UI recipe", () => {
  const input = {
    appId: "app_inkcap",
    recipe: {
      entry: "apps/inkcap/index.html",
      maxOutputBytes: 67_108_864,
      backend: null,
    },
  };
  const ui = normalizeAppPublisherRecipe(input);
  assert.equal(
    ui.buildRecipeDigest,
    "sha256:c048fef0b3d2a314105425bd20b7b5a71ee002e181d113737cb648c9f791ac1b",
  );
  const joined = normalizeAppPublisherRecipe({
    ...input,
    recipe: {
      ...input.recipe,
      backend: {
        entry: "apps/inkcap/backend/index.ts",
        exportName: "Inkcap",
        compatibilityDate: "2026-09-04",
        runtime: { kind: "durable-facet", stateSchema: 1 },
      },
    },
  });
  assert.equal(ui.recipe.toolchain.packageResolution, undefined);
  assert.equal(joined.recipe.toolchain.recipe, "captured-workspace-html-v1");
  assert.equal(
    joined.recipe.toolchain.packageResolution,
    "captured-browser-module-main-v1",
  );
  assert.equal(joined.recipe.toolchain.esbuild, "0.28.2");
  assert.notEqual(joined.buildRecipeDigest, ui.buildRecipeDigest);
});

for (const withBackend of [false, true]) {
  test(`captured UI ${withBackend ? "and backend" : "alone"} uses committed bytes and one immutable writer`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "oyster-build-"));
    const source = join(directory, "source");
    const artifacts = join(directory, "artifacts");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: source,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    try {
      await mkdir(join(source, "apps/notes/ui"), { recursive: true });
      await mkdir(join(source, "apps/notes/backend"));
      const declaration = {
        displayName: "Notes",
        capabilities: ["computer.readFile"],
        handlers: [],
        roles: [],
      };
      await writeFile(
        join(source, "apps/notes/package.json"),
        JSON.stringify({
          fungi: {
            app: {
              displayName: declaration.displayName,
              capabilities: declaration.capabilities,
            },
          },
        }),
      );
      await writeFile(
        join(source, "apps/notes/ui/index.html"),
        "<!doctype html><h1>Committed Notes</h1>",
      );
      await writeFile(
        join(source, "apps/notes/backend/index.ts"),
        'export class Notes { message() { return "committed backend"; } }',
      );
      git("init", "--quiet");
      git("config", "user.name", "Build fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("add", ".");
      git("commit", "--quiet", "-m", "test: captured App");
      const revision = parseSourceRevision(`git:${git("rev-parse", "HEAD")}`);
      await writeFile(join(source, "apps/notes/ui/index.html"), "dirty UI");
      await writeFile(
        join(source, "apps/notes/backend/index.ts"),
        'throw new Error("dirty backend");',
      );
      const preparer = createAppCandidatePreparer({
        config: {
          appId: "app_notes",
          recipe: {
            kind: "bundled-html",
            entry: "apps/notes/ui/index.html",
            assetBase: "./",
            assets: {
              maxManifestBytes: 8192,
              maxObjects: 8,
              maxObjectBytes: 8192,
              maxTotalBytes: 16384,
            },
            maxOutputBytes: 16384,
            backend: withBackend
              ? {
                  entry: "apps/notes/backend/index.ts",
                  runtime: { kind: "durable-facet", stateSchema: 1 },
                  compatibilityDate: "2026-09-04",
                  exportName: "Notes",
                }
              : null,
          },
        },
        sourceCapture: createLocalCommitSourceCapture(source, revision),
        buildExecutor: createLocalBuildExecutor(),
      });
      const prepared = await Effect.runPromise(
        Effect.scoped(preparer.prepareCandidate(parseReleaseId("rel_notes"))),
      );
      const release = await Effect.runPromise(
        commitPreparedCandidate(prepared, {
          artifactWriter: createLocalArtifactWriter(artifacts, {
            maxManifestBytes: 8192,
            maxObjects: 8,
            maxObjectBytes: 8192,
            maxTotalBytes: 16384,
          }),
          releaseCatalog: { createRelease: async (value) => value },
        }),
      );
      assert.equal(release.artifact.provenance.sourceRevision, revision);
      const read = (ref) =>
        readFile(join(artifacts, ref.slice("artifact:".length)), "utf8");
      const root = Schema.decodeUnknownSync(appBuildJsonSchema)(
        await read(release.artifact.artifactRef),
      );
      assert.deepEqual(root.declaration, declaration);
      assert.ok(root.ui);
      const assets = Schema.decodeUnknownSync(assetBuildJsonSchema)(
        await read(root.ui.artifactRef),
      );
      const index = assets.assets.find((asset) => asset.path === "/index.html");
      assert.ok(index);
      assert.equal(
        await read(index.artifactRef),
        "<!doctype html><h1>Committed Notes</h1>",
      );
      if (withBackend) {
        assert.ok(root.backend);
        const backend = Schema.decodeUnknownSync(backendJsonSchema)(
          await read(root.backend.artifactRef),
        );
        assert.match(backend.code, /committed backend/);
        assert.doesNotMatch(backend.code, /dirty backend/);
      } else assert.equal(root.backend, undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const entry of [
  "apps/bonsai/web/index.html",
  "packages/oyster/examples/notes-app/ui/index.html",
]) {
  test(`${entry} accepts captured UI source joined to its backend`, () => {
    const { recipe } = normalizeAppPublisherRecipe({
      appId: "app_source",
      recipe: {
        entry,
        assetBase: "./",
        assets: {
          maxManifestBytes: 1_048_576,
          maxObjects: 1024,
          maxObjectBytes: 16_777_216,
          maxTotalBytes: 67_108_864,
        },
        maxOutputBytes: 67_108_864,
        backend: {
          entry: "apps/source/backend/index.ts",
          exportName: "App",
          compatibilityDate: "2026-09-04",
          runtime: { kind: "durable-facet", stateSchema: 1 },
        },
      },
    });
    assert.equal(recipe.format, "assets");
    assert.equal(recipe.kind, undefined);
    assert.equal(recipe.toolchain.recipe, "captured-workspace-html-v1");
  });
}
