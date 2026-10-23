import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";
import * as Effect from "effect/Effect";
import { base64url } from "jose";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import * as Schema from "effect/Schema";
import {
  parseAppId,
  parseArtifactRef,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  type ArtifactRef,
  type Sha256Digest,
} from "@fungi.computer/puffball";
import {
  createCapturedCandidatePreparer,
  normalizeAppPublisherRecipe,
  type AppPublisherCoreConfigInput,
  type BuildOutput,
} from "../src/build/effect.js";
import {
  createLocalBuildExecutor,
  createLocalCommitSourceCapture,
} from "../src/build/local-build.js";
import {
  encodeTeamAppCandidateManifest,
  teamAppCandidateManifestSchema,
  type TeamAppCandidateManifest,
} from "../src/build/submission-contract.js";
import {
  contentObjectRef,
  putContentObject,
  type ContentObjectBucket,
} from "../src/build/content-objects.js";
import { stageBuildOutput } from "../src/build/artifact-writer.js";
import { backendJsonSchema } from "@fungi.computer/puffball/backend";
import {
  createOysterAppBuilds,
  migrateOysterAppBuilds,
  oysterAppBuildTimeoutMs,
  type OysterAppBuildOptions,
  type OysterBuildComputer,
  type OysterBuildLocation,
} from "../src/app-builds.js";
import {
  verifyRelease,
  type ArtifactHeads,
  type ArtifactStore,
} from "../src/release.js";

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
/** The fixture build's output, as the Computer's builder holds it. */
let built: BuildOutput;
let candidate: TeamAppCandidateManifest;
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
  built = prepared.output;
  candidate = {
    appId: prepared.appId,
    output: stageBuildOutput(built).manifest,
    provenance: prepared.provenance,
  };
}, 60_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

/** One stored object and the SHA-256 its writer had the store verify. */
type StoredObject = { bytes: Uint8Array; digest: Sha256Digest | null };

const digestOf = (bytes: Uint8Array) =>
  parseSha256Digest(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );

/** The host artifact store over memory, as R2 keeps it: `put` overwrites and
 * verifies nothing (as `r2ArtifactStore` writes a root), `head` reports the
 * size and any SHA-256 a streamed upload had the store check. */
function memoryStore(): ArtifactStore &
  ArtifactHeads & { objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  return {
    objects,
    get: (artifactRef: ArtifactRef) =>
      Promise.resolve(objects.get(artifactRef)?.bytes.slice() ?? null),
    put: (artifactRef: ArtifactRef, bytes: Uint8Array) => {
      objects.set(artifactRef, { bytes: bytes.slice(), digest: null });
      return Promise.resolve();
    },
    head: (artifactRef: ArtifactRef) => {
      const object = objects.get(artifactRef);
      return Promise.resolve(
        object === undefined
          ? null
          : { byteLength: object.bytes.byteLength, digest: object.digest },
      );
    },
  };
}

/** The same memory as an R2 bucket the egress streams into: a put whose
 * body's SHA-256 differs from the one it names is refused. */
function bucketOver(
  store: ReturnType<typeof memoryStore>,
): ContentObjectBucket {
  return {
    head: (key) => {
      const object = store.objects.get(key);
      return Promise.resolve(
        object === undefined
          ? null
          : {
              size: object.bytes.byteLength,
              checksums:
                object.digest === null
                  ? {}
                  : {
                      sha256: Uint8Array.from(
                        object.digest.slice("sha256:".length).match(/../gu) ??
                          [],
                        (pair) => Number.parseInt(pair, 16),
                      ).buffer,
                    },
            },
      );
    },
    async put(key, value, { sha256 }) {
      const bytes =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer());
      const digest = digestOf(bytes);
      if (digest !== `sha256:${sha256}`) throw new Error("Checksum mismatch");
      store.objects.set(key, { bytes, digest });
      return null;
    },
  };
}

/** What the Computer's builder uploads through the egress before its manifest. */
async function upload(
  store: ReturnType<typeof memoryStore>,
  output: BuildOutput = built,
) {
  for (const object of stageBuildOutput(output).objects)
    expect(
      await putContentObject(
        bucketOver(store),
        { digest: object.digest, byteLength: object.bytes.byteLength },
        new Response(object.bytes).body,
        "application/octet-stream",
      ),
    ).toBe("stored");
}

