import type { CapabilitySource } from "@fungi.computer/mycelium";
import type { VeilBindings } from "@fungi.computer/veil/gatekeeper";
import { configuredPublicFetch } from "@fungi.computer/veil/public-fetch";
import { causeClass } from "../cause-class.js";
import { createWebSource, parallelWebSearch } from "../web/index.js";

/**
 * A standalone Oyster's `web` module. Page reads go through Veil's
 * public-fetch door exactly as the Hub's do (one resolve, non-public addresses
 * refused, redirects rechecked). Search is Parallel through Veil's route when
 * the owner configured `PARALLEL_API_KEY`, else an explicit refusal. There is
 * no credit ledger here: the owner's Parallel account pays directly.
 */
export function standaloneWebSource(env: VeilBindings): CapabilitySource {
  return createWebSource({
    // The sockets door loads when a page is first read, so hosts that never
    // fetch (and Node test hosts) never resolve the Workers-only module.
    get: async (request) => {
      const { connect } = await import("cloudflare:sockets");
      return configuredPublicFetch({
        connect,
        fetch: (input, init) => fetch(input, init),
      }).get(request);
    },
    search: parallelWebSearch(env, {
      fetch: (input, init) => fetch(input, init),
      report: (event) => {
        // Code-only: never a URL, provider body or key.
        console.warn("Oyster web search", {
          kind: event.kind,
          status: event.status,
          cause: causeClass(event.cause),
        });
      },
    }),
  });
}
