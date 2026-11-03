import { z } from "zod";
import {
  configuredProviderEgress,
  providerFetch,
  type VeilBindings,
} from "@fungi.computer/veil/gatekeeper";
import type { WebSearch } from "./search-contract.js";

/**
 * `web.search` through Parallel's Search API (routed through the AI Gateway
 * when the host names one). Veil owns the key and the route: this module never
 * sees the credential. Without a Parallel key the operation says so and
 * fetches nothing; it never invents results. Funding is the host's decision:
 * the Hub wraps this search in Team credits, a standalone Oyster's owner pays
 * Parallel directly.
 */

/** Excerpt characters returned to the model across all results. */
const maxChars = 12_000;

export type WebSearchErrorCode =
  "unavailable" | "insufficient_credits" | "denied" | "provider";

/** A typed search failure whose message is safe to show the model. */
export class WebSearchError extends Error {
  constructor(
    readonly code: WebSearchErrorCode,
    message: string,
  ) {
    super(`web.search ${code}: ${message}`);
    this.name = "WebSearchError";
  }
}

/** A diagnostic a host decides how to record; it never carries a body or key. */
export type WebSearchReport = Readonly<{
  kind: "response_body_unavailable";
  status: number;
  cause: unknown;
}>;

/** Parallel's `/v1/search` answer; unknown fields are ignored. */
const parallelResponseSchema = z.looseObject({
  results: z.array(
    z.looseObject({
      url: z.url(),
      title: z.string().nullish(),
      publish_date: z.string().nullish(),
      excerpts: z.array(z.string()).default([]),
    }),
  ),
});

/**
 * Parallel Search over `baseUrl`, which is Parallel or the gateway route.
 * `fetch` is Veil's `parallel` route: it carries the key, never this module.
 */
function createParallelSearch(
  options: Readonly<{
    baseUrl: string;
    fetch: typeof globalThis.fetch;
    report: (event: WebSearchReport) => void;
  }>,
): WebSearch {
  return {
    search: async (input, signal) => {
      let response: Response;
      try {
        response = await options.fetch(`${options.baseUrl}/v1/search`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            objective: input.objective,
            search_queries:
              input.queries.length > 0
                ? input.queries
                : [input.objective.slice(0, 200)],
            mode: "basic",
            max_chars_total: maxChars,
            advanced_settings: { max_results: input.maxResults },
          }),
          signal,
        });
      } catch {
        signal.throwIfAborted();
        throw new WebSearchError(
          "provider",
          "the search service is unreachable",
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new WebSearchError(
          "provider",
          `the search service answered HTTP ${String(response.status)}`,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        signal.throwIfAborted();
        options.report({
          kind: "response_body_unavailable",
          status: response.status,
          cause,
        });
        throw new WebSearchError(
          "provider",
          "the search answer could not be read",
        );
      }
      const parsed = parallelResponseSchema.safeParse(body);
      if (!parsed.success)
        throw new WebSearchError("provider", "the search answer was malformed");
      let budget = maxChars;
      return {
        results: parsed.data.results
          .slice(0, input.maxResults)
          .map((result) => {
            const excerpts: string[] = [];
            for (const excerpt of result.excerpts) {
              if (budget <= 0) break;
              excerpts.push(excerpt.slice(0, budget));
              budget -= excerpt.length;
            }
            return {
              url: result.url,
              title: result.title ?? null,
              publishDate: result.publish_date ?? null,
              excerpts,
            };
          }),
      };
    },
  };
}

/** The operation's behavior when no search provider is configured. */
export const unconfiguredWebSearch: WebSearch = {
  search: () =>
    Promise.reject(
      new WebSearchError(
        "unavailable",
        "web search is not configured on this platform; no search was run",
      ),
    ),
};

/**
 * Parallel Search for a host's Worker environment: unconfigured without
 * Veil's Parallel credential, otherwise Parallel through the AI Gateway when
 * the host names one, else directly.
 */
export function parallelWebSearch(
  env: VeilBindings,
  options: Readonly<{
    fetch: typeof globalThis.fetch;
    report: (event: WebSearchReport) => void;
  }>,
): WebSearch {
  const egress = configuredProviderEgress(env, { fetch: options.fetch });
  const baseUrl = egress.baseUrl("parallel");
  if (baseUrl === null) return unconfiguredWebSearch;
  return createParallelSearch({
    baseUrl,
    fetch: providerFetch(egress, "parallel"),
    report: options.report,
  });
}
