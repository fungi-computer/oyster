import type { UiConnection } from "@fungi.computer/knapsack";
import { Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { vi } from "vitest";
import { z } from "zod";

/** Keep Node's actual Fetch semantics, without Vitest's DOM FormData adapter. */
export function useNativeFetchRequest(): void {
  // Vitest 4's JSDOM Request subclass spreads a Request used as RequestInit,
  // dropping its inherited method/headers. These fixtures use Node streams,
  // not DOM Blob/FormData; retain the native constructor underneath.
  vi.stubGlobal("Request", Object.getPrototypeOf(Request));
}

/** Couple an in-memory HTTP response to cancellation as native Fetch does. */
export async function fetchUiResponse(ui: UiConnection, request: Request) {
  const response = await ui.fetch(request);
  return new Response(
    response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
      signal: request.signal,
    }),
    response,
  );
}

/** Run the real Session-bound UI source through Mycelium's maintained test sandbox. */
export async function invokeUi(
  connection: UiConnection,
  sessionId: string,
  operation: "discover" | "execute",
  commandId = "stage:set-scene",
) {
  const runtime = await Mycelium.make({
    sources: [connection.source],
    session: { sessionId },
    sandbox: directSandbox(async (bindings) => {
      const method = bindings.ui?.[operation];
      if (method === undefined) throw new Error("UI operation missing");
      return method(operation === "discover" ? {} : { commandId });
    }),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "page-ui-test",
        name: "execute",
        arguments: { code: "fixture" },
      }),
    );
    const parts = await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
    );
    const text = parts[0]?.result.content[0];
    if (text?.type !== "text") throw new Error("UI result missing");
    return z.json().parse(JSON.parse(text.text));
  } finally {
    await lease.release();
    await runtime.close();
  }
}