function fixture(
  simulate: (job: { jobId: string; command: string }) => Promise<number>,
  source: ReturnType<typeof normalizeAppPublisherRecipe> = normalized,
  templates: OysterAppBuildOptions["templates"] = {
    read: () => Promise.resolve(null),
  },
  /** The output whose objects the builder uploads before it reports. */
  uploaded: BuildOutput | null = built,
) {
  const store = memoryStore();
  let hostedBackend = true;
  const port: OysterBuildComputer = {
    buildBackend: () =>
      Promise.resolve(
        hostedBackend ? { kind: "hosted" } : { kind: "no_backend" },
      ),
    async runBuild(input) {
      if (uploaded !== null) await upload(store, uploaded);
      return { output: { exitCode: await simulate(input) } };
    },
  };
  const owner = fromNodeSqlite(new DatabaseSync(":memory:"));
  const reopen = () =>
    createOysterAppBuilds({
      owner,
      tenantId: "tenant-1",
      computer: { name: "workspace", objectId: computerObjectId, port },
      artifacts: store,
      templates,
    });
  const builds = reopen();
  builds.registerSource({
    appId: parseAppId(appId),
    location: {
      kind: "installation",
      installationId: "bonsai",
      repository: "my-fixture",
    },
    recipe: source.recipe,
    buildRecipeDigest: source.buildRecipeDigest,
  });
  return {
    builds,
    store,
    reopen,
    setHostedBackend: (available: boolean) => {
      hostedBackend = available;
    },
  };
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

it("repository registration replays with the existing fork identity, not the manifest identity", () => {
  const { builds } = fixture(() => {
    throw new Error("Registration must not run a build");
  });
  const input = {
    appId: "app_original",
    location: {
      kind: "installation",
      installationId: "bonsai",
      repository: "my-fixture",
    },
    recipe: {
      kind: "bundled-html",
      entry: "bundle/index.html",
      assets,
      assetBase: "./",
      backend: null,
      maxOutputBytes: assets.maxTotalBytes,
    },
  } satisfies {
    appId: string;
    location: OysterBuildLocation;
    recipe: AppPublisherCoreConfigInput["recipe"];
  };
  const first = builds.registerRepositorySource(input);
  const replay = builds.registerRepositorySource({
    ...input,
    appId: "app_another_attempt",
  });
  expect(first).toMatchObject({
    kind: "registered",
    source: { appId: "app_fixture", location: input.location },
  });
  expect(replay).toEqual(first);
  expect(builds.readSource("app_original")).toBeNull();
  expect(builds.readSource("app_another_attempt")).toBeNull();
});

it("repository registration refuses an App identity already bound to another repository", () => {
  const { builds } = fixture(() => {
    throw new Error("No build during registration");
  });
  const original = builds.readSource(appId);
  const result = builds.registerRepositorySource({
    appId,
    location: {
      kind: "installation",
      installationId: "bonsai",
      repository: "different",
    },
    recipe: {
      kind: "bundled-html",
      entry: "bundle/index.html",
      assets,
      assetBase: "./",
      backend: null,
      maxOutputBytes: assets.maxTotalBytes,
    },
  });
  expect(result).toEqual({ kind: "conflict" });
  expect(builds.readSource(appId)).toEqual(original);
});

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
    // Object uploads: this job's grant on this Computer, bounded by its recipe.
    expect(
      await builds.admitObjectUpload(jobId, computerObjectId, grantOf(command)),
    ).toEqual({ maxObjectBytes: assets.maxObjectBytes * 2 });
    expect(
      await builds.admitObjectUpload(jobId, computerObjectId, "forged"),
    ).toBeNull();
    expect(
      await builds.admitObjectUpload(
        jobId,
        "another-computer",
        grantOf(command),
      ),
    ).toBeNull();
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

it("records the built Release in the artifact store as an installable, verified Release", async () => {
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

/** Run one build that submits the shared manifest and settles on its artifact report. */
async function buildWith(
  prepare: (store: ReturnType<typeof memoryStore>) => void,
  uploaded: BuildOutput | null = built,
) {
  const { builds, store } = fixture(
    async ({ jobId, command }) => {
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
    },
    normalized,
    undefined,
    uploaded,
  );
  prepare(store);
  const { run } = await builds.start({
    appId,
    sourceRevision,
    requestedBy: "o",
  });
  return { done: await run(), store };
}

function firstAsset() {
  if (built.kind === "backend" || built.ui.content.kind !== "assets")
    throw new Error("The fixture builds an asset UI");
  const [asset] = built.ui.content.assets;
  if (asset === undefined) throw new Error("The fixture builds one asset");
  return {
    artifactRef: parseArtifactRef(
      `artifact:sha256-${digestOf(asset.bytes).slice("sha256:".length)}`,
    ),
    asset,
  };
}

it("shares an object a packed upload already stored, as one representation", async () => {
  const { artifactRef, asset } = firstAsset();
  const { done, store } = await buildWith((memory) => {
    memory.objects.set(artifactRef, {
      bytes: asset.bytes.slice(),
      digest: null,
    });
  });
  expect(done.status).toBe("succeeded");
  if (done.release === null) throw new Error("The build recorded no Release");
  expect((await verifyRelease(store, done.release)).ui?.kind).toBe("assets");
});

it("fails a manifest whose object was never uploaded", async () => {
  const { done, store } = await buildWith(() => undefined, null);
  expect(done.status).toBe("failed");
  expect(done.release).toBeNull();
  // Nothing was written for it: no asset manifest, no root.
  expect(store.objects.size).toBe(0);
});

it("fails a manifest whose stored object has another size or an unverified digest", async () => {
  const { artifactRef, asset } = firstAsset();
  // Bytes some other writer left at the address, never checked by the store.
  const unverified = await buildWith((memory) => {
    memory.objects.set(artifactRef, {
      bytes: new TextEncoder().encode("other"),
      digest: null,
    });
  }, null);
  expect(unverified.done.status).toBe("failed");
  expect(unverified.done.release).toBeNull();
  const resized = await buildWith((memory) => {
    memory.objects.set(artifactRef, {
      bytes: asset.bytes.slice(1),
      digest: digestOf(asset.bytes),
    });
  }, null);
  expect(resized.done.status).toBe("failed");
  expect(resized.done.release).toBeNull();
});

it("refuses an uploaded object whose bytes are not its digest, keeping a verified one", async () => {
  const store = memoryStore();
  const { asset } = firstAsset();
  const named = {
    digest: digestOf(asset.bytes),
    byteLength: asset.bytes.byteLength,
  };
  expect(
    await putContentObject(
      bucketOver(store),
      named,
      new Response(new TextEncoder().encode("forged")).body,
      "application/octet-stream",
    ),
  ).toBe("refused");
  expect(store.objects.size).toBe(0);
  expect(
    await putContentObject(
      bucketOver(store),
      named,
      new Response(asset.bytes).body,
      "application/octet-stream",
    ),
  ).toBe("stored");
  // Write-once: the verified object is kept; another body is read through
  // and discarded (cancelling it would reset the uploader's connection).
  const before = store.objects.get(contentObjectRef(named.digest));
  expect(
    await putContentObject(
      bucketOver(store),
      named,
      new Response(asset.bytes).body,
      "application/octet-stream",
    ),
  ).toBe("stored");
  expect(store.objects.get(contentObjectRef(named.digest))).toBe(before);
});

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

/** Two build owners over one durable store, as a Durable Object restart
 * leaves them: the first started the job, the second serves the reports. */
function restartedOwners(clock: { now: number }) {
  const owner = fromNodeSqlite(new DatabaseSync(":memory:"));
  const store = memoryStore();
  const commands: string[] = [];
  const create = () =>
    createOysterAppBuilds({
      owner,
      tenantId: "tenant-1",
      now: () => clock.now,
      computer: {
        name: "workspace",
        objectId: computerObjectId,
        // The Computer keeps building after the owner that called it is gone.
        port: {
          buildBackend: () => Promise.resolve({ kind: "hosted" }),
          runBuild: ({ command }) => {
            commands.push(command);
            return new Promise(() => undefined);
          },
        },
      },
      artifacts: store,
      templates: { read: () => Promise.resolve(null) },
    });
  return { create, store, commands };
}

it("completes a build from the Computer's reports after its owner restarted mid-run", async () => {
  // Live: the registry Durable Object restarted while Tourtois built; the
  // Computer kept building and its object uploads must still be admitted.
  const clock = { now: Date.now() };
  const { create, store, commands } = restartedOwners(clock);
  const before = create();
  before.registerSource({
    appId: parseAppId(appId),
    location: {
      kind: "installation",
      installationId: "bonsai",
      repository: "my-fixture",
    },
    recipe: normalized.recipe,
    buildRecipeDigest: normalized.buildRecipeDigest,
  });
  const { build, run } = await before.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
  });
  void run();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [command = ""] = commands;
  const after = create();
  expect(after.read(build.jobId)?.status).toBe("running");
  const credentialId =
    after.admitBuild(build.jobId, computerObjectId)?.credentialId ?? "";
  expect(credentialId).not.toBe("");
  expect(
    await after.admitObjectUpload(
      build.jobId,
      computerObjectId,
      grantOf(command),
    ),
  ).not.toBeNull();
  await upload(store);
  expect(
    (
      await after.submitCandidate(
        build.jobId,
        received(built, normalized),
        grantOf(command),
        credentialId,
      )
    ).status,
  ).toBe(200);
  after.record({
    kind: "build-status",
    jobId: build.jobId,
    credentialId,
    status: "succeeded",
    detail: null,
  });
  const done = after.read(build.jobId);
  expect(done?.status).toBe("succeeded");
  expect(done?.release).not.toBeNull();
});

it("keeps a build running when the Computer loses its result, and completes it from the reports", async () => {
  // Live: Prints's build kept running after the Computer's connection to its
  // container dropped; reading that unknown outcome as "exited with null"
  // failed the job and refused the build's own object uploads.
  const store = memoryStore();
  let command = "";
  const builds = createOysterAppBuilds({
    owner: fromNodeSqlite(new DatabaseSync(":memory:")),
    tenantId: "tenant-1",
    computer: {
      name: "workspace",
      objectId: computerObjectId,
      port: {
        buildBackend: () => Promise.resolve({ kind: "hosted" }),
        runBuild: (input) => {
          command = input.command;
          return Promise.resolve({ output: null });
        },
      },
    },
    artifacts: store,
    templates: { read: () => Promise.resolve(null) },
  });
  builds.registerSource({
    appId: parseAppId(appId),
    location: {
      kind: "installation",
      installationId: "bonsai",
      repository: "my-fixture",
    },
    recipe: normalized.recipe,
    buildRecipeDigest: normalized.buildRecipeDigest,
  });
  const { build, run } = await builds.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
  });
  expect((await run()).status).toBe("running");
  const credentialId =
    builds.admitBuild(build.jobId, computerObjectId)?.credentialId ?? "";
  expect(
    await builds.admitObjectUpload(
      build.jobId,
      computerObjectId,
      grantOf(command),
    ),
  ).not.toBeNull();
  await upload(store);
  expect(
    (
      await builds.submitCandidate(
        build.jobId,
        received(built, normalized),
        grantOf(command),
        credentialId,
      )
    ).status,
  ).toBe(200);
  builds.record({
    kind: "build-status",
    jobId: build.jobId,
    credentialId,
    status: "succeeded",
    detail: null,
  });
  expect(builds.read(build.jobId)?.status).toBe("succeeded");
});

