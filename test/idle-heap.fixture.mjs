// Child of idle-heap.test.mjs, run with --expose-gc: evaluate one Worker
// bundle and print the V8 heap its module state retains. Node keeps module
// source text outside the heap, as celld does for a Latin-1 bundle, so the
// delta is the evaluated state alone.
import { register } from "node:module";
import process from "node:process";
import { URL, pathToFileURL } from "node:url";
import { z } from "zod";

register(new URL("./idle-heap-hooks.fixture.mjs", import.meta.url));
const [bundle] = process.argv.slice(2);
if (bundle === undefined)
  throw new Error("usage: idle-heap.fixture.mjs <bundle>");
const gc = z
  .function({ error: "idle-heap.fixture.mjs needs --expose-gc" })
  .parse(globalThis.gc);

gc();
const before = process.memoryUsage().heapUsed;
const worker = await import(pathToFileURL(bundle).href);
gc();
gc();
const after = process.memoryUsage().heapUsed;
// Keep the module namespace reachable until the second measurement.
process.stdout.write(
  JSON.stringify({
    exports: Object.keys(worker).length,
    heapBytes: after - before,
  }),
);
