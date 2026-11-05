/**
 * A build's uploaded objects in an R2-shaped store: addressed by their owner,
 * content and stored media type (`artifact:o<owner>-sha256-<hex>.<type>`),
 * written once from a stream with the store itself verifying the digest, and
 * described by `head()` without a read. The bytes never pass through an
 * isolate's memory as a whole.
 *
 * The owner (one Team or tenant) is part of the key, so no upload ever leans
 * on an object another owner stored: erasing one owner's Apps cannot take
 * bytes from under another owner's unreleased upload. The media type is part
 * of the key because a reader (the Publisher's) checks the stored type.
 * Objects a host derives itself (asset manifests, roots) are named outside
 * this namespace, so no upload can address them.
 */
import { createHash } from "node:crypto";
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
  /**
   * Store `value` at `key`; the bucket refuses bytes whose SHA-256 differs.
   * As in R2, `onlyIf: { etagDoesNotMatch: "*" }` makes the put conditional
   * on `key` being absent: an existing object is kept and the put resolves
   * `null` instead.
   */
  put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array,
    options: Readonly<{
      sha256: string;
      httpMetadata: Readonly<{ contentType: CandidateObjectMediaType }>;
      onlyIf?: Readonly<{ etagDoesNotMatch: string }>;
    }>,
  ): Promise<object | null>;
}>;

const mediaTypeKeys = {
  "text/html; charset=utf-8": "html",
  "application/vnd.fungi.app-backend+json": "backend",
  "application/octet-stream": "octets",
} as const satisfies Record<CandidateObjectMediaType, string>;

/** The one Team or tenant whose uploads share a key namespace. */
export type ContentObjectOwner = Readonly<{ namespace: string }>;

/**
 * Name the upload namespace of a Team or tenant id. Ids are opaque to the
 * store, so the namespace is a fixed-length digest of the id.
 */
export function contentObjectOwner(id: string): ContentObjectOwner {
  if (id.length === 0) throw new Error("Content object owner id is empty");
  return Object.freeze({
    namespace: createHash("sha256")
      .update(`fungi.content-object-owner\0${id}`)
      .digest("hex")
      .slice(0, 32),
  });
}

/** The store key of one uploaded object: its owner, digest and stored media type. */
export function contentObjectRef(
  owner: ContentObjectOwner,
  digest: Sha256Digest,
  mediaType: CandidateObjectMediaType,
): ArtifactRef {
  return parseArtifactRef(
    `artifact:o${owner.namespace}-sha256-${digest.slice("sha256:".length)}.${mediaTypeKeys[mediaType]}`,
  );
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
 * Stream one object into the store under its owner, digest and media type. The store refuses a
 * body whose SHA-256 differs. The key is write-once (a stored version may be
 * pinned by a Release): the put is conditional on the key being absent, and
 * an existing object is never replaced. When the key already holds an object
 * of the named size whose store-verified digest is the named one, or that the
 * store never checksummed (a packed upload's plain bytes, which the candidate
 * check reads and hashes), the body is discarded and the object kept; any
 * other existing object refuses the upload.
 */
export async function putContentObject(
  bucket: ContentObjectBucket,
  owner: ContentObjectOwner,
  object: CandidateObject,
  body: ReadableStream<Uint8Array> | null,
  mediaType: CandidateObjectMediaType,
): Promise<"stored" | "refused"> {
  const artifactRef = contentObjectRef(owner, object.digest, mediaType);
  const kept = (existing: ArtifactHead) =>
    existing.byteLength === object.byteLength &&
    (existing.digest === null || existing.digest === object.digest);
  const existing = await headContentObject(bucket, artifactRef);
  if (existing !== null) {
    // Read the body through (discarding it) rather than cancel it: a
    // cancelled request body resets the uploader's connection mid-send.
    await body?.pipeTo(new WritableStream());
    return kept(existing) ? "stored" : "refused";
  }
  let written: object | null;
  try {
    written = await bucket.put(artifactRef, body ?? new Uint8Array(0), {
      sha256: object.digest.slice("sha256:".length),
      httpMetadata: { contentType: mediaType },
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch {
    return "refused";
  }
  if (written !== null) return "stored";
  // Another writer took the key after the head above; its object is kept.
  const taken = await headContentObject(bucket, artifactRef);
  return taken !== null && kept(taken) ? "stored" : "refused";
}