it("fails a build that reaches its expiry without a result, and refuses its late reports", async () => {
  const clock = { now: Date.now() };
  const { create, commands } = restartedOwners(clock);
  const before = create();
  before.registerSource({
    appId: parseAppId(appId),
    location: {
      kind: "installation",
      installationId: "bonsai",
      repository: "my-fixture",
    },
    recipe: normalized.recipe,
    buildRecipeDigest: normalized.buildRecipeDigest,
  });
  const { build, run } = await before.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
  });
  void run();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const credentialId =
    before.admitBuild(build.jobId, computerObjectId)?.credentialId ?? "";
  const after = create();
  expect(after.read(build.jobId)?.status).toBe("running");
  // Past the build timeout and the job's grace, no result can arrive.
  clock.now += oysterAppBuildTimeoutMs + 5 * 60_000;
  expect(after.read(build.jobId)).toMatchObject({
    status: "failed",
    detail: "Build expired without a result",
    release: null,
  });
  expect(after.admitBuild(build.jobId, computerObjectId)).toBeNull();
  expect(
    (
      await after.submitCandidate(
        build.jobId,
        received(built, normalized),
        grantOf(commands[0] ?? ""),
        credentialId,
      )
    ).status,
  ).toBe(403);
  // A fresh build of the same commit can start.
  const retried = await after.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
  });
  expect(retried.build.status).toBe("running");
});

