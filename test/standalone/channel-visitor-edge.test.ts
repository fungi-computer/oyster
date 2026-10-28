import { describe, expect, it } from "vitest";
import {
  createVisitorEdge,
  type VisitorEdgeChannel,
} from "../../src/channels/visitor-edge.js";
import { channelIds } from "../../src/channels/ids.js";

const siteKey = channelIds.site.generate();
const bindingId = channelIds.binding.generate();
const tokens = {
  fern: `vt_${"A".repeat(43)}`,
  moss: `vt_${"B".repeat(43)}`,
};

function edge() {
  const calls: string[] = [];
  const door = (agent: string): VisitorEdgeChannel => ({
    [Symbol.dispose]: () => {
      calls.push(`dispose:${agent}`);
    },
    readChannelSite: () => Promise.resolve(null),
    mintChannelVisitor: () =>
      Promise.resolve({ kind: "denied", reason: "unmapped" }),
    refreshChannelVisitor: () =>
      Promise.resolve({
        kind: "denied",
        reason: "refresh_invalid",
      }),
    rotateChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
    sendAsChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
    withdrawAsChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
    latestPendingAsChannelVisitor: () =>
      Promise.resolve({ kind: "unauthorized" }),
    readAsChannelVisitor: () =>
      Promise.resolve({
        kind: "view",
        view: { agent, lines: [] },
      }),
    openVisitorSession: (input) => {
      calls.push(`session:${agent}:${String(input.options.limit ?? "all")}`);
      return Promise.resolve({
        kind: "session",
        snapshot: JSON.stringify({ agent }),
      });
    },
    watchAsChannelVisitor: () =>
      Promise.resolve({
        kind: "stream",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`event: agent\ndata: ${agent}\n\n`),
            );
            controller.close();
          },
        }),
      }),
  });
  const app = createVisitorEdge({
    resolveSite: (_context, key: string) => {
      calls.push(`site:${key}`);
      return Promise.resolve(key === siteKey ? { bindingId } : null);
    },
    openSite: () => {
      calls.push("site-door");
      return Promise.resolve(door("site"));
    },
    authenticateVisitor: (_context, _site, token: string) => {
      calls.push("authenticate");
      if (token === tokens.fern) return Promise.resolve({ visitorId: "fern" });
      if (token === tokens.moss) return Promise.resolve({ visitorId: "moss" });
      return Promise.resolve(null);
    },
    openChannel: (_context, _site, visitor: { visitorId: string }) => {
      calls.push(`agent:${visitor.visitorId}`);
      return Promise.resolve(door(visitor.visitorId));
    },
    addressHash: () => Promise.resolve("hash"),
    assetPath: (kind: "widget" | "styles") => `/${kind}`,
    onError: (error: Error) => {
      throw error;
    },
  });
  const url = (path: string) =>
    `https://hub.example/api/embed/v1/sites/${siteKey}${path}`;
  const headers = (token: string) => ({
    origin: "https://hub.example",
    authorization: `Bearer ${token}`,
  });
  return { app, calls, url, headers };
}

describe("host-selected visitor conversation edge", () => {
  it("allows authenticated event-stream reads without Origin", async () => {
    const { app, url } = edge();
    const events = await app.request(url("/conversation/events"), {
      headers: { authorization: `Bearer ${tokens.fern}` },
    });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    expect(await events.text()).toBe("event: agent\ndata: fern\n\n");
  });

  it("still requires Origin even when Sec-Fetch-Site is same-origin", async () => {
    const { app, calls, url } = edge();
    const response = await app.request(url("/session"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.fern}`,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ limit: 5 }),
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("authenticates before Agent selection and never opens an Agent for a bad bearer", async () => {
    const { app, calls, url, headers } = edge();
    const response = await app.request(url("/session"), {
      method: "POST",
      headers: headers(`vt_${"C".repeat(43)}`),
      body: JSON.stringify({ limit: 5 }),
    });
    expect(response.status).toBe(401);
    expect(calls).toEqual([`site:${siteKey}`, "authenticate"]);
  });

  it("refuses unknown visitors before resolving Agents across current conversation operations", async () => {
    const { app, calls, url, headers } = edge();
    const token = `vt_${"C".repeat(43)}`;
    const requestId = "widget-request-1";
    const requests = [
      {
        path: "/messages",
        method: "POST",
        body: JSON.stringify({ requestId, text: "Hello" }),
      },
      {
        path: "/requests/withdraw",
        method: "POST",
        body: JSON.stringify({ requestId }),
      },
      { path: "/conversation/pending/latest", method: "GET" },
      { path: "/conversation/events", method: "GET" },
    ] as const;
    for (const { path, method, ...rest } of requests) {
      const response = await app.request(url(path), {
        method,
        headers: headers(token),
        ...rest,
      });
      expect(response.status).toBe(401);
    }
    expect(calls).toEqual(
      requests.flatMap(() => [`site:${siteKey}`, "authenticate"]),
    );
  });

  it("leaves the legacy GET /conversation on its site owner", async () => {
    const { app, calls, url, headers } = edge();
    const response = await app.request(url("/conversation"), {
      headers: headers(tokens.fern),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agent: "site", lines: [] });
    expect(calls).toEqual([`site:${siteKey}`, "site-door", "dispose:site"]);
  });

  it("resolves a different Agent per authenticated visitor for document and SSE", async () => {
    const { app, calls, url, headers } = edge();
    for (const [token, agent] of [
      [tokens.fern, "fern"],
      [tokens.moss, "moss"],
    ] as const) {
      const document = await app.request(url("/session"), {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ limit: 5 }),
      });
      expect(document.status).toBe(200);
      expect(await document.json()).toEqual({ agent });
      const events = await app.request(url("/conversation/events"), {
        headers: headers(token),
      });
      expect(events.headers.get("content-type")).toBe("text/event-stream");
      expect(await events.text()).toBe(`event: agent\ndata: ${agent}\n\n`);
    }
    expect(calls.filter((call) => call.startsWith("agent:"))).toEqual([
      "agent:fern",
      "agent:fern",
      "agent:moss",
      "agent:moss",
    ]);
    expect(calls).not.toContain("site-door");
    expect(calls.indexOf("authenticate")).toBeLessThan(
      calls.indexOf("agent:fern"),
    );
  });
});
