/**
 * Oyster's one immutable artifact representation: content-addressed bytes
 * keyed by artifact reference, with media types carried by the App build
 * and asset manifests. A build's own objects are named as uploads are
 * (`contentObjectRef`: owner, digest and stored media type); the objects only
 * the store's owner derives are named outside that namespace. The local packer
 * writes it to a directory, and a host's build owner writes it to that host's
 * artifact store under the building Team's or tenant's namespace.
 *
 * It has two halves. Staging turns a build's bytes into content-addressed
 * objects and the output manifest that names them by digest and size. The
 * root half turns an output manifest into the small objects only the store's
 * owner writes: the asset manifest and the App root. The local packer runs
 * both; a host whose builder uploaded the objects itself runs only the root
 * half, over the same manifest, so both write identical root bytes.
 *
 * Every object is derived and checked before the first is stored: an asset
 * build that its policy refuses, or a root over its bound, stores nothing.
 */
import { createHash } from "node:crypto";
import mime from "mime";
import * as Schema from "effect/Schema";
import {
  assetBuildJsonSchema,
  assetPathSchema,
  decodeAssetBuild,
  type AssetBuildPolicy,
} from "@fungi.computer/puffball/assets";
import {
  appBuildJsonSchema,
  createAppBuild,
} from "@fungi.computer/puffball/app";
import {
  parseArtifactRef,
  parseSha256Digest,
  type ArtifactRef,
  type Sha256Digest,
} from "@fungi.computer/puffball";
import type { BuildOutput, StoredArtifact } from "./effect.js";
import {
  contentObjectRef,
  type ContentObjectOwner,
} from "./content-objects.js";
import type {
  CandidateObject,
  CandidateObjectMediaType,
  CandidateOutputManifest,
} from "./submission-contract.js";

/** Write-once object storage for one artifact root. */
export type ImmutableArtifactObjects = Readonly<{
  /** Create the object, or answer `exists` when the reference is taken. */
  create(
    artifactRef: ArtifactRef,
    bytes: Uint8Array,
  ): Promise<"created" | "exists">;
  /** Read the object's bytes, or `null` when absent. */
  read(artifactRef: ArtifactRef): Promise<Uint8Array | null>;
}>;

/** One object ready to store under its reference. */
export type StagedArtifactObject = Readonly<{
  artifactRef: ArtifactRef;
  bytes: Uint8Array;
  digest: Sha256Digest;
}>;

/** One distinct object a build's output manifest names, before it has an owner. */
export type StagedCandidateObject = Readonly<{
  bytes: Uint8Array;
  digest: Sha256Digest;
  mediaType: CandidateObjectMediaType;
}>;

/** A build's output manifest and each distinct object it names. */
export type StagedBuildOutput = Readonly<{
  manifest: CandidateOutputManifest;
  objects: readonly StagedCandidateObject[];
}>;

/** The small objects a root write stores, and the root they make. */
type DerivedArtifactRoot = Readonly<{
  objects: readonly StagedArtifactObject[];
  root: StoredArtifact;
}>;

function sha256(bytes: Uint8Array): Sha256Digest {
  return parseSha256Digest(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );
}

/** The address of a derived object: `artifact:sha256-<hex>`, which no upload can name. */
function derivedArtifactRef(digest: Sha256Digest): ArtifactRef {
  return parseArtifactRef(`artifact:sha256-${digest.slice("sha256:".length)}`);
}

/**
 * The root bound for an App whose recipe declares no asset policy: this
 * writer's private fallback, not recipe policy. An asset recipe's own
 * `maxManifestBytes` bounds its root as it bounds its asset manifest.
 */
const fallbackRootBytes = 1024 * 1024;

type UiManifest = Extract<CandidateOutputManifest, { kind: "ui" }>["ui"];
type PreparedUi = Extract<BuildOutput, { kind: "ui" }>["ui"];

/**
 * Stage a build's bytes: the output manifest that names each object by its
 * digest and size, and each distinct object once.
 */
export function stageBuildOutput(output: BuildOutput): StagedBuildOutput {
  const objects: StagedCandidateObject[] = [];
  const stage = (
    bytes: Uint8Array,
    mediaType: CandidateObjectMediaType,
  ): CandidateObject => {
    const digest = sha256(bytes);
    if (
      !objects.some(
        (object) => object.digest === digest && object.mediaType === mediaType,
      )
    )
      objects.push({ bytes: bytes.slice(), digest, mediaType });
    return { digest, byteLength: bytes.byteLength };
  };
  const declared =
    output.declaration === undefined ? {} : { declaration: output.declaration };
  const ui = (prepared: PreparedUi): UiManifest =>
    prepared.content.kind === "html"
      ? {
          mediaType: "text/html; charset=utf-8",
          content: {
            kind: "html",
            ...stage(prepared.content.bytes, "text/html; charset=utf-8"),
          },
        }
      : {
          mediaType: "application/vnd.fungi.app-assets+json",
          content: {
            kind: "assets",
            base: prepared.content.base,
            assets: prepared.content.assets.map((asset) => ({
              path: asset.path,
              ...stage(asset.bytes, "application/octet-stream"),
            })),
          },
        };
  const manifest: CandidateOutputManifest =
    output.kind === "ui"
      ? { kind: "ui", ui: ui(output.ui), ...declared }
      : output.kind === "backend"
        ? {
            kind: "backend",
            backend: stage(
              output.backend,
              "application/vnd.fungi.app-backend+json",
            ),
            ...declared,
          }
        : {
            kind: "app",
            ui: ui(output.ui),
            backend: stage(
              output.backend,
              "application/vnd.fungi.app-backend+json",
            ),
            ...declared,
          };
  return { manifest, objects };
}

