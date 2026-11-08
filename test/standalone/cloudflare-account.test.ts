import { describe, expect, it } from "vitest";
import { cloudflareAccountReady } from "../../src/standalone/cloudflare-account.js";

describe("cloudflareAccountReady", () => {
  const AI = {};
  it("is not ready without the AI binding", () => {
    expect(
      cloudflareAccountReady({ OYSTER_ORIGIN: "https://oyster.example" }),
    ).toBe(false);
  });
  it("is ready with the binding when the host names no origin", () => {
    expect(cloudflareAccountReady({ AI })).toBe(true);
  });
  it("is not ready for a local trial, which has no account behind its binding", () => {
    for (const origin of [
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
    ])
      expect(cloudflareAccountReady({ AI, OYSTER_ORIGIN: origin })).toBe(false);
  });
  it("is ready for a deployed Oyster with its binding", () => {
    expect(
      cloudflareAccountReady({ AI, OYSTER_ORIGIN: "https://oyster.example" }),
    ).toBe(true);
  });
  it("is not ready when the origin is not a URL", () => {
    expect(cloudflareAccountReady({ AI, OYSTER_ORIGIN: "oyster" })).toBe(false);
  });
});
