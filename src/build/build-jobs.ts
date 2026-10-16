import * as Schema from "effect/Schema";
import { base64url } from "jose";
import type { Sha256Digest } from "@fungi.computer/puffball";
import type { PinnedRecipe } from "./effect.js";
import { workspaceBuildPolicy } from "./build-policy.js";

/** The secret-free Team job; no provider token enters publication. */
const jobSchema = Schema.Struct({
  jobId: Schema.NonEmptyString,
  computerId: Schema.NonEmptyString,
  credentialId: Schema.NonEmptyString,
  issuedAt: Schema.Number,
  repository: Schema.NonEmptyString,
  expiresAt: Schema.Number,
  remote: Schema.NonEmptyString,
  reportUrl: Schema.NonEmptyString,
  status: Schema.Literals(["running", "succeeded", "failed", "revoked"]),
  artifact: Schema.NullOr(
    Schema.Struct({ digest: Schema.NonEmptyString, bytes: Schema.Number }),
  ),
  detail: Schema.NullOr(Schema.String),
});
export type TeamBuildJob = Schema.Schema.Type<typeof jobSchema>;
export type BuildCredential = Pick<
  TeamBuildJob,
  | "jobId"
  | "computerId"
  | "credentialId"
  | "repository"
  | "issuedAt"
  | "expiresAt"
  | "remote"
  | "reportUrl"
>;
const executionSchema = Schema.Struct({
  output: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        exitCode: Schema.NullOr(Schema.Number),
        stderr: Schema.optional(Schema.String),
      }),
    ),
  ),
});

export type TeamBuildComputer = Readonly<{
  applyBuildDecision: (decision: {
    kind: "build";
    schemaVersion: 1;
    teamId: string;
    computerId: string;
    jobId: string;
    credentialId: string;
    operations: readonly ["computer.execute"];
    sequence: number;
    issuedAt: number;
    expiresAt: number;
    status: "allowed" | "revoked";
    basis: { credentialExpiresAt: number };
  }) => Promise<void>;
  execute: (input: {
    teamId: string;
    computerId: string;
    jobId: string;
    credentialId: string;
    command: string;
    timeoutMs: number;
  }) => Promise<Schema.Schema.Type<typeof executionSchema>>;
  deliverTeamGitEvents: () => Promise<number>;
}>;

