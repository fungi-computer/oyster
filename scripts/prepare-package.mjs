// Stage this package's public files without mutating its workspace manifest.
// pnpm resolves workspace dependency versions when it packs publishConfig.directory.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as z from "zod";

const root = new URL("../", import.meta.url);
const destination = new URL(".botanical/package/", root);
const manifest = z
  .record(z.string(), z.unknown())
  .parse(JSON.parse(await readFile(new URL("package.json", root), "utf8")));
delete manifest.scripts;
delete manifest.botanical;
delete manifest.devDependencies;
delete manifest.publishConfig;
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const path of [
  "dist",
  "docs/api",
  "docs/media",
  "examples/standalone",
  "examples/git",
  "docs/site/agent-quickstart.mdx",
  "README.md",
  "LICENSE",
]) {
  await cp(new URL(path, root), new URL(path, destination), {
    recursive: true,
  });
}
await writeFile(
  new URL("package.json", destination),
  JSON.stringify(manifest, null, 2) + "\n",
);
