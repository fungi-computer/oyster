import { describe, expect, it } from "vitest";
import {
  originAllowed,
  type ConversationBinding,
} from "../../src/channels/binding.js";

describe("web channel binding facts", () => {
  it("keeps the site key, origins and optional accent on the Oyster binding", () => {
    const binding = {
      bindingId: "binding",
      lifecycle: "active",
      selector: {
        provider: "web",
        siteKey: "site",
        origins: ["https://example.com"],
        accent: "#aabbcc",
      },
    } satisfies ConversationBinding;
    expect(binding.selector.origins).toEqual(["https://example.com"]);
    expect(binding.selector.accent).toBe("#aabbcc");
  });

  it("admits only an exact origin or a single-label HTTPS wildcard", () => {
    const allowed = ["https://*.example.com", "http://localhost:5173"];
    expect(originAllowed(allowed, "https://www.example.com")).toBe(true);
    expect(originAllowed(allowed, "https://a.b.example.com")).toBe(false);
    expect(originAllowed(allowed, "https://example.com")).toBe(false);
    expect(originAllowed(allowed, "https://evilexample.com")).toBe(false);
    expect(originAllowed(allowed, "http://www.example.com")).toBe(false);
    expect(originAllowed(allowed, "http://localhost:5173")).toBe(true);
    expect(originAllowed(allowed, "https://localhost:5173")).toBe(false);
  });
});
