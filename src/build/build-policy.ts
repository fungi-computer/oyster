/**
 * The pinned workspace build policy: how a captured workspace's manifests
 * build (`package.json#fungi.build`). v2 lets a dependency name its own
 * package build script, which only an admitted Computer build runs.
 *
 * It is part of every workspace HTML recipe's toolchain, so its digest moves
 * with it, and the Computer build request carries it at the top level, where
 * a builder compiled before it existed refuses the request outright.
 */
export const workspaceBuildPolicy = "package-json-fungi-build-v2";
