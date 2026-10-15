/**
 * Oyster's App build owner: an App's registered source, its build jobs on the
 * host's own Computer, and the Releases those builds produce.
 *
 * A build runs the shared job lifecycle (`build/build-jobs.ts`) and the fixed
 * captured builder command on one Computer. The Computer holds no key: its
 * clone is admitted at egress for exactly the job's one repository (read
 * only), and its candidate upload for exactly the job. The candidate is
 * written to the Release bucket by the shared R2 writer, verified like any
 * installed Release, and recorded here; installing it is a separate owner act.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  parseArtifactRef,
  parseReleaseId,
  type Release,
} from "@fungi.computer/puffball";
import {
  appIdSchema,
  releaseSchema,
  sha256DigestSchema,
  sourceRevisionSchema,
} from "@fungi.computer/puffball/effect";
import {
  capturedPinnedRecipeSchema,
  commitPreparedCandidate,
  digestPinnedRecipe,
  type PinnedRecipe,
} from "./build/effect.js";
import {
  encodeTeamAppCandidateSubmission,
  type TeamAppCandidateSubmission,
} from "./build/submission-contract.js";
import {
  createTeamBuildPublisher,
  teamAppBuildCommand,
  type TeamBuildJob,
} from "./build/build-jobs.js";
import {
  createR2ArtifactWriter,
  type PublisherR2Bucket,
} from "./build/r2-artifact-writer.js";
import { buildGitPassPrefix } from "./git-auth.js";
import { verifyRelease, type ArtifactStore } from "./release.js";

/** A Computer's whole-build budget: a cold standard-2 build measured 185-270 s. */
export const oysterAppBuildTimeoutMs = 900_000;
/** The job, its clone admission and its upload grant end together. */
const jobTtlMs = oysterAppBuildTimeoutMs + 5 * 60_000;
/** Host names the Computer's egress serves for a build; never public hosts. */
export const oysterBuildGitHost = "git.team.internal";
export const oysterBuildReportHost = "build.team.internal";

/** An App's registered build source: one repository and its pinned recipe. */
export const oysterBuildSourceSchema = Schema.Struct({
  appId: appIdSchema,
  /** The installation whose Git holds the repository (Bonsai for a fork). */
  installationId: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9_-]{1,256}$/u),
  ),
  repository: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,128}$/u)),
  recipe: capturedPinnedRecipeSchema,
  buildRecipeDigest: sha256DigestSchema,
});
export type OysterBuildSource = Schema.Schema.Type<
  typeof oysterBuildSourceSchema
>;

/** What an owner sees of one build. */
export type OysterBuildView = Readonly<{
  jobId: string;
  appId: string;
  releaseId: string;
  sourceRevision: string;
  status: "running" | "succeeded" | "failed" | "revoked";
  detail: string | null;
  release: Release | null;
}>;

/** One Computer as the build owner reaches it. */
export type OysterBuildComputer = Readonly<{
  /** Run the fixed build command; the Computer re-admits the job first. */
  runBuild(input: {
    jobId: string;
    command: string;
    timeoutMs: number;
  }): Promise<
    Readonly<{
      output?: Readonly<{ exitCode: number | null; stderr?: string }> | null;
    }>
  >;
}>;

export type OysterAppBuildOptions = Readonly<{
  owner: WatchdogSqliteOwner;
  /** The tenant the jobs belong to (the job lifecycle's team). */
  tenantId: string;
  /** The fixed Computer this host builds on, and its Durable Object id. */
  computer: Readonly<{
    name: string;
    objectId: string;
    port: OysterBuildComputer;
  }>;
  bucket: PublisherR2Bucket;
  artifacts: ArtifactStore;
  now?: () => number;
}>;

