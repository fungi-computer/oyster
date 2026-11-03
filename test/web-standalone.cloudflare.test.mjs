/* global AbortController, Request, Response */
import { Mycelium } from "@fungi.computer/mycelium";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { standaloneWebSource } from "../src/standalone/web.ts";

const session = { sessionId: "session-one" };

/** Run `body(web)` against the real registered `web` module of a standalone host. */
async function withWeb(env, body) {
  const acquired = await standaloneWebSource(env).acquire({
    signal: new AbortController().signal,
    invalidate: () => undefined,
    session,
  });
  try {
    const runtime = await Mycelium.make({
      modules: acquired.snapshot.modules,
      session,
      sandbox: directSandbox(async (bindings) => {
        if (bindings.web === undefined)
          throw new Error("Expected the registered web module");
        return await body(bindings.web);
      }),
    });
    try {
      const lease = await runtime.acquire();
      try {
        const listing = lease.catalog.list({ namespace: "web", limit: 50 });
        const prepared = await Effect.runPromise(
          lease.executeTool.prepare({
            type: "toolCall",
            id: "web-call",
            name: "execute",
            arguments: { code: "return null" },
          }),
        );
        await Effect.runPromise(Stream.runCollect(prepared.execute()));
        return { listing };
      } finally {
        await lease.release();
      }
    } finally {
      await runtime.close();
    }
  } finally {
    await acquired.release();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("standalone web module", () => {
  it("offers web.fetch and web.search through tool discovery", async () => {
    const { listing } = await withWeb({}, () => null);
    expect(listing.results.map((operation) => operation.path)).toEqual([
      "web.fetch",
      "web.search",
    ]);
  });

  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/",
    "http://[::1]/",
  ])("refuses %s without opening a connection", async (url) => {
    const network = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", network);
    let failure;
    await withWeb({}, async (web) => {
      failure = await web.fetch({ url }).then(
        () => undefined,
        (error) => error,
      );
      return null;
    });
    expect(String(failure?.message ?? failure)).toContain("disallowed_url");
    expect(network).not.toHaveBeenCalled();
  });

  it("states that search is not configured without a Parallel key", async () => {
    const network = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", network);
    let failure;
    await withWeb({}, async (web) => {
      failure = await web.search({ objective: "ferns" }).then(
        () => undefined,
        (error) => error,
      );
      return null;
    });
    expect(String(failure?.message ?? failure)).toContain("not configured");
    expect(network).not.toHaveBeenCalled();
  });

  it("searches Parallel with the owner's key held by Veil, not the Agent", async () => {
    const calls = [];
    vi.stubGlobal("fetch", (input, init) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        apiKey: request.headers.get("x-api-key"),
      });
      return Promise.resolve(
        Response.json({
          results: [
            {
              url: "https://ferns.example/care",
              title: "Fern care",
              excerpts: ["Ferns like shade."],
            },
          ],
        }),
      );
    });
    let output;
    await withWeb({ PARALLEL_API_KEY: "parallel-secret-key" }, async (web) => {
      output = await web.search({ objective: "fern care" });
      return null;
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.parallel.ai/v1/search");
    expect(calls[0].apiKey).toContain("parallel-secret-key");
    expect(JSON.stringify(output)).not.toContain("parallel-secret-key");
    expect(output.results[0]).toMatchObject({
      url: "https://ferns.example/care",
    });
  });
});
