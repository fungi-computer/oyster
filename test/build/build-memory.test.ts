import { expect, it } from "vitest";
import {
  buildHeapMib,
  defaultBuildConcurrency,
  machineMemoryMib,
} from "../../src/build/build-memory.js";

const gib = 1024;

it("keeps the 4 GiB compiler heap wherever it fits and shrinks it on a small Computer", () => {
  for (const memory of [8 * gib, 12 * gib, 16 * gib])
    expect(buildHeapMib(memory)).toBe(4096);
  expect(buildHeapMib(4 * gib)).toBe(2730);
});

it("runs one build per 6 GiB, two at most by default and one at least", () => {
  expect(defaultBuildConcurrency(4 * gib)).toBe(1);
  expect(defaultBuildConcurrency(8 * gib)).toBe(1);
  expect(defaultBuildConcurrency(12 * gib)).toBe(2);
  expect(defaultBuildConcurrency(16 * gib)).toBe(2);
  expect(defaultBuildConcurrency(64 * gib)).toBe(2);
});

it("reads this machine's memory as a positive number of MiB", () => {
  expect(machineMemoryMib()).toBeGreaterThan(0);
});
