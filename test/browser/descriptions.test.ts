import { describe, expect, it } from "vitest";
import { CLOUD_BROWSER_DESCRIPTIONS } from "../../src/browser/index.js";

describe("cloudBrowser tool descriptions", () => {
  it("names the module and every operation", () => {
    expect(Object.keys(CLOUD_BROWSER_DESCRIPTIONS)).toEqual([
      "module",
      "markdown",
      "links",
      "scrape",
      "extract",
      "open",
      "navigate",
      "snapshot",
      "click",
      "type",
      "press",
      "scroll",
      "screenshot",
      "pdf",
      "handoff",
      "close",
    ]);
  });

  it.each(Object.entries(CLOUD_BROWSER_DESCRIPTIONS))(
    "keeps %s under 1000 characters",
    (_name, text) => {
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThan(1000);
    },
  );
});