it("refuses a build for an App without a registered source or with a mismatched recipe digest", async () => {
  const { builds } = fixture(() => Promise.resolve(0));
  await expect(
    builds.start({ appId: "app_other", sourceRevision, requestedBy: "o" }),
  ).rejects.toThrow("App has no build source");
  expect(() =>
    builds.registerSource({
      appId: parseAppId(appId),
      location: {
        kind: "installation",
        installationId: "bonsai",
        repository: "my-fixture",
      },
      recipe: normalized.recipe,
      buildRecipeDigest: parseSha256Digest(`sha256:${"0".repeat(64)}`),
    }),
  ).toThrow("Build recipe digest does not match its recipe");
});

/** A Computer's manifest as the build egress receives it: serialized
 * under the transport ceiling, then decoded by the manifest schema. */
function received(
  output: BuildOutput,
  source: ReturnType<typeof normalizeAppPublisherRecipe>,
): TeamAppCandidateManifest {
  return Schema.decodeUnknownSync(teamAppCandidateManifestSchema, {
    onExcessProperty: "error",
  })(
    JSON.parse(
      encodeTeamAppCandidateManifest({
        appId: candidate.appId,
        output: stageBuildOutput(output).manifest,
        provenance: {
          ...candidate.provenance,
          buildRecipeDigest: source.buildRecipeDigest,
        },
      }),
    ),
  );
}

