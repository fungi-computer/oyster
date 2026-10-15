import {
  assetBaseSchema,
  assetPathSchema,
} from "@fungi.computer/puffball/assets";
import {
  appIdSchema,
  releaseIdSchema,
  sha256DigestSchema,
  sourceRevisionSchema,
} from "@fungi.computer/puffball/effect";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";
import { backendJsonSchema } from "@fungi.computer/puffball/backend";
import * as Schema from "effect/Schema";
import { isSigilName } from "@fungi.computer/sigils";

/** The largest Team App candidate submission request body, in bytes. */
export const TEAM_APP_SUBMISSION_MAX_REQUEST_BYTES = 24 * 1024 * 1024;

/** One uploaded byte string; the enclosing HTTP request has a separate total bound. */
const bytesSchema = Schema.Uint8ArrayFromBase64.pipe(
  Schema.check(
    Schema.makeFilter((bytes) => bytes.byteLength <= 16 * 1024 * 1024),
  ),
);
const backendBytesSchema = bytesSchema.pipe(
  Schema.check(
    Schema.makeFilter(
      (bytes) =>
        Schema.decodeUnknownResult(backendJsonSchema)(
          new TextDecoder().decode(bytes),
          { onExcessProperty: "error" },
        )._tag === "Success",
    ),
  ),
);
const uiOutputSchema = Schema.Union([
  Schema.Struct({
    mediaType: Schema.Literal("text/html; charset=utf-8"),
    content: Schema.Struct({
      kind: Schema.Literal("html"),
      bytes: bytesSchema,
    }),
  }),
  Schema.Struct({
    mediaType: Schema.Literal("application/vnd.fungi.app-assets+json"),
    content: Schema.Struct({
      kind: Schema.Literal("assets"),
      base: assetBaseSchema,
      assets: Schema.Array(
        Schema.Struct({ path: assetPathSchema, bytes: bytesSchema }),
      ),
    }),
  }),
]);
/** A request only; the Team's installation grants remain the authority. */
const declaration = {
  declaration: Schema.optionalKey(
    appDeclarationSchema.check(
      Schema.makeFilter(
        (declaration) =>
          declaration.icon === undefined || isSigilName(declaration.icon),
        { message: "App icon must name a registered Sigil" },
      ),
    ),
  ),
};
const outputSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ui"),
    ui: uiOutputSchema,
    ...declaration,
  }),
  Schema.Struct({
    kind: Schema.Literal("backend"),
    backend: backendBytesSchema,
    ...declaration,
  }),
  Schema.Struct({
    kind: Schema.Literal("app"),
    ui: uiOutputSchema,
    backend: backendBytesSchema,
    ...declaration,
  }),
]);
const candidateFields = {
  appId: appIdSchema,
  output: outputSchema,
  provenance: Schema.Struct({
    sourceRevision: sourceRevisionSchema,
    sourceTreeDigest: sha256DigestSchema,
    buildRecipeDigest: sha256DigestSchema,
  }),
};

/** Exact submitted output and provenance before the Team assigns a stable Release ID. */
export const teamAppCandidateSubmissionSchema = Schema.Struct(candidateFields);

/** Publisher persistence input after TeamDO reserves retry-stable identities. */
export const preparedCandidateSchema = Schema.Struct({
  ...candidateFields,
  releaseId: releaseIdSchema,
});

/** One submitted Team App candidate. */
export type TeamAppCandidateSubmission = Schema.Schema.Type<
  typeof teamAppCandidateSubmissionSchema
>;
/** One Team App candidate with its reserved Release ID. */
export type PreparedTeamAppCandidate = Schema.Schema.Type<
  typeof preparedCandidateSchema
>;

/** Canonical wire bytes make TeamDO's same-request digest independent of JSON spacing. */
export function encodeTeamAppCandidateSubmission(
  input: TeamAppCandidateSubmission,
): string {
  return JSON.stringify(
    Schema.encodeUnknownSync(teamAppCandidateSubmissionSchema)(input),
  );
}