/**
 * Derive the asset manifest (for an asset UI) and the App root an output
 * manifest names, each checked against the policy, without storing either.
 */
function artifactRootObjects(
  manifest: CandidateOutputManifest,
  options: Readonly<{
    owner: ContentObjectOwner;
    rootArtifactRef: ArtifactRef;
    assetPolicy: AssetBuildPolicy | undefined;
  }>,
): DerivedArtifactRoot {
  const objects: StagedArtifactObject[] = [];
  const referenced = (
    object: CandidateObject,
    mediaType: CandidateObjectMediaType,
  ) => ({
    artifactRef: contentObjectRef(options.owner, object.digest, mediaType),
    digest: object.digest,
    version: object.digest,
    byteLength: object.byteLength,
  });
  const stage = (bytes: Uint8Array, ref?: ArtifactRef) => {
    const digest = sha256(bytes);
    const artifactRef = ref ?? derivedArtifactRef(digest);
    objects.push({ artifactRef, bytes, digest });
    return {
      artifactRef,
      digest,
      version: digest,
      byteLength: bytes.byteLength,
    };
  };
  const ui = manifest.kind === "backend" ? null : manifest.ui;
  const storedUi = (() => {
    if (ui === null) return null;
    if (ui.content.kind === "html")
      return {
        ...referenced(ui.content, "text/html; charset=utf-8"),
        mediaType: ui.mediaType,
      };
    if (!options.assetPolicy)
      throw new Error("Asset writer requires explicit policy");
    const byPath = new Map<string, CandidateObject>();
    for (const asset of ui.content.assets) {
      const path = Schema.decodeUnknownSync(assetPathSchema)(asset.path);
      if (byPath.has(path)) throw new Error("Duplicate build path");
      byPath.set(path, asset);
    }
    const assets = [];
    for (const [path, asset] of [...byPath].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const mediaType = mime.getType(path);
      const contentType = mediaType?.startsWith("text/")
        ? `${mediaType}; charset=utf-8`
        : mediaType;
      if (!contentType)
        throw new Error("Build asset has no maintained content type");
      assets.push({
        path,
        ...referenced(asset, "application/octet-stream"),
        contentType,
      });
    }
    const assetManifest = new TextEncoder().encode(
      Schema.encodeUnknownSync(assetBuildJsonSchema)({
        format: "fungi-assets-v1",
        base: ui.content.base,
        assets,
      }),
    );
    decodeAssetBuild(assetManifest, options.assetPolicy);
    return { ...stage(assetManifest), mediaType: ui.mediaType };
  })();
  const storedBackend =
    manifest.kind === "ui"
      ? null
      : {
          ...referenced(
            manifest.backend,
            "application/vnd.fungi.app-backend+json",
          ),
          mediaType: "application/vnd.fungi.app-backend+json" as const,
        };
  const rootBytes = new TextEncoder().encode(
    Schema.encodeUnknownSync(appBuildJsonSchema)(
      createAppBuild(storedUi, storedBackend, manifest.declaration),
    ),
  );
  if (
    rootBytes.byteLength >
    (options.assetPolicy?.maxManifestBytes ?? fallbackRootBytes)
  )
    throw new Error("App root exceeds its manifest bound");
  const root = stage(rootBytes, options.rootArtifactRef);
  return {
    objects,
    root: Object.freeze({
      artifactRef: root.artifactRef,
      artifactDigest: root.digest,
    }),
  };
}

/** Store each object once; an existing object must hold the same bytes. */
async function storeObjects(
  staged: readonly StagedArtifactObject[],
  objects: ImmutableArtifactObjects,
): Promise<void> {
  for (const { artifactRef, bytes, digest } of staged)
    if ((await objects.create(artifactRef, bytes)) === "exists") {
      const existing = await objects.read(artifactRef);
      if (existing === null || sha256(existing) !== digest)
        throw new Error("Immutable artifact collision");
    }
}

/**
 * Write the asset manifest and App root an output manifest names. The
 * objects it names are already stored, and checked, by the caller.
 */
export async function writeArtifactRoot(
  manifest: CandidateOutputManifest,
  objects: ImmutableArtifactObjects,
  options: Readonly<{
    owner: ContentObjectOwner;
    rootArtifactRef: ArtifactRef;
    assetPolicy: AssetBuildPolicy | undefined;
  }>,
): Promise<StoredArtifact> {
  const derived = artifactRootObjects(manifest, options);
  await storeObjects(derived.objects, objects);
  return derived.root;
}

/** Persist one build's UI, backend and root; an existing object must hold the same bytes. */
export async function writeImmutableArtifact(
  output: BuildOutput,
  objects: ImmutableArtifactObjects,
  options: Readonly<{
    owner: ContentObjectOwner;
    rootArtifactRef: ArtifactRef;
    assetPolicy: AssetBuildPolicy | undefined;
  }>,
): Promise<StoredArtifact> {
  const staged = stageBuildOutput(output);
  const derived = artifactRootObjects(staged.manifest, options);
  const owned = staged.objects.map(({ bytes, digest, mediaType }) => ({
    artifactRef: contentObjectRef(options.owner, digest, mediaType),
    bytes,
    digest,
  }));
  await storeObjects([...owned, ...derived.objects], objects);
  return derived.root;
}
