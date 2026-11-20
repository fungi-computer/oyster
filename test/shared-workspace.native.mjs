// Real pnpm and compiler qualification of a shared pass: two Apps that share
// workspace packages, built from one capture of HEAD, equal the same Apps
// built one at a time, and the second App's write-once scratch files do not
// collide with the first's.
import assert from "node:assert/strict";
import console from "node:console";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import * as Effect from "effect/Effect";
import { parseReleaseId, parseSourceRevision } from "@fungi.computer/puffball";
import {
  createAppCandidatePreparer,
  createLocalBuildExecutor,
  createLocalCandidatesPreparer,
  createLocalCommitSourceCapture,
  stageBuildOutput,
} from "../dist/build.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const revision = parseSourceRevision(
  `git:${execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim()}`,
);
const store = execFileSync("pnpm", ["store", "path"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const assets = {
  maxManifestBytes: 1048576,
  maxObjects: 1024,
  maxObjectBytes: 16777216,
  maxTotalBytes: 67108864,
};
const config = (appId, entry, backend, compatibilityDate) => ({
  appId,
  recipe: {
    entry,
    assets,
    assetBase: "./",
    maxOutputBytes: assets.maxTotalBytes,
    backend: {
      entry: backend[0],
      exportName: backend[1],
      compatibilityDate,
      runtime: { kind: "durable-facet", stateSchema: 1 },
    },
  },
});
// Two default Apps that both build Caps and its workspace closure.
const configs = [
  config(
    "app_shedpass",
    "apps/shed/index.html",
    ["apps/shed/backend/index.ts", "Shed"],
    "2026-09-25",
  ),
  config(
    "app_marketplacepass",
    "apps/marketplace/index.html",
    ["apps/marketplace/backend/index.ts", "Bazaar"],
    "2026-09-04",
  ),
];
const releaseIds = configs.map(({ appId }) =>
  parseReleaseId(`rel_${appId.slice(4)}`),
);
const evidence = (candidate) => ({
  appId: candidate.appId,
  manifest: createHash("sha256")
    .update(JSON.stringify(stageBuildOutput(candidate.output).manifest))
    .digest("hex"),
  declaration: JSON.stringify(candidate.output.declaration ?? null),
  provenance: candidate.provenance,
});

const single = [];
for (const [index, input] of configs.entries())
  single.push(
    evidence(
      await Effect.runPromise(
        createAppCandidatePreparer({
          config: input,
          sourceCapture: createLocalCommitSourceCapture(repository, revision),
          buildExecutor: createLocalBuildExecutor({
            packageStoreDirectory: store,
          }),
        }).prepareCandidate(releaseIds[index]),
      ),
    ),
  );
const phases = [];
const pass = (
  await Effect.runPromise(
    createLocalCandidatesPreparer({
      configs,
      sourceCapture: createLocalCommitSourceCapture(repository, revision),
      executor: {
        packageStoreDirectory: store,
        onPhase: (phase) => {
          phases.push(phase);
        },
      },
    }).prepareCandidates(releaseIds),
  )
).map(evidence);
assert.deepEqual(pass, single, "each App equals its single build");
assert.equal(
  pass[0].provenance.sourceTreeDigest,
  pass[1].provenance.sourceTreeDigest,
  "one capture for the pass",
);
assert.notEqual(
  pass[0].provenance.buildRecipeDigest,
  pass[1].provenance.buildRecipeDigest,
  "each App keeps its own recipe digest",
);
assert.deepEqual(phases, ["install", "build", "build"], "one install");
console.log(
  "PASS: a shared pass builds Shed and Marketplace from one capture and one install, byte-equal to their single builds",
);
await assert.rejects(
  Effect.runPromise(
    createLocalCandidatesPreparer({
      configs,
      sourceCapture: createLocalCommitSourceCapture(repository, revision),
      executor: { packageStoreDirectory: store },
    }).prepareCandidates(releaseIds.slice(1)),
  ),
  /configuration/u,
);
console.log("PASS: a pass refuses Release IDs that do not match its Apps");