const jobRow = Schema.Struct({
  job_id: Schema.String,
  app_id: Schema.String,
  release_id: Schema.String,
  source_revision: Schema.String,
  installation_id: Schema.String,
  repository: Schema.String,
  recipe: Schema.String,
  recipe_digest: Schema.String,
  requested_by: Schema.String,
  credential_id: Schema.String,
  upload_grant_digest: Schema.String,
  status: Schema.Literals(["running", "succeeded", "failed", "revoked"]),
  artifact_digest: Schema.NullOr(Schema.String),
  artifact_bytes: Schema.NullOr(Schema.Number),
  detail: Schema.NullOr(Schema.String),
  issued_at: Schema.Number,
  expires_at: Schema.Number,
  executable_until: Schema.Number,
});
type JobRow = Schema.Schema.Type<typeof jobRow>;
const decodeJob = Schema.decodeUnknownSync(jobRow);
const sourceRow = Schema.Struct({ source: Schema.String });
const releaseRow = Schema.Struct({ release: Schema.String });
const sourceCodec = Schema.fromJsonString(oysterBuildSourceSchema);
const releaseCodec = Schema.fromJsonString(releaseSchema);
const recipeCodec = Schema.fromJsonString(capturedPinnedRecipeSchema);

/** Unguessable hex identity from the platform CSPRNG. */
function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Constant-time comparison of two equal-length hex digests. */
function sameDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** The SQLite tables one Oyster build owner keeps. */
export function migrateOysterAppBuilds(
  owner: WatchdogSqliteOwner["sql"],
): void {
  owner.exec(
    "CREATE TABLE IF NOT EXISTS oyster_build_sources (app_id TEXT PRIMARY KEY, source TEXT NOT NULL) STRICT",
  );
  owner.exec(
    `CREATE TABLE IF NOT EXISTS oyster_build_jobs (
      job_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, release_id TEXT NOT NULL UNIQUE,
      source_revision TEXT NOT NULL, installation_id TEXT NOT NULL, repository TEXT NOT NULL,
      recipe TEXT NOT NULL, recipe_digest TEXT NOT NULL, requested_by TEXT NOT NULL,
      credential_id TEXT NOT NULL, upload_grant_digest TEXT NOT NULL,
      status TEXT NOT NULL, artifact_digest TEXT, artifact_bytes INTEGER, detail TEXT,
      issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, executable_until INTEGER NOT NULL
    ) STRICT`,
  );
  owner.exec(
    "CREATE TABLE IF NOT EXISTS oyster_build_releases (release_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, release TEXT NOT NULL) STRICT",
  );
}