/** Build under `recipe`, with the Computer uploading and submitting `output`. */
async function submitUnder(
  recipe: AppPublisherCoreConfigInput["recipe"],
  output: BuildOutput,
) {
  const source = normalizeAppPublisherRecipe({ appId, recipe });
  let submitted = 0;
  const { builds, store } = fixture(
    async ({ jobId, command }) => {
      const credentialId =
        builds.admitBuild(jobId, computerObjectId)?.credentialId ?? "";
      submitted = (
        await builds.submitCandidate(
          jobId,
          received(output, source),
          grantOf(command),
          credentialId,
        )
      ).status;
      if (submitted === 200)
        builds.record({
          kind: "build-status",
          jobId,
          credentialId,
          status: "succeeded",
          detail: null,
        });
      return 0;
    },
    source,
    undefined,
    output,
  );
  const { run } = await builds.start({
    appId,
    sourceRevision,
    requestedBy: "o",
  });
  const done = await run();
  return { submitted, done, store };
}

/** An over-policy manifest writes nothing beyond its uploaded objects and
 * settles failed; the bound itself builds. */
async function expectBound(
  recipe: (limit: number) => AppPublisherCoreConfigInput["recipe"],
  output: BuildOutput,
  limit: number,
) {
  const over = await submitUnder(recipe(limit - 1), output);
  expect(over.submitted).toBe(422);
  expect(over.done.status).toBe("failed");
  expect(over.done.release).toBeNull();
  expect(over.store.objects.size).toBe(stageBuildOutput(output).objects.length);
  const at = await submitUnder(recipe(limit), output);
  expect(at.submitted).toBe(200);
  expect(at.done.status).toBe("succeeded");
  if (at.done.release === null)
    throw new Error("The build recorded no Release");
  await verifyRelease(at.store, at.done.release);
}

it("holds a submitted HTML document to its recipe's maxOutputBytes", async () => {
  const bytes = new TextEncoder().encode(
    "<!doctype html><title>Exactly this long</title>",
  );
  await expectBound(
    (maxOutputBytes) => ({
      entry: "bundle/index.html",
      backend: null,
      maxOutputBytes,
    }),
    {
      kind: "ui",
      ui: {
        mediaType: "text/html; charset=utf-8",
        content: { kind: "html", bytes },
      },
    },
    bytes.byteLength,
  );
});

it("holds a submitted backend to its recipe's maxOutputBytes", async () => {
  const backend = {
    runtime: { kind: "durable-facet", stateSchema: 1 },
    compatibilityDate: "2026-09-04",
    exportName: "Fixture",
  } as const;
  const bytes = new TextEncoder().encode(
    Schema.encodeUnknownSync(backendJsonSchema)({
      ...backend,
      code: "export class Fixture {}",
    }),
  );
  await expectBound(
    (maxOutputBytes) => ({ entry: "backend.ts", backend, maxOutputBytes }),
    { kind: "backend", backend: bytes },
    bytes.byteLength,
  );
});

