import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { describe, expect, it } from "vitest";

import { channelIds } from "../../src/channels/ids.js";
import {
  createWebsiteBindings,
  personChannelInstructions,
  WebsiteBindingError,
} from "../../src/channels/web-binding.js";

function owner(agents: readonly string[] = ["agent_1"]) {
  const database = new DatabaseSync(":memory:");
  const sql = fromNodeSqlite(database);
  return createWebsiteBindings({
    ...sql,
    agentExists: (agentId) => agents.includes(agentId),
  });
}

describe("website bindings", () => {
  it("mints the site key and admits only an existing Agent", () => {
    const bindings = owner();
    const created = bindings.create(
      {
        agentId: "agent_1",
        selector: { provider: "web", origins: ["https://shop.example"] },
      },
      "request-1",
    );
    expect(channelIds.site.is(created.selector.siteKey)).toBe(true);
    expect(created).toMatchObject({
      lifecycle: "active",
      authorityVersion: 1,
      persona: "",
    });
    expect(() =>
      bindings.create(
        {
          agentId: "agent_2",
          selector: { provider: "web", origins: ["https://shop.example"] },
        },
        "request-2",
      ),
    ).toThrow(new WebsiteBindingError("not_found"));
    expect(() =>
      bindings.create(
        {
          agentId: "agent_1",
          selector: { provider: "web", origins: ["http://shop.example"] },
        },
        "request-3",
      ),
    ).toThrow(new WebsiteBindingError("invalid_input"));
  });

  it("creates once per request and refuses a changed replay", () => {
    const bindings = owner();
    const input = {
      agentId: "agent_1",
      selector: {
        provider: "web" as const,
        origins: ["https://shop.example"],
      },
    };
    const first = bindings.create(input, "same-request");
    expect(bindings.create(input, "same-request")).toEqual(first);
    expect(bindings.list()).toHaveLength(1);
    expect(() =>
      bindings.create(
        {
          ...input,
          selector: { ...input.selector, origins: ["https://other.example"] },
        },
        "same-request",
      ),
    ).toThrow(new WebsiteBindingError("request_conflict"));
    expect(() => bindings.create(input, "")).toThrow(
      new WebsiteBindingError("invalid_input"),
    );
  });

  it("fences every edit by the version the owner read", () => {
    const bindings = owner();
    const created = bindings.create(
      {
        agentId: "agent_1",
        selector: { provider: "web", origins: ["https://shop.example"] },
      },
      "request-4",
    );
    const paused = bindings.update(created.bindingId, {
      expectedVersion: 1,
      lifecycle: "suspended",
      turnstile: true,
      accent: "#AABBCC",
      persona: "Sell ferns.",
    });
    expect(paused).toMatchObject({
      lifecycle: "suspended",
      authorityVersion: 2,
      persona: "Sell ferns.",
      selector: { turnstile: true, accent: "#aabbcc" },
    });
    expect(() =>
      bindings.update(created.bindingId, {
        expectedVersion: 1,
        lifecycle: "active",
      }),
    ).toThrow(new WebsiteBindingError("version_conflict"));
    expect(() =>
      bindings.update("binding_missing", { expectedVersion: 1 }),
    ).toThrow(new WebsiteBindingError("not_found"));
    const cleared = bindings.update(created.bindingId, {
      expectedVersion: 2,
      accent: null,
      turnstile: false,
    });
    expect(cleared.selector).toEqual({
      provider: "web",
      siteKey: created.selector.siteKey,
      origins: ["https://shop.example"],
    });
  });

  it("stops resolving a rotated site key and finds the new one", () => {
    const bindings = owner();
    const created = bindings.create(
      {
        agentId: "agent_1",
        selector: { provider: "web", origins: ["https://shop.example"] },
      },
      "request-5",
    );
    const rotated = bindings.update(created.bindingId, {
      expectedVersion: 1,
      rotateSiteKey: true,
    });
    expect(rotated.selector.siteKey).not.toBe(created.selector.siteKey);
    expect(bindings.readBySiteKey(created.selector.siteKey)).toBeNull();
    expect(bindings.readBySiteKey(rotated.selector.siteKey)?.bindingId).toBe(
      created.bindingId,
    );
    expect(bindings.list()).toEqual([rotated]);
  });
});

describe("person channel instructions", () => {
  it("puts the owner's persona after the fixed rules", () => {
    expect(personChannelInstructions("  ")).not.toContain("Owner persona");
    const text = personChannelInstructions("Sell ferns.");
    expect(text.indexOf("Never claim an action")).toBeLessThan(
      text.indexOf("Owner persona:\nSell ferns."),
    );
  });
});
