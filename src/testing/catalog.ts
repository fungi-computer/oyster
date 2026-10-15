import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  createAppReleaseCore,
  createDeterministicMemoryAppReleaseStore,
  adaptPromiseAppReleaseStore,
  releaseSchema,
  adaptPromiseArtifactReader,
} from "@fungi.computer/puffball/effect";
import { parseSha256Digest } from "@fungi.computer/puffball";
import { appMediaType } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
// The Publisher's artifact store: every Release root and child object by ref.
const fixtureSchema = Schema.Struct({
  releases: Schema.Array(releaseSchema),
  objects: Schema.Record(
    Schema.String,
    Schema.Struct({
      mediaType: Schema.Literals([
        appMediaType,
        backendMediaType,
        "text/html; charset=utf-8",
      ]),
      body: Schema.String,
    }),
  ),
});
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** Digest-verifying local catalog shared by native App host proofs. */
export function createFixtureCatalog(encoded: string) {
  const fixture = Schema.decodeUnknownSync(
    Schema.fromJsonString(fixtureSchema),
  )(encoded);
  return createAppReleaseCore({
    store: adaptPromiseAppReleaseStore(
      createDeterministicMemoryAppReleaseStore(),
    ),
    artifactReader: adaptPromiseArtifactReader({
      read: async ({ artifactRef, expectedDigest }) => {
        const object = fixture.objects[artifactRef];
        if (!object) return { kind: "missing" };
        const bytes = new TextEncoder().encode(object.body);
        const digest = parseSha256Digest(
          `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes))}`,
        );
        if (digest !== expectedDigest)
          return { kind: "digest-mismatch", actualDigest: digest };
        return {
          kind: "verified",
          digest,
          mediaType: object.mediaType,
          bytes: { byteLength: bytes.length, copy: () => bytes.slice() },
          byteLength: bytes.length,
        };
      },
    }),
    artifactPolicy: { maxBytes: 1024 * 1024 },
  });
}

export async function seedFixtureCatalog(
  encoded: string,
  catalog: ReturnType<typeof createFixtureCatalog>,
) {
  const fixture = Schema.decodeUnknownSync(
    Schema.fromJsonString(fixtureSchema),
  )(encoded);
  for (const release of fixture.releases) {
    await Effect.runPromise(catalog.createApp({ appId: release.appId }));
    await Effect.runPromise(catalog.createRelease(release));
    await Effect.runPromise(catalog.verifyReleaseArtifact(release.releaseId));
  }
}
