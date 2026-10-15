import { buildAssetManifest } from "@fungi.computer/cloudflare-worker-bundler/assets";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  assetBuildMediaType,
  assetBuildJsonSchema,
  assetBuildPolicySchema,
  assetBaseSchema,
  decodeAssetBuild,
  assetPathSchema,
  type AssetBuildPolicy,
  type BuildAsset,
} from "@fungi.computer/puffball/assets";
import {
  appBuildJsonSchema,
  appMediaType,
  createAppBuild,
} from "@fungi.computer/puffball/app";
import {
  matchesAssetObject,
  type AssetR2Object,
  type AssetR2Bucket,
} from "@fungi.computer/puffball/cloudflare-assets";
import {
  parseSha256Digest,
  parseArtifactRef,
  type ArtifactRef,
  type AppReleaseCatalogOptions,
  type VerifiedArtifactRead,
} from "@fungi.computer/puffball";
import {
  createR2ArtifactReader,
  type AppReleaseR2Bucket,
} from "@fungi.computer/puffball/cloudflare";
import type { ArtifactWriter, BuildOutput } from "./effect.js";

/**
 * The native R2 writer for a built App: immutable, digest-addressed objects
 * keyed by artifact reference, read back and verified before the root is
 * returned. Hub's Publisher and Oyster's Computer builds both write Releases
 * through it.
 */
export type ArtifactPolicy = NonNullable<
  AppReleaseCatalogOptions["artifactPolicy"]
>;

/** Native binding subset; conditional put never replaces a retained artifact. */
export type PublisherR2Bucket = AppReleaseR2Bucket &
  AssetR2Bucket & {
    put(
      key: string,
      value: Uint8Array,
      options: {
        onlyIf: { etagDoesNotMatch: string };
        sha256: string;
        httpMetadata: { contentType: string };
      },
    ): Promise<AssetR2Object | null>;
  };

/** Private host pins a retry-stable reference; the actual build supplies its digest. */
export function createR2ArtifactWriter(options: {
  bucket: PublisherR2Bucket;
  artifactRef: ArtifactRef;
  policy: ArtifactPolicy;
  assets?: AssetBuildPolicy;
}): ArtifactWriter {
  const artifactRef = options.artifactRef;
  const assets = options.assets
    ? {
        bucket: options.bucket,
        policy: Object.freeze(
          Schema.decodeUnknownSync(assetBuildPolicySchema)({
            ...options.assets,
          }),
        ),
      }
    : undefined;
  const policy = { ...options.policy };
  const reader = createR2ArtifactReader(options.bucket, policy, assets);
  const writeImmutable = async (input: {
    artifactRef: ArtifactRef;
    bytes: Uint8Array;
    mediaType: VerifiedArtifactRead["mediaType"];
    limit: number | undefined;
  }) => {
    if (input.limit === undefined || input.bytes.byteLength > input.limit)
      throw new Error("Publisher artifact exceeds configured policy");
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const artifactDigest = parseSha256Digest(`sha256:${digest}`);
    const readStored = () =>
      reader.read({
        artifactRef: input.artifactRef,
        expectedDigest: artifactDigest,
        verification: "publication",
      });
    let stored = await readStored();
    if (stored.kind === "missing") {
      await options.bucket.put(input.artifactRef, input.bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: digest,
        httpMetadata: { contentType: input.mediaType },
      });
      stored = await readStored();
    }
    const object = await options.bucket.head(input.artifactRef);
    if (
      stored.kind !== "verified" ||
      stored.mediaType !== input.mediaType ||
      object?.size !== input.bytes.byteLength
    )
      throw new Error("Publisher artifact readback failed");
    return {
      artifactRef: input.artifactRef,
      artifactDigest,
      version: object.version,
      byteLength: input.bytes.byteLength,
      mediaType: input.mediaType,
    };
  };
  const childArtifactRef = (digest: string): ArtifactRef =>
    parseArtifactRef(`artifact:sha256-${digest.slice("sha256:".length)}`);
  return {
    write: (output: BuildOutput) =>
      Effect.tryPromise(async () => {
        const uiOutput = output.kind === "backend" ? null : output.ui;
        const backendBytes = output.kind === "ui" ? null : output.backend;
        const uiBytes =
          uiOutput === null
            ? null
            : uiOutput.content.kind === "html"
              ? uiOutput.content.bytes.slice()
              : await storeAssetObjects(
                  uiOutput.content.assets,
                  uiOutput.content.base,
                  options.bucket,
                  assets?.policy,
                );
        const uiMediaType = uiOutput?.mediaType ?? null;
        const ui =
          uiBytes === null || uiMediaType === null
            ? null
            : await writeImmutable({
                artifactRef: childArtifactRef(
                  `sha256:${createHash("sha256")
                    .update(uiBytes)
                    .digest("hex")}`,
                ),
                bytes: uiBytes,
                mediaType: uiMediaType,
                limit:
                  uiMediaType === assetBuildMediaType
                    ? policy.maxManifestBytes
                    : policy.maxBytes,
              });
        const backend =
          backendBytes === null
            ? null
            : await writeImmutable({
                artifactRef: childArtifactRef(
                  `sha256:${createHash("sha256")
                    .update(backendBytes)
                    .digest("hex")}`,
                ),
                bytes: backendBytes,
                mediaType: "application/vnd.fungi.app-backend+json",
                limit: policy.maxBytes,
              });
        const rootInput = createAppBuild(
          ui === null || uiMediaType === null
            ? null
            : {
                artifactRef: ui.artifactRef,
                digest: ui.artifactDigest,
                version: ui.version,
                byteLength: ui.byteLength,
                mediaType: uiMediaType,
              },
          backend === null
            ? null
            : {
                artifactRef: backend.artifactRef,
                digest: backend.artifactDigest,
                version: backend.version,
                byteLength: backend.byteLength,
                mediaType: "application/vnd.fungi.app-backend+json",
              },
          output.declaration,
        );
        const root = Schema.encodeUnknownSync(appBuildJsonSchema)(rootInput);
        const rootBytes = new TextEncoder().encode(root);
        const stored = await writeImmutable({
          artifactRef,
          bytes: rootBytes,
          mediaType: appMediaType,
          limit: policy.maxManifestBytes,
        });
        return {
          artifactRef: stored.artifactRef,
          artifactDigest: stored.artifactDigest,
        };
      }),
  };
}

