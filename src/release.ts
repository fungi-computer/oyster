import * as Schema from "effect/Schema";
import {
  appBuildJsonSchema,
  type AppApi,
  type AppBuild,
  type AppDeclaration,
} from "@fungi.computer/puffball/app";
import {
  assetBuildMediaType,
  decodeAssetBuild,
  type AssetBuild,
  type AssetBuildPolicy,
} from "@fungi.computer/puffball/assets";
import {
  backendJsonSchema,
  type DurableBackend,
} from "@fungi.computer/puffball/backend";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import type {
  ArtifactRef,
  Release,
  Sha256Digest,
} from "@fungi.computer/puffball";

/** Immutable Release bytes addressed by their artifact reference. */
export type ArtifactStore = Readonly<{
  /** Read the stored bytes for `artifactRef`, or `null` when absent. */
  get: (artifactRef: ArtifactRef) => Promise<Uint8Array | null>;
  /** Store bytes under `artifactRef`; the caller has verified the digest. */
  put: (artifactRef: ArtifactRef, bytes: Uint8Array) => Promise<void>;
}>;

/** What a store knows of one object without reading it. */
export type ArtifactHead = Readonly<{
  byteLength: number;
  /** The digest the store verified when it took the bytes, if it did. */
  digest: Sha256Digest | null;
}>;

/** A store that can describe an object without reading its bytes. */
export type ArtifactHeads = Readonly<{
  /** Describe the object at `artifactRef`, or `null` when absent. */
  head: (artifactRef: ArtifactRef) => Promise<ArtifactHead | null>;
}>;