it("holds submitted assets to their recipe's asset policy before writing a root", async () => {
  const output = built;
  if (output.kind === "backend" || output.ui.content.kind !== "assets")
    throw new Error("The fixture builds an asset UI");
  const largest = Math.max(
    ...output.ui.content.assets.map((asset) => asset.bytes.byteLength),
  );
  await expectBound(
    (maxObjectBytes) => ({
      kind: "bundled-html",
      entry: "bundle/index.html",
      assets: { ...assets, maxObjectBytes },
      assetBase: "./",
      backend: null,
      maxOutputBytes: assets.maxTotalBytes,
    }),
    output,
    largest,
  );
});

/** The App's published template as its build source, with one recorded seed. */
function templateFixture(
  simulate: Parameters<typeof fixture>[0],
  recorded: Readonly<{ revision: string; digest: string }> = {
    revision: sourceRevision,
    digest: normalized.buildRecipeDigest,
  },
) {
  const reads: string[] = [];
  const built = fixture(simulate, normalized, {
    read: (readAppId, revision) => {
      reads.push(revision);
      return Promise.resolve(
        readAppId === appId && revision === recorded.revision
          ? {
              appId: parseAppId(appId),
              repository: "template-fixture",
              sourceRevision: parseSourceRevision(`git:${"e".repeat(40)}`),
              sourceTreeDigest: parseSha256Digest(`sha256:${"f".repeat(64)}`),
              seedRevision: parseSourceRevision(revision),
              recipe: normalized.recipe,
              buildRecipeDigest: parseSha256Digest(recorded.digest),
            }
          : null,
      );
    },
  });
  built.builds.registerSource({
    appId: parseAppId(appId),
    location: { kind: "template" },
    recipe: normalized.recipe,
    buildRecipeDigest: normalized.buildRecipeDigest,
  });
  return { ...built, reads };
}

it("builds a template's recorded seed revision, cloning only that template while the job lives", async () => {
  const { builds, reads } = templateFixture(async ({ jobId, command }) => {
    expect(command).toContain(
      "TEAM_BUILD_REMOTE=https://git.team.internal/template-fixture.git",
    );
    expect(
      builds.admitTemplateClone(computerObjectId, "template-fixture"),
    ).toBe(true);
    expect(
      builds.admitTemplateClone("another-computer", "template-fixture"),
    ).toBe(false);
    expect(builds.admitTemplateClone(computerObjectId, "template-other")).toBe(
      false,
    );
    // A template job grants no Git door pass.
    expect(
      builds.gitPassFor(computerObjectId, {
        installationId: "bonsai",
        repository: "template-fixture",
        scope: "read",
      }),
    ).toBeNull();
    const credentialId =
      builds.admitBuild(jobId, computerObjectId)?.credentialId ?? "";
    expect(
      (
        await builds.submitCandidate(
          jobId,
          candidate,
          grantOf(command),
          credentialId,
        )
      ).status,
    ).toBe(200);
    builds.record({
      kind: "build-status",
      jobId,
      credentialId,
      status: "succeeded",
      detail: null,
    });
    return 0;
  });
  const { run } = await builds.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
  });
  const done = await run();
  expect(reads).toEqual([sourceRevision]);
  expect(done.status).toBe("succeeded");
  expect(done.release?.artifact.provenance.sourceRevision).toBe(sourceRevision);
  // The template clone ends with the job.
  expect(builds.admitTemplateClone(computerObjectId, "template-fixture")).toBe(
    false,
  );
}, 60_000);

it("refuses a template build at a revision that is not a seed of its pinned recipe", async () => {
  const unseeded = templateFixture(() => Promise.resolve(0));
  await expect(
    unseeded.builds.start({
      appId,
      sourceRevision: `git:${"d".repeat(40)}`,
      requestedBy: "o",
    }),
  ).rejects.toThrow("Revision is not a seed of this App's template");
  const otherRecipe = templateFixture(() => Promise.resolve(0), {
    revision: sourceRevision,
    digest: `sha256:${"0".repeat(64)}`,
  });
  await expect(
    otherRecipe.builds.start({ appId, sourceRevision, requestedBy: "o" }),
  ).rejects.toThrow("Revision is not a seed of this App's template");
});

