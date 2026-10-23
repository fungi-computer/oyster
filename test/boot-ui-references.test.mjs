import assert from "node:assert/strict";
import { test } from "node:test";
import { TextEncoder } from "node:util";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { parseArtifactRef, parseSha256Digest } from "@fungi.computer/puffball";
import { assetBuildMediaType } from "@fungi.computer/puffball/assets";
import { readBootUi } from "../src/boot-gate.ts";
import { release } from "./apps-fixture.js";
import { sha256 } from "../src/release.ts";

const { Response } = globalThis;

async function fixture(assetBytes) {
  const artifactRef = parseArtifactRef("artifact:ui");
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      format: "fungi-assets-v1",
      base: "./",
      assets: [
        {
          path: "/index.html",
          artifactRef,
          digest: parseSha256Digest(await sha256(assetBytes)),
          version: "candidate",
          byteLength: assetBytes.byteLength,
          contentType: "text/html",
        },
      ],
    }),
  );
  const build = createAppBuild(
    {
      artifactRef: parseArtifactRef("artifact:ui-manifest"),
      digest: parseSha256Digest(await sha256(manifest)),
      byteLength: manifest.byteLength,
      version: "candidate",
      mediaType: assetBuildMediaType,
    },
    null,
  );
  const rootBytes = new TextEncoder().encode(JSON.stringify(build));
  const rootRef = release.artifact.artifactRef;
  const calls = [];
  const objects = new Map([
    [rootRef, rootBytes],
    [parseArtifactRef("artifact:ui-manifest"), manifest],
    [artifactRef, assetBytes],
  ]);
  return {
    calls,
    release: {
      ...release,
      artifact: {
        ...release.artifact,
        artifactDigest: parseSha256Digest(await sha256(rootBytes)),
      },
    },
    store: {
      get: async (ref) => {
        calls.push(ref);
        return objects.get(ref) ?? null;
      },
      stream: async (ref) => {
        const bytes = objects.get(ref);
        return bytes === undefined ? null : new Response(bytes).body;
      },
      put: async () => assert.fail("boot capture must not write artifacts"),
    },
  };
}

async function htmlFixture(html) {
  const artifactRef = parseArtifactRef("artifact:html");
  const build = createAppBuild(
    {
      artifactRef,
      digest: parseSha256Digest(await sha256(html)),
      byteLength: html.byteLength,
      version: "candidate",
      mediaType: "text/html; charset=utf-8",
    },
    null,
  );
  const rootBytes = new TextEncoder().encode(JSON.stringify(build));
  const objects = new Map([
    [release.artifact.artifactRef, rootBytes],
    [artifactRef, html],
  ]);
  const calls = [];
  return {
    calls,
    release: {
      ...release,
      artifact: {
        ...release.artifact,
        artifactDigest: parseSha256Digest(await sha256(rootBytes)),
      },
    },
    store: {
      get: async (ref) => {
        calls.push(ref);
        return objects.get(ref) ?? null;
      },
      stream: async (ref) => {
        const bytes = objects.get(ref);
        return bytes === undefined ? null : new Response(bytes).body;
      },
      put: async () => assert.fail("boot capture must not write artifacts"),
    },
  };
}

test("boot control payload size is independent of UI asset size", async () => {
  const small = await fixture(new Uint8Array(8));
  const large = await fixture(new Uint8Array(1024 * 1024));
  const [smallUi, largeUi] = await Promise.all([
    readBootUi(small.store, small.release),
    readBootUi(large.store, large.release),
  ]);
  assert.equal(smallUi.base, "./");
  assert.equal(largeUi.base, "./");
  assert.equal(JSON.stringify(largeUi).length, JSON.stringify(smallUi).length);
  assert.ok(!JSON.stringify(largeUi).toLowerCase().includes("base64"));
  assert.deepEqual(Object.keys(largeUi.assets[0]).sort(), [
    "artifactRef",
    "contentType",
    "digest",
    "path",
  ]);
  assert.notEqual(smallUi.assets[0].digest, largeUi.assets[0].digest);
  assert.equal(smallUi.assets[0].digest, await sha256(new Uint8Array(8)));
  assert.equal(
    largeUi.assets[0].digest,
    await sha256(new Uint8Array(1024 * 1024)),
  );
});

test("capturing boot UI reads release metadata but not asset bodies", async () => {
  const fixtureData = await fixture(new Uint8Array(4096));
  const ui = await readBootUi(fixtureData.store, fixtureData.release);
  assert.equal(ui.assets.length, 1);
  assert.deepEqual(fixtureData.calls, [
    fixtureData.release.artifact.artifactRef,
    parseArtifactRef("artifact:ui-manifest"),
  ]);
});

test("HTML boot capture references its body without eagerly reading it", async () => {
  const fixtureData = await htmlFixture(
    new TextEncoder().encode("<!doctype html><p>candidate</p>"),
  );
  const ui = await readBootUi(fixtureData.store, fixtureData.release);
  assert.equal(ui.base, "./");
  assert.deepEqual(ui.assets, [
    {
      path: "/index.html",
      contentType: "text/html; charset=utf-8",
      artifactRef: "artifact:html",
      digest: await sha256(
        new TextEncoder().encode("<!doctype html><p>candidate</p>"),
      ),
    },
  ]);
  assert.deepEqual(fixtureData.calls, [
    fixtureData.release.artifact.artifactRef,
  ]);
});
