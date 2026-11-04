import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVisitorEdge,
  type VisitorEdgeChannel,
  type VisitorSiteFacts,
  type VisitorTurnstile,
} from "../../src/channels/visitor-edge.js";
import { channelIds } from "../../src/channels/ids.js";
import type { TurnstileConfiguration } from "../../src/turnstile.js";

const siteKey = channelIds.site.generate();
const bindingId = channelIds.binding.generate();
const enabled: TurnstileConfiguration = {
  kind: "enabled",
  siteKey: "1x".padEnd(24, "0"),
  secretKey: "1x".padEnd(35, "0"),
};
const credentials = {
  visitorId: "visitor-1",
  accessToken: `vt_${"A".repeat(43)}`,
  accessExpiresAt: 1,
  refreshSecret: `vr_${"B".repeat(43)}`,
};

function edge(
  options: Readonly<{
    required: boolean;
    configuration: TurnstileConfiguration;
  }>,
) {
  const minted: string[] = [];
  const facts: VisitorSiteFacts = {
    name: "Fern",
    avatar: {
      v: 1,
      character: "cat",
      appearance: {},
      expression: "normal",
      renderStyle: "plain",
    },
    origins: ["https://shop.example"],
  };
  if (options.required) facts.turnstile = true;
  const door = (): VisitorEdgeChannel => ({
    [Symbol.dispose]: () => undefined,
    readChannelSite: () => Promise.resolve(facts),
    mintChannelVisitor: ({ addressHash }) => {
      minted.push(addressHash);
      return Promise.resolve({ kind: "granted", credentials });
    },
    refreshChannelVisitor: () =>
      Promise.resolve({ kind: "denied", reason: "refresh_invalid" }),
    rotateChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
    sendAsChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
    withdrawAsChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
    latestPendingAsChannelVisitor: () =>
      Promise.resolve({ kind: "unauthorized" }),
    readAsChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
    openVisitorSession: () => Promise.resolve({ kind: "unauthorized" }),
    watchAsChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
  });
  const turnstile: VisitorTurnstile = {
    configuration: options.configuration,
    timeoutMs: 1000,
    onError: () => undefined,
  };
  const app = createVisitorEdge({
    resolveSite: (_context, key: string) =>
      Promise.resolve(key === siteKey ? { bindingId } : null),
    openSite: () => Promise.resolve(door()),
    authenticateVisitor: () => Promise.resolve(null),
    openChannel: () => Promise.resolve(door()),
    addressHash: () => Promise.resolve("hash"),
    turnstile: () => turnstile,
    assetPath: (kind: "widget" | "styles") => `/${kind}`,
    onError: (error: Error) => {
      throw error;
    },
  });
  const mint = (body: Readonly<{ turnstileToken?: string }>) =>
    app.request(`https://oyster.test/api/embed/v1/sites/${siteKey}/visitors`, {
      method: "POST",
      headers: {
        origin: "https://oyster.test",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return { app, mint, minted };
}

function siteverify(verdict: "pass" | "fail" | "down") {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: { body: string }) => {
      calls.push(init.body);
      if (verdict === "down") return Promise.reject(new Error("offline"));
      return Promise.resolve(Response.json({ success: verdict === "pass" }));
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a site that requires Turnstile", () => {
  it("never mints for a visitor without a token", async () => {
    const calls = siteverify("pass");
    const { mint, minted } = edge({
      required: true,
      configuration: enabled,
    });
    const response = await mint({});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "turnstile_required" });
    expect(minted).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses a token Cloudflare fails", async () => {
    const calls = siteverify("fail");
    const { mint, minted } = edge({
      required: true,
      configuration: enabled,
    });
    const response = await mint({ turnstileToken: "bad" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "turnstile_failed" });
    expect(minted).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("closes when Cloudflare cannot be reached", async () => {
    siteverify("down");
    const { mint, minted } = edge({
      required: true,
      configuration: enabled,
    });
    expect((await mint({ turnstileToken: "any" })).status).toBe(503);
    expect(minted).toEqual([]);
  });

  it("closes when the host holds only half of its keys", async () => {
    const calls = siteverify("pass");
    const { mint, minted } = edge({
      required: true,
      configuration: { kind: "misconfigured" },
    });
    expect((await mint({ turnstileToken: "any" })).status).toBe(503);
    expect(minted).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("mints after a passing token and sends Cloudflare the host secret", async () => {
    const calls = siteverify("pass");
    const { mint, minted } = edge({
      required: true,
      configuration: enabled,
    });
    const response = await mint({ turnstileToken: "good" });
    expect(response.status).toBe(201);
    expect(minted).toEqual(["hash"]);
    expect(JSON.parse(calls[0] ?? "{}")).toEqual({
      secret: enabled.secretKey,
      response: "good",
    });
  });

  it("honours an explicit host opt-out", async () => {
    const calls = siteverify("fail");
    const { mint } = edge({
      required: true,
      configuration: { kind: "disabled" },
    });
    expect((await mint({})).status).toBe(201);
    expect(calls).toEqual([]);
  });

  it("offers the challenge to the embed document, and only then", async () => {
    siteverify("pass");
    const required = edge({ required: true, configuration: enabled });
    const document = await required.app.request(
      `https://oyster.test/embed/v1/s/${siteKey}`,
    );
    const html = await document.text();
    expect(html).toContain(`data-turnstile-site="${enabled.siteKey}"`);
    expect(document.headers.get("content-security-policy")).toContain(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    const plain = edge({ required: false, configuration: enabled });
    const open = await plain.app.request(
      `https://oyster.test/embed/v1/s/${siteKey}`,
    );
    expect(await open.text()).toContain('data-turnstile-site=""');
    expect(open.headers.get("content-security-policy")).not.toContain(
      "challenges.cloudflare.com",
    );
  });
});

describe("a site that does not require Turnstile", () => {
  it("never calls Cloudflare, whatever the host keys", async () => {
    const calls = siteverify("fail");
    const { mint } = edge({ required: false, configuration: enabled });
    expect((await mint({})).status).toBe(201);
    expect(calls).toEqual([]);
  });
});