it.each(["fresh", "current"] as const)(
  "initializes a %s build store without converting data or probing its schema",
  async (state) => {
    const scratch = fileURLToPath(
      new URL("../../../.botanical/", import.meta.url),
    );
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "oyster-build-schema-"));
    let database: DatabaseSync | undefined;
    try {
      const path = join(directory, "builds.sqlite");
      database = new DatabaseSync(path);
      let owner = fromNodeSqlite(database);
      const open = () =>
        createOysterAppBuilds({
          owner,
          tenantId: "tenant-1",
          now: () => 1_000,
          computer: {
            name: "workspace",
            objectId: computerObjectId,
            port: {
              buildBackend: () => Promise.resolve({ kind: "hosted" }),
              runBuild: () => {
                throw new Error("Initialization must not execute a build");
              },
            },
          },
          artifacts: memoryStore(),
          templates: { read: () => Promise.resolve(null) },
        });
      const facts = () => ({
        sources: owner.sql.exec("SELECT * FROM oyster_build_sources").toArray(),
        jobs: owner.sql.exec("SELECT * FROM oyster_build_jobs").toArray(),
        releases: owner.sql
          .exec("SELECT * FROM oyster_build_releases")
          .toArray(),
      });
      if (state === "current") {
        const builds = open();
        builds.registerSource({
          appId: parseAppId(appId),
          location: {
            kind: "installation",
            installationId: "bonsai",
            repository: "my-fixture",
          },
          recipe: normalized.recipe,
          buildRecipeDigest: normalized.buildRecipeDigest,
        });
        await builds.start({
          appId,
          sourceRevision,
          requestedBy: "owner-1",
          installAt: "my-fixture",
          requestId: "pending-build",
        });
      }
      const before = state === "current" ? facts() : null;
      database.close();
      database = new DatabaseSync(path);
      owner = fromNodeSqlite(database);
      const conversions: {
        action: number;
        table: string | null;
        column: string | null;
      }[] = [];
      database.setAuthorizer((action, table, column) => {
        if (
          action === constants.SQLITE_PRAGMA ||
          action === constants.SQLITE_ALTER_TABLE ||
          action === constants.SQLITE_DROP_TABLE ||
          (action === constants.SQLITE_UPDATE &&
            table === "oyster_build_sources")
        )
          conversions.push({ action, table, column });
        return constants.SQLITE_OK;
      });
      migrateOysterAppBuilds(owner);
      database.setAuthorizer(null);
      expect(conversions).toEqual([]);
      expect(
        owner.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .toArray(),
      ).toEqual([
        { name: "oyster_build_jobs" },
        { name: "oyster_build_releases" },
        { name: "oyster_build_sources" },
      ]);
      if (before === null) {
        expect(facts()).toEqual({ sources: [], jobs: [], releases: [] });
        expect(open().readSource(appId)).toBeNull();
      } else {
        expect(facts()).toEqual(before);
        expect(open().readSource(appId)?.location).toEqual({
          kind: "installation",
          installationId: "bonsai",
          repository: "my-fixture",
        });
        expect(
          open().latestRepositoryBuild("bonsai", "my-fixture")?.installation,
        ).toEqual({ kind: "pending", installationId: "my-fixture" });
      }
    } finally {
      if (database?.isOpen) database.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["installed", "needs_consent", "failed"] as const)(
  "retains typed %s installation outcome on the successful build across owner restart",
  async (kind) => {
    const { builds, reopen } = fixture(async ({ jobId, command }) => {
      const admission = builds.admitBuild(jobId, computerObjectId);
      if (admission === null) throw new Error("Build not admitted");
      expect(
        (
          await builds.submitCandidate(
            jobId,
            candidate,
            grantOf(command),
            admission.credentialId,
          )
        ).status,
      ).toBe(200);
      builds.record({
        kind: "build-status",
        jobId,
        credentialId: admission.credentialId,
        status: "succeeded",
        detail: null,
      });
      return 0;
    });
    const { build, run } = await builds.start({
      appId,
      sourceRevision,
      requestedBy: "owner-1",
      installAt: "my-fixture",
    });
    await run();
    const outcome =
      kind === "failed"
        ? {
            kind,
            installationId: "my-fixture",
            detail: "Automatic installation unavailable",
          }
        : { kind, installationId: "my-fixture" };
    const resumed = reopen();
    let decisions = 0;
    expect(
      await resumed.install(build.jobId, (release, installationId) => {
        decisions += 1;
        expect(release).toEqual(resumed.read(build.jobId)?.release);
        expect(installationId).toBe("my-fixture");
        if (kind === "failed") throw new Error("internal-secret");
        return Promise.resolve({ kind, installationId });
      }),
    ).toBe(true);
    expect(
      await reopen().install(build.jobId, () => {
        throw new Error("Terminal installations must not run twice");
      }),
    ).toBe(false);
    expect(decisions).toBe(1);
    expect(reopen().read(build.jobId)).toMatchObject({
      status: "succeeded",
      installation: outcome,
    });
  },
);