async function storeAssetObjects(
  outputs: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  suppliedBase: string,
  bucket: PublisherR2Bucket,
  policy: AssetBuildPolicy | undefined,
): Promise<Uint8Array> {
  const base = Schema.decodeUnknownSync(assetBaseSchema)(suppliedBase);
  if (!policy)
    throw new Error(
      "Asset writer requires explicit policy and native metadata binding",
    );
  if (outputs.length === 0 || outputs.length > policy.maxObjects)
    throw new Error("Asset count exceeds policy");
  const content: Record<string, ArrayBuffer> = {};
  let total = 0;
  for (const output of outputs) {
    const path = Schema.decodeUnknownSync(assetPathSchema)(output.path);
    if (Object.hasOwn(content, path)) throw new Error("Duplicate build path");
    total += output.bytes.byteLength;
    if (
      output.bytes.byteLength > policy.maxObjectBytes ||
      !Number.isSafeInteger(total) ||
      total > policy.maxTotalBytes
    )
      throw new Error("Asset bytes exceed policy");
    content[path] = new Uint8Array(output.bytes).buffer;
  }
  const metadata = await buildAssetManifest(content);
  const assets = await Effect.runPromise(
    Effect.forEach(
      Object.keys(content).sort(),
      (path) =>
        Effect.tryPromise(async () => {
          const bytes = content[path];
          const type = metadata.get(path)?.contentType;
          if (!bytes || !type)
            throw new Error("Build asset has no maintained content type");
          const hash = createHash("sha256")
            .update(new Uint8Array(bytes))
            .digest("hex");
          const artifactRef = parseArtifactRef(`artifact:sha256-${hash}`);
          let object = await bucket.head(artifactRef);
          if (object === null) {
            object = await bucket.put(artifactRef, new Uint8Array(bytes), {
              onlyIf: { etagDoesNotMatch: "*" },
              sha256: hash,
              httpMetadata: { contentType: type },
            });
            object ??= await bucket.head(artifactRef);
          }
          if (!object) throw new Error("Asset readback missing");
          const asset: BuildAsset = {
            path,
            artifactRef,
            digest: parseSha256Digest(`sha256:${hash}`),
            version: object.version,
            byteLength: bytes.byteLength,
            contentType: type,
          };
          if (!matchesAssetObject(asset, object))
            throw new Error("Immutable asset collision");
          return asset;
        }),
      { concurrency: 4 },
    ),
  );
  const root = new TextEncoder().encode(
    Schema.encodeUnknownSync(assetBuildJsonSchema)({
      format: "fungi-assets-v1",
      base,
      assets,
    }),
  );
  decodeAssetBuild(root, policy);
  return root;
}
