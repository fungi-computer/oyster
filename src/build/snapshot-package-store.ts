import { isAbsolute } from "node:path";

/** Frozen hydration policy. Cached bytes are verified and copied into each snapshot. */
export function frozenSnapshotInstallArguments(packageStoreDirectory?: string) {
  if (packageStoreDirectory !== undefined && !isAbsolute(packageStoreDirectory))
    throw new Error("Publisher package store must be an absolute host path");
  return [
    "install",
    "--prod=false",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    packageStoreDirectory === undefined
      ? "--package-import-method=auto"
      : "--package-import-method=copy",
    "--virtual-store-dir=node_modules/.pnpm",
    `--store-dir=${packageStoreDirectory ?? ".publisher-store"}`,
    "--verify-store-integrity=true",
    "--config.enable-global-virtual-store=false",
    "--reporter=append-only",
  ];
}

/**
 * `pnpm run` for one declared package build script, which follows `--` so
 * pnpm selects that literal name (never an option or a `/pattern/`). pnpm 11
 * runs `pre<name>`/`post<name>` by default, and installs first when it judges
 * dependencies stale, running their lifecycle scripts; a captured `.npmrc` or
 * `pnpm-workspace.yaml` may also ask for either. These command line settings
 * win, so the frozen, script-free install stays the only install. What the
 * named script itself runs is that package's own build.
 */
export const packageScriptArguments = Object.freeze([
  "run",
  "--config.enable-pre-post-scripts=false",
  "--config.verify-deps-before-run=false",
  "--",
]);
