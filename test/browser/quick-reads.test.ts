import { describe, expect, it, vi } from "vitest";
import { browserRunQuickReads } from "../../src/browser/quick-reads.js";
import { CloudBrowserUpstreamError } from "../../src/browser/errors.js";
import type { HttpFetch, Json } from "../../src/browser/cdp-client.js";

const url = new URL("https://example.com");
const signal = new AbortController().signal;

function configWith(result: Json, ok = true, status = 200) {
  const fetcher = vi.fn<HttpFetch>(() =>
    Promise.resolve(Response.json({ success: ok, result }, { status })),
  );
  return {
    reads: browserRunQuickReads({
      accountId: "acct_1",
      apiToken: "token",
      fetch: fetcher,
    }),
    fetcher,
  };
}

describe("Cloudflare Browser Run Quick Reads", () => {
  it("markdown truncates to maxChars and marks it truncated", async () => {
    const { reads, fetcher } = configWith("x".repeat(100));
    const { result, browserMs } = await reads.markdown(url, 10, signal);
    expect(result.text).toBe(`${"x".repeat(10)}\n[truncated]`);
    expect(result.truncated).toBe(true);
    expect(browserMs).toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acct_1/browser-rendering/markdown",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: url.href }),
        signal,
      }),
    );
  });

  it("markdown does not truncate under the bound", async () => {
    const { reads } = configWith("short");
    await expect(reads.markdown(url, 100, signal)).resolves.toEqual({
      result: { url: url.href, text: "short", truncated: false },
      browserMs: null,
    });
  });

  it("links caps the list at 500 and flags truncation", async () => {
    const many = Array.from(
      { length: 501 },
      (_, index) => `https://x.test/${String(index)}`,
    );
    const { reads } = configWith(many);
    const { result, browserMs } = await reads.links(url, signal);
    expect(result.links).toEqual(many.slice(0, 500));
    expect(result.truncated).toBe(true);
    expect(browserMs).toBeNull();
  });

  it("scrape bounds total bytes to 64 KiB and flags truncation", async () => {
    const { reads } = configWith([
      { selector: "article", results: { text: "y".repeat(100_000), html: "" } },
    ]);
    const { result, browserMs } = await reads.scrape(url, ["article"], signal);
    expect(result.truncated).toBe(true);
    expect(browserMs).toBeNull();
    const totalBytes = result.result.reduce(
      (total, entry) =>
        total +
        entry.elements.reduce(
          (sum, element) => sum + element.text.length + element.html.length,
          0,
        ),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("extract returns the provider's structured result", async () => {
    const { reads, fetcher } = configWith({ title: "Example" });
    const { result, browserMs } = await reads.extract(
      url,
      "extract the title",
      signal,
    );
    expect(result.result).toEqual({ title: "Example" });
    expect(browserMs).toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acct_1/browser-rendering/json",
      expect.objectContaining({
        body: JSON.stringify({ url: url.href, prompt: "extract the title" }),
      }),
    );
  });

  it("surfaces a provider failure as a typed upstream error", async () => {
    const { reads } = configWith(null, false, 500);
    await expect(reads.markdown(url, 100, signal)).rejects.toBeInstanceOf(
      CloudBrowserUpstreamError,
    );
  });

  it.each([0, 1_250])(
    "returns the provider's reported %i browser milliseconds",
    async (browserMs) => {
      const { reads, fetcher } = configWith("short");
      fetcher.mockResolvedValueOnce(
        Response.json(
          { success: true, result: "short" },
          { headers: { "X-Browser-Ms-Used": String(browserMs) } },
        ),
      );
      await expect(reads.markdown(url, 100, signal)).resolves.toEqual({
        result: { url: url.href, text: "short", truncated: false },
        browserMs,
      });
    },
  );
});
