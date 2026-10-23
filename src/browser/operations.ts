import { z } from "zod";

/**
 * The agent browser's closed operation vocabulary: input/output schemas,
 * bounds and the one discriminated union `browser.ts` pattern-matches.
 * There is deliberately no `send`/`execute`/`evaluate` member: the Agent
 * can never reach raw CDP or run script in the page, only this typed set.
 * Every failure comes from `./errors.js`'s `CloudBrowserFailure` union.
 */

const maxChars = 50_000;
const defaultMarkdownChars = 20_000;
const maxLinks = 500;
const maxSelectors = 10;
const maxScrapeBytes = 64 * 1024;
const maxSnapshotBytes = 64 * 1024;
const maxScreenshotBytes = 8 * 1024 * 1024;
const maxPdfBytes = 8 * 1024 * 1024;

/** The module's fixed output bounds (characters, links, selectors, bytes). */
export const cloudBrowserBounds = Object.freeze({
  maxChars,
  defaultMarkdownChars,
  maxLinks,
  maxSelectors,
  maxScrapeBytes,
  maxSnapshotBytes,
  maxScreenshotBytes,
  maxPdfBytes,
});

/** Input of a URL-only Quick Read (`links`). */
export const urlInputSchema = z.strictObject({ url: z.url().max(2_048) });

/** Input of `markdown`: a URL and a character bound. */
export const markdownInputSchema = z.strictObject({
  url: z.url().max(2_048),
  maxChars: z.number().int().min(1).max(maxChars).default(defaultMarkdownChars),
});
/** Output of `markdown`: the page text, possibly truncated. */
export const markdownResultSchema = z.strictObject({
  url: z.string(),
  text: z.string(),
  truncated: z.boolean(),
});

/** Output of `links`: bare URL strings, bounded. */
export const linksResultSchema = z.strictObject({
  url: z.string(),
  /** Cloudflare's `/links` Quick Action returns bare URL strings, not anchor text. */
  links: z.array(z.string()).max(maxLinks),
  truncated: z.boolean(),
});

/** Input of `scrape`: a URL and up to ten CSS selectors. */
export const scrapeInputSchema = z.strictObject({
  url: z.url().max(2_048),
  selectors: z.array(z.string().min(1).max(256)).min(1).max(maxSelectors),
});
/** Output of `scrape`: matched elements per selector, bounded. */
export const scrapeResultSchema = z.strictObject({
  url: z.string(),
  result: z.array(
    z.strictObject({
      selector: z.string(),
      elements: z.array(z.strictObject({ text: z.string(), html: z.string() })),
    }),
  ),
  truncated: z.boolean(),
});

/** Input of `extract`: a URL and a prompt. */
export const extractInputSchema = z.strictObject({
  url: z.url().max(2_048),
  prompt: z.string().min(1).max(2_000),
});
/** Output of `extract`: JSON-safe structured data. */
export const extractResultSchema = z.strictObject({
  url: z.string(),
  // `z.json()`, not `z.unknown()`: Mycelium-facing schemas must stay JSON-safe.
  result: z.json(),
});

const leaseIdSchema = z.string().min(1).max(128);

/** Input of `open`: an optional first URL. */
export const openInputSchema = z.strictObject({
  // `.nullable().default(null)`, not `.optional()`: every Mycelium-facing
  // schema's parsed output must stay JSON-safe (no `undefined`).
  url: z.url().max(2_048).nullable().default(null),
});
/** Output of `open`: the new lease and its first URL. */
export const openResultSchema = z.strictObject({
  leaseId: leaseIdSchema,
  url: z.string().nullable(),
});

/** Input of `navigate`: a lease and a URL. */
export const navigateInputSchema = z.strictObject({
  leaseId: leaseIdSchema,
  url: z.url().max(2_048),
});
/** Output of `navigate`: the page's location after load. */
export const navigateResultSchema = z.strictObject({
  leaseId: leaseIdSchema,
  url: z.string(),
  status: z.number().int().nullable(),
  title: z.string().nullable(),
});

/** Input of `snapshot`: a lease. */
export const snapshotInputSchema = z.strictObject({ leaseId: leaseIdSchema });
/** Output of `snapshot`: a bounded accessibility-tree summary. */
export const snapshotResultSchema = z.strictObject({
  leaseId: leaseIdSchema,
  tree: z.string(),
  truncated: z.boolean(),
});

