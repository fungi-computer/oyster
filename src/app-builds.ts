/**
 * Oyster's App build owner: an App's registered source, its build jobs on the
 * host's own Computer, and the Releases those builds produce.
 *
 * A build runs the shared job lifecycle (`build/build-jobs.ts`) and the fixed
 * captured builder command on one Computer. The Computer holds no key: its
 * clone is admitted at egress for exactly the job's one repository (read
 * only), and its candidate upload for exactly the job. A source is either a
 * repository in an installation's Git (a fork, through the Git door) or the
 * App's own published template, built only at a recorded seed revision of
 * its pinned recipe (no installed App is needed). The build streams each
 * built object into the host's artifact store itself, through the egress, and
 * then submits a small manifest naming them. This owner only records facts:
 * it checks each named object's stored size and digest, writes the asset
 * manifest and App root in Oyster's one immutable artifact representation
 * (the same objects a packed upload writes), verifies the Release like any
 * installed one, and records it; installing it is a separate owner act.
 */
import * as Schema from "effect/Schema";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { candidateFailureDiagnostic } from "./build/candidate-diagnostic.js";
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
  normalizeAppPublisherRecipe,
  type AppPublisherCoreConfigInput,
  digestPinnedRecipe,
  fitsPinnedRecipe,
  pinnedRecipeObjectBound,
  type PinnedRecipe,
} from "./build/effect.js";
import {
  candidateManifestObjects,
  decodeCandidateBackend,
  digestTeamAppCandidateManifest,
  type TeamAppCandidateManifest,
} from "./build/submission-contract.js";
import { contentObjectRef } from "./build/content-objects.js";
import {
  createTeamBuildPublisher,
  teamAppBuildCommand,
  type TeamBuildJob,
} from "./build/build-jobs.js";
import {
  writeArtifactRoot,
  type ImmutableArtifactObjects,
} from "./build/artifact-writer.js";
import { buildGitPassPrefix } from "./git-auth.js";
import {
  defaultAssetPolicy,
  readVerified,
  verifyRelease,
  type ArtifactHeads,
  type ArtifactStore,
} from "./release.js";
import {
  appForTemplateRepository,
  templateRepositoryForApp,
} from "./source/template-repository.js";
import type { PublisherTemplateSeedReceipts } from "./source/seed-receipt.js";
import {
  buildJobsFromOlderOyster,
  OlderOysterStoreError,
} from "./older-oyster-store.js";

/** A Computer's whole-build budget: a cold build on a 6 GiB Computer measured 185-270 s. */
export const oysterAppBuildTimeoutMs = 900_000;
/** The job, its clone admission and its upload grant end together. */
const jobTtlMs = oysterAppBuildTimeoutMs + 5 * 60_000;
/** Host names the Computer's egress serves for a build; never public hosts. */
export const oysterBuildGitHost = "git.team.internal";
export const oysterBuildReportHost = "build.team.internal";

/** Where an App's source is cloned from. */
export const oysterBuildLocationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("installation"),
    /** The installation whose Git holds the repository (Bonsai for a fork). */
    installationId: Schema.String.check(
      Schema.isPattern(/^[a-zA-Z0-9_-]{1,256}$/u),
    ),
    repository: Schema.String.check(
      Schema.isPattern(/^[a-zA-Z0-9._-]{1,128}$/u),
    ),
  }),
  /** The App's own published template (`templateRepositoryForApp`). */
  Schema.Struct({ kind: Schema.Literal("template") }),
]);
export type OysterBuildLocation = Schema.Schema.Type<
  typeof oysterBuildLocationSchema
>;

/** An App's registered build source: where it is cloned and its pinned recipe. */
export const oysterBuildSourceSchema = Schema.Struct({
  appId: appIdSchema,
  location: oysterBuildLocationSchema,
  recipe: capturedPinnedRecipeSchema,
  buildRecipeDigest: sha256DigestSchema,
});
export type OysterBuildSource = Schema.Schema.Type<
  typeof oysterBuildSourceSchema
>;

/** Installation is a build outcome, never a pending consent/approval record. */
export const oysterBuildInstallationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pending"),
    installationId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literals(["installed", "needs_consent"]),
    installationId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    installationId: Schema.String,
    detail: Schema.String,
  }),
]);
export type OysterBuildInstallation = Schema.Schema.Type<
  typeof oysterBuildInstallationSchema
