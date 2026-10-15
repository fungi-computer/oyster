import type { FileEntry, FileSource } from "./files.js";

/** Files in an R2 bucket under `prefix` (one workspace per prefix). */
export function r2FileSource(bucket: R2Bucket, prefix: string): FileSource {
  const key = (path: string) => `${prefix}${path.slice(1)}`;
  const dirKey = (path: string) => (path === "/" ? prefix : `${key(path)}/`);
  return {
    async list(path, limit, offset) {
      const base = dirKey(path);
      const entries: FileEntry[] = [];
      let cursor: string | undefined;
      do {
        const options: R2ListOptions = { prefix: base, delimiter: "/" };
        if (cursor !== undefined) options.cursor = cursor;
        const page = await bucket.list(options);
        for (const folder of page.delimitedPrefixes)
          entries.push({
            name: folder.slice(base.length, -1),
            type: "directory",
            size: 0,
            modifiedAt: 0,
          });
        for (const object of page.objects) {
          const name = object.key.slice(base.length);
          // A directory marker is the directory itself, not an entry.
          if (name === "") continue;
          entries.push({
            name,
            type: "file",
            size: object.size,
            modifiedAt: object.uploaded.getTime(),
          });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined && entries.length < offset + limit + 1);
      // An empty, unmarked directory other than the root does not exist.
      if (
        entries.length === 0 &&
        path !== "/" &&
        (await bucket.head(dirKey(path))) === null
      )
        return null;
      entries.sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "directory"
            ? -1
            : 1,
      );
      const page = entries.slice(offset, offset + limit);
      return {
        path,
        entries: page,
        nextOffset: offset + limit < entries.length ? offset + limit : null,
      };
    },
    async read(path) {
      const object = await bucket.get(key(path));
      return object === null
        ? null
        : new Uint8Array(await object.arrayBuffer());
    },
    async write(path, content) {
      await bucket.put(key(path), content);
    },
    async mkdir(path) {
      await bucket.put(dirKey(path), new Uint8Array());
    },
    async replace(path, expectedContent, content) {
      const current = await bucket.get(key(path));
      if (current === null || (await current.text()) !== expectedContent)
        return { kind: "conflict" };
      const bytes = new TextEncoder().encode(content);
      // Compare-and-swap: R2 refuses the write if the object changed since the read.
      const written = await bucket.put(key(path), bytes, {
        onlyIf: { etagMatches: current.etag },
      });
      return written === null
        ? { kind: "conflict" }
        : { kind: "replaced", path, bytes: bytes.length };
    },
  };
}
