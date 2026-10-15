import { lstat, opendir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import * as Schema from "effect/Schema";
import { assetPathSchema } from "@fungi.computer/puffball/assets";
import type { PinnedRecipe, RawBuildOutput } from "./effect.js";
import { boundedBundlePolicy, bundledHtmlRecipe } from "./html-recipe.js";

/** Read only regular files under the captured entry's directory. No scripts,
 * dependency hydration, URL rewriting, or access to the producer's live build.
 */
export async function readBundledHtml(
  snapshot: string,
  recipe: PinnedRecipe,
): Promise<Extract<RawBuildOutput, { kind: "assets" }>> {
  const policy = recipe.assets;
  if (
    !policy ||
    !recipe.assetBase ||
    !recipe.entry.endsWith("/index.html") ||
    !boundedBundlePolicy(policy, recipe.maxOutputBytes)
  )
    throw new Error("Invalid bundled HTML policy");
  // Check every ancestor before descending: a symlink is not a bundle root.
  const parts = dirname(recipe.entry).split("/");
  let root = snapshot;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes("\\"))
      throw new Error("Invalid bundle directory");
    root = join(root, part);
    if (!(await lstat(root)).isDirectory())
      throw new Error("Bundle directory must be a captured directory");
  }
  const assets: { path: string; bytes: Uint8Array }[] = [];
  let total = 0;
  let entries = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await opendir(directory);
    for await (const child of children) {
      // Bound traversal too, including empty directories.
      if (++entries > policy.maxObjects * 2)
        throw new Error("Bundle directory count exceeds policy");
      const path = Schema.decodeUnknownSync(assetPathSchema)(
        `${prefix}/${child.name}`,
      );
      const source = join(directory, child.name);
      if (child.isDirectory()) {
        await visit(source, path);
        continue;
      }
      if (
        !child.isFile() ||
        !bundledHtmlRecipe.extensions.includes(extname(child.name))
      )
        throw new Error("Bundle contains an unsupported file type");
      if (assets.length >= policy.maxObjects)
        throw new Error("Bundle file count exceeds policy");
      const stat = await lstat(source);
      total += stat.size;
      if (
        !stat.isFile() ||
        stat.size > policy.maxObjectBytes ||
        !Number.isSafeInteger(total) ||
        total > policy.maxTotalBytes
      )
        throw new Error("Bundle bytes exceed policy");
      const bytes = await readFile(source);
      if (bytes.byteLength !== stat.size)
        throw new Error("Bundle changed during capture");
      assets.push({ path, bytes });
    }
  };
  await visit(root, "");
  if (!assets.some((asset) => asset.path === "/index.html"))
    throw new Error("Bundle is missing its HTML entry");
  assets.sort((a, b) => a.path.localeCompare(b.path));
  return { kind: "assets", base: recipe.assetBase, assets };
}
