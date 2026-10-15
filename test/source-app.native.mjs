// Build a real first-party App entirely from its committed repository source.
// Local compilation only: no installation, provider calls or deployment.
import assert from "node:assert/strict";
import console from "node:console";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseReleaseId, parseSourceRevision } from "@fungi.computer/puffball";
import { appBuildJsonSchema } from "@fungi.computer/puffball/app";
import { assetBuildJsonSchema } from "@fungi.computer/puffball/assets";
import {
  createAppCandidatePreparer,
  createLocalCommitSourceCapture,
  createLocalBuildExecutor,
  createLocalArtifactWriter,
  commitPreparedCandidate,
  repositoryEnvironment,
} from "../dist/build.js";

const repository = process.argv[3]
  ? resolve(process.argv[3])
  : fileURLToPath(new URL("../../../", import.meta.url));
const app = process.argv[2] ?? "bonsai";
assert.ok(app === "bonsai" || app === "notes" || app === "inkcap");
const entry =
  app === "bonsai"
    ? "apps/bonsai/web/index.html"
    : app === "inkcap"
      ? "apps/inkcap/index.html"
      : "packages/oyster/examples/notes-app/ui/index.html";
const backendEntry =
  app === "bonsai"
    ? "apps/bonsai/backend/index.ts"
    : app === "inkcap"
      ? "apps/inkcap/backend/index.ts"
      : "packages/oyster/examples/notes-app/backend/index.ts";
const revision = parseSourceRevision(
  `git:${execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    env: repositoryEnvironment(),
    encoding: "utf8",
  }).trim()}`,
);
const store = execFileSync("pnpm", ["store", "path"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const policy = {
  maxManifestBytes: 1_048_576,
  maxObjects: 1024,
  maxObjectBytes: 16_777_216,
  maxTotalBytes: 67_108_864,
};
const recipe = {
  entry,
  maxOutputBytes: policy.maxTotalBytes,
  backend: {
    entry: backendEntry,
    exportName:
      app === "bonsai" ? "BonsaiApp" : app === "inkcap" ? "Inkcap" : "Notes",
    compatibilityDate: "2026-09-04",
    runtime: { kind: "durable-facet", stateSchema: 1 },
  },
};
const directory = await mkdtemp(join(tmpdir(), "oyster-source-proof-"));
try {
  const compiler = createLocalBuildExecutor({ packageStoreDirectory: store });
  const preparer = createAppCandidatePreparer({
    config: {
      appId: `app_${app}`,
      recipe:
        app === "inkcap"
          ? recipe
          : { ...recipe, assets: policy, assetBase: "./" },
    },
    sourceCapture: createLocalCommitSourceCapture(repository, revision),
    buildExecutor: {
      ...compiler,
      build: (source, recipe) =>
        compiler
          .build(source, recipe)
          .pipe(
            Effect.tapError((error) => Effect.sync(() => console.error(error))),
          ),
    },
  });
  const prepared = await Effect.runPromise(
    Effect.scoped(preparer.prepareCandidate(parseReleaseId(`rel_${app}`))),
  );
  const release = await Effect.runPromise(
    commitPreparedCandidate(prepared, {
      artifactWriter: createLocalArtifactWriter(directory, policy),
      releaseCatalog: { createRelease: async (value) => value },
    }),
  );
  assert.equal(release.artifact.provenance.sourceRevision, revision);
  const read = (ref) =>
    readFile(join(directory, ref.slice("artifact:".length)), "utf8");
  const root = Schema.decodeUnknownSync(appBuildJsonSchema)(
    await read(release.artifact.artifactRef),
  );
  assert.ok(root.backend);
  assert.ok(root.ui);
  assert.ok(
    root.declaration.api.methods[
      app === "bonsai" ? "repos.list" : app === "inkcap" ? "commit" : "readNote"
    ],
  );
  if (app === "inkcap") {
    assert.equal(root.ui.mediaType, "text/html; charset=utf-8");
    assert.match(await read(root.ui.artifactRef), /<script\b/);
  } else {
    const assets = Schema.decodeUnknownSync(assetBuildJsonSchema)(
      await read(root.ui.artifactRef),
    );
    assert.ok(assets.assets.some((asset) => asset.path === "/index.html"));
    assert.ok(assets.assets.some((asset) => asset.path.endsWith(".js")));
  }
  console.log(
    `${app}: captured UI source, backend, declaration, immutable artifacts and ${revision} passed`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
