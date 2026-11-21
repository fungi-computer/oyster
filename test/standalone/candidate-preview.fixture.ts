import { backendMediaType } from "@fungi.computer/puffball/backend";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { parseArtifactRef, parseSha256Digest } from "@fungi.computer/puffball";
import { assetBuildMediaType } from "@fungi.computer/puffball/assets";
import { parseRelease, sha256 } from "../../src/release.js";
import { defaultTenant } from "../../src/tenant.js";
import { standaloneCandidatePreview } from "../../src/standalone/candidate-preview.js";
import type { OysterBuildView } from "../../src/app-builds.js";
import type { OwnerPrincipal } from "../../src/authorization.js";

export const previewOrigin = "https://oyster.example";
export const previewSecret =
  "candidate-preview-test-secret-at-least-32-characters";

/** Faithful persisted build/artifact ports, with no installation or backend runtime. */
export async function candidatePreviewFixture({
  files = [
    {
      path: "/index.html",
      contentType: "text/html",
      text: "<!doctype html><body>candidate</body>",
    },
  ],
  origin = previewOrigin,
  appName = "Garden Planner",
  ui: uiKind = "assets",
  backend: withBackend = false,
}: Readonly<{
  files?: readonly { path: string; contentType: string; text: string }[];
  origin?: string;
  appName?: string;
  ui?: "html" | "assets" | "none";
  backend?: boolean;
}> = {}) {
  const objects = new Map<string, Uint8Array>();
  const put = async (bytes: Uint8Array) => {
    const digest = parseSha256Digest(await sha256(bytes));
    const artifactRef = parseArtifactRef(`artifact:sha256-${digest.slice(7)}`);
    objects.set(artifactRef, bytes);
    return {
      artifactRef,
      digest,
      byteLength: bytes.byteLength,
      version: "candidate",
    };
  };
  const assets = [];
  for (const file of files)
    assets.push({
      path: file.path,
      contentType: file.contentType,
      ...(await put(new TextEncoder().encode(file.text))),
    });
  const first = assets[0];
  if (first === undefined) throw new Error("Fixture requires an entry");
  const ui =
    uiKind === "html"
      ? first
      : await put(
          new TextEncoder().encode(
            JSON.stringify({
              format: "fungi-assets-v1",
              base: "./",
              assets,
            }),
          ),
        );
  const backend = withBackend
    ? {
        ...(await put(
          new TextEncoder().encode(
            JSON.stringify({
              runtime: { kind: "durable-facet", stateSchema: 1 },
              compatibilityDate: "2026-09-25",
              exportName: "Guest",
              code: "throw new Error('Preview must not execute the backend'); export class Guest {}",
            }),
          ),
        )),
        mediaType: backendMediaType,
      }
    : null;
  const root = await put(
    new TextEncoder().encode(
      JSON.stringify(
        createAppBuild(
          uiKind === "none"
            ? null
            : {
                artifactRef: ui.artifactRef,
                digest: ui.digest,
                byteLength: ui.byteLength,
                version: ui.version,
                mediaType:
                  uiKind === "html"
                    ? "text/html; charset=utf-8"
                    : assetBuildMediaType,
              },
          backend,
          {
            displayName: appName,
            capabilities: ["computer.execute"],
            handlers: [],
            roles: [],
          },
        ),
      ),
    ),
  );
  const release = parseRelease({
    appId: "app_preview",
    releaseId: "rel_preview",
    artifact: {
      artifactRef: root.artifactRef,
      artifactDigest: root.digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: root.digest,
        buildRecipeDigest: root.digest,
      },
    },
  });
  let build: OysterBuildView | null = {
    jobId: "job-fixture",
    appId: release.appId,
    releaseId: release.releaseId,
    sourceRevision: release.artifact.provenance.sourceRevision,
    status: "succeeded",
    detail: null,
    release,
    installation: null,
  };
  let owner: OwnerPrincipal | null = {
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  };
  const options = {
    scope: { tenantId: defaultTenant, origin },
    secret: previewSecret,
    owner: () => Promise.resolve(owner),
    readBuild: (id: string) =>
      Promise.resolve(id === build?.jobId ? build : null),
    artifacts: {
      get: (ref: string) => Promise.resolve(objects.get(ref) ?? null),
      put: () =>
        Promise.reject(new Error("Preview must never write artifacts")),
    },
  };
  return {
    options,
    preview: standaloneCandidatePreview(options),
    objects,
    release,
    setBuild: (next: OysterBuildView | null) => {
      build = next;
    },
    build: () => build,
    setOwner: (next: OwnerPrincipal | null) => {
      owner = next;
    },
  };
}
