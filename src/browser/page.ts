import { z } from "zod";
import { CloudBrowserTimeout, CloudBrowserUpstreamError } from "./errors.js";
import {
  cloudBrowserBounds,
  type BinaryResult,
  type SnapshotResult,
} from "./operations.js";
import type { CdpClient, Json } from "./cdp-client.js";

/**
 * Drive one page of a connected session through a closed set of CDP methods
 * (navigate/snapshot/click/type/press/scroll/screenshot/pdf). Internal to the
 * module: callers have already checked lease ownership and URL egress policy.
 * The session-create response shape was confirmed by the live workerd smoke
 * on 2026-10-03; see `test/browser/cdp-client.test.ts`.
 */

const targetSchema = z.object({ targetId: z.string(), type: z.string() });
const getTargetsResultSchema = z.object({ targetInfos: z.array(targetSchema) });
const attachResultSchema = z.object({ sessionId: z.string() });
const navigateResultSchema = z.object({
  frameId: z.string().optional(),
  errorText: z.string().optional(),
});
const navigationHistorySchema = z.object({
  currentIndex: z.number().int(),
  entries: z.array(z.object({ url: z.string(), title: z.string().optional() })),
});
const axValueSchema = z.object({ value: z.json().optional() }).optional();
const axNodeSchema = z.object({
  role: axValueSchema,
  name: axValueSchema,
  value: axValueSchema,
  ignored: z.boolean().optional(),
});
const axTreeSchema = z.object({ nodes: z.array(axNodeSchema) });
const capturedDataSchema = z.object({ data: z.string() });

export type Page = Readonly<{
  client: CdpClient;
  cdpSessionId: string;
  /** The attached page target, so observers can tell it from pages it opens. */
  targetId: string;
}>;

/** Attach to the session's first page target (or a new blank one). */
export async function attachPage(client: CdpClient): Promise<Page> {
  const targets = getTargetsResultSchema.parse(
    await client.call("Target.getTargets", {}),
  );
  const targetId =
    targets.targetInfos.find((target) => target.type === "page")?.targetId ??
    z
      .object({ targetId: z.string() })
      .parse(await client.call("Target.createTarget", { url: "about:blank" }))
      .targetId;
  const { sessionId: cdpSessionId } = attachResultSchema.parse(
    await client.call("Target.attachToTarget", { targetId, flatten: true }),
  );
  await client.call("Page.enable", {}, { sessionId: cdpSessionId });
  await client.call("Accessibility.enable", {}, { sessionId: cdpSessionId });
  return { client, cdpSessionId, targetId };
}

export type PageLocation = Readonly<{ url: string; title: string | null }>;

/** The page's current history entry. */
export async function pageLocation(
  { client, cdpSessionId }: Page,
  fallbackUrl: string,
): Promise<PageLocation> {
  const history = navigationHistorySchema.parse(
    await client.call(
      "Page.getNavigationHistory",
      {},
      { sessionId: cdpSessionId },
    ),
  );
  const current = history.entries[history.currentIndex];
  return { url: current?.url ?? fallbackUrl, title: current?.title ?? null };
}

