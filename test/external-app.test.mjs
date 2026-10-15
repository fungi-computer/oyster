import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAppPublisherRecipe } from "../src/build/effect.ts";
import * as Effect from "effect/Effect";
import * as build from "../src/build/local-build.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("an external npm App uses the canonical HTML and backend builder without a monorepo entry", () => {
  const captured = normalizeAppPublisherRecipe({
    appId: "app_starter",
    recipe: {
      kind: "source-html",
      entry: "index.html",
      assetBase: "./",
      assets: {
        maxManifestBytes: 1048576,
        maxObjects: 1024,
        maxObjectBytes: 16777216,
        maxTotalBytes: 67108864,
      },
      maxOutputBytes: 67108864,
      backend: {
        entry: "src/backend/index.ts",
        exportName: "MyApp",
        compatibilityDate: "2026-09-04",
        runtime: { kind: "durable-facet", stateSchema: 1 },
      },
    },
  });
  assert.equal(captured.recipe.kind, "source-html");
  assert.equal(captured.recipe.entry, "index.html");
  assert.equal(captured.recipe.backend.entry, "src/backend/index.ts");
  assert.equal(captured.recipe.toolchain.vite, "8.2.2");
});

test("local App authoring captures saved files without changing customer Git history or capturing secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oyster-authoring-"));
  try {
    await mkdir(join(directory, "src"));
    await writeFile(
      join(directory, "src/main.ts"),
      'export const message = "Saved edit";',
    );
    await writeFile(join(directory, ".dev.vars"), "TEST_LOCAL_VALUE=private");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* build
            .createLocalDirectorySourceCapture(directory)
            .capture();
          yield* Effect.tryPromise(async () => {
            assert.equal(
              await readFile(join(source.snapshotPath, "src/main.ts"), "utf8"),
              'export const message = "Saved edit";',
            );
            await assert.rejects(
              readFile(join(source.snapshotPath, ".dev.vars")),
              { code: "ENOENT" },
            );
            await assert.rejects(readFile(join(directory, ".git/HEAD")), {
              code: "ENOENT",
            });
          });
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
