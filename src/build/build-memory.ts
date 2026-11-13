import { totalmem } from "node:os";

const mebibyte = 1024 * 1024;
/** What one Bonsai-sized compile wants: a 4 GiB heap. */
const preferredHeapMib = 4096;
/** Heap plus pnpm and esbuild beside it: 4 GiB and 2 GiB. */
const memoryPerBuildMib = 6144;
/** Builds a machine runs at once unless the caller asks for more. */
const preferredBuildConcurrency = 2;

/**
 * The memory this process may use, in MiB: its cgroup limit when it has one,
 * else the machine's. A Computer is a VM of 4, 8 or 16 GiB (or a 12 GiB
 * container), so the build must read it rather than assume one.
 */
export function machineMemoryMib(): number {
  const constrained = process.constrainedMemory();
  const bytes =
    constrained > 0 && constrained < totalmem() ? constrained : totalmem();
  return Math.floor(bytes / mebibyte);
}

/** The compiler heap ceiling: 4 GiB, or two thirds of a smaller machine. */
export function buildHeapMib(memoryMib: number): number {
  return Math.min(preferredHeapMib, Math.floor((memoryMib * 2) / 3));
}

/**
 * How many builds fit at once: one per 6 GiB, at most two by default (a third
 * is allowed only when asked for), at least one.
 */
export function defaultBuildConcurrency(memoryMib: number): number {
  return Math.max(
    1,
    Math.min(
      preferredBuildConcurrency,
      Math.floor(memoryMib / memoryPerBuildMib),
    ),
  );
}