>;
const installationCodec = Schema.fromJsonString(oysterBuildInstallationSchema);

/** What an owner sees of one build. */
export type OysterBuildView = Readonly<{
  jobId: string;
  appId: string;
  releaseId: string;
  sourceRevision: string;
  status: "running" | "succeeded" | "failed" | "interrupted" | "revoked";
  detail: string | null;
  release: Release | null;
  installation: OysterBuildInstallation | null;
}>;

/** Known preflight refusals, before a job or Computer run exists. */
export const oysterBuildStartReasonSchema = Schema.Literals([
  "invalid_revision",
  "no_source",
  "not_template_seed",
  "no_backend",
]);
export type OysterBuildStartReason = Schema.Schema.Type<
  typeof oysterBuildStartReasonSchema
>;
export const oysterBuildStartMessages = {
  invalid_revision:
    "Source revision must be git: followed by a full commit hash",
  no_source: "App has no build source",
  no_backend: "No hosted build backend is attached to this Computer",
  not_template_seed: "Revision is not a seed of this App's template",
} satisfies Readonly<Record<OysterBuildStartReason, string>>;

/** Local typed failure. The registry turns it into data before a DO RPC. */
export class OysterBuildStartError extends Data.TaggedError(
  "OysterBuildStartError",
)<{
  readonly reason: OysterBuildStartReason;
  readonly message: string;
}> {
  constructor(reason: OysterBuildStartReason) {
    super({ reason, message: oysterBuildStartMessages[reason] });
  }
}

export type OysterBuildStartResult =
  | Readonly<{ kind: "started"; build: OysterBuildView }>
  | Readonly<{ kind: "refused"; reason: OysterBuildStartReason }>;

/** One Computer as the build owner reaches it. */
/** The Computer established no terminal result for a build command, for
 * example because its connection to the container dropped mid-command. */
class BuildOutcomeUnknown extends Error {
  constructor() {
    super("Build outcome unknown");
  }
}

export type OysterBuildBackend =
  Readonly<{ kind: "hosted" }> | Readonly<{ kind: "no_backend" }>;

export type OysterBuildComputer = Readonly<{
  /** Read the configured hosted route without starting a machine. Local machines never build Apps. */
  buildBackend(): Promise<OysterBuildBackend>;
  /** Run the fixed build command; the Computer re-admits the job first.
   * A missing `output` means no terminal result was established: the
   * command may still be running, so it is never read as an exit. */
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
  /** The host's artifact store; a build's objects are already in it. */
  artifacts: ArtifactStore & ArtifactHeads;
  /** The seed receipts a template build must match. */
  templates: Pick<PublisherTemplateSeedReceipts, "read">;
  now?: () => number;
}>;

/** The repository a job clones: its installation repository, or its App's template. */
const cloneRepository = (job: Pick<JobRow, "app_id" | "location">) =>
  job.location.kind === "installation"
    ? job.location.repository
    : templateRepositoryForApp(job.app_id);

const jobRow = Schema.Struct({
  job_id: Schema.String,
  app_id: Schema.String,
  release_id: Schema.String,
  source_revision: Schema.String,
  /** The job's clone location, as its source named it when the job started. */
  location: Schema.fromJsonString(oysterBuildLocationSchema),
  recipe: Schema.String,
  recipe_digest: Schema.String,
  requested_by: Schema.String,
  credential_id: Schema.String,
  upload_grant_digest: Schema.String,
  request_id: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "running",
    "succeeded",
    "failed",
    "interrupted",
    "revoked",
  ]),
  artifact_digest: Schema.NullOr(Schema.String),
  artifact_bytes: Schema.NullOr(Schema.Number),
  detail: Schema.NullOr(Schema.String),
  installation: Schema.NullOr(installationCodec),
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
const locationCodec = Schema.fromJsonString(oysterBuildLocationSchema);

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

