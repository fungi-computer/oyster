import { z } from "zod";
import { CloudBrowserUpstreamError } from "./errors.js";
import type { HttpFetch, Json } from "./cdp-client.js";
import {
  cloudBrowserBounds,
  extractResultSchema,
  type ExtractResult,
  type LinksResult,
  type MarkdownResult,
  type ScrapeResult,
} from "./operations.js";

/**
 * Cloudflare Browser Run's stateless "Quick Actions" REST endpoints. A Workers
 * BROWSER binding has no equivalent, so a binding host offers no Quick Reads.
 * Each call is one POST with an account-scoped API token holding only the
 * "Browser Rendering Edit" permission. Every URL arrives already checked by
 * `browser.ts` against `url-policy.ts`; this file never sees a raw one.
 *
 * https://developers.cloudflare.com/browser-run/rest-api/
 * https://developers.cloudflare.com/api/resources/browser_rendering/subresources/markdown/methods/create/
 * https://developers.cloudflare.com/api/resources/browser_rendering/subresources/links/methods/create/
 * https://developers.cloudflare.com/api/resources/browser_rendering/subresources/scrape/methods/create/
 * https://developers.cloudflare.com/api/resources/browser_rendering/subresources/json/methods/create/
 */

const quickActionResponseSchema = z.object({
  success: z.boolean(),
  result: z.json().optional(),
  errors: z
    .array(z.object({ code: z.number(), message: z.string() }))
    .optional(),
});

/** The Browser Run account and API token a host's Quick Reads use. */
export type BrowserRunQuickReadsConfig = Readonly<{
  accountId: string;
  apiToken: string;
  fetch?: HttpFetch;
}>;

/** A read's result and the browser time the provider reports for it, if any. */
export type QuickRead<Result> = Readonly<{
  result: Result;
  browserMs: number | null;
}>;

/**
 * The stateless half of the host port; only `browserRunQuickReads` builds
 * one. The caller (`browser.ts`) owns the deadline through `signal`.
 */
export type QuickReads = Readonly<{
  /** Render a page as markdown, truncated to `maxChars`. */
  markdown: (
    url: URL,
    maxChars: number,
    signal: AbortSignal,
  ) => Promise<QuickRead<MarkdownResult>>;
  /** Render a page and return its links. */
  links: (url: URL, signal: AbortSignal) => Promise<QuickRead<LinksResult>>;
  /** Render a page and return elements matching CSS selectors. */
  scrape: (
    url: URL,
    selectors: readonly string[],
    signal: AbortSignal,
  ) => Promise<QuickRead<ScrapeResult>>;
  /** Render a page and extract structured data matching a prompt. */
  extract: (
    url: URL,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<QuickRead<ExtractResult>>;
}>;

/**
 * Browser Run reports each REST call's browser time in this header
 * (https://developers.cloudflare.com/browser-run/rest-api/).
 */
const browserMsHeaderSchema = z
  .string()
  .regex(/^\d{1,15}$/u)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

function reportedBrowserMs(response: Response): number | null {
  const parsed = browserMsHeaderSchema.safeParse(
    response.headers.get("x-browser-ms-used") ?? undefined,
  );
  return parsed.success ? parsed.data : null;
}

const scrapeElementSchema = z.object({
  attributes: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .optional(),
  text: z.string().optional(),
  html: z.string().optional(),
});
const scrapeEntrySchema = z.object({
  selector: z.string(),
  // Cloudflare's own examples are inconsistent about one match vs many; accept both.
  results: z.union([scrapeElementSchema, z.array(scrapeElementSchema)]),
});

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n[truncated]`, truncated: true };
}

function boundScrape(
  entries: readonly z.output<typeof scrapeEntrySchema>[],
): Pick<ScrapeResult, "result" | "truncated"> {
  let remaining = cloudBrowserBounds.maxScrapeBytes;
  let truncated = false;
  const mapped: ScrapeResult["result"] = [];
  outer: for (const entry of entries) {
    const source = Array.isArray(entry.results)
      ? entry.results
      : [entry.results];
    const elements: { text: string; html: string }[] = [];
    for (const element of source) {
      const text = element.text ?? "";
      const html = element.html ?? "";
      const size = text.length + html.length;
      if (size > remaining) {
        const share = Math.max(remaining, 0);
        elements.push({
          text: text.slice(0, share),
          html: html.slice(0, Math.max(share - text.length, 0)),
        });
        truncated = true;
        mapped.push({ selector: entry.selector, elements });
        break outer;
      }
      remaining -= size;
      elements.push({ text, html });
    }
    mapped.push({ selector: entry.selector, elements });
  }
  return { result: mapped, truncated };
}

/** Browser Run's REST Quick Actions as a host's `QuickReads`. */
export function browserRunQuickReads(
  config: BrowserRunQuickReadsConfig,
): QuickReads {
  const fetcher: HttpFetch = config.fetch ?? ((url, init) => fetch(url, init));

  async function call(
    action: string,
    body: Readonly<Record<string, Json>>,
    signal: AbortSignal,
  ): Promise<Readonly<{ result: Json | undefined; browserMs: number | null }>> {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
        config.accountId,
      )}/browser-rendering/${action}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    const status = response.status;
    let parsed: z.output<typeof quickActionResponseSchema>;
    try {
      parsed = quickActionResponseSchema.parse(await response.json());
    } catch {
      throw new CloudBrowserUpstreamError({
        op: action,
        status,
        message: "Browser Run returned an unreadable response",
      });
    }
    if (!response.ok || !parsed.success)
      throw new CloudBrowserUpstreamError({
        op: action,
        status,
        message:
          parsed.errors?.[0]?.message ??
          `Browser Run ${action} failed (HTTP ${String(status)})`,
      });
    return { result: parsed.result, browserMs: reportedBrowserMs(response) };
  }

  return {
    markdown: async (url, maxChars, signal) => {
      const { result, browserMs } = await call(
        "markdown",
        { url: url.href },
        signal,
      );
      const bound = truncate(z.string().parse(result), maxChars);
      return {
        result: { url: url.href, text: bound.text, truncated: bound.truncated },
        browserMs,
      };
    },
    links: async (url, signal) => {
      const { result, browserMs } = await call(
        "links",
        { url: url.href },
        signal,
      );
      const all = z.array(z.string()).parse(result);
      return {
        result: {
          url: url.href,
          links: all.slice(0, cloudBrowserBounds.maxLinks),
          truncated: all.length > cloudBrowserBounds.maxLinks,
        },
        browserMs,
      };
    },
    scrape: async (url, selectors, signal) => {
      const { result, browserMs } = await call(
        "scrape",
        {
          url: url.href,
          elements: selectors.map((selector) => ({ selector })),
        },
        signal,
      );
      return {
        result: {
          url: url.href,
          ...boundScrape(z.array(scrapeEntrySchema).parse(result)),
        },
        browserMs,
      };
    },
    extract: async (url, prompt, signal) => {
      const { result, browserMs } = await call(
        "json",
        { url: url.href, prompt },
        signal,
      );
      return {
        result: extractResultSchema.parse({ url: url.href, result }),
        browserMs,
      };
    },
  };
}
