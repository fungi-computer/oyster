import {
  CapabilityFailed,
  Mycelium,
  type CapabilitySource,
} from "@fungi.computer/mycelium";
import { VeilError } from "@fungi.computer/veil";
import {
  PublicFetchError,
  type PublicGet,
} from "@fungi.computer/veil/public-fetch";
import { decodeHTML } from "entities";
import { z } from "zod";
import {
  webSearchInputSchema,
  webSearchOutputSchema,
  type WebSearch,
} from "./search-contract.js";

/**
 * The Agent's bounded web reader: `web.fetch` GETs one public URL from the
 * Worker (no Computer needed) and returns readable text plus page metadata.
 * Every hop, redirects included, goes through Veil's public-fetch door, which
 * resolves once, refuses non-public addresses and connects to exactly the
 * address it checked; this module opens no connection of its own. The read is
 * bounded in bytes, characters and time. The owner grants it per binding as
 * the `web` tool.
 */

/** Bytes read from one response body before it is cut off. */
export const WEB_FETCH_MAX_BYTES = 1024 * 1024;
/** Default characters of extracted text returned to the model. */
const WEB_FETCH_DEFAULT_CHARS = 24_000;
const maxChars = 100_000;
/** Whole-call deadline, redirects and DNS included. */
const WEB_FETCH_TIMEOUT_MS = 10_000;
const maxRedirects = 5;
const accept =
  "text/markdown, text/plain;q=0.9, application/json;q=0.8, text/html;q=0.5, */*;q=0.1";
const userAgent = "FungiAgent/1.0 (+https://fungi.computer)";

type WebFetchErrorCode =
  | "disallowed_url"
  | "dns_failed"
  | "timeout"
  | "too_many_redirects"
  | "non_2xx"
  | "unsupported_content"
  | "network";

/** A bounded, typed failure; its message is safe to show the model. */
class WebFetchError extends CapabilityFailed {
  constructor(
    readonly code: WebFetchErrorCode,
    message: string,
  ) {
    super({
      namespace: "web",
      operation: "fetch",
      cause: {
        kind: "OperationFailed",
        message: `web.fetch ${code}: ${message}`,
      },
    });
    this.name = "WebFetchError";
  }
}

const inputSchema = z.strictObject({
  url: z.string().min(1).max(2_048),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(maxChars)
    .default(WEB_FETCH_DEFAULT_CHARS),
});
const outputSchema = z.strictObject({
  url: z.string(),
  status: z.number().int(),
  contentType: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
});
export type WebFetchResult = z.output<typeof outputSchema>;

function parseTarget(raw: string): URL {
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:"))
    throw new WebFetchError("disallowed_url", "only http(s) URLs are fetched");
  if (url.username !== "" || url.password !== "")
    throw new WebFetchError(
      "disallowed_url",
      "URLs with credentials are refused",
    );
  url.hash = "";
  return url;
}

/** Map a refusal from Veil's door to the typed failure the model sees. */
function doorFailure(
  refusal: VeilError | undefined,
  url: URL,
  signal: AbortSignal,
): Error {
  if (signal.aborted) return deadline(signal);
  if (refusal?.code === "denied")
    return new WebFetchError(
      "disallowed_url",
      `${url.hostname} is not a public address`,
    );
  if (refusal instanceof PublicFetchError && refusal.stage === "dns")
    return new WebFetchError("dns_failed", `${url.hostname} did not resolve`);
  return new WebFetchError("network", `${url.host} could not be reached`);
}

function deadline(signal: AbortSignal): Error {
  return signal.reason instanceof DOMException &&
    signal.reason.name === "TimeoutError"
    ? new WebFetchError("timeout", "the page did not answer in time")
    : signal.reason instanceof Error
      ? signal.reason
      : new Error("web.fetch was cancelled");
}

/** Read at most the byte cap, cancelling the rest of the body. */
async function readBounded(
  response: Response,
): Promise<Readonly<{ bytes: Uint8Array; truncated: boolean }>> {
  if (response.body === null)
    return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    // A Response body yields bytes; the Workers typing leaves the chunk open.
    const value: unknown = next.value;
    if (!(value instanceof Uint8Array))
      throw new WebFetchError("network", "the page body was not bytes");
    const room = WEB_FETCH_MAX_BYTES - total;
    if (value.byteLength >= room) {
      chunks.push(value.subarray(0, room));
      total += room;
      truncated = value.byteLength > room;
      if (!truncated) continue;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

const mediaTypeSchema = z
  .string()
  .transform((value) => value.split(";")[0]?.trim().toLowerCase() ?? "");
const charsetPattern = /;\s*charset\s*=\s*"?([^";\s]+)"?/iu;

function decodeText(bytes: Uint8Array, contentType: string): string {
  const label = charsetPattern.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch (cause) {
    // An unknown charset label is the page's mistake; any other failure is ours.
    if (!(cause instanceof RangeError)) throw cause;
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

const textTypes = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/csv",
  "text/xml",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
]);
const htmlTypes = new Set(["text/html", "application/xhtml+xml"]);

/** Elements whose content is never readable page text. */
const hidden =
  "head, script, style, noscript, template, svg, iframe, canvas, object, select";
/** Elements that separate blocks of readable text. */
const blocks =
  "p, div, section, article, main, aside, header, footer, nav, li, ul, ol, dl, dt, dd, table, tr, blockquote, pre, figure, figcaption, form, h1, h2, h3, h4, h5, h6";
/** Void elements (no end tag) that still break a line. */
const breaks = "br, hr";

type Page = { title: string | null; description: string | null; text: string };