it("a failed automatic build never accepts an installation outcome and is not left pending install", async () => {
  const { builds, reopen } = fixture(() => Promise.resolve(2));
  const { build, run } = await builds.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
    installAt: "my-fixture",
  });
  expect(
    await builds.install(build.jobId, () => {
      throw new Error("An unsettled or failed build must never install");
    }),
  ).toBe(false);
  const done = await run();
  expect(done.status).toBe("failed");
  expect(done.installation).toMatchObject({
    kind: "failed",
    installationId: "my-fixture",
  });
  expect(
    await builds.install(build.jobId, () => {
      throw new Error("An unsettled or failed build must never install");
    }),
  ).toBe(false);
  expect(reopen().read(build.jobId)?.installation).toEqual(done.installation);
});

it("a Workflow node reuses its exact-head build across retries and restart", async () => {
  let executions = 0;
  const { builds, reopen, setHostedBackend } = fixture(() => {
    executions += 1;
    return Promise.resolve(2);
  });
  const input = {
    appId,
    sourceRevision,
    requestedBy: "owner-1",
    installAt: "my-fixture",
    requestId: "workflow-run-node-build",
  };
  const first = await builds.start(input);
  expect(first.build).toMatchObject({
    appId,
    sourceRevision,
    installation: { kind: "pending", installationId: "my-fixture" },
  });
  await first.run();
  setHostedBackend(false);
  const replay = await reopen().start(input);
  expect(replay.build.jobId).toBe(first.build.jobId);
  await replay.run();
  expect(executions).toBe(1);
});

it("refuses no_backend before minting a job or starting a command", async () => {
  const owner = fromNodeSqlite(new DatabaseSync(":memory:"));
  const builds = createOysterAppBuilds({
    owner,
    tenantId: "tenant-1",
    computer: {
      name: "local-only",
      objectId: computerObjectId,
      port: {
        buildBackend: () => Promise.resolve({ kind: "no_backend" }),
        runBuild: () => {
          throw new Error("A local machine must not run an App build");
        },
      },
    },
    artifacts: memoryStore(),
    templates: { read: () => Promise.resolve(null) },
  });
  builds.registerSource({
    appId: parseAppId(appId),
    location: {
      kind: "installation",
      installationId: "bonsai",
      repository: "my-fixture",
    },
    recipe: normalized.recipe,
    buildRecipeDigest: normalized.buildRecipeDigest,
  });
  await expect(
    builds.start({ appId, sourceRevision, requestedBy: "owner-1" }),
  ).rejects.toMatchObject({ reason: "no_backend" });
  expect(
    owner.sql.exec("SELECT job_id FROM oyster_build_jobs").toArray(),
  ).toEqual([]);
});

it("a reopened repository status finds its latest job without a remembered job id and cannot cross the source owner", async () => {
  const { builds, reopen } = fixture(() => Promise.resolve(2));
  expect(builds.latestRepositoryBuild("bonsai", "my-fixture")).toBeNull();
  await builds.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
    installAt: "my-fixture",
  });
  const latest = await builds.start({
    appId,
    sourceRevision,
    requestedBy: "owner-1",
    installAt: "my-fixture",
  });
  await latest.run();
  expect(reopen().latestRepositoryBuild("bonsai", "my-fixture")).toMatchObject({
    jobId: latest.build.jobId,
    status: "failed",
    installation: { kind: "failed", installationId: "my-fixture" },
  });
  expect(
    reopen().latestRepositoryBuild("other-installation", "my-fixture"),
  ).toBeNull();
  expect(
    reopen().latestRepositoryBuild("bonsai", "other-repository"),
  ).toBeNull();
});
