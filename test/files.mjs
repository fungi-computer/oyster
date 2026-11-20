/* global Request, ReadableStream, TextEncoder, TextDecoder, console */
import assert from "node:assert/strict";
import { normalizeFilePath } from "../dist/files.js";
import { capabilityFixture } from "../dist/testing/index.js";
import { r2FileSource } from "../dist/r2-files.js";

// A small in-memory stand-in for the R2 calls the file source makes.
function memoryBucket() {
  const objects = new Map();
  let version = 0;
  const object = (key) => {
    const entry = objects.get(key);
    return entry === undefined
      ? null
      : {
          key,
          size: entry.bytes.length,
          etag: entry.etag,
          uploaded: new Date(0),
          arrayBuffer: async () => entry.bytes.buffer.slice(0),
          text: async () => new TextDecoder().decode(entry.bytes),
        };
  };
  return {
    async head(key) {
      return object(key);
    },
    async get(key) {
      return object(key);
    },
    async put(key, value, options) {
      const current = objects.get(key);
      const expected = options?.onlyIf?.etagMatches;
      if (expected !== undefined && current?.etag !== expected) return null;
      objects.set(key, { bytes: new Uint8Array(value), etag: `e${++version}` });
      return object(key);
    },
    async list({ prefix, delimiter }) {
      const folders = new Set();
      const files = [];
      for (const key of [...objects.keys()].sort()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(delimiter);
        if (cut < 0) files.push(object(key));
        else folders.add(prefix + rest.slice(0, cut + 1));
      }
      return {
        objects: files,
        delimitedPrefixes: [...folders],
        truncated: false,
      };
    },
  };
}

assert.equal(normalizeFilePath("/a//b/./c"), "/a/b/c");
assert.equal(normalizeFilePath("/a/../b"), null);
assert.equal(normalizeFilePath("relative"), null);
assert.equal(normalizeFilePath("/"), "/");

const source = r2FileSource(memoryBucket(), "workspace/");
const encode = (text) => new TextEncoder().encode(text);
await source.write("/notes/a.md", encode("# A"));
await source.mkdir("/empty");
assert.deepEqual(
  (await source.list("/", 10, 0)).entries.map((entry) => [
    entry.name,
    entry.type,
  ]),
  [
    ["empty", "directory"],
    ["notes", "directory"],
  ],
);
assert.deepEqual((await source.list("/empty", 10, 0)).entries, []);
assert.equal(await source.list("/missing", 10, 0), null);
assert.equal(new TextDecoder().decode(await source.read("/notes/a.md")), "# A");
assert.deepEqual(await source.replace("/notes/a.md", "stale", "# B"), {
  kind: "conflict",
});
assert.deepEqual(await source.replace("/notes/a.md", "# A", "# B"), {
  kind: "replaced",
  path: "/notes/a.md",
  bytes: 3,
});

// Routes: visitors are refused; the owner reaches files; paths cannot escape.
const { app: routes } = await capabilityFixture({
  fileSource: source,
  capabilities: ["computer.list", "computer.readFile", "computer.writeFile"],
});
const call = (path, init = {}, who = "owner") =>
  routes.fetch(
    new Request(`https://oyster.test${path}`, {
      ...init,
      headers: {
        ...init.headers,
        "x-who": who,
        "X-Oyster-Installation": "capability-fixture",
      },
    }),
  );
assert.equal((await call("/files/list?path=/", {}, "anonymous")).status, 401);
assert.equal((await call("/files/list?path=/../x")).status, 400);
assert.equal(
  await (await call("/files/content?path=/notes/a.md")).text(),
  "# B",
);
assert.equal(
  (await call("/files/content?path=/n.md", { method: "PUT", body: "hi" }))
    .status,
  204,
);
const replaced = await call("/files/replace", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "/n.md", expectedContent: "no", content: "x" }),
});
assert.deepEqual(await replaced.json(), { kind: "conflict" });

// A chunked body has no Content-Length to trust: the route stops reading as
// soon as it passes the limit, instead of buffering all of it first.
const chunkedBody = (chunks, chunkBytes, prefix = "") => {
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulled === 0 && prefix !== "") controller.enqueue(encode(prefix));
      if (pulled === chunks) return controller.close();
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(97));
    },
  });
  return { stream, pulled: () => pulled };
};
const MiB = 1024 * 1024;
const upload = chunkedBody(40, MiB);
const tooLarge = await call("/files/content?path=/big.bin", {
  method: "PUT",
  body: upload.stream,
  duplex: "half",
});
assert.equal(tooLarge.status, 413);
assert.ok(upload.pulled() < 30, `read ${String(upload.pulled())} MiB`);
assert.equal(await source.read("/big.bin"), null);
const edit = chunkedBody(80, MiB, '{"path":"/n.md","expectedContent":"');
const editTooLarge = await call("/files/replace", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: edit.stream,
  duplex: "half",
});
assert.equal(editTooLarge.status, 413);
assert.ok(edit.pulled() < 60, `read ${String(edit.pulled())} MiB`);
const folder = await call("/files/mkdir", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: `/${"d".repeat(16 * 1024)}` }),
});
assert.equal(folder.status, 413);
console.log("oyster files: ok");