/** Extract title, description and readable text with the native HTML rewriter. */
async function readHtml(html: string): Promise<Page> {
  const parts: string[] = [];
  const title: string[] = [];
  let description: string | null = null;
  let ogTitle: string | null = null;
  let hiddenDepth = 0;
  const rewriter = new HTMLRewriter()
    .on("title", {
      text: (chunk) => {
        title.push(chunk.text);
      },
    })
    .on("meta", {
      element: (element) => {
        const key = (
          element.getAttribute("name") ??
          element.getAttribute("property") ??
          ""
        ).toLowerCase();
        const content = element.getAttribute("content");
        if (content === null) return;
        if (
          description === null &&
          (key === "description" || key === "og:description")
        )
          description = decodeHTML(content);
        if (ogTitle === null && key === "og:title")
          ogTitle = decodeHTML(content);
      },
    })
    .on(hidden, {
      element: (element) => {
        hiddenDepth += 1;
        element.onEndTag(() => {
          hiddenDepth -= 1;
        });
      },
    })
    .on(blocks, {
      element: (element) => {
        parts.push("\n");
        element.onEndTag(() => {
          parts.push("\n");
        });
      },
    })
    .on(breaks, {
      element: () => {
        parts.push("\n");
      },
    })
    .onDocument({
      text: (chunk) => {
        if (hiddenDepth === 0) parts.push(chunk.text);
      },
    });
  await rewriter.transform(new Response(html)).arrayBuffer();
  const text = decodeHTML(parts.join(""))
    .replace(/[ \t\f\v\r\u00a0]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const pageTitle = decodeHTML(title.join("")).trim();
  return {
    title: pageTitle === "" ? ogTitle : pageTitle,
    description,
    text,
  };
}

/** Fetch one public page: GET only, redirects rechecked, bounded everywhere. */
export async function fetchWebPage(
  input: Readonly<{ url: string; maxChars?: number }>,
  options: Readonly<{
    get: PublicGet;
    signal: AbortSignal;
    timeoutMs?: number;
  }>,
): Promise<WebFetchResult> {
  const request = inputSchema.parse(input);
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS),
  ]);
  let target = parseTarget(request.url);
  let response: Response | undefined;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    try {
      response = await options.get({ url: target, accept, userAgent, signal });
    } catch (error) {
      throw doorFailure(
        error instanceof VeilError ? error : undefined,
        target,
        signal,
      );
    }
    const location = response.headers.get("Location");
    if (response.status < 300 || response.status > 399 || location === null)
      break;
    await response.body?.cancel();
    target = parseTarget(new URL(location, target).href);
    response = undefined;
  }
  if (response === undefined)
    throw new WebFetchError(
      "too_many_redirects",
      `more than ${String(maxRedirects)} redirects`,
    );
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!response.ok) {
    await response.body?.cancel();
    throw new WebFetchError(
      "non_2xx",
      `${target.href} answered HTTP ${String(response.status)}`,
    );
  }
  const mediaType = mediaTypeSchema.parse(contentType);
  const html = htmlTypes.has(mediaType);
  if (!html && !textTypes.has(mediaType) && !mediaType.startsWith("text/")) {
    await response.body?.cancel();
    throw new WebFetchError(
      "unsupported_content",
      `${mediaType || "an unlabelled body"} is not readable text`,
    );
  }
  let body: Awaited<ReturnType<typeof readBounded>>;
  try {
    body = await readBounded(response);
  } catch {
    if (signal.aborted) throw deadline(signal);
    throw new WebFetchError("network", "the page body was interrupted");
  }
  const decoded = decodeText(body.bytes, contentType);
  const page: Page = html
    ? await readHtml(decoded)
    : { title: null, description: null, text: decoded };
  const text = page.text.slice(0, request.maxChars);
  return outputSchema.parse({
    url: target.href,
    status: response.status,
    contentType: mediaType,
    title: page.title,
    description: page.description,
    text,
    truncated: body.truncated || text.length < page.text.length,
    bytes: body.bytes.byteLength,
  });
}

/**
 * Compose the `web` module (`web.fetch`, `web.search`) for one run lease; the
 * host grants both through the `web` tool.
 */
export function createWebSource(
  options: Readonly<{
    /** Veil's public-fetch door, the only way this module reaches the web. */
    get: PublicGet;
    /** Metered search, or the explicit unconfigured refusal. */
    search: WebSearch;
  }>,
): CapabilitySource {
  const { get } = options;
  return {
    id: "hub-web",
    acquire: ({ signal }) => {
      signal.throwIfAborted();
      return Promise.resolve({
        snapshot: {
          version: "hub-web-v2",
          modules: [
            Mycelium.module({
              id: "hub-web",
              name: "web",
              description: "Search and read the public web.",
              operations: {
                fetch: Mycelium.operation({
                  replay: "unsafe",
                  description: `Fetch one public http(s) URL with GET and return its readable text, title and description. Redirects are followed (up to ${String(maxRedirects)}); private, local and internal addresses are refused. Reads at most 1 MiB in ${String(WEB_FETCH_TIMEOUT_MS / 1_000)} s and returns up to maxChars characters (default ${String(WEB_FETCH_DEFAULT_CHARS)}); check truncated.`,
                  input: inputSchema,
                  output: outputSchema,
                  execute: (input, context) =>
                    fetchWebPage(input, {
                      get,
                      signal: context.signal,
                    }),
                }),
                search: Mycelium.operation({
                  replay: "unsafe",
                  description: `Search the public web for an objective (optionally with up to 5 short keyword queries) and return ranked URLs with titles and text excerpts. Then read a result with web.fetch.`,
                  input: webSearchInputSchema,
                  output: webSearchOutputSchema,
                  execute: (input, context) =>
                    options.search.search(input, context.signal),
                }),
              },
            }),
          ],
        },
        release: () => Promise.resolve(),
      });
    },
  };
}