/** Publisher executes builds; Team retains job authority, Computer runs them. */
export function createTeamBuildPublisher(
  options: Readonly<{
    team: Readonly<{
      mintTeamBuildCredential: (input: {
        jobId: string;
        repository: string;
        computerId: string;
        ttlMs: number;
      }) => Promise<BuildCredential>;
      revokeTeamBuild: (jobId: string) => Promise<TeamBuildJob>;
      /** One Team-owned door checks Computer ownership and settles its job. */
      build: () => Promise<
        Readonly<{
          prepare: (jobId: string) => Promise<TeamBuildJob>;
          read: (jobId: string) => Promise<TeamBuildJob | null>;
          complete: (
            jobId: string,
            status: "succeeded" | "failed",
            detail: string,
          ) => Promise<TeamBuildJob>;
          deliverProjection: () => Promise<void>;
          [Symbol.dispose]: () => void;
        }>
      >;
    }>;
    computer: (computerId: string) => TeamBuildComputer;
    now?: () => number;
    teamId: string;
    maxPermissionAgeMs?: number;
  }>,
) {
  const now = options.now ?? Date.now;
  const maxPermissionAgeMs = options.maxPermissionAgeMs ?? 5 * 60_000;
  const decodeJob = Schema.decodeUnknownSync(jobSchema);
  return Object.freeze({
    mint(input: Parameters<typeof options.team.mintTeamBuildCredential>[0]) {
      return options.team.mintTeamBuildCredential(input);
    },
    async read(jobId: string) {
      using build = await options.team.build();
      return await build.read(jobId);
    },
    revoke(jobId: string) {
      return options.team.revokeTeamBuild(jobId);
    },
    async run(input: {
      jobId: string;
      command: string;
      timeoutMs: number;
    }): Promise<TeamBuildJob> {
      using build = await options.team.build();
      const job = decodeJob(await build.prepare(input.jobId));
      const issuedAt = now();
      if (job.status !== "running" || job.expiresAt <= issuedAt)
        throw new Error("Team build expired");
      const computer = options.computer(job.computerId);
      const decision = {
        kind: "build" as const,
        schemaVersion: 1 as const,
        teamId: options.teamId,
        computerId: job.computerId,
        jobId: job.jobId,
        credentialId: job.credentialId,
        operations: ["computer.execute"] as const,
        sequence: 1,
        issuedAt,
        expiresAt: Math.min(job.expiresAt, issuedAt + maxPermissionAgeMs),
        status: "allowed" as const,
        basis: { credentialExpiresAt: job.expiresAt },
      };
      await computer.applyBuildDecision(decision);
      try {
        const result = Schema.decodeUnknownSync(executionSchema)(
          await computer.execute({
            teamId: options.teamId,
            computerId: job.computerId,
            jobId: job.jobId,
            credentialId: job.credentialId,
            command:
              "export TEAM_BUILD_REMOTE=" +
              job.remote +
              " TEAM_BUILD_REPORT=" +
              job.reportUrl +
              "\n" +
              input.command,
            timeoutMs: input.timeoutMs,
          }),
        );
        await computer.deliverTeamGitEvents();
        const current = decodeJob(await build.read(input.jobId));
        if (current.status !== "running") {
          await build.deliverProjection();
          return current;
        }
        const exitCode = result.output?.exitCode ?? null;
        const completed = decodeJob(
          await build.complete(
            job.jobId,
            exitCode === 0 && current.artifact !== null
              ? "succeeded"
              : "failed",
            exitCode === 0
              ? "Build exited without reporting status"
              : "Build exited with " +
                  String(exitCode) +
                  ": " +
                  (result.output?.stderr ?? "").slice(-1_000),
          ),
        );
        await build.deliverProjection();
        return completed;
      } finally {
        await computer.applyBuildDecision({
          ...decision,
          sequence: 2,
          status: "revoked",
          issuedAt: Math.min(now(), decision.expiresAt - 1),
        });
      }
    },
  });
}

/** Fixed captured builder command; neither source nor the customer supplies shell code. */
export function teamAppBuildCommand(
  configuration: Readonly<{
    appId: string;
    sourceRevision: string;
    source: Readonly<{
      recipe: PinnedRecipe;
      buildRecipeDigest: Sha256Digest;
    }>;
  }>,
  uploadGrant: string,
) {
  const encoded = base64url.encode(
    JSON.stringify({
      uploadGrant,
      // A builder that predates this policy refuses the whole request.
      buildPolicy: workspaceBuildPolicy,
      appId: configuration.appId,
      sourceRevision: configuration.sourceRevision,
      recipe: configuration.source.recipe,
      buildRecipeDigest: configuration.source.buildRecipeDigest,
    }),
  );
  return [
    "set -eu",
    // Build scratch (clone, snapshot, installed packages) lives on the
    // Computer's disk: an on-box VM's /tmp is RAM-backed tmpfs, which a
    // workspace install fills while the compiler needs that memory.
    "work=$(mktemp -d /var/tmp/fungi-app-build-XXXXXXXX)",
    `trap 'rm -rf "$work"' EXIT`,
    'mkdir "$work/tmp"',
    'export TMPDIR="$work/tmp"',
    "clone_started=$(date +%s%3N)",
    'git clone -q --no-checkout -- "$TEAM_BUILD_REMOTE" "$work/source" 2>/dev/null',
    // The builder reports each phase's duration with its outcome.
    "export TEAM_BUILD_CLONE_MS=$(( $(date +%s%3N) - clone_started ))",
    `node /opt/fungi/team-candidate-builder.mjs '${encoded}' "$work/source" "$work/candidate"`,
  ].join("\n");
}
