import { isAbsolute, relative, resolve, sep } from "node:path";

/** Whether `path` names the captured snapshot root or a path inside it. */
export function isInsideSnapshot(snapshot: string, path: string): boolean {
  const suffix = relative(snapshot, resolve(path));
  return (
    suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  );
}
