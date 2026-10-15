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
