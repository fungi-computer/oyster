import { CapabilityFailed, Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import type { BrowserBinding } from "../../src/browser/index.js";
import { standaloneBrowserSource } from "../../src/standalone/browser.js";

const identity = () => ({
  teamId: "https://oyster.test",
  agentId: "agent-one",
});
const session = { sessionId: "session-one" };
const acquisitionContext = () => ({
  signal: new AbortController().signal,
  invalidate: () => {
    throw new Error("This fixed browser source must not invalidate");
  },
});

function recordingBinding() {
  const calls: string[] = [];
  const binding: BrowserBinding = {
    fetch: (url) => {
      calls.push(url);
      return Promise.resolve(new Response(null, { status: 503 }));
    },
  };
  return { binding, calls };
}

describe("standalone browser capability source", () => {
  it("offers no modules when the host has no BROWSER binding", async () => {
    const source = standaloneBrowserSource(undefined, identity);
    const acquired = await source.acquire({
      ...acquisitionContext(),
      session,
    });
    try {
      expect(acquired.snapshot.modules).toEqual([]);
    } finally {
      await acquired.release();
    }
  });

  it("offers exactly the eight driven cloudBrowser operations on a binding", async () => {
    const { binding, calls } = recordingBinding();
    const source = standaloneBrowserSource(binding, identity);
    const acquired = await source.acquire({
      ...acquisitionContext(),
      session,
    });
    try {
      expect(acquired.snapshot.modules).toHaveLength(1);
      const runtime = await Mycelium.make({
        modules: acquired.snapshot.modules,
        session,
        sandbox: directSandbox(() =>
          Promise.reject(new Error("Catalog discovery must not execute")),
        ),
      });
      try {
        const lease = await runtime.acquire();
        try {
          const listing = lease.catalog.list({
            namespace: "cloudBrowser",
            limit: 50,
          });
          expect(listing.results.map((operation) => operation.path)).toEqual([
            "cloudBrowser.click",
            "cloudBrowser.close",
            "cloudBrowser.navigate",
            "cloudBrowser.open",
            "cloudBrowser.press",
            "cloudBrowser.scroll",
            "cloudBrowser.snapshot",
            "cloudBrowser.type",
          ]);
          expect(listing.total).toBe(8);
          expect(listing.nextCursor).toBeNull();
          expect(calls).toEqual([]);
        } finally {
          await lease.release();
        }
      } finally {
        await runtime.close();
      }
    } finally {
      await acquired.release();
    }
  });

  it("offers no modules to a session-free caller even with a binding", async () => {
    const { binding, calls } = recordingBinding();
    const acquired = await standaloneBrowserSource(binding, identity).acquire(
      acquisitionContext(),
    );
    try {
      expect(acquired.snapshot.modules).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      await acquired.release();
    }
  });

  it.each([
    ["loopback IP", "http://127.0.0.1/"],
    ["embedded credentials", "https://u:p@example.com/"],
  ])(
    "refuses %s before the BROWSER provider sees an open",
    async (_label, url) => {
      const { binding, calls } = recordingBinding();
      const acquired = await standaloneBrowserSource(binding, identity).acquire(
        {
          ...acquisitionContext(),
          session,
        },
      );
      try {
        let failure: unknown;
        let executions = 0;
        const runtime = await Mycelium.make({
          modules: acquired.snapshot.modules,
          session,
          // The maintained trusted test sandbox invokes the real registered
          // operation, not a browser door replacement or a WebSocket imitation.
          sandbox: directSandbox(async (bindings) => {
            executions += 1;
            const open = bindings.cloudBrowser?.open;
            if (open === undefined)
              throw new Error("Expected the registered cloudBrowser.open");
            // Keep the refusal itself; the provider fetch count is checked below.
            failure = await open({ url }).then(
              () => undefined,
              (error: unknown) => error,
            );
            return null;
          }),
        });
        try {
          const lease = await runtime.acquire();
          try {
            const prepared = await Effect.runPromise(
              lease.executeTool.prepare({
                type: "toolCall",
                id: "refused-browser-open",
                name: "execute",
                arguments: {
                  code: `return await env.cloudBrowser.open(${JSON.stringify({ url })})`,
                },
              }),
            );
            const parts = await Effect.runPromise(
              Stream.runCollect(prepared.execute()),
            );
            expect(parts).toEqual([
              {
                type: "result",
                result: {
                  content: [{ type: "text", text: "null" }],
                  isError: false,
                },
              },
            ]);
            expect(executions).toBe(1);
            expect(calls).toEqual([]);
            expect(failure).toBeInstanceOf(CapabilityFailed);
            expect(failure).toMatchObject({
              namespace: "cloudBrowser",
              operation: "open",
              cause: { kind: "InvalidInput" },
            });
          } finally {
            await lease.release();
          }
        } finally {
          await runtime.close();
        }
      } finally {
        await acquired.release();
      }
    },
  );
});
