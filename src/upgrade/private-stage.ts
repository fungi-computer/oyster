import { nanoid } from "@fungi.computer/cairn";

/** Private safety ceilings; exceeding one refuses a stage rather than omitting data. */
const partBytes = 8 * 1024 * 1024;
const maxParts = 10_000;

type ArchivedPart = Readonly<{
  name: string;
  key: string;
  size: number;
  sha256: string;
}>;

async function digest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Stage supplied sources in a separate, private R2 binding. Even a complete
 * stage is unverified: there is no proven no-writes window or DO/Git inventory.
 * The real manifest belongs to the later certification step, not this module.
 */
export async function stageUpgradeSources(
  input: Readonly<{
    releases: R2Bucket;
    privateBucket: R2Bucket;
    snapshots: () => AsyncIterable<
      | Readonly<{ kind: "part"; name: string; bytes: Uint8Array }>
      | Readonly<{
          kind: "complete";
          partCount: number;
          unreachable: readonly string[];
        }>
    >;
    oldWorkerName: string;
    oldVersion: "0.0.1" | "0.1.0" | "0.2.0";
  }>,
): Promise<Readonly<{ stageKey: string; sha256: string }>> {
  if (input.releases === input.privateBucket)
    throw new Error("The archive must have a separate private R2 binding");

  // A retry gets a fresh namespace: an old unsealed attempt can never be
  // completed by a later invocation.
  const prefix = `oyster-upgrade/${nanoid()}`;
  const parts: ArchivedPart[] = [];
  const store = async (name: string, bytes: ArrayBuffer): Promise<void> => {
    if (parts.length >= maxParts || bytes.byteLength > partBytes)
      throw new Error("Archive safety ceiling reached; nothing was certified");
    const key = `${prefix}/part-${String(parts.length)}`;
    if ((await input.privateBucket.put(key, bytes)) === null)
      throw new Error("Private archive write refused");
    const saved = await input.privateBucket.get(key);
    if (saved === null) throw new Error("Private archive readback failed");
    const readback = await saved.arrayBuffer();
    const sha256 = await digest(bytes);
    if (
      readback.byteLength !== bytes.byteLength ||
      (await digest(readback)) !== sha256
    )
      throw new Error("Private archive checksum mismatch");
    parts.push({ name, key, size: bytes.byteLength, sha256 });
  };

  let cursor: string | undefined;
  let pages = 0;
  let truncated = true;
  while (truncated) {
    if (++pages > maxParts)
      throw new Error("R2 listing safety ceiling reached");
    const page = await input.releases.list({ cursor });
    for (const object of page.objects) {
      if (!Number.isSafeInteger(object.size) || object.size < 0)
        throw new Error("Invalid R2 object size");
      for (
        let offset = 0;
        offset < object.size || offset === 0;
        offset += partBytes
      ) {
        const length = Math.min(partBytes, object.size - offset);
        const source = await input.releases.get(
          object.key,
          length === 0 ? undefined : { range: { offset, length } },
        );
        if (source?.etag !== object.etag)
          throw new Error("R2 object changed during archive");
        const bytes = await source.arrayBuffer();
        if (bytes.byteLength !== length)
          throw new Error("Incomplete R2 object read");
        await store(`R2:${object.key}:${String(offset)}`, bytes);
      }
    }
    if (page.truncated) {
      const next = page.cursor;
      if (next.length === 0 || next === cursor)
        throw new Error("Incomplete R2 listing");
      cursor = next;
    } else {
      truncated = false;
    }
  }

  let completed:
    Readonly<{ partCount: number; unreachable: readonly string[] }> | undefined;
  let snapshotCount = 0;
  let registryPresent = false;
  for await (const record of input.snapshots()) {
    if (completed !== undefined) throw new Error("Incomplete DO snapshot");
    if (record.kind === "part") {
      const bytes = record.bytes;
      if (!(bytes instanceof Uint8Array))
        throw new Error("Invalid DO snapshot bytes");
      await store(`DO:${record.name}`, Uint8Array.from(bytes).buffer);
      if (record.name === "registry" || record.name.startsWith("registry/"))
        registryPresent = true;
      snapshotCount += 1;
    } else {
      completed = record;
    }
  }
  const unreachable = completed?.unreachable;
  if (unreachable === undefined || completed?.partCount !== snapshotCount)
    throw new Error("Incomplete DO snapshot");
  if (!registryPresent) throw new Error("Old Oyster registry snapshot missing");

  const stage = {
    kind: "oyster-unverified-stage-v1",
    oldWorkerName: input.oldWorkerName,
    oldVersion: input.oldVersion,
    parts,
    unreachable,
  };
  const stageKey = `${prefix}/stage.json`;
  const bytes = new TextEncoder().encode(JSON.stringify(stage));
  const sha256 = await digest(Uint8Array.from(bytes).buffer);
  if ((await input.privateBucket.put(stageKey, bytes)) === null)
    throw new Error("Private archive stage write refused");
  const saved = await input.privateBucket.get(stageKey);
  if (saved === null || (await digest(await saved.arrayBuffer())) !== sha256)
    throw new Error("Private archive stage checksum mismatch");
  return { stageKey, sha256 };
}