/** Input of `click`: a lease and a viewport coordinate. */
export const clickInputSchema = z.strictObject({
  leaseId: leaseIdSchema,
  x: z.number().int().min(0).max(20_000),
  y: z.number().int().min(0).max(20_000),
});
/** Input of `type`: a lease and text to insert. */
export const typeInputSchema = z.strictObject({
  leaseId: leaseIdSchema,
  text: z.string().max(10_000),
});
/** Input of `press`: a lease and one key name. */
export const pressInputSchema = z.strictObject({
  leaseId: leaseIdSchema,
  key: z.string().min(1).max(64),
});
/** Input of `scroll`: a lease and a pixel delta. */
export const scrollInputSchema = z.strictObject({
  leaseId: leaseIdSchema,
  deltaX: z.number().int().min(-100_000).max(100_000).default(0),
  deltaY: z.number().int().min(-100_000).max(100_000).default(0),
});
/** Output of a driven input step: the lease it acted on. */
export const leaseAckSchema = z.strictObject({ leaseId: leaseIdSchema });

/** Input of `close`: a lease. */
export const closeInputSchema = z.strictObject({ leaseId: leaseIdSchema });
/** Output of `close`: the closed lease. */
export const closeResultSchema = z.strictObject({
  leaseId: leaseIdSchema,
  closed: z.literal(true),
  /** "closing" when the provider acknowledged but has not yet confirmed the end. */
  provider: z.enum(["closed", "closing"]),
});

/** Parsed `markdown` input. */
export type MarkdownInput = z.output<typeof markdownInputSchema>;
/** Parsed `markdown` output. */
export type MarkdownResult = z.output<typeof markdownResultSchema>;
/** Parsed `links` output. */
export type LinksResult = z.output<typeof linksResultSchema>;
/** Parsed `scrape` input. */
export type ScrapeInput = z.output<typeof scrapeInputSchema>;
/** Parsed `scrape` output. */
export type ScrapeResult = z.output<typeof scrapeResultSchema>;
/** Parsed `extract` input. */
export type ExtractInput = z.output<typeof extractInputSchema>;
/** Parsed `extract` output. */
export type ExtractResult = z.output<typeof extractResultSchema>;
/** Parsed `open` output. */
export type OpenResult = z.output<typeof openResultSchema>;
/** Parsed `navigate` output. */
export type NavigateResult = z.output<typeof navigateResultSchema>;
/** Parsed `snapshot` output. */
export type SnapshotResult = z.output<typeof snapshotResultSchema>;

/** Raw bytes never cross the Mycelium boundary; only a byte count does. */
export type BinaryResult = Readonly<{
  leaseId: string;
  bytes: Uint8Array;
  contentType: string;
}>;

/**
 * Every call the agent tool can make. `markdown`/`links`/`scrape`/`extract`
 * are stateless Quick Reads (absent on a host without them); `open`..`close`
 * share one driven session keyed by `leaseId`. "screenshot"/"pdf" return raw
 * bytes here; `capability-source.ts` saves them through the host's door and
 * hands the model only a byte count.
 */
export type CloudBrowserOperation =
  | Readonly<{ kind: "markdown"; input: MarkdownInput }>
  | Readonly<{ kind: "links"; url: string }>
  | Readonly<{ kind: "scrape"; input: ScrapeInput }>
  | Readonly<{ kind: "extract"; input: ExtractInput }>
  | Readonly<{ kind: "open"; url: string | null }>
  | Readonly<{ kind: "navigate"; leaseId: string; url: string }>
  | Readonly<{ kind: "snapshot"; leaseId: string }>
  | Readonly<{ kind: "click"; leaseId: string; x: number; y: number }>
  | Readonly<{ kind: "type"; leaseId: string; text: string }>
  | Readonly<{ kind: "press"; leaseId: string; key: string }>
  | Readonly<{
      kind: "scroll";
      leaseId: string;
      deltaX: number;
      deltaY: number;
    }>
  | Readonly<{ kind: "screenshot"; leaseId: string }>
  | Readonly<{ kind: "pdf"; leaseId: string }>
  | Readonly<{ kind: "close"; leaseId: string }>;

/** Acknowledgement of one driven input step. */
export type CloudBrowserAck = Readonly<{ leaseId: string }>;
/** Acknowledgement that a lease closed. */
export type CloudBrowserClosed = Readonly<{
  leaseId: string;
  closed: true;
  provider: "closed" | "closing";
}>;

/** What one `CloudBrowserOperation` returns, before the agent tool shapes it. */
export type CloudBrowserOperationResult =
  | MarkdownResult
  | LinksResult
  | ScrapeResult
  | ExtractResult
  | OpenResult
  | NavigateResult
  | SnapshotResult
  | CloudBrowserAck
  | BinaryResult
  | CloudBrowserClosed;