/** A store that can stream immutable object bytes without materializing them. */
export type ArtifactStreams = Readonly<{
  /**
   * Open a one-shot byte stream, or return `null` when absent. The signal owns
   * cancellation of both source opening where supported and subsequent reads.
   */
  stream: (
    artifactRef: ArtifactRef,
    signal?: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array> | null>;
}>;

/** Why a Release could not be read; the host maps it to an HTTP refusal. */
export class ReleaseError extends Error {
  override readonly name = "ReleaseError";
  constructor(
    readonly code:
      | "artifact_missing"
      | "digest_mismatch"
      | "invalid_release"
      | "asset_missing",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Default bounds for an App's UI asset build. */
export const defaultAssetPolicy: AssetBuildPolicy = {
  maxManifestBytes: 1024 * 1024,
  maxObjects: 2_000,
  maxObjectBytes: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};

/** A Release whose root, UI and backend artifacts were read and verified. */
export type VerifiedRelease = Readonly<{
  release: Release;
  build: AppBuild;
  /** The App API declared by the Release, or `null` when it has none. */
  api: AppApi | null;
  declaration: AppDeclaration | null;
  ui:
    | Readonly<{ kind: "html"; artifactRef: ArtifactRef; digest: Sha256Digest }>
    | Readonly<{ kind: "assets"; build: AssetBuild }>
    | null;
  backend: Readonly<{
    artifactRef: ArtifactRef;
    digest: Sha256Digest;
  }> | null;
}>;

/** Hex SHA-256 digest in Puffball's `sha256:<hex>` form. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  let hex = "";
  for (const byte of hash) hex += byte.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

/** Read one artifact and refuse it unless its bytes match `digest`. */
export async function readVerified(
  store: ArtifactStore,
  artifactRef: ArtifactRef,
  digest: Sha256Digest,
): Promise<Uint8Array> {
  const bytes = await store.get(artifactRef);
  if (bytes === null)
    throw new ReleaseError("artifact_missing", `Missing ${artifactRef}`);
  if ((await sha256(bytes)) !== digest)
    throw new ReleaseError("digest_mismatch", `Digest mismatch ${artifactRef}`);
  return bytes;
}

/**
 * Copies of verified artifacts near the reader, keyed by content digest. An
 * entry holds only bytes that already matched its digest, so a hit is served
 * without another store read or hash.
 */
export type VerifiedObjectCache = Readonly<{
  /** The cached bytes for `digest`, or null on a miss. */
  match: (digest: Sha256Digest) => Promise<ReadableStream<Uint8Array> | null>;
  /** Keep verified bytes; an unstored write only costs the next reader a store read. */
  put: (
    digest: Sha256Digest,
    bytes: Uint8Array,
  ) => Promise<"stored" | "unstored">;
}>;

/** {@link readVerified} through an optional digest-keyed cache it fills on a miss. */
export async function readCachedVerified(
  store: ArtifactStore,
  cache: VerifiedObjectCache | undefined,
  artifactRef: ArtifactRef,
  digest: Sha256Digest,
): Promise<ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>> {
  const hit = await cache?.match(digest);
  if (hit !== undefined && hit !== null) return hit;
  const bytes = await readVerified(store, artifactRef, digest);
  await cache?.put(digest, bytes);
  // A response body owns a plain ArrayBuffer, whatever view the store returned.
  return new Uint8Array(bytes);
}

const decodeText = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);

/** Decode an untrusted Release record, as an install request carries it. */
export function parseRelease(value: unknown): Release {
  try {
    return Schema.decodeUnknownSync(releaseSchema)(value, {
      onExcessProperty: "error",
    });
  } catch (cause) {
    throw new ReleaseError("invalid_release", "Invalid Release", { cause });
  }
}

/**
 * Read a Release root and verify its UI build and backend descriptor.
 * `readAssets` verifies UI object bodies when true. When false, it reads the
 * asset manifest needed to resolve references but does not read any UI object
 * body, including standalone HTML.
 */
export async function verifyRelease(
  store: ArtifactStore,
  release: Release,
  policy: AssetBuildPolicy = defaultAssetPolicy,
  /** Read and check every UI object now. Serving verifies each on demand. */
  readAssets = true,
): Promise<VerifiedRelease> {
  const rootBytes = await readVerified(
    store,
    release.artifact.artifactRef,
    release.artifact.artifactDigest,
  );
  let build: AppBuild;
  try {
    build = Schema.decodeUnknownSync(appBuildJsonSchema)(
      decodeText(rootBytes),
      {
        onExcessProperty: "error",
      },
    );
  } catch (cause) {
    throw new ReleaseError("invalid_release", "Invalid App root", { cause });
  }
  let ui: VerifiedRelease["ui"] = null;
  if ("ui" in build) {
    const bytes =
      readAssets || build.ui.mediaType === assetBuildMediaType
        ? await readVerified(store, build.ui.artifactRef, build.ui.digest)
        : null;
    if (build.ui.mediaType === assetBuildMediaType) {
      if (bytes === null)
        throw new ReleaseError(
          "invalid_release",
          "Asset manifest is required to verify its object references",
        );
      let assets: AssetBuild;
      try {
        assets = decodeAssetBuild(bytes, policy);
      } catch (cause) {
        throw new ReleaseError("invalid_release", "Invalid assets", { cause });
      }
      // One asset at a time: a Release's assets together can exceed an
      // isolate's memory, each alone is bounded by its policy.
      if (readAssets)
        for (const asset of assets.assets)
          await readVerified(store, asset.artifactRef, asset.digest);
      ui = { kind: "assets", build: assets };
    } else
      ui = {
        kind: "html",
        artifactRef: build.ui.artifactRef,
        digest: build.ui.digest,
      };
  }
  let backend: VerifiedRelease["backend"] = null;
  if ("backend" in build) {
    await readBackend(store, build.backend.artifactRef, build.backend.digest);
    backend = {
      artifactRef: build.backend.artifactRef,
      digest: build.backend.digest,
    };
  }
  return {
    release,
    build,
    api: build.declaration?.api ?? null,
    declaration: build.declaration ?? null,
    ui,
    backend,
  };
}

/** Read and decode a verified durable backend descriptor. */
async function readBackend(
  store: ArtifactStore,
  artifactRef: ArtifactRef,
  digest: Sha256Digest,
): Promise<DurableBackend> {
  const bytes = await readVerified(store, artifactRef, digest);
  try {
    return Schema.decodeUnknownSync(backendJsonSchema)(decodeText(bytes), {
      onExcessProperty: "error",
    });
  } catch (cause) {
    throw new ReleaseError("invalid_release", "Invalid backend", { cause });
  }
}

/**
 * Resolve a Release to its verified durable backend without reading its UI:
 * the root artifact, then the backend descriptor it names.
 */
export async function resolveBackend(
  store: ArtifactStore,
  release: Release,
): Promise<Readonly<{
  digest: Sha256Digest;
  backend: DurableBackend;
  declaration: AppDeclaration | null;
}> | null> {
  const rootBytes = await readVerified(
    store,
    release.artifact.artifactRef,
    release.artifact.artifactDigest,
  );
  let build: AppBuild;
  try {
    build = Schema.decodeUnknownSync(appBuildJsonSchema)(
      decodeText(rootBytes),
      {
        onExcessProperty: "error",
      },
    );
  } catch (cause) {
    throw new ReleaseError("invalid_release", "Invalid App root", { cause });
  }
  if (!("backend" in build)) return null;
  return {
    digest: build.backend.digest,
    declaration: build.declaration ?? null,
    backend: await readBackend(
      store,
      build.backend.artifactRef,
      build.backend.digest,
    ),
  };
}

/** A verified backend, as {@link resolveBackend} returns it. */
export type ResolvedBackend = NonNullable<
  Awaited<ReturnType<typeof resolveBackend>>
>;

/**
 * Verify each Release's backend once per owner. A Release's artifacts are
 * immutable and content-addressed, so a verified read is reused for the same
 * Release ID and artifact digest; a failed read is not cached.
 */
export function backendCache(
  store: ArtifactStore,
): (release: Release) => Promise<ResolvedBackend | null> {
  const verified = new Map<string, Promise<ResolvedBackend | null>>();
  return (release) => {
    const key = `${release.releaseId}:${release.artifact.artifactDigest}`;
    let entry = verified.get(key);
    if (entry === undefined) {
      entry = resolveBackend(store, release).catch((cause: unknown) => {
        verified.delete(key);
        throw cause;
      });
      verified.set(key, entry);
    }
    return entry;
  };
}
