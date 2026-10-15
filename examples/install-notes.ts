// Pack the Notes App from this checkout's current commit and install it on a
// running Oyster as installation `notes`. Run from packages/oyster:
//
//   OYSTER_URL=http://127.0.0.1:8787 OYSTER_OWNER_KEY=… \
//     pnpm exec tsx examples/install-notes.ts
//
// The build reads committed files only: commit an edit before packing it.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { installRelease, packRelease } from "@fungi.computer/oyster/pack";

const url = process.env.OYSTER_URL;
const key = process.env.OYSTER_OWNER_KEY;
if (url === undefined || key === undefined)
  throw new Error("Set OYSTER_URL and OYSTER_OWNER_KEY");

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const repository = git("rev-parse", "--show-toplevel");
const out = await mkdtemp(join(tmpdir(), "oyster-notes-"));
try {
  await packRelease({
    appId: "app_notes",
    sourceDirectory: repository,
    sourceRevision: `git:${git("-C", repository, "rev-parse", "HEAD")}`,
    packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    recipe: {
      entry: "packages/oyster/examples/notes-app/ui/index.html",
      assets: {
        maxManifestBytes: 1_048_576,
        maxObjects: 1024,
        maxObjectBytes: 16_777_216,
        maxTotalBytes: 67_108_864,
      },
      assetBase: "./",
      maxOutputBytes: 67_108_864,
      backend: {
        entry: "packages/oyster/examples/notes-app/backend/index.ts",
        exportName: "Notes",
        compatibilityDate: "2026-09-04",
        runtime: { kind: "durable-facet", stateSchema: 1 },
      },
    },
    outDirectory: join(out, "release"),
  });
  const response = await installRelease({
    directory: join(out, "release"),
    url,
    key,
    installationId: "notes",
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(`Install refused (${String(response.status)}): ${body}`);
  console.log(`installed notes: ${String(response.status)} ${body}`);
} finally {
  await rm(out, { recursive: true, force: true });
}
