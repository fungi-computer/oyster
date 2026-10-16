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

/**
 * The largest candidate manifest request body, in bytes. A manifest names
 * objects; their bytes are uploaded one at a time, never inside it.
 */
export const TEAM_APP_CANDIDATE_MANIFEST_MAX_BYTES = 1024 * 1024;

const byteLengthSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.check(Schema.makeFilter(Number.isSafeInteger)),
);
/** One content-addressed object a build uploaded before its manifest. */
export const candidateObjectSchema = Schema.Struct({
  digest: sha256DigestSchema,
  byteLength: byteLengthSchema,
});
/** One uploaded object, as a manifest names it. */
export type CandidateObject = Schema.Schema.Type<typeof candidateObjectSchema>;

const uiManifestSchema = Schema.Union([
  Schema.Struct({
    mediaType: Schema.Literal("text/html; charset=utf-8"),
    content: Schema.Struct({
      kind: Schema.Literal("html"),
      ...candidateObjectSchema.fields,
    }),
  }),
  Schema.Struct({
    mediaType: Schema.Literal("application/vnd.fungi.app-assets+json"),
    content: Schema.Struct({
      kind: Schema.Literal("assets"),
      base: assetBaseSchema,
      assets: Schema.Array(
        Schema.Struct({
          path: assetPathSchema,
          ...candidateObjectSchema.fields,
        }),
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
/** A build's output by reference: the same surfaces as its bytes, sized. */
export const candidateOutputManifestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ui"),
    ui: uiManifestSchema,
    ...declaration,
  }),
  Schema.Struct({
    kind: Schema.Literal("backend"),
    backend: candidateObjectSchema,
    ...declaration,
  }),
  Schema.Struct({
    kind: Schema.Literal("app"),
    ui: uiManifestSchema,
    backend: candidateObjectSchema,
    ...declaration,
  }),
]);
/** One build output by reference. */
export type CandidateOutputManifest = Schema.Schema.Type<
  typeof candidateOutputManifestSchema
>;

const provenanceSchema = Schema.Struct({
  sourceRevision: sourceRevisionSchema,
  sourceTreeDigest: sha256DigestSchema,
  buildRecipeDigest: sha256DigestSchema,
});
const manifestFields = {
  appId: appIdSchema,
  output: candidateOutputManifestSchema,
  provenance: provenanceSchema,
};

/**
 * A submitted Team App candidate: its output's objects by digest and size,
 * and its provenance, before the Team assigns a stable Release ID.
 */
export const teamAppCandidateManifestSchema = Schema.Struct(manifestFields);
/** One submitted Team App candidate manifest. */
export type TeamAppCandidateManifest = Schema.Schema.Type<
  typeof teamAppCandidateManifestSchema
>;

/** Publisher persistence input after TeamDO reserves retry-stable identities. */
export const preparedCandidateManifestSchema = Schema.Struct({
  ...manifestFields,
  releaseId: releaseIdSchema,
});
/** One Team App candidate manifest with its reserved Release ID. */
export type PreparedTeamAppCandidateManifest = Schema.Schema.Type<
  typeof preparedCandidateManifestSchema
>;

/** One operator-published byte string; its request has a separate total bound. */
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
const uiBytesSchema = Schema.Union([
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

/**
 * A platform App candidate the trusted operator built and packed itself,
 * with its bytes inline: the operator's platform publication request only.
 * A Team candidate never carries bytes; it is a manifest.
 */
export const preparedCandidateSchema = Schema.Struct({
  appId: appIdSchema,
  releaseId: releaseIdSchema,
  output: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("ui"),
      ui: uiBytesSchema,
      ...declaration,
    }),
    Schema.Struct({
      kind: Schema.Literal("backend"),
      backend: backendBytesSchema,
      ...declaration,
    }),
    Schema.Struct({
      kind: Schema.Literal("app"),
      ui: uiBytesSchema,
      backend: backendBytesSchema,
      ...declaration,
    }),
  ]),
  provenance: provenanceSchema,
});

/** Canonical manifest bytes, so a digest is independent of JSON spacing. */
export function encodeTeamAppCandidateManifest(
  manifest: TeamAppCandidateManifest,
): string {
  return JSON.stringify(
    Schema.encodeUnknownSync(teamAppCandidateManifestSchema)(manifest),
  );
}

/** The hex SHA-256 of a manifest's canonical bytes: its App root's name. */
export async function digestTeamAppCandidateManifest(
  manifest: TeamAppCandidateManifest,
): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(encodeTeamAppCandidateManifest(manifest)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The media type an uploaded object is stored with. A store that reads an
 * HTML document or backend descriptor by its stored type (the Publisher's)
 * needs it; an asset's type is its manifest's, so it is an octet stream.
 */
export const candidateObjectMediaTypes = [
  "text/html; charset=utf-8",
  "application/vnd.fungi.app-backend+json",
  "application/octet-stream",
] as const;
/** One of {@link candidateObjectMediaTypes}. */
export type CandidateObjectMediaType =
  (typeof candidateObjectMediaTypes)[number];

/** The stored media type a request names, if it is one an object may carry. */
export function candidateObjectMediaType(
  value: string | null,
): CandidateObjectMediaType | null {
  return candidateObjectMediaTypes.find((type) => type === value) ?? null;
}

/** One object a build uploads, with the media type it is stored under. */
export type CandidateUpload = CandidateObject &
  Readonly<{ mediaType: CandidateObjectMediaType }>;

/** Every distinct object a manifest names, each once, in manifest order. */
export function candidateManifestObjects(
  output: CandidateOutputManifest,
): readonly CandidateUpload[] {
  const objects: CandidateUpload[] = [];
  const add = (
    object: CandidateObject,
    mediaType: CandidateObjectMediaType,
  ) => {
    const seen = objects.find(({ digest }) => digest === object.digest);
    if (seen === undefined)
      objects.push({
        digest: object.digest,
        byteLength: object.byteLength,
        mediaType,
      });
    else if (seen.byteLength !== object.byteLength)
      throw new Error("One object digest names two sizes");
  };
  if (output.kind !== "backend") {
    const { content } = output.ui;
    if (content.kind === "html") add(content, "text/html; charset=utf-8");
    else
      for (const asset of content.assets)
        add(asset, "application/octet-stream");
  }
  if (output.kind !== "ui")
    add(output.backend, "application/vnd.fungi.app-backend+json");
  return objects;
}

/** Decode a stored backend descriptor; a manifest's backend must be one. */
export function decodeCandidateBackend(bytes: Uint8Array) {
  return Schema.decodeUnknownSync(backendJsonSchema)(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    { onExcessProperty: "error" },
  );
}
