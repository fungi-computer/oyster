import { expect, it, vi } from "vitest";
import { parseSha256Digest } from "@fungi.computer/puffball";
import { edgeVerifiedObjectCache } from "../src/cloudflare.js";

const digest = parseSha256Digest(`sha256:${"a".repeat(64)}`);

/** The zone cache's match/put over memory, keyed by request URL. */
function memoryCache(failPut = false) {
  const entries = new Map<string, Response>();
  return {
    entries,
    match: (request: RequestInfo | URL) =>
      Promise.resolve(
        entries.get(new Request(request).url)?.clone() ?? undefined,
      ),
    put: (request: RequestInfo | URL, response: Response) => {
      if (failPut) return Promise.reject(new TypeError("Cache full"));
      entries.set(new Request(request).url, response);
      return Promise.resolve();
    },
  };
}

it("keeps verified bytes under a digest key on the tenant origin", async () => {
  const cache = memoryCache();
  const edge = edgeVerifiedObjectCache(cache, "https://oyster.test");
  expect(await edge.match(digest)).toBeNull();
  expect(
    await edge.put(digest, new TextEncoder().encode("<p>verified</p>")),
  ).toBe("stored");
  expect([...cache.entries.keys()]).toEqual([
    `https://oyster.test/_oyster/verified/${digest}`,
  ]);
  const hit = await edge.match(digest);
  expect(await new Response(hit).text()).toBe("<p>verified</p>");
});

it("logs a failed cache write and leaves the next read a miss", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const edge = edgeVerifiedObjectCache(
      memoryCache(true),
      "https://oyster.test",
    );
    expect(await edge.put(digest, new Uint8Array([1]))).toBe("unstored");
    expect(error).toHaveBeenCalledWith("Verified object cache write failed", {
      digest,
      failure: "TypeError",
    });
    expect(await edge.match(digest)).toBeNull();
  } finally {
    error.mockRestore();
  }
});
