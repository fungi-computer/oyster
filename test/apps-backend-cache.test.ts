import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  artifactRefSchema,
  releaseIdSchema,
  releaseSchema,
  sha256DigestSchema,
} from "@fungi.computer/puffball/effect";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { backendCache, sha256, type ArtifactStore } from "../src/release.js";

async function fixture() {
  const bytes = new Map<string, Uint8Array>();
  const reads: string[] = [];
  let failNext = false;
  const store: ArtifactStore = {
    get: (artifactRef) => {
      reads.push(artifactRef);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("transient read failure"));
      }
      return Promise.resolve(bytes.get(artifactRef) ?? null);
    },
    put: (artifactRef, value) => {
      bytes.set(artifactRef, value);
      return Promise.resolve();
    },
  };
  const persist = async (json: string) => {
    const encoded = new TextEncoder().encode(json);
    const digest = Schema.decodeUnknownSync(sha256DigestSchema)(
      await sha256(encoded),
    );
    const artifactRef = Schema.decodeUnknownSync(artifactRefSchema)(
      `artifact:sha256-${digest.slice(7)}`,
    );
    await store.put(artifactRef, encoded);
    return { artifactRef, digest, byteLength: encoded.length, version: digest };
  };
  const backend = {
    ...(await persist(
      JSON.stringify({
        runtime: { kind: "durable-facet", stateSchema: 1 },
        compatibilityDate: "2026-09-04",
        exportName: "Notes",
        code: "export class Notes {}",
      }),
    )),
    mediaType: backendMediaType,
  };
  const root = await persist(JSON.stringify(createAppBuild(null, backend)));
  const release = Schema.decodeUnknownSync(releaseSchema)({
    appId: "app_notes",
    releaseId: "rel_notes",
    artifact: {
      artifactRef: root.artifactRef,
      artifactDigest: root.digest,
      provenance: {
        sourceRevision: `git:${"b".repeat(40)}`,
        sourceTreeDigest: root.digest,
        buildRecipeDigest: root.digest,
      },
    },
  });
  return {
    store,
    release,
    reads,
    failOnce: () => {
      failNext = true;
    },
  };
}

it("verifies a content-addressed backend once per Release digest", async () => {
  const f = await fixture();
  const resolve = backendCache(f.store);
  const first = await resolve(f.release);
  const again = await Promise.all([resolve(f.release), resolve(f.release)]);
  // The root and backend artifacts are each read and verified exactly once.
  expect(f.reads).toHaveLength(2);
  expect(first?.backend.exportName).toBe("Notes");
  expect(again).toEqual([first, first]);
});

it("does not cache a failed read and retries on the next call", async () => {
  const f = await fixture();
  const resolve = backendCache(f.store);
  f.failOnce();
  await expect(resolve(f.release)).rejects.toThrow("transient read failure");
  expect((await resolve(f.release))?.backend.exportName).toBe("Notes");
  expect(f.reads).toHaveLength(3);
});

it("keys verification by Release identity, so another Release reads again", async () => {
  const f = await fixture();
  const resolve = backendCache(f.store);
  await resolve(f.release);
  await resolve({
    ...f.release,
    releaseId: Schema.decodeUnknownSync(releaseIdSchema)("rel_notes2"),
  });
  expect(f.reads).toHaveLength(4);
});
