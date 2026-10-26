import { describe, expect, it } from "vitest";
import type { Json } from "../../src/browser/cdp-client.js";
import { attachPage } from "../../src/browser/page.js";
import { onboxBrowserSessions } from "../../src/browser/sessions.js";

describe("Chromium context selection", () => {
  it("attaches only to a page in the selected context, never a neighbor's page", async () => {
    const calls: {
      method: string;
      params: Readonly<Record<string, Json>>;
    }[] = [];
    const client = {
      browserContextId: "context-b",
      call: (method: string, params: Readonly<Record<string, Json>>) => {
        calls.push({ method, params });
        if (method === "Target.getTargets")
          return Promise.resolve({
            targetInfos: [
              {
                targetId: "other-team",
                type: "page",
                browserContextId: "context-a",
              },
              { targetId: "ours", type: "page", browserContextId: "context-b" },
            ],
          });
        if (method === "Target.attachToTarget")
          return Promise.resolve({ sessionId: "attached-ours" });
        return Promise.resolve({});
      },
      on: () => () => undefined,
      waitForEvent: () => Promise.resolve({}),
      close: () => undefined,
    };
    const page = await attachPage(client);
    expect(page.targetId).toBe("ours");
    expect(calls).toContainEqual({
      method: "Target.attachToTarget",
      params: { targetId: "ours", flatten: true },
    });
    expect(calls.some(({ method }) => method === "Target.createTarget")).toBe(
      false,
    );
  });

  it("refuses an on-box origin outside loopback before any CDP call", () => {
    expect(() => onboxBrowserSessions("https://example.com")).toThrow(
      "bare IPv4 loopback",
    );
  });

  it("reports an unreadable native discovery response as a provider failure", async () => {
    const sessions = onboxBrowserSessions("http://127.0.0.1:49180", () =>
      Promise.resolve(new Response("not-json")),
    );
    await expect(
      sessions.create({ keepAliveMs: 10_000 }, new AbortController().signal),
    ).rejects.toMatchObject({
      _tag: "CloudBrowserUpstreamError",
      op: "onbox.connect",
    });
  });
});
