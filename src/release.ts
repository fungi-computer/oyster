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
 * Read a Release root and verify every artifact it names: the UI document or
 * asset build (and each asset object), and the backend descriptor.
 */
export async function verifyRelease(
  store: ArtifactStore,
  release: Release,
  policy: AssetBuildPolicy = defaultAssetPolicy,
  /**
   * Read and check every UI asset now. Serving can skip this: each asset is
   * verified against its digest when it is read.
   */
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
    const bytes = await readVerified(
      store,
      build.ui.artifactRef,
      build.ui.digest,
    );
    if (build.ui.mediaType === assetBuildMediaType) {
      let assets: AssetBuild;
      try {
        assets = decodeAssetBuild(bytes, policy);
      } catch (cause) {
        throw new ReleaseError("invalid_release", "Invalid assets", { cause });
      }
      if (readAssets)
        await Promise.all(
          assets.assets.map((asset) =>
            readVerified(store, asset.artifactRef, asset.digest),
          ),
        );
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
