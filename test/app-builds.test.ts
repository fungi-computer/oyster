import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import { base64url } from "jose";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import * as Schema from "effect/Schema";
import {
  parseAppId,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  type ArtifactRef,
} from "@fungi.computer/puffball";
import {
  createCapturedCandidatePreparer,
  normalizeAppPublisherRecipe,
} from "../src/build/effect.js";
import {
  createLocalBuildExecutor,
  createLocalCommitSourceCapture,
} from "../src/build/local-build.js";
import {
  teamAppCandidateSubmissionSchema,
  type TeamAppCandidateSubmission,
} from "../src/build/submission-contract.js";
import {
  createOysterAppBuilds,
  type OysterBuildComputer,
} from "../src/app-builds.js";
import { verifyRelease, type ArtifactStore } from "../src/release.js";

const assets = {
  maxManifestBytes: 65_536,
  maxObjects: 16,
  maxObjectBytes: 65_536,
  maxTotalBytes: 131_072,
};
const appId = "app_fixture";
const computerObjectId = "computer-object-1";

let work: string;
let sourceRevision: string;
let candidate: TeamAppCandidateSubmission;
let normalized: ReturnType<typeof normalizeAppPublisherRecipe>;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "oyster-app-builds-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", work, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({ name: "fixture" }),
  );
  await mkdir(join(work, "bundle"));
  await writeFile(
    join(work, "bundle/index.html"),
    "<!doctype html><title>Built on the Computer</title>",
  );
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  sourceRevision = `git:${git("rev-parse", "HEAD")}`;
  normalized = normalizeAppPublisherRecipe({
    appId,
    recipe: {
      kind: "bundled-html",
      entry: "bundle/index.html",
      assets,
      assetBase: "./",
      backend: null,
      maxOutputBytes: assets.maxTotalBytes,
    },
  });
  // What the fixed builder command produces on the Computer for this commit.
  const prepared = await Effect.runPromise(
    createCapturedCandidatePreparer(
      {
        appId: parseAppId(appId),
        recipe: normalized.recipe,
        buildRecipeDigest: normalized.buildRecipeDigest,
      },
      {
        sourceCapture: createLocalCommitSourceCapture(
          work,
          parseSourceRevision(sourceRevision),
        ),
        buildExecutor: createLocalBuildExecutor(),
      },
    ).prepareCandidate(parseReleaseId("rel_build")),
  );
  candidate = Schema.decodeUnknownSync(
    Schema.toType(teamAppCandidateSubmissionSchema),
  )({
    appId: prepared.appId,
    output: prepared.output,
    provenance: prepared.provenance,
  });
}, 60_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

/** The R2 surface the writer and reader use, over memory, with R2's conditional put. */
function memoryBucket() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string; version: string }
  >();
  const metadata = (object: { bytes: Uint8Array; version: string }) => ({
    version: object.version,
    size: object.bytes.byteLength,
    checksums: {
      sha256: new Uint8Array(createHash("sha256").update(object.bytes).digest())
        .buffer,
    },
  });
  return {
    head: (key: string) => {
      const object = objects.get(key);
      return Promise.resolve(object === undefined ? null : metadata(object));
    },
    get: (key: string) => {
      const object = objects.get(key);
      if (object === undefined) return Promise.resolve(null);
      return Promise.resolve({
        ...metadata(object),
        httpMetadata: { contentType: object.contentType },
        body: new Blob([object.bytes]).stream(),
        arrayBuffer: () => Promise.resolve(object.bytes.slice().buffer),
      });
    },
    put: (
      key: string,
      value: Uint8Array,
      options: {
        onlyIf: { etagDoesNotMatch: string };
        httpMetadata: { contentType: string };
      },
    ) => {
      if (options.onlyIf.etagDoesNotMatch === "*" && objects.has(key))
        return Promise.resolve(null);
      const object = {
        bytes: value.slice(),
        contentType: options.httpMetadata.contentType,
        version: String(objects.size + 1),
      };
      objects.set(key, object);
      return Promise.resolve(metadata(object));
    },
  };
}

function fixture(
  simulate: (job: { jobId: string; command: string }) => Promise<number>,
) {
  const bucket = memoryBucket();
  const store: ArtifactStore = {
    async get(artifactRef: ArtifactRef) {
      const object = await bucket.get(artifactRef);
      return object === null
        ? null
        : new Uint8Array(await object.arrayBuffer());
    },
    put: () => Promise.reject(new Error("Builds write through the R2 writer")),
  };
  const port: OysterBuildComputer = {
    async runBuild(input) {
      return { output: { exitCode: await simulate(input) } };
    },
  };
  const builds = createOysterAppBuilds({
    owner: fromNodeSqlite(new DatabaseSync(":memory:")),
    tenantId: "tenant-1",
    computer: { name: "workspace", objectId: computerObjectId, port },
    bucket,
    artifacts: store,
  });
  builds.registerSource({
    appId: parseAppId(appId),
    installationId: "bonsai",
    repository: "my-fixture",
    recipe: normalized.recipe,
    buildRecipeDigest: normalized.buildRecipeDigest,
  });
  return { builds, store };
}

