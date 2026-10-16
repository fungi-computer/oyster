import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { appBuildJsonSchema } from "@fungi.computer/puffball/app";
import { parseArtifactRef, type ArtifactRef } from "@fungi.computer/puffball";
import type { AssetBuildPolicy } from "@fungi.computer/puffball/assets";
import {
  stageBuildOutput,
  writeArtifactRoot,
  writeImmutableArtifact,
  type ImmutableArtifactObjects,
} from "../src/build/artifact-writer.js";
import type { BuildOutput } from "../src/build/effect.js";

const encoder = new TextEncoder();
const rootArtifactRef = parseArtifactRef("artifact:root-under-test");
const generous: AssetBuildPolicy = {
  maxManifestBytes: 65_536,
  maxObjects: 16,
  maxObjectBytes: 65_536,
  maxTotalBytes: 131_072,
};
const index = { path: "/index.html", bytes: encoder.encode("<!doctype html>") };
const script = { path: "/app.js", bytes: encoder.encode("export {};") };
/** An asset UI and a backend. With one asset the root, which names both,
 * outgrows the asset manifest. */
function appOutput(assets: readonly (typeof index)[]): BuildOutput {
  return {
    kind: "app",
    ui: {
      mediaType: "application/vnd.fungi.app-assets+json",
      content: { kind: "assets", base: "./", assets },
    },
    backend: encoder.encode('{"code":"export class Fixture {}"}'),
  };
}
const single = appOutput([index]);
const pair = appOutput([index, script]);

function memoryObjects(): ImmutableArtifactObjects & {
  objects: Map<ArtifactRef, Uint8Array>;
} {
  const objects = new Map<ArtifactRef, Uint8Array>();
  return {
    objects,
    create(artifactRef, bytes) {
      if (objects.has(artifactRef)) return Promise.resolve("exists");
      objects.set(artifactRef, bytes.slice());
      return Promise.resolve("created");
    },
    read: (artifactRef) => Promise.resolve(objects.get(artifactRef) ?? null),
  };
}

/** The asset manifest's and root's sizes under a policy that admits both. */
async function sizes() {
  const store = memoryObjects();
  await writeImmutableArtifact(single, store, {
    rootArtifactRef,
    assetPolicy: generous,
  });
  const root = store.objects.get(rootArtifactRef);
  if (root === undefined) throw new Error("The root was not stored");
  const build = Schema.decodeUnknownSync(appBuildJsonSchema)(
    new TextDecoder().decode(root),
  );
  if (!("ui" in build)) throw new Error("The root names no UI");
  const manifest = store.objects.get(build.ui.artifactRef);
  if (manifest === undefined) throw new Error("The manifest was not stored");
  return { manifest: manifest.byteLength, root: root.byteLength };
}

async function refusedWithNothingStored(
  output: BuildOutput,
  assetPolicy: AssetBuildPolicy,
) {
  const store = memoryObjects();
  await expect(
    writeImmutableArtifact(output, store, { rootArtifactRef, assetPolicy }),
  ).rejects.toThrow();
  expect(store.objects.size).toBe(0);
}

it("refuses more assets than the policy's maxObjects before storing any", async () => {
  await refusedWithNothingStored(pair, { ...generous, maxObjects: 1 });
});

it("refuses assets over the policy's maxTotalBytes before storing any", async () => {
  await refusedWithNothingStored(pair, { ...generous, maxTotalBytes: 24 });
});

it("bounds the asset manifest and the App root by the policy's maxManifestBytes", async () => {
  const measured = await sizes();
  expect(measured.root).toBeGreaterThan(measured.manifest);
  await refusedWithNothingStored(single, {
    ...generous,
    maxManifestBytes: measured.manifest - 1,
  });
  // The manifest fits, the root does not.
  await refusedWithNothingStored(single, {
    ...generous,
    maxManifestBytes: measured.manifest,
  });
  const store = memoryObjects();
  await writeImmutableArtifact(single, store, {
    rootArtifactRef,
    assetPolicy: { ...generous, maxManifestBytes: measured.root },
  });
  // The asset, the manifest, the backend and the root.
  expect(store.objects.size).toBe(4);
});

it("writes the same asset manifest and root from staged objects as the local packer", async () => {
  const packed = memoryObjects();
  const packedRoot = await writeImmutableArtifact(pair, packed, {
    rootArtifactRef,
    assetPolicy: generous,
  });
  // A host whose builder uploaded the objects writes only the root half.
  const staged = stageBuildOutput(pair);
  const hosted = memoryObjects();
  for (const object of staged.objects)
    await hosted.create(object.artifactRef, object.bytes);
  const hostedRoot = await writeArtifactRoot(staged.manifest, hosted, {
    rootArtifactRef,
    assetPolicy: generous,
  });
  expect(hostedRoot).toEqual(packedRoot);
  expect([...hosted.objects.keys()].sort()).toEqual(
    [...packed.objects.keys()].sort(),
  );
  for (const [artifactRef, bytes] of packed.objects)
    expect(hosted.objects.get(artifactRef)).toEqual(bytes);
});

it("refuses a manifest naming one asset path twice before writing anything", async () => {
  const staged = stageBuildOutput(pair);
  if (
    staged.manifest.kind !== "app" ||
    staged.manifest.ui.content.kind !== "assets"
  )
    throw new Error("Expected an asset App");
  const [first] = staged.manifest.ui.content.assets;
  if (first === undefined) throw new Error("Expected an asset");
  const store = memoryObjects();
  await expect(
    writeArtifactRoot(
      {
        ...staged.manifest,
        ui: {
          mediaType: "application/vnd.fungi.app-assets+json",
          content: {
            ...staged.manifest.ui.content,
            assets: [first, first],
          },
        },
      },
      store,
      { rootArtifactRef, assetPolicy: generous },
    ),
  ).rejects.toThrow("Duplicate build path");
  expect(store.objects.size).toBe(0);
});
