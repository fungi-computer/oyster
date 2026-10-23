import { describe, expect, it } from "vitest";
import {
  passivePreviewResponse,
  previewOrigins,
  standalonePreviewRequest,
} from "../../src/standalone/preview.js";

const origins = {
  owner: "https://oyster.shiit.app",
  preview: "https://oyster-contest.levi-fe0.workers.dev",
};
const env = {
  OYSTER_ORIGIN: origins.owner,
  OYSTER_PREVIEW_ORIGIN: origins.preview,
};
const signature = "a".repeat(20);

describe("standalone preview-only origin fence", () => {
  it("requires the explicit approved origin pair and does not infer it from a request", () => {
    expect(previewOrigins({})).toBeNull();
    expect(
      previewOrigins({
        OYSTER_ORIGIN: origins.owner,
        OYSTER_PREVIEW_ORIGIN: origins.preview,
      }),
    ).toEqual(origins);
    // The pair is config, not a fixed literal: any distinct, well-formed
    // origin pair the operator configures is honored, not just this one.
    const otherOrigins = {
      owner: "https://bonsai-preview.levi-fe0.workers.dev",
      preview: "https://bonsai-preview-other.levi-fe0.workers.dev",
    };
    expect(
      previewOrigins({
        OYSTER_ORIGIN: otherOrigins.owner,
        OYSTER_PREVIEW_ORIGIN: otherOrigins.preview,
      }),
    ).toEqual(otherOrigins);
    for (const preview of [
      origins.owner,
      `${origins.preview}/api`,
      "http://oyster-contest.levi-fe0.workers.dev",
    ])
      expect(
        previewOrigins({
          OYSTER_ORIGIN: origins.owner,
          OYSTER_PREVIEW_ORIGIN: preview,
        }),
      ).toBeNull();
    expect(
      previewOrigins({ OYSTER_PREVIEW_ORIGIN: origins.preview }),
    ).toBeNull();
    expect(
      previewOrigins({
        OYSTER_ORIGIN: "not an origin",
        OYSTER_PREVIEW_ORIGIN: origins.preview,
      }),
    ).toBeNull();
  });
  it("refuses every non-preview path and non-read method without entering a forwarder", async () => {
    // Nothing configured OYSTER_PREVIEW_ORIGIN at all, or at a host other
    // than this one: that host is not a security fence on a literal — it
    // just leaves routing to the caller, like any other unmatched origin.
    for (const unconfigured of [
      {},
      {
        OYSTER_ORIGIN: origins.owner,
        OYSTER_PREVIEW_ORIGIN: "https://unrelated.example",
      },
    ])
      expect(
        await standalonePreviewRequest(
          new Request(`${origins.preview}/login`),
          unconfigured,
          (id) => Promise.resolve(id === "workspace"),
          () => {
            throw new Error(
              "Unconfigured preview must never enter the forwarder",
            );
          },
        ),
      ).toBeNull();
    // Once a host IS the configured preview tunnel, it stays fenced off from
    // the normal router even if the rest of the pair (the owner origin) is
    // separately broken or missing — misconfiguration never falls through.
    for (const brokenOwner of [
      { OYSTER_PREVIEW_ORIGIN: origins.preview },
      {
        OYSTER_ORIGIN: "not an origin",
        OYSTER_PREVIEW_ORIGIN: origins.preview,
      },
      {
        OYSTER_ORIGIN: origins.preview,
        OYSTER_PREVIEW_ORIGIN: origins.preview,
      },
    ])
      expect(
        (
          await standalonePreviewRequest(
            new Request(`${origins.preview}/login`),
            brokenOwner,
            (id) => Promise.resolve(id === "workspace"),
            () => {
              throw new Error("Forbidden forwarding");
            },
          )
        )?.status,
      ).toBe(404);
    for (const path of [
      "/",
      "/api",
      "/apps",
      "/ui/shed",
      "/login",
      "/mcp",
      "/__vm/lab/ws",
      "/preview/workspace/3000/bad/",
      "/preview/other/3000/" + signature + "/",
      "/preview/workspace/3000/" + signature + "/../../../../../api",
    ])
      expect(
        (
          await standalonePreviewRequest(
            new Request(origins.preview + path),
            env,
            (id) => Promise.resolve(id === "workspace"),
            () => {
              throw new Error("Forbidden forwarding");
            },
          )
        )?.status,
      ).toBe(404);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
      expect(
        (
          await standalonePreviewRequest(
            new Request(
              `${origins.preview}/preview/workspace/3000/${signature}/`,
              { method },
            ),
            env,
            (id) => Promise.resolve(id === "workspace"),
            () => {
              throw new Error("Forbidden forwarding");
            },
          )
        )?.status,
      ).toBe(404);
  });
  it("forwards only service-relative paths while removing ambient credentials", async () => {
    const seen: Request[] = [];
    const response = await standalonePreviewRequest(
      new Request(
        `${origins.preview}/preview/workspace/3000/${signature}/docs?a=1`,
        {
          headers: {
            Cookie: "fixture-private",
            Authorization: "Bearer fixture-private",
            Host: "fixture.invalid",
          },
        },
      ),
      env,
      (id) => Promise.resolve(id === "workspace"),
      (computerId, ticket, port, request) => {
        expect(computerId).toBe("workspace");
        expect(ticket).toBe(signature);
        expect(port).toBe(3000);
        seen.push(request);
        return Promise.resolve(new Response("hi"));
      },
    );
    expect(response?.status).toBe(200);
    expect(seen[0]?.url).toBe("http://localhost/docs?a=1");
    expect(seen[0]?.headers.has("Cookie")).toBe(false);
    expect(seen[0]?.headers.has("Authorization")).toBe(false);
    expect(seen[0]?.headers.has("Host")).toBe(false);
  });
  it("leaves the canonical owner origin to its existing router", async () => {
    expect(
      await standalonePreviewRequest(
        new Request(`${origins.owner}/api`),
        env,
        (id) => Promise.resolve(id === "workspace"),
        () => {
          throw new Error("Not a preview");
        },
      ),
    ).toBeNull();
  });
});