/** The upload grant the fixed command carries to the Computer's builder. */
function grantOf(command: string): string {
  const encoded = /team-candidate-builder\.mjs '([A-Za-z0-9_-]+)'/u.exec(
    command,
  )?.[1];
  expect(encoded).toBeDefined();
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ uploadGrant: Schema.String })),
  )(new TextDecoder().decode(base64url.decode(encoded ?? "")), {
    onExcessProperty: "ignore",
  }).uploadGrant;
}

it("builds a registered source's exact commit on the Computer into a verified Release", async () => {
  // The simulated Computer reads `builds` only once a build runs.
  const { builds } = fixture(async ({ jobId, command }) => {
    expect(command).toContain(
      `TEAM_BUILD_REMOTE=https://git.team.internal/git/bonsai/my-fixture.git`,
    );
    // Scratch is on the Computer's disk, never an on-box VM's RAM-backed /tmp.
    expect(command).toContain("mktemp -d /var/tmp/fungi-app-build-");
    expect(command).toContain('export TMPDIR="$work/tmp"');
    expect(command).toContain(
      `TEAM_BUILD_REPORT=https://build.team.internal/jobs/${jobId}`,
    );
    expect(builds.admitExecution(jobId, computerObjectId)).toBe(true);
    expect(builds.admitExecution(jobId, "another-computer")).toBe(false);
    // The egress clone: one repository, read only, this Computer only.
    const pass = builds.gitPassFor(computerObjectId, {
      installationId: "bonsai",
      repository: "my-fixture",
      scope: "read",
    });
    expect(pass).not.toBeNull();
    const target = {
      installationId: "bonsai",
      repository: "my-fixture",
      scope: "read",
    } as const;
    expect(builds.admitGitPass(pass ?? "", target)).toEqual({
      requestedBy: "owner-1",
    });
    expect(
      builds.admitGitPass(pass ?? "", { ...target, scope: "write" }),
    ).toBeNull();
    expect(
      builds.admitGitPass(pass ?? "", { ...target, repository: "other" }),
    ).toBeNull();
    expect(builds.gitPassFor("another-computer", target)).toBeNull();
    const admitted = builds.admitBuild(jobId, computerObjectId);
    expect(admitted).not.toBeNull();
    expect(builds.admitBuild(jobId, "another-computer")).toBeNull();
    const credentialId = admitted?.credentialId ?? "";
    // A wrong grant or a candidate for another commit is refused.
    expect(
      (await builds.submitCandidate(jobId, candidate, "forged", credentialId))
        .status,
    ).toBe(403);
    expect(
      (
        await builds.submitCandidate(
          jobId,
          {
            ...candidate,
            provenance: {
              ...candidate.provenance,
              sourceRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
            },
          },
          grantOf(command),
          credentialId,
        )
      ).status,
    ).toBe(409);
    const submitted = await builds.submitCandidate(
      jobId,
      candidate,
      grantOf(command),
      credentialId,
    );
    expect(submitted.status).toBe(200);
    builds.record({
      kind: "build-status",
      jobId,
      credentialId,
      status: "succeeded",
      detail: null,
    });
    return 0;
  });
  const { build, run } = await builds.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
  });
  expect(build.status).toBe("running");
  const done = await run();
  expect(done.status).toBe("succeeded");
  expect(done.release?.releaseId).toBe(build.releaseId);
  expect(done.release?.artifact.provenance.sourceRevision).toBe(sourceRevision);
  expect(builds.release(build.releaseId)).toEqual(done.release);
  // The clone credential ends with the job.
  expect(
    builds.gitPassFor(computerObjectId, {
      installationId: "bonsai",
      repository: "my-fixture",
      scope: "read",
    }),
  ).toBeNull();
}, 60_000);

it("records the built Release in the bucket as an installable, verified Release", async () => {
  const { builds, store } = fixture(async ({ jobId, command }) => {
    const credentialId =
      builds.admitBuild(jobId, computerObjectId)?.credentialId ?? "";
    await builds.submitCandidate(
      jobId,
      candidate,
      grantOf(command),
      credentialId,
    );
    builds.record({
      kind: "build-artifact",
      jobId,
      credentialId,
      digest: `sha256:${"a".repeat(64)}`,
      bytes: 1,
    });
    return 0;
  });
  const { run } = await builds.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
  });
  const done = await run();
  // Exit 0 after the artifact report settles succeeded without a status report.
  expect(done.status).toBe("succeeded");
  if (done.release === null) throw new Error("The build recorded no Release");
  const verified = await verifyRelease(store, done.release);
  expect(verified.ui?.kind).toBe("assets");
}, 60_000);

it("fails a build whose Computer exits without a Release", async () => {
  const { builds } = fixture(() => Promise.resolve(1));
  const { run } = await builds.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
  });
  const done = await run();
  expect(done.status).toBe("failed");
  expect(done.release).toBeNull();
});

it("refuses a build for an App without a registered source or with a mismatched recipe digest", async () => {
  const { builds } = fixture(() => Promise.resolve(0));
  await expect(
    builds.start({ appId: "app_other", sourceRevision, requestedBy: "o" }),
  ).rejects.toThrow("App has no build source");
  expect(() =>
    builds.registerSource({
      appId: parseAppId(appId),
      installationId: "bonsai",
      repository: "my-fixture",
      recipe: normalized.recipe,
      buildRecipeDigest: parseSha256Digest(`sha256:${"0".repeat(64)}`),
    }),
  ).toThrow("Build recipe digest does not match its recipe");
});