/** Create the current build tables and index atomically; an older store is refused, never converted. */
export function migrateOysterAppBuilds(owner: WatchdogSqliteOwner): void {
  const { sql } = owner;
  if (buildJobsFromOlderOyster(sql)) throw new OlderOysterStoreError();
  owner.transactionSync(() => {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS oyster_build_sources (app_id TEXT PRIMARY KEY, source TEXT NOT NULL) STRICT",
    );
    const jobColumns = `
      job_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, release_id TEXT NOT NULL UNIQUE,
      source_revision TEXT NOT NULL, location TEXT NOT NULL,
      recipe TEXT NOT NULL, recipe_digest TEXT NOT NULL, requested_by TEXT NOT NULL,
      credential_id TEXT NOT NULL, upload_grant_digest TEXT NOT NULL,
      status TEXT NOT NULL, artifact_digest TEXT, artifact_bytes INTEGER, detail TEXT,
      installation TEXT, request_id TEXT,
      issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, executable_until INTEGER NOT NULL`;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS oyster_build_jobs (${jobColumns}) STRICT`,
    );
    sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS oyster_build_request ON oyster_build_jobs(request_id)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS oyster_build_releases (release_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, release TEXT NOT NULL) STRICT",
    );
  });
}

/** The build owner over one tenant's SQLite, Computer and artifact store. */
export function createOysterAppBuilds(options: OysterAppBuildOptions) {
  const { owner } = options;
  const now = options.now ?? Date.now;
  // The host store overwrites on put, so write-once is checked here first.
  const storeObjects: ImmutableArtifactObjects = {
    async create(artifactRef, bytes) {
      if ((await options.artifacts.get(artifactRef)) !== null) return "exists";
      await options.artifacts.put(artifactRef, bytes);
      return "created";
    },
    read: (artifactRef) => options.artifacts.get(artifactRef),
  };
  migrateOysterAppBuilds(owner);
  // A job outlives the owner instance that started it: the Computer keeps
  // building and its own reports (objects, candidate, status) settle the
  // job, so an owner restart must not fail it. A job that reaches its expiry
  // without a result can never settle, so it is interrupted instead of reading
  // as running for as long as anyone asks.
  const failedInstallation = `CASE WHEN installation IS NULL THEN NULL ELSE
    json_object('kind', 'failed', 'installationId', json_extract(installation, '$.installationId'),
      'detail', COALESCE(?, 'Build did not succeed')) END`;
  const expire = () =>
    owner.sql.exec(
      `UPDATE oyster_build_jobs SET installation=${failedInstallation}, status='interrupted', detail=? WHERE status='running' AND expires_at<=?`,
      "Build expired without a result",
      "Build expired without a result",
      now(),
    );
  expire();

  const decodeRecipe = (recipe: string): PinnedRecipe =>
    Schema.decodeUnknownSync(recipeCodec)(recipe);
  const grantAdmits = async (job: JobRow, grant: string) =>
    sameDigest(
      job.upload_grant_digest,
      await sha256Hex(new TextEncoder().encode(grant)),
    );
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
    repository: cloneRepository(job),
    expiresAt: job.expires_at,
    remote:
      job.location.kind === "installation"
        ? `https://${oysterBuildGitHost}/git/${job.location.installationId}/${job.location.repository}.git`
        : `https://${oysterBuildGitHost}/${cloneRepository(job)}.git`,
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
    status: "succeeded" | "failed" | "interrupted" | "revoked",
    detail: string | null,
  ) => {
    owner.sql.exec(
      `UPDATE oyster_build_jobs SET installation=CASE WHEN ?='succeeded' THEN installation ELSE ${failedInstallation} END,
        status=?, detail=?, expires_at=MIN(expires_at, ?) WHERE job_id=? AND status='running'`,
      status,
      detail,
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
      execute: async (input) => {
        // The Computer's connection may close without a terminal execution
        // reply. A missing output is not an exit; a rejected RPC carrying an
        // Error (including an admission refusal) remains a definite failure.
        const result = await options.computer.port.runBuild({
          jobId: input.jobId,
          command: input.command,
          timeoutMs: input.timeoutMs,
        });
        if (result.output === undefined || result.output === null)
          throw new BuildOutcomeUnknown();
        return result;
      },
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
      // An unknown output can belong to a live builder. Its reports can
      // still succeed; the existing build expiry interrupts it if abandoned.
      if (!(cause instanceof BuildOutcomeUnknown))
        settle(jobId, "failed", candidateFailureDiagnostic(cause));
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
    installation: job.installation,
  });

  const registerSource = (source: OysterBuildSource): OysterBuildSource => {
    if (digestPinnedRecipe(source.recipe) !== source.buildRecipeDigest)
      throw new Error("Build recipe digest does not match its recipe");
    owner.sql.exec(
      "INSERT INTO oyster_build_sources(app_id, source) VALUES(?, ?) ON CONFLICT(app_id) DO UPDATE SET source=excluded.source",
      source.appId,
      Schema.encodeUnknownSync(sourceCodec)(source),
    );
    return source;
  };

  const readRepositorySource = (
    installationId: string,
    repository: string,
  ): OysterBuildSource | null => {
    const [row] = owner.sql
      .exec(
        "SELECT source FROM oyster_build_sources WHERE json_extract(source, '$.location.kind')='installation' AND json_extract(source, '$.location.installationId')=? AND json_extract(source, '$.location.repository')=? LIMIT 1",
        installationId,
        repository,
      )
      .toArray();
    return row === undefined
      ? null
      : Schema.decodeUnknownSync(sourceCodec)(
          Schema.decodeUnknownSync(sourceRow)(row).source,
        );
  };

  async function start(input: {
    appId: string;
    sourceRevision: string;
    requestedBy: string;
    /** The Workflow's installation target. Absence leaves manual builds manual. */
    installAt?: string;
    /** One host-owned Workflow node reuses its job, including after restart. */
    requestId?: string;
  }): Promise<
    Readonly<{ build: OysterBuildView; run: () => Promise<OysterBuildView> }>
  > {
    const revision = Schema.decodeUnknownOption(sourceRevisionSchema)(
      input.sourceRevision,
    );
    if (Option.isNone(revision))
      throw new OysterBuildStartError("invalid_revision");
    const sourceRevision = revision.value;
    const source = readSource(input.appId);
    if (source === null) throw new OysterBuildStartError("no_source");
    if (source.location.kind === "template") {
      const receipt = await options.templates.read(
        source.appId,
        sourceRevision,
      );
      if (receipt?.buildRecipeDigest !== source.buildRecipeDigest)
        throw new OysterBuildStartError("not_template_seed");
    }
    const reusedRequest = (): string | null => {
      if (input.requestId !== undefined) {
        const [row] = owner.sql
          .exec(
            "SELECT * FROM oyster_build_jobs WHERE request_id=?",
            input.requestId,
          )
          .toArray();
        if (row !== undefined) {
          const existing = decodeJob(row);
          if (
            existing.app_id !== source.appId ||
            existing.source_revision !== sourceRevision
          )
            throw new Error("Build request identity conflict");
          return existing.job_id;
        }
      }
      return null;
    };
    const existing = reusedRequest();
    if (existing !== null)
      return {
        build: view(required(existing)),
        run: () => Promise.resolve(view(required(existing))),
      };
    if ((await options.computer.port.buildBackend()).kind === "no_backend")
      throw new OysterBuildStartError("no_backend");
    const jobId = `build_${randomHex(16)}`;
    const releaseId = parseReleaseId(
      `rel_${sourceRevision.slice("git:".length, "git:".length + 12)}${randomHex(4)}`,
    );
    const uploadGrant = randomHex(32);
    const issuedAt = now();
    const uploadGrantDigest = await sha256Hex(
      new TextEncoder().encode(uploadGrant),
    );
    const reused = owner.transactionSync(() => {
      const existing = reusedRequest();
      if (existing !== null) return existing;
      owner.sql.exec(
        `INSERT INTO oyster_build_jobs(job_id, app_id, release_id, source_revision, location,
          recipe, recipe_digest, requested_by, credential_id, upload_grant_digest,
          status, artifact_digest, artifact_bytes, detail, installation, request_id, issued_at, expires_at, executable_until)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, ?, ?, ?, 0)`,
        jobId,
        source.appId,
        releaseId,
        sourceRevision,
        Schema.encodeUnknownSync(locationCodec)(source.location),
        Schema.encodeUnknownSync(recipeCodec)(source.recipe),
        source.buildRecipeDigest,
        input.requestedBy,
        randomHex(32),
        uploadGrantDigest,
        input.installAt === undefined
          ? null
          : Schema.encodeUnknownSync(installationCodec)({
              kind: "pending",
              installationId: input.installAt,
            }),
        input.requestId ?? null,
        issuedAt,
        issuedAt + jobTtlMs,
      );
      return null;
    });
    if (reused !== null)
      return {
        build: view(required(reused)),
        run: () => Promise.resolve(view(required(reused))),
      };
    // The grant leaves this owner only inside the fixed command.
    const command = teamAppBuildCommand(
      { appId: source.appId, sourceRevision, source },
      uploadGrant,
    );
    return { build: view(required(jobId)), run: () => run(jobId, command) };
  }

  let installationBusy = false;
  function recordInstallationOutcome(
    jobId: string,
    outcome: Exclude<OysterBuildInstallation, { kind: "pending" }>,
  ): boolean {
    return owner.transactionSync(() => {
      const job = readJob(jobId);
      if (
        job?.status !== "succeeded" ||
        readRelease(jobId) === null ||
        job.installation?.kind !== "pending" ||
        job.installation.installationId !== outcome.installationId
      )
        return false;
      owner.sql.exec(
        "UPDATE oyster_build_jobs SET installation=? WHERE job_id=?",
        Schema.encodeUnknownSync(installationCodec)(outcome),
        jobId,
      );
      return true;
    });
  }

  return Object.freeze({
    /** Record (or replace) an App's build source; the caller is the owner. */
    registerSource,
    /** Resolve repository identity and replace its current recipe as one transition.
     * A fork's existing identity wins over the copied manifest's App id. */
    registerRepositorySource(input: {
      appId: string;
      location: Extract<OysterBuildLocation, { kind: "installation" }>;
      recipe: AppPublisherCoreConfigInput["recipe"];
    }):
      { kind: "registered"; source: OysterBuildSource } | { kind: "conflict" } {
      return owner.transactionSync(() => {
        const existing = readRepositorySource(
          input.location.installationId,
          input.location.repository,
        );
        const appId = Schema.decodeUnknownSync(appIdSchema)(
          existing?.appId ?? input.appId,
        );
        if (existing === null && readSource(appId) !== null)
          return { kind: "conflict" };
        const pinned = normalizeAppPublisherRecipe({
          appId,
          recipe: input.recipe,
        });
        return {
          kind: "registered",
          source: registerSource({
            appId,
            location: input.location,
            recipe: pinned.recipe,
            buildRecipeDigest: pinned.buildRecipeDigest,
          }),
        };
      });
    },
    readSource,
    readRepositorySource,
    /**
     * Mint one build job for an App's registered source at one exact commit.
     * A template source builds only a seed revision recorded for its pinned
     * recipe.
     * Answers the job and its one run, which the caller keeps alive (the
     * upload grant exists only inside that run's fixed command).
     */
    start,
    read(jobId: string): OysterBuildView | null {
      expire();
      const job = readJob(jobId);
      return job === null ? null : view(job);
    },
    /** Discover the current source's latest job from the caller's Git owner,
     * never a job id remembered in a browser or another installation's repo. */
    latestRepositoryBuild(
      installationId: string,
      repository: string,
    ): OysterBuildView | null {
      expire();
      const source = readRepositorySource(installationId, repository);
      if (source === null) return null;
      const [row] = owner.sql
        .exec(
          "SELECT * FROM oyster_build_jobs WHERE app_id=? AND json_extract(location, '$.kind')='installation' AND json_extract(location, '$.installationId')=? AND json_extract(location, '$.repository')=? ORDER BY rowid DESC LIMIT 1",
          source.appId,
          installationId,
          repository,
        )
        .toArray();
      return row === undefined ? null : view(decodeJob(row));
    },
    /** One bounded host installation at a time. Only a verified successful
     * build may reach the installer; the same existing row owns its outcome.
     * A Workflow retry may resume a pending decision, never a terminal one. */
    async install(
      jobId: string,
      decide: (
        release: Release,
        installationId: string,
      ) => Promise<Exclude<OysterBuildInstallation, { kind: "pending" }>>,
    ): Promise<boolean> {
      const job = readJob(jobId);
      const release = readRelease(jobId);
      if (
        installationBusy ||
        job?.status !== "succeeded" ||
        release === null ||
        job.installation?.kind !== "pending"
      )
        return false;
      installationBusy = true;
      try {
        let outcome: Exclude<OysterBuildInstallation, { kind: "pending" }>;
        try {
          outcome = await decide(release, job.installation.installationId);
        } catch {
          outcome = {
            kind: "failed",
            installationId: job.installation.installationId,
            detail: "Automatic installation unavailable",
          };
        }
        return recordInstallationOutcome(jobId, outcome);
      } finally {
        installationBusy = false;
      }
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
          `SELECT * FROM oyster_build_jobs WHERE json_extract(location, '$.kind')='installation'
            AND json_extract(location, '$.installationId')=? AND json_extract(location, '$.repository')=?
            AND status='running' AND expires_at>? ORDER BY issued_at DESC LIMIT 1`,
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
        job.location.kind === "installation" &&
        sameDigest(job.credential_id, match[2] ?? "") &&
        job.location.installationId === target.installationId &&
        job.location.repository === target.repository
        ? { requestedBy: job.requested_by }
        : null;
    },
    /**
     * May this Computer's clone read this template repository now? Only while
     * a live template job on this Computer names it.
     */
    admitTemplateClone(computerObjectId: string, repository: string): boolean {
      if (computerObjectId !== options.computer.objectId) return false;
      // The template repository names exactly one App (templateRepositoryForApp).
      const appId = appForTemplateRepository(repository);
      if (appId === null) return false;
      return (
        owner.sql
          .exec(
            `SELECT 1 FROM oyster_build_jobs WHERE app_id=? AND json_extract(location, '$.kind')='template'
              AND status='running' AND expires_at>? LIMIT 1`,
            appId,
            now(),
          )
          .toArray().length > 0
      );
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
     * May this live job's build upload one object now, and how large? The
     * grant is the one inside the job's fixed command; the bound is its
     * recipe's (`pinnedRecipeObjectBound`).
     */
    async admitObjectUpload(
      jobId: string,
      computerObjectId: string,
      grant: string,
    ): Promise<Readonly<{ maxObjectBytes: number }> | null> {
      const job = readJob(jobId);
      if (
        computerObjectId !== options.computer.objectId ||
        !live(job) ||
        !(await grantAdmits(job, grant))
      )
        return null;
      return {
        maxObjectBytes: pinnedRecipeObjectBound(decodeRecipe(job.recipe)),
      };
    },
    /**
     * The Computer's candidate manifest for a live job: checked against the
     * job and its pinned recipe, each named object found stored with its
     * size and verified digest (one at a time; only the backend descriptor
     * is read), its asset manifest and App root written, verified as an
     * installable Release and recorded. An over-policy candidate stores
     * nothing.
     */
    async submitCandidate(
      jobId: string,
      manifest: TeamAppCandidateManifest,
      grant: string,
      credentialId: string,
    ): Promise<Response> {
      const job = readJob(jobId);
      if (
        !live(job) ||
        job.credential_id !== credentialId ||
        !(await grantAdmits(job, grant))
      )
        return new Response(null, { status: 403 });
      if (
        manifest.appId !== job.app_id ||
        manifest.provenance.sourceRevision !== job.source_revision ||
        manifest.provenance.buildRecipeDigest !== job.recipe_digest
      )
        return new Response(null, { status: 409 });
      if (readRelease(jobId) !== null)
        return new Response(null, { status: 409 });
      const recipe = decodeRecipe(job.recipe);
      let release: Release;
      try {
        if (!fitsPinnedRecipe(manifest.output, recipe))
          throw new Error("Candidate exceeds its pinned recipe");
        for (const object of candidateManifestObjects(manifest.output)) {
          const head = await options.artifacts.head(
            contentObjectRef(object.digest),
          );
          if (
            head?.byteLength !== object.byteLength ||
            head.digest !== object.digest
          )
            throw new Error("Candidate object is not stored as named");
        }
        if (manifest.output.kind !== "ui")
          decodeCandidateBackend(
            await readVerified(
              options.artifacts,
              contentObjectRef(manifest.output.backend.digest),
              manifest.output.backend.digest,
            ),
          );
        const root = await writeArtifactRoot(manifest.output, storeObjects, {
          rootArtifactRef: parseArtifactRef(
            `artifact:sha256-${await digestTeamAppCandidateManifest(manifest)}`,
          ),
          assetPolicy: recipe.assets,
        });
        release = Schema.decodeUnknownSync(releaseSchema)({
          releaseId: job.release_id,
          appId: manifest.appId,
          artifact: {
            artifactRef: root.artifactRef,
            artifactDigest: root.artifactDigest,
            provenance: manifest.provenance,
          },
        });
        // Each object was checked by its stored digest above.
        await verifyRelease(
          options.artifacts,
          release,
          defaultAssetPolicy,
          false,
        );
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
