import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  appIdSchema,
  sourceRevisionSchema,
  sha256DigestSchema,
} from "@fungi.computer/puffball/effect";
import { parseReleaseId } from "@fungi.computer/puffball";
import {
  capturedPinnedRecipeSchema,
  createCapturedCandidatePreparer,
  digestPinnedRecipe,
  encodeTeamAppCandidateManifest,
  TEAM_APP_CANDIDATE_MANIFEST_MAX_BYTES,
  workspaceBuildPolicy,
} from "../build-contract.js";
import {
  createLocalCommitSourceCapture,
  createLocalBuildExecutor,
  stageBuildOutput,
} from "../build.js";

export class TeamCandidateBuildError extends Error {
  constructor(
    readonly code: "invalid_recipe" | "output_limit" | "report_failed",
  ) {
    super(`Team candidate ${code}`);
    this.name = "TeamCandidateBuildError";
  }
}

export const teamCandidateConfigurationSchema = Schema.Struct({
  /** The build policy the host expects; a builder that predates it refuses
   * the request, and this one refuses any other. */
  buildPolicy: Schema.Literal(workspaceBuildPolicy),
  appId: appIdSchema,
  sourceRevision: sourceRevisionSchema,
  recipe: capturedPinnedRecipeSchema,
  buildRecipeDigest: sha256DigestSchema,
});

/** Where a built candidate's manifest and its objects are written. */
export function teamCandidateLayout(outputPath: string) {
  return {
    manifest: join(outputPath, "manifest.json"),
    object: (digest: string) =>
      join(outputPath, "objects", digest.replace(":", "-")),
  };
}

/**
 * Runs inside the admitted Computer, using Oyster's captured builder.
 * This is the one composition that runs a dependency's declared package
 * build script; its executor refuses a recipe pinned under another policy.
 * It writes a new directory: each built object under its digest, and the
 * small manifest that names them, ready to upload one at a time.
 */
export async function buildTeamCandidate(input: {
  configuration: unknown;
  repositoryPath: string;
  /** A directory this build creates; it must not exist yet. */
  outputPath: string;
  /** Trusted Computer-local cache; never part of customer configuration. */
  packageStoreDirectory?: string;
  /** Host-owned observation of raw subprocess output; never source configuration. */
  onOutput?: (stream: "stdout" | "stderr", bytes: Uint8Array) => void;
}): Promise<
  Readonly<{
    digest: string;
    bytes: number;
    /** Milliseconds: capturing the cloned source, installing, compiling. */
    phases: Readonly<{ capture: number; install: number; build: number }>;
  }>
> {
  const config = Schema.decodeUnknownSync(teamCandidateConfigurationSchema, {
    onExcessProperty: "error",
  })(input.configuration);
  if (digestPinnedRecipe(config.recipe) !== config.buildRecipeDigest)
    throw new TeamCandidateBuildError("invalid_recipe");
  const phases = { install: 0, build: 0 };
  const onPhase = (phase: "install" | "build", milliseconds: number) => {
    phases[phase] += milliseconds;
  };
  const onOutput = (stream: "stdout" | "stderr", bytes: Uint8Array) => {
    input.onOutput?.(stream, bytes);
  };
  const prepareStarted = performance.now();
  const candidate = await Effect.runPromise(
    createCapturedCandidatePreparer(config, {
      sourceCapture: createLocalCommitSourceCapture(
        input.repositoryPath,
        config.sourceRevision,
      ),
      buildExecutor: createLocalBuildExecutor(
        input.packageStoreDirectory === undefined
          ? { packageScripts: "run", onPhase, onOutput }
          : {
              packageScripts: "run",
              packageStoreDirectory: input.packageStoreDirectory,
              onPhase,
              onOutput,
            },
      ),
    }).prepareCandidate(parseReleaseId("rel_build")),
  );
  const prepared = performance.now() - prepareStarted;
  const staged = stageBuildOutput(candidate.output);
  const bytes = Buffer.from(
    encodeTeamAppCandidateManifest({
      appId: candidate.appId,
      output: staged.manifest,
      provenance: candidate.provenance,
    }),
  );
  if (bytes.byteLength > TEAM_APP_CANDIDATE_MANIFEST_MAX_BYTES)
    throw new TeamCandidateBuildError("output_limit");
  const layout = teamCandidateLayout(input.outputPath);
  // A new directory: an earlier build's output is never mixed in.
  await mkdir(input.outputPath, { mode: 0o700 });
  await mkdir(join(input.outputPath, "objects"), { mode: 0o700 });
  for (const object of staged.objects)
    await writeFile(layout.object(object.digest), object.bytes, {
      flag: "wx",
      mode: 0o600,
    });
  await writeFile(layout.manifest, bytes, { flag: "wx", mode: 0o600 });
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.byteLength,
    phases: {
      // Snapshot capture and staging: everything but the install and compile.
      capture: Math.max(0, prepared - phases.install - phases.build),
      install: phases.install,
      build: phases.build,
    },
  };
}
