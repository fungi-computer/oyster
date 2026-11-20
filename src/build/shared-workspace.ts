import { realpathSync } from "node:fs";
import { join } from "node:path";
import { isInsideSnapshot } from "./snapshot-programs/snapshot-path.js";

/**
 * The one TypeScript compiler every App of a shared pass resolves. The
 * dependency compiler loads TypeScript from each App's own `node_modules`, so
 * one App's emit stands for another's only when both resolve the same
 * compiler inside the captured snapshot; anything else fails closed.
 */
export function sharedTypeScriptCompiler(
  snapshotPath: string,
  appDirectories: readonly string[],
): string {
  const compilers = new Set(
    appDirectories.map((directory) =>
      realpathSync(join(snapshotPath, directory, "node_modules/typescript")),
    ),
  );
  const [compiler] = compilers;
  if (
    compilers.size !== 1 ||
    compiler === undefined ||
    !isInsideSnapshot(snapshotPath, compiler)
  )
    throw new Error(
      "A shared pass requires every App to resolve the same TypeScript compiler",
    );
  return compiler;
}