/** The build owner over one tenant's SQLite, Computer and Release bucket. */
export function createOysterAppBuilds(options: OysterAppBuildOptions) {
  const { owner } = options;
  const now = options.now ?? Date.now;
  migrateOysterAppBuilds(owner.sql);

  const readJob = (jobId: string): JobRow | null => {
    const [row] = owner.sql
      .exec("SELECT * FROM oyster_build_jobs WHERE job_id=?", jobId)
      .toArray();
    return row === undefined ? null : decodeJob(row);
  };
  const live = (job: JobRow | null): job is JobRow =>
    job !== null && job.status === "running" && job.expires_at > now();
  const readRelease = (jobId: string): Release | null => {
    const [row] = owner.sql
      .exec("SELECT release FROM oyster_build_releases WHERE job_id=?", jobId)
      .toArray();
    return row === undefined
      ? null
      : Schema.decodeUnknownSync(releaseCodec)(
          Schema.decodeUnknownSync(releaseRow)(row).release,
        );
  };
  const lifecycleJob = (job: JobRow): TeamBuildJob => ({
    jobId: job.job_id,
    computerId: options.computer.name,
    credentialId: job.credential_id,
    issuedAt: job.issued_at,
    repository: job.repository,
    expiresAt: job.expires_at,
    remote: `https://${oysterBuildGitHost}/git/${job.installation_id}/${job.repository}.git`,
    reportUrl: `https://${oysterBuildReportHost}/jobs/${job.job_id}`,
    status: job.status,
    artifact:
      job.artifact_digest === null || job.artifact_bytes === null
        ? null
        : { digest: job.artifact_digest, bytes: job.artifact_bytes },
    detail: job.detail,
  });
  const settle = (
    jobId: string,
    status: "succeeded" | "failed" | "revoked",
    detail: string | null,
  ) => {
    owner.sql.exec(
      "UPDATE oyster_build_jobs SET status=?, detail=?, expires_at=MIN(expires_at, ?) WHERE job_id=? AND status='running'",
      status,
      detail,
      now(),
      jobId,
    );
  };
  const required = (jobId: string): JobRow => {
    const job = readJob(jobId);
    if (job === null) throw new Error("Unknown build job");
    return job;
  };

  const publisher = createTeamBuildPublisher({
    teamId: options.tenantId,
    now,
    maxPermissionAgeMs: jobTtlMs,
    team: {
      // The job row is minted in `start`; the lifecycle only reads it back.
      mintTeamBuildCredential: ({ jobId }) =>
        Promise.resolve(lifecycleJob(required(jobId))),
      revokeTeamBuild: (jobId) => {
        settle(jobId, "revoked", "Build revoked");
        return Promise.resolve(lifecycleJob(required(jobId)));
      },
      build: () =>
        Promise.resolve({
          prepare: (jobId: string) =>
            Promise.resolve(lifecycleJob(required(jobId))),
          read: (jobId: string) => {
            const job = readJob(jobId);
            return Promise.resolve(job === null ? null : lifecycleJob(job));
          },
          complete: (
            jobId: string,
            status: "succeeded" | "failed",
            detail: string,
          ) => {
            settle(jobId, status, detail);
            return Promise.resolve(lifecycleJob(required(jobId)));
          },
          // Oyster's egress writes job facts here directly; nothing is queued.
          deliverProjection: () => Promise.resolve(),
          [Symbol.dispose]: () => undefined,
        }),
    },
    computer: () => ({
      applyBuildDecision: (decision) => {
        owner.sql.exec(
          "UPDATE oyster_build_jobs SET executable_until=? WHERE job_id=?",
          decision.status === "allowed" ? decision.expiresAt : 0,
          decision.jobId,
        );
        return Promise.resolve();
      },
      execute: (input) =>
        options.computer.port.runBuild({
          jobId: input.jobId,
          command: input.command,
          timeoutMs: input.timeoutMs,
        }),
      deliverTeamGitEvents: () => Promise.resolve(0),
    }),
  });

  const readSource = (appId: string): OysterBuildSource | null => {
    const [row] = owner.sql
      .exec("SELECT source FROM oyster_build_sources WHERE app_id=?", appId)
      .toArray();
    return row === undefined
      ? null
      : Schema.decodeUnknownSync(sourceCodec)(
          Schema.decodeUnknownSync(sourceRow)(row).source,
        );
  };
  const run = async (jobId: string, command: string) => {
    try {
      await publisher.run({
        jobId,
        command,
        timeoutMs: oysterAppBuildTimeoutMs,
      });
    } catch (cause) {
      settle(
        jobId,
        "failed",
        cause instanceof Error ? cause.message : "Build failed",
      );
    }
    return view(required(jobId));
  };
  const view = (job: JobRow): OysterBuildView => ({
    jobId: job.job_id,
    appId: job.app_id,
    releaseId: job.release_id,
    sourceRevision: job.source_revision,
    status: job.status,
    detail: job.detail,
    release: readRelease(job.job_id),
  });

  return Object.freeze({
    /** Record (or replace) an App's build source; the caller is the owner. */
    registerSource(source: OysterBuildSource): OysterBuildSource {
      if (digestPinnedRecipe(source.recipe) !== source.buildRecipeDigest)
        throw new Error("Build recipe digest does not match its recipe");
      owner.sql.exec(
        "INSERT INTO oyster_build_sources(app_id, source) VALUES(?, ?) ON CONFLICT(app_id) DO UPDATE SET source=excluded.source",
        source.appId,
        Schema.encodeUnknownSync(sourceCodec)(source),
      );
      return source;
    },
    readSource,
    /**
     * Mint one build job for an App's registered source at one exact commit.
     * Answers the job and its one run, which the caller keeps alive (the
     * upload grant exists only inside that run's fixed command).
     */
    async start(input: {
      appId: string;
      sourceRevision: string;
      requestedBy: string;
    }): Promise<
      Readonly<{ build: OysterBuildView; run: () => Promise<OysterBuildView> }>
    > {
      const sourceRevision = Schema.decodeUnknownSync(sourceRevisionSchema)(
        input.sourceRevision,
      );
      const source = readSource(input.appId);
      if (source === null) throw new Error("App has no build source");
      const jobId = `build_${randomHex(16)}`;
      const releaseId = parseReleaseId(
        `rel_${sourceRevision.slice("git:".length, "git:".length + 12)}${randomHex(4)}`,
      );
      const uploadGrant = randomHex(32);
      const issuedAt = now();
      owner.sql.exec(
        `INSERT INTO oyster_build_jobs(job_id, app_id, release_id, source_revision, installation_id,
          repository, recipe, recipe_digest, requested_by, credential_id, upload_grant_digest,
          status, artifact_digest, artifact_bytes, detail, issued_at, expires_at, executable_until)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, ?, 0)`,
        jobId,
        source.appId,
        releaseId,
        sourceRevision,
        source.installationId,
        source.repository,
        Schema.encodeUnknownSync(recipeCodec)(source.recipe),
        source.buildRecipeDigest,
        input.requestedBy,
        randomHex(32),
        await sha256Hex(new TextEncoder().encode(uploadGrant)),
        issuedAt,
        issuedAt + jobTtlMs,
      );
      // The grant leaves this owner only inside the fixed command.
      const command = teamAppBuildCommand(
        { appId: source.appId, sourceRevision, source },
        uploadGrant,
      );
      return { build: view(required(jobId)), run: () => run(jobId, command) };
    },
    read(jobId: string): OysterBuildView | null {
      const job = readJob(jobId);
      return job === null ? null : view(job);
    },
    /** A built Release by id, for an owner to install or select. */
    release(releaseId: string): Release | null {
      const [row] = owner.sql
        .exec(
          "SELECT release FROM oyster_build_releases WHERE release_id=?",
          releaseId,
        )
        .toArray();
      return row === undefined
        ? null
        : Schema.decodeUnknownSync(releaseCodec)(
            Schema.decodeUnknownSync(releaseRow)(row).release,
          );
    },
    /** May this Computer execute this job now? Re-checked by the Computer. */
    admitExecution(jobId: string, computerObjectId: string): boolean {
      const job = readJob(jobId);
      return (
        computerObjectId === options.computer.objectId &&
        live(job) &&
        job.executable_until > now()
      );
    },
    /** The live job a build report from this Computer may speak for. */
    admitBuild(
      jobId: string,
      computerObjectId: string,
    ): Readonly<{ credentialId: string }> | null {
      const job = readJob(jobId);
      return computerObjectId === options.computer.objectId && live(job)
        ? { credentialId: job.credential_id }
        : null;
    },
    /**
     * The clone credential the egress presents for this Computer's live job
     * on exactly this repository, read only; null when no job admits it.
     */
    gitPassFor(
      computerObjectId: string,
      target: Readonly<{
        installationId: string;
        repository: string;
        scope: "read" | "write";
      }>,
    ): string | null {
      if (
        computerObjectId !== options.computer.objectId ||
        target.scope !== "read"
      )
        return null;
      const job = owner.sql
        .exec(
          "SELECT * FROM oyster_build_jobs WHERE installation_id=? AND repository=? AND status='running' AND expires_at>? ORDER BY issued_at DESC LIMIT 1",
          target.installationId,
          target.repository,
          now(),
        )
        .toArray()
        .map((row) => decodeJob(row))[0];
      return job === undefined
        ? null
        : `${buildGitPassPrefix}${job.job_id}.${job.credential_id}`;
    },
    /** Admit a presented clone credential at the Git door: one repository, read. */
    admitGitPass(
      pass: string,
      target: Readonly<{
        installationId: string;
        repository: string;
        scope: "read" | "write";
      }>,
    ): Readonly<{ requestedBy: string }> | null {
      const match = /^obp\.(build_[0-9a-f]{32})\.([0-9a-f]{64})$/u.exec(pass);
      if (match === null || target.scope !== "read") return null;
      const job = readJob(match[1] ?? "");
      return live(job) &&
        sameDigest(job.credential_id, match[2] ?? "") &&
        job.installation_id === target.installationId &&
        job.repository === target.repository
        ? { requestedBy: job.requested_by }
        : null;
    },
    /** A reported artifact or status for a live job. */
    record(
      event:
        | Readonly<{
            kind: "build-artifact";
            jobId: string;
            credentialId: string;
            digest: string;
            bytes: number;
          }>
        | Readonly<{
            kind: "build-status";
            jobId: string;
            credentialId: string;
            status: "succeeded" | "failed";
            detail: string | null;
          }>,
    ): void {
      const job = readJob(event.jobId);
      if (!live(job) || job.credential_id !== event.credentialId) return;
      if (event.kind === "build-artifact")
        owner.sql.exec(
          "UPDATE oyster_build_jobs SET artifact_digest=?, artifact_bytes=? WHERE job_id=?",
          event.digest,
          event.bytes,
          event.jobId,
        );
      // Success is the recorded Release's fact, never the report's alone.
      else if (event.status === "failed" || readRelease(event.jobId) !== null)
        settle(event.jobId, event.status, event.detail);
    },
    /**
     * The Computer's candidate for a live job: checked against the job, written
     * by the shared R2 writer, verified as an installable Release and recorded.
     */
    async submitCandidate(
      jobId: string,
      candidate: TeamAppCandidateSubmission,
      grant: string,
      credentialId: string,
    ): Promise<Response> {
      const job = readJob(jobId);
      if (
        !live(job) ||
        job.credential_id !== credentialId ||
        !sameDigest(
          job.upload_grant_digest,
          await sha256Hex(new TextEncoder().encode(grant)),
        )
      )
        return new Response(null, { status: 403 });
      if (
        candidate.appId !== job.app_id ||
        candidate.provenance.sourceRevision !== job.source_revision ||
        candidate.provenance.buildRecipeDigest !== job.recipe_digest
      )
        return new Response(null, { status: 409 });
      if (readRelease(jobId) !== null)
        return new Response(null, { status: 409 });
      const recipe: PinnedRecipe = Schema.decodeUnknownSync(recipeCodec)(
        job.recipe,
      );
      const digest = await sha256Hex(
        new TextEncoder().encode(encodeTeamAppCandidateSubmission(candidate)),
      );
      const writerOptions: Parameters<typeof createR2ArtifactWriter>[0] = {
        bucket: options.bucket,
        artifactRef: parseArtifactRef(`artifact:sha256-${digest}`),
        policy: {
          maxBytes: recipe.maxOutputBytes,
          maxManifestBytes: recipe.assets?.maxManifestBytes ?? 1024 * 1024,
        },
      };
      if (recipe.assets !== undefined) writerOptions.assets = recipe.assets;
      let release: Release;
      try {
        release = await Effect.runPromise(
          commitPreparedCandidate(
            { ...candidate, releaseId: parseReleaseId(job.release_id) },
            {
              artifactWriter: createR2ArtifactWriter(writerOptions),
              releaseCatalog: {
                createRelease: (value) => Promise.resolve(value),
              },
            },
          ),
        );
        await verifyRelease(options.artifacts, release);
      } catch {
        settle(jobId, "failed", "Candidate could not be stored as a Release");
        return new Response(null, { status: 422 });
      }
      owner.transactionSync(() => {
        owner.sql.exec(
          "INSERT INTO oyster_build_releases(release_id, job_id, release) VALUES(?, ?, ?)",
          release.releaseId,
          jobId,
          Schema.encodeUnknownSync(releaseCodec)(release),
        );
      });
      return Response.json({
        kind: "submitted",
        release: Schema.encodeUnknownSync(releaseSchema)(release),
      });
    },
  });
}

export type OysterAppBuilds = ReturnType<typeof createOysterAppBuilds>;