describe("passive preview response boundary", () => {
  it("owns the sandbox and strips supplier cookies, identity and relaxation headers", async () => {
    const response = await passivePreviewResponse(
      new Response("<h1>hi</h1>", {
        headers: {
          "Content-Type": "text/html",
          "Set-Cookie": "fixture-private",
          "Clear-Site-Data": '"*"',
          "Access-Control-Allow-Origin": "*",
          "Content-Security-Policy": "sandbox allow-scripts allow-same-origin",
          "X-Private": "fixture-private",
        },
      }),
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "sandbox;",
    );
    expect(response.headers.get("Content-Security-Policy")).not.toContain(
      "allow-scripts",
    );
    for (const header of [
      "Set-Cookie",
      "Clear-Site-Data",
      "Access-Control-Allow-Origin",
      "X-Private",
    ])
      expect(response.headers.has(header)).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.text()).toBe("<h1>hi</h1>");
  });
  it("refuses redirects, Refresh and executable/non-document responses", async () => {
    expect(
      (
        await passivePreviewResponse(
          new Response(null, {
            status: 302,
            headers: { Location: origins.owner },
          }),
        )
      ).status,
    ).toBe(502);
    expect(
      (
        await passivePreviewResponse(
          new Response("hi", {
            headers: {
              "Content-Type": "text/html",
              Refresh: "0;url=" + origins.owner,
            },
          }),
        )
      ).status,
    ).toBe(502);
    for (const type of [
      "text/javascript",
      "application/json",
      "image/svg+xml",
      "application/octet-stream",
    ])
      expect(
        (
          await passivePreviewResponse(
            new Response("hi", { headers: { "Content-Type": type } }),
          )
        ).status,
      ).toBe(415);
  });
});
