import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  parseArtifactRef,
  parseSha256Digest,
  type ArtifactRef,
} from "@fungi.computer/puffball";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { releaseCache } from "../src/internal/host-gate.js";
import { parseRelease, type ArtifactStore } from "../src/release.js";

const digestOf = (bytes: Uint8Array) =>
  parseSha256Digest(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );

/** An artifact store that counts reads and can refuse the next one. */
function countingStore() {
  const objects = new Map<string, Uint8Array>();
  const reads: string[] = [];
  let missing = 0;
  const store: ArtifactStore = {
    get: (artifactRef: ArtifactRef) => {
      reads.push(artifactRef);
      if (missing > 0) {
        missing -= 1;
        return Promise.resolve(null);
      }
      return Promise.resolve(objects.get(artifactRef)?.slice() ?? null);
    },
    put: (artifactRef: ArtifactRef, bytes: Uint8Array) => {
      objects.set(artifactRef, bytes.slice());
      return Promise.resolve();
    },
  };
  const release = (name: string) => {
    const ui = new TextEncoder().encode(`<!doctype html><p>${name}</p>`);
    const uiRef = parseArtifactRef(`artifact:${name}-ui`);
    objects.set(uiRef, ui);
    const root = new TextEncoder().encode(
      JSON.stringify(
        createAppBuild(
          {
            artifactRef: uiRef,
            digest: digestOf(ui),
            version: digestOf(ui),
            byteLength: ui.byteLength,
            mediaType: "text/html; charset=utf-8",
          },
          null,
        ),
      ),
    );
    const rootRef = parseArtifactRef(`artifact:${name}`);
    objects.set(rootRef, root);
    const digest = digestOf(root);
    return parseRelease({
      appId: `app_${name}`,
      releaseId: `rel_${name}`,
      artifact: {
        artifactRef: rootRef,
        artifactDigest: digest,
        provenance: {
          sourceRevision: `git:${"b".repeat(40)}`,
          sourceTreeDigest: digest,
          buildRecipeDigest: digest,
        },
      },
    });
  };
  return {
    store,
    reads,
    release,
    refuseNext: () => {
      missing += 1;
    },
  };
}

it("verifies a Release once, however many callers ask", async () => {
  const fixture = countingStore();
  const resolve = releaseCache(fixture.store);
  const notes = fixture.release("notes");
  const [first, second] = await Promise.all([resolve(notes), resolve(notes)]);
  const third = await resolve(notes);
  expect(first).toBe(second);
  expect(third).toBe(first);
  expect(first.ui).toMatchObject({ kind: "html" });
  // The root alone: an html UI body is verified when served, not here.
  expect(fixture.reads).toEqual(["artifact:notes"]);
});

it("reads a failed Release again on the next request", async () => {
  const fixture = countingStore();
  const resolve = releaseCache(fixture.store);
  const notes = fixture.release("notes");
  fixture.refuseNext();
  await expect(resolve(notes)).rejects.toMatchObject({
    code: "artifact_missing",
  });
  await expect(resolve(notes)).resolves.toMatchObject({ release: notes });
  expect(fixture.reads).toEqual(["artifact:notes", "artifact:notes"]);
});

it("forgets the oldest-verified Release past its bound", async () => {
  const fixture = countingStore();
  const resolve = releaseCache(fixture.store, 1);
  const notes = fixture.release("notes");
  const tasks = fixture.release("tasks");
  await resolve(notes);
  await resolve(tasks);
  await resolve(tasks);
  await resolve(notes);
  expect(fixture.reads).toEqual([
    "artifact:notes",
    "artifact:tasks",
    "artifact:notes",
  ]);
});