/** Navigate to an already policy-checked URL and wait for its load event. */
export async function navigatePage(
  page: Page,
  url: URL,
  timeoutMs: number,
): Promise<PageLocation> {
  const { client, cdpSessionId } = page;
  // Listen before navigating so a fast load is not missed; a navigation that
  // fails never leaves a pending wait behind.
  const load = { fired: false, notify: (): void => undefined };
  const stop = client.on("Page.loadEventFired", (_params, sessionId) => {
    if (sessionId !== cdpSessionId) return;
    load.fired = true;
    load.notify();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = navigateResultSchema.parse(
      await client.call(
        "Page.navigate",
        { url: url.href },
        { sessionId: cdpSessionId },
      ),
    );
    if (result.errorText !== undefined)
      throw new CloudBrowserUpstreamError({
        op: "navigate",
        status: null,
        message: result.errorText,
      });
    await new Promise<void>((resolve, reject) => {
      if (load.fired) {
        resolve();
        return;
      }
      load.notify = resolve;
      timer = setTimeout(() => {
        reject(
          new CloudBrowserTimeout({ op: "Page.loadEventFired", timeoutMs }),
        );
      }, timeoutMs);
    });
    return await pageLocation(page, url.href);
  } finally {
    stop();
    if (timer !== undefined) clearTimeout(timer);
  }
}

function axText(value: Json | undefined): string | null {
  const parsed = z.string().min(1).safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function snapshotPage(
  { client, cdpSessionId }: Page,
  leaseId: string,
  signal: AbortSignal,
): Promise<SnapshotResult> {
  const tree = axTreeSchema.parse(
    await client.call(
      "Accessibility.getFullAXTree",
      {},
      { sessionId: cdpSessionId, signal },
    ),
  );
  const lines: string[] = [];
  let joinedLength = 0;
  let truncated = false;
  for (const node of tree.nodes) {
    if (node.ignored === true) continue;
    const role = axText(node.role?.value);
    const name = axText(node.name?.value);
    const value = axText(node.value?.value);
    if (role === null && name === null) continue;
    const line = [role, name, value]
      .filter((part) => part !== null)
      .join(" · ");
    if (joinedLength + line.length > cloudBrowserBounds.maxSnapshotBytes) {
      truncated = true;
      break;
    }
    joinedLength += (lines.length === 0 ? 0 : 1) + line.length;
    lines.push(line);
  }
  return { leaseId, tree: lines.join("\n"), truncated };
}

export async function clickPage(
  { client, cdpSessionId }: Page,
  x: number,
  y: number,
  signal: AbortSignal,
): Promise<void> {
  const options = { sessionId: cdpSessionId, signal };
  for (const type of ["mousePressed", "mouseReleased"])
    await client.call(
      "Input.dispatchMouseEvent",
      { type, x, y, button: "left", clickCount: 1 },
      options,
    );
}

export async function typePage(
  { client, cdpSessionId }: Page,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  await client.call(
    "Input.insertText",
    { text },
    { sessionId: cdpSessionId, signal },
  );
}

export async function pressPage(
  { client, cdpSessionId }: Page,
  key: string,
  signal: AbortSignal,
): Promise<void> {
  const options = { sessionId: cdpSessionId, signal };
  for (const type of ["keyDown", "keyUp"])
    await client.call("Input.dispatchKeyEvent", { type, key }, options);
}

export async function scrollPage(
  { client, cdpSessionId }: Page,
  deltaX: number,
  deltaY: number,
  signal: AbortSignal,
): Promise<void> {
  await client.call(
    "Input.dispatchMouseEvent",
    { type: "mouseWheel", x: 1, y: 1, deltaX, deltaY },
    { sessionId: cdpSessionId, signal },
  );
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function capture(
  { client, cdpSessionId }: Page,
  input: Readonly<{
    op: "screenshot" | "pdf";
    method: string;
    params: Readonly<Record<string, Json>>;
    maxBytes: number;
    contentType: string;
  }>,
  leaseId: string,
  signal: AbortSignal,
): Promise<BinaryResult> {
  const result = capturedDataSchema.parse(
    await client.call(input.method, input.params, {
      sessionId: cdpSessionId,
      signal,
    }),
  );
  const bytes = decodeBase64(result.data);
  if (bytes.byteLength > input.maxBytes)
    throw new CloudBrowserUpstreamError({
      op: input.op,
      status: null,
      message: `The ${input.op} exceeds the 8 MiB bound`,
    });
  return { leaseId, bytes, contentType: input.contentType };
}

export function screenshotPage(
  page: Page,
  leaseId: string,
  signal: AbortSignal,
): Promise<BinaryResult> {
  return capture(
    page,
    {
      op: "screenshot",
      method: "Page.captureScreenshot",
      params: { format: "png" },
      maxBytes: cloudBrowserBounds.maxScreenshotBytes,
      contentType: "image/png",
    },
    leaseId,
    signal,
  );
}

export function pdfPage(
  page: Page,
  leaseId: string,
  signal: AbortSignal,
): Promise<BinaryResult> {
  return capture(
    page,
    {
      op: "pdf",
      method: "Page.printToPDF",
      params: {},
      maxBytes: cloudBrowserBounds.maxPdfBytes,
      contentType: "application/pdf",
    },
    leaseId,
    signal,
  );
}
