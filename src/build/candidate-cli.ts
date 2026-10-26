import * as Schema from "effect/Schema";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { readFile } from "node:fs/promises";
import { candidateFailureDiagnostic } from "./candidate-diagnostic.js";
import {
  candidateManifestObjects,
  teamAppCandidateManifestSchema,
} from "../build-contract.js";
import {
  buildTeamCandidate,
  teamCandidateConfigurationSchema,
  teamCandidateLayout,
  TeamCandidateBuildError,
} from "./candidate-builder.js";

/** Objects in flight at once; each is read from disk only while it uploads. */
const uploadConcurrency = 4;
/** Attempts per object when its connection drops before a response. */
const uploadAttempts = 3;

/** Report bounded diagnostics to the host's build output. */
function reportFailure(cause: unknown) {
  const diagnostic = candidateFailureDiagnostic(cause);
  process.stderr.write(`Team App source/build failed: ${diagnostic}\n`);
  process.stderr.write(
    `${JSON.stringify({
      source: "oyster-candidate-builder",
      failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
      diagnostic,
    })}\n`,
  );
}

const [configuration, repositoryPath, outputPath] = process.argv.slice(2);
if (!configuration || !repositoryPath || !outputPath)
  throw new Error(
    "Usage: team-candidate-builder CONFIG_BASE64 REPOSITORY OUTPUT_DIRECTORY",
  );
try {
  const { uploadGrant, ...config } = Schema.decodeUnknownSync(
    Schema.Struct({
      ...teamCandidateConfigurationSchema.fields,
      uploadGrant: Schema.String,
    }),
    { onExcessProperty: "error" },
  )(JSON.parse(Buffer.from(configuration, "base64url").toString("utf8")));
  const { phases, ...artifact } = await buildTeamCandidate({
    configuration: config,
    repositoryPath,
    outputPath,
    // Computer scratch survives captured snapshot cleanup, without a global or durable Workspace store.
    packageStoreDirectory: "/var/tmp/fungi-app-package-store",
  });
  const reportUrl = process.env.TEAM_BUILD_REPORT;
  if (!reportUrl) throw new TeamCandidateBuildError("report_failed");
  const layout = teamCandidateLayout(outputPath);
  const manifestBytes = await readFile(layout.manifest);
  const manifest = Schema.decodeUnknownSync(
    Schema.fromJsonString(teamAppCandidateManifestSchema),
  )(new TextDecoder().decode(manifestBytes));
  // Every object first, each streamed alone; the manifest only names them.
  const uploadStarted = performance.now();
  const pending = [...candidateManifestObjects(manifest.output)];
  // A write-once PUT is safe to repeat, so a dropped connection is retried.
  const put = async (object: (typeof pending)[number]) => {
    for (let attempt = 1; ; attempt += 1) {
      const stored = await fetch(
        `${reportUrl}/objects/${object.digest.replace(":", "-")}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": object.mediaType,
            "X-Team-App-Build": uploadGrant,
          },
          body: await readFile(layout.object(object.digest)),
        },
      ).catch((cause: unknown) => {
        if (attempt >= uploadAttempts) throw cause;
        return null;
      });
      await stored?.body?.cancel();
      if (stored?.ok) return;
      if (stored !== null || attempt >= uploadAttempts)
        throw new TeamCandidateBuildError("report_failed");
    }
  };
  const upload = async () => {
    for (let object = pending.shift(); object; object = pending.shift())
      await put(object);
  };
  await Promise.all(Array.from({ length: uploadConcurrency }, upload));
  const candidate = await fetch(`${reportUrl}/candidate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Team-App-Build": uploadGrant,
    },
    body: manifestBytes,
  });
  if (!candidate.ok) throw new TeamCandidateBuildError("report_failed");
  const receipt = Schema.decodeUnknownSync(
    Schema.Struct({
      kind: Schema.Literal("submitted"),
      release: releaseSchema,
    }),
  )(await candidate.json());
  const recorded = await fetch(`${reportUrl}/artifact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(artifact),
  });
  if (!recorded.ok) throw new TeamCandidateBuildError("report_failed");
  await recorded.body?.cancel();
  const uploaded = performance.now() - uploadStarted;
  // The success detail reports where the build's time went; the owner reads
  // it with the build. The clone ran before this program (TEAM_BUILD_CLONE_MS).
  const cloned = Number(process.env.TEAM_BUILD_CLONE_MS ?? "0");
  const status = await fetch(`${reportUrl}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "succeeded",
      detail: JSON.stringify({
        phasesMs: {
          clone: Math.round(
            (Number.isFinite(cloned) ? cloned : 0) + phases.capture,
          ),
          install: Math.round(phases.install),
          build: Math.round(phases.build),
          upload: Math.round(uploaded),
        },
      }),
    }),
  });
  if (!status.ok) throw new TeamCandidateBuildError("report_failed");
  await status.body?.cancel();
  process.stdout.write(
    JSON.stringify({ ...artifact, release: receipt.release }),
  );
} catch (cause) {
  reportFailure(cause);
  process.exitCode = 1;
}
