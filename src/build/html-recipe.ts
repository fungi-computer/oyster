import type { AssetBuildPolicy } from "@fungi.computer/puffball/assets";

/** Engine/toolchain-independent input: an already bundled, captured directory.
 * The producer owns compilation; Publisher never discovers its build scripts.
 * These ceilings cannot be raised by a publication request.
 */
export const bundledHtmlRecipe = Object.freeze({
  kind: "bundled-html" as const,
  toolchain: Object.freeze({ recipe: "captured-bundled-html-v1" }),
  limits: Object.freeze({
    maxManifestBytes: 1_048_576,
    maxObjects: 1024,
    maxObjectBytes: 16_777_216,
    maxTotalBytes: 67_108_864,
  }),
  extensions: Object.freeze([
    ".html",
    ".js",
    ".mjs",
    ".css",
    ".json",
    ".gz",
    ".wasm",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".avif",
    ".gif",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".mp3",
    ".ogg",
    ".wav",
    ".mp4",
    ".webm",
    ".txt",
  ]),
});

/** Requests may tighten the catalog bounds, never raise them. */
export function boundedBundlePolicy(
  policy: AssetBuildPolicy,
  maxOutputBytes: number,
): boolean {
  const limits = bundledHtmlRecipe.limits;
  return (
    maxOutputBytes <= limits.maxTotalBytes &&
    policy.maxTotalBytes <= maxOutputBytes &&
    policy.maxManifestBytes <= limits.maxManifestBytes &&
    policy.maxObjects <= limits.maxObjects &&
    policy.maxObjectBytes <= limits.maxObjectBytes &&
    policy.maxTotalBytes <= limits.maxTotalBytes
  );
}
