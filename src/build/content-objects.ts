/**
 * A build's uploaded objects in an R2-shaped store: content addressed
 * (`artifact:sha256-<hex>`), written once from a stream with the store
 * itself verifying the digest, and described by `head()` without a read.
 * The bytes never pass through an isolate's memory as a whole.
 */
import {
  parseArtifactRef,
  parseSha256Digest,
  type ArtifactRef,
  type Sha256Digest,
} from "@fungi.computer/puffball";
import type { ArtifactHead } from "../release.js";
import type {
  CandidateObject,
  CandidateObjectMediaType,
} from "./submission-contract.js";

/** The parts of an R2 bucket a content-object store uses. */
export type ContentObjectBucket = Readonly<{
  /** Describe the object at `key` without its body, or `null` when absent. */
  head(key: string): Promise<Readonly<{
    size: number;
    checksums: Readonly<{ sha256?: ArrayBuffer }>;
  }> | null>;
  /** Store `value` at `key`; the bucket refuses bytes whose SHA-256 differs. */
  put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array,
    options: Readonly<{
      sha256: string;
      httpMetadata: Readonly<{ contentType: CandidateObjectMediaType }>;
    }>,
  ): Promise<object | null>;
}>;

/** The store key of one content-addressed object. */
export function contentObjectRef(digest: Sha256Digest): ArtifactRef {
  return parseArtifactRef(`artifact:sha256-${digest.slice("sha256:".length)}`);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Describe a stored object by its size and the SHA-256 the store verified. */
export async function headContentObject(
  bucket: ContentObjectBucket,
  artifactRef: ArtifactRef,
): Promise<ArtifactHead | null> {
  const object = await bucket.head(artifactRef);
  if (object === null) return null;
  const sha256 = object.checksums.sha256;
  return {
    byteLength: object.size,
    digest:
      sha256 === undefined ? null : parseSha256Digest(`sha256:${hex(sha256)}`),
  };
}

/**
 * Stream one object into the store under its digest. The store refuses a
 * body whose SHA-256 differs; an object already stored with the same
 * verified digest and size is kept (write-once: a stored version may be
 * pinned by a Release) and the body is discarded, never stored.
 */
export async function putContentObject(
  bucket: ContentObjectBucket,
  object: CandidateObject,
  body: ReadableStream<Uint8Array> | null,
  mediaType: CandidateObjectMediaType,
): Promise<"stored" | "refused"> {
  const artifactRef = contentObjectRef(object.digest);
  const existing = await headContentObject(bucket, artifactRef);
  if (
    existing !== null &&
    existing.digest === object.digest &&
    existing.byteLength === object.byteLength
  ) {
    // Read the body through (discarding it) rather than cancel it: a
    // cancelled request body resets the uploader's connection mid-send.
    await body?.pipeTo(new WritableStream());
    return "stored";
  }
  try {
    await bucket.put(artifactRef, body ?? new Uint8Array(0), {
      sha256: object.digest.slice("sha256:".length),
      httpMetadata: { contentType: mediaType },
    });
  } catch {
    return "refused";
  }
  return "stored";
}
