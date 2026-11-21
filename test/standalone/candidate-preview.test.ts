import { defaultTenant } from "../../src/tenant.js";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { z } from "zod";
import { expect, it, vi, afterEach } from "vitest";
import { serveHost } from "../../src/authorization.js";
import { standaloneCandidatePreview } from "../../src/standalone/candidate-preview.js";
import {
  candidatePreviewFixture,
  previewOrigin,
} from "./candidate-preview.fixture.js";
import { SignJWT, decodeJwt, jwtVerify } from "jose";
import { previewSecret } from "./candidate-preview.fixture.js";
import { standaloneBuildRoutes } from "../../src/standalone/builds.js";

const origin = "https://oyster.example";

it("requires same-origin owner-direct admission before minting a candidate grant", async () => {
  const preview = standaloneCandidatePreview({
    scope: { tenantId: defaultTenant, origin },
    secret: "candidate-preview-test-secret-at-least-32-characters",
    owner: () =>
      Promise.resolve({
        actor: { kind: "member", memberId: "owner" },
        role: "owner",
      }),
    readBuild: () => Promise.resolve(null),
    artifacts: {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    },
  });
  const app = serveHost(
    preview.routes,
    () =>
      Promise.resolve({
        kind: "admitted",
        principal: {
          actor: { kind: "member", memberId: "owner" },
          role: "owner",
        },
      }),
    { liveKey: () => Promise.resolve(null), appToolPolicy: () => null },
  );
  const entry = `${origin}/builds/job-fixture/preview`;
  const landing = await app.request(entry);
  expect(landing.status).toBe(200);
  expect(await landing.text()).not.toContain("candidate-preview-test-secret");
  for (const headers of [
    new Headers({
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }),
    new Headers({ origin: "null", "sec-fetch-site": "cross-site" }),
    new Headers(),
  ]) {
    const refused = await app.request(entry, { method: "POST", headers });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
  }
  const sameOrigin = await app.request(entry, {
    method: "POST",
    headers: { origin },
  });
  expect(sameOrigin.status).toBe(404);
  // A no-referrer landing can send Origin: null on its same-origin form POST.
  const sameSite = await app.request(entry, {
    method: "POST",
    headers: { origin: "null", "sec-fetch-site": "same-origin" },
  });
  expect(sameSite.status).toBe(404);
});

function ownerApp(preview: ReturnType<typeof standaloneCandidatePreview>) {
  return serveHost(
    preview.routes,
    () =>
      Promise.resolve({
        kind: "admitted",
        principal: {
          actor: { kind: "member", memberId: "owner" },
          role: "owner",
        },
      }),
    { liveKey: () => Promise.resolve(null), appToolPolicy: () => null },
  );
}

it("mounts a verified unselected candidate with the scripts-only sandbox on iframe and direct document", async () => {
  const fixture = await candidatePreviewFixture();
  const app = ownerApp(fixture.preview);
  const issued = await app.request(
    `${previewOrigin}/builds/job-fixture/preview`,
    { method: "POST", headers: { origin: previewOrigin } },
  );
  expect(issued.status).toBe(200);
  const parent = await issued.text();
  expect(parent).toContain('sandbox="allow-scripts"');
  expect(parent).toContain("build aaaaaaa");
  expect(parent).toContain("not checked");
  expect(parent).toContain("Details");
  const entry = previewEntry(parent);
  const document = await app.request(entry, { headers: { origin: "null" } });
  expect(document.status).toBe(200);
  expect(document.headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts;",
  );
  expect(document.headers.get("content-security-policy")).not.toMatch(
    /allow-forms|allow-popups|allow-same-origin/,
  );
  expect(document.headers.get("access-control-allow-origin")).toBe("null");
  expect(document.headers.has("access-control-allow-credentials")).toBe(false);
  expect(await document.text()).toContain("candidate");
  expect(fixture.build()?.installation).toBeNull();
});

it("refuses a preview-shaped token signed with the owner key or a different HKDF purpose", async () => {
  const fixture = await candidatePreviewFixture();
  const app = ownerApp(fixture.preview);
  const parent = await (
    await app.request(`${previewOrigin}/builds/job-fixture/preview`, {
      method: "POST",
      headers: { origin: previewOrigin },
    })
  ).text();
  const entry = new URL(previewEntry(parent));
  const valid = z.string().min(1).parse(entry.pathname.split("/")[2]);
  const claims = decodeJwt(valid);
  const input = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(previewSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const otherPurpose = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: new TextEncoder().encode("oyster/another-purpose/v1"),
    },
    input,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
  for (const wrongKey of [
    new TextEncoder().encode(previewSecret),
    otherPurpose,
  ]) {
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(wrongKey);
    const refused = await app.request(entry.href.replace(valid, forged));
    expect(refused.status).toBe(404);
  }
  const expectedPurpose = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: new TextEncoder().encode("oyster/candidate-preview/v1"),
    },
    input,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
  expect((await jwtVerify(valid, expectedPurpose)).payload.sub).toBe("owner");
  expect((await app.request(entry.href)).status).toBe(200);
});

function previewEntry(parent: string) {
  const configuration = (node: DefaultTreeAdapterTypes.Node): string | null => {
    if (
      "tagName" in node &&
      node.tagName === "script" &&
      node.attrs.some(
        ({ name, value }) => name === "id" && value === "boot-config",
      )
    )
      return node.childNodes
        .map((child) => ("value" in child ? child.value : ""))
        .join("");
    if ("childNodes" in node)
      for (const child of node.childNodes) {
        const found = configuration(child);
        if (found !== null) return found;
      }
    return null;
  };
  const config = configuration(parse(parent));
  if (!config) throw new Error("Preview configuration missing");
  return z.object({ entry: z.url() }).parse(JSON.parse(config)).entry;
}

async function issuedEntry(app: ReturnType<typeof ownerApp>) {
  const issued = await app.request(
    `${previewOrigin}/builds/job-fixture/preview`,
    { method: "POST", headers: { origin: previewOrigin } },
  );
  expect(issued.status).toBe(200);
  return previewEntry(await issued.text());
}

afterEach(() => vi.useRealTimers());

it("expires in five minutes and renews only through the owner entry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
  const fixture = await candidatePreviewFixture({ ui: "html" });
  const app = ownerApp(fixture.preview);
  const old = await issuedEntry(app);
  expect((await app.request(old)).status).toBe(200);
  vi.setSystemTime(new Date("2026-11-21T10:05:00Z"));
  expect((await app.request(old)).status).toBe(404);
  const renewed = await issuedEntry(app);
  expect(renewed).not.toBe(old);
  expect((await app.request(renewed)).status).toBe(200);
});

it("rechecks live owner and immutable job custody for every asset", async () => {
  const fixture = await candidatePreviewFixture();
  const app = ownerApp(fixture.preview);
  const entry = await issuedEntry(app);
  fixture.setOwner(null);
  expect((await app.request(entry)).status).toBe(404);
  fixture.setOwner({
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  });
  expect((await app.request(entry)).status).toBe(200);
  const build = fixture.build();
  if (build === null) throw new Error("Fixture build missing");
  fixture.setBuild({ ...build, sourceRevision: `git:${"b".repeat(40)}` });
  expect((await app.request(entry)).status).toBe(404);
  fixture.setBuild({ ...build, status: "revoked" });
  expect((await app.request(entry)).status).toBe(404);
});

it("refuses missing or tampered bytes, unlisted assets, other hosts and queries", async () => {
  const fixture = await candidatePreviewFixture();
  const app = ownerApp(fixture.preview);
  const entry = await issuedEntry(app);
  for (const url of [
    entry.replace("index.html", "secret.json"),
    entry + "?raw",
    entry.replace(previewOrigin, "https://other.example"),
  ]) {
    const refused = await app.request(url);
    expect(refused.status).toBe(404);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
  }
  for (const [reference, bytes] of fixture.objects) {
    if (new TextDecoder().decode(bytes).includes("<body>candidate")) {
      fixture.objects.set(reference, new TextEncoder().encode("tampered"));
      expect((await app.request(entry)).status).toBe(404);
      fixture.objects.delete(reference);
      expect((await app.request(entry)).status).toBe(404);
    }
  }
});

it("never issues grants to anonymous requests, members, keys or App-mediated owners", async () => {
  const fixture = await candidatePreviewFixture();
  for (const authenticate of [
    () => Promise.resolve({ kind: "refused", status: 401 } as const),
    () =>
      Promise.resolve({
        kind: "admitted",
        principal: {
          actor: { kind: "member", memberId: "member" },
          role: "member",
        },
      } as const),
    () =>
      Promise.resolve({
        kind: "admitted",
        principal: { actor: { kind: "team-key", keyId: "key" } },
      } as const),
  ]) {
    const app = serveHost(fixture.preview.routes, authenticate, {
      liveKey: () => Promise.resolve(null),
      appToolPolicy: () => null,
    });
    const response = await app.request(
      `${previewOrigin}/builds/job-fixture/preview`,
      { method: "POST", headers: { origin: previewOrigin } },
    );
    expect([401, 403]).toContain(response.status);
    expect(await response.text()).not.toContain("private-builds");
  }
  const mediated = await ownerApp(fixture.preview).request(
    `${previewOrigin}/builds/job-fixture/preview`,
    {
      method: "POST",
      headers: { origin: previewOrigin, "X-Oyster-Installation": "bonsai" },
    },
  );
  expect(mediated.status).toBe(403);
});

it("refuses delivery when a build is revoked during artifact I/O", async () => {
  const fixture = await candidatePreviewFixture();
  const app = ownerApp(fixture.preview);
  const entry = await issuedEntry(app);
  const get = fixture.options.artifacts.get;
  fixture.options.artifacts.get = async (reference) => {
    const bytes = await get(reference);
    if (
      bytes !== null &&
      new TextDecoder().decode(bytes).includes("<body>candidate")
    ) {
      const build = fixture.build();
      if (build !== null) fixture.setBuild({ ...build, status: "revoked" });
    }
    return bytes;
  };
  expect((await app.request(entry)).status).toBe(404);
});

it("shows UI without executing its backend and names a headless candidate unavailable", async () => {
  const visual = await candidatePreviewFixture({ ui: "html", backend: true });
  const visualApp = ownerApp(visual.preview);
  const entry = await issuedEntry(visualApp);
  expect((await visualApp.request(entry)).status).toBe(200);
  expect(visual.build()?.installation).toBeNull();
  const headless = await candidatePreviewFixture({ ui: "none", backend: true });
  const unavailable = await ownerApp(headless.preview).request(
    `${previewOrigin}/builds/job-fixture/preview`,
    { method: "POST", headers: { origin: previewOrigin } },
  );
  expect(unavailable.status).toBe(404);
  expect(await unavailable.text()).toBe("Candidate preview unavailable");
});

it("returns only the stable owner entry in successful build status, never a content grant", async () => {
  const fixture = await candidatePreviewFixture();
  const table = standaloneBuildRoutes(() => ({
    buildBackend: () => Promise.resolve({ kind: "no_backend" }),
    startBuild: () => Promise.resolve({ kind: "refused", reason: "no_source" }),
    readBuild: fixture.options.readBuild,
    readBuildLog: () => Promise.resolve(null),
  })).include(fixture.preview.routes);
  const app = ownerApp({ routes: table });
  const status = await app.request(`${previewOrigin}/api/builds/job-fixture`);
  expect(status.status).toBe(200);
  const body = z.object({ previewUrl: z.url() }).parse(await status.json());
  expect(body.previewUrl).toBe(`${previewOrigin}/builds/job-fixture/preview`);
  const landing = await app.request(body.previewUrl);
  expect(landing.status).toBe(200);
  expect(await landing.text()).not.toContain("rel_preview");
});

it("keeps refused content methods private and uncached too", async () => {
  const fixture = await candidatePreviewFixture();
  const app = ownerApp(fixture.preview);
  const entry = await issuedEntry(app);
  for (const method of ["POST", "PUT", "DELETE"]) {
    const refused = await app.request(entry, { method });
    expect(refused.status).toBe(404);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
  }
});

it("keeps manual freshness unverified and accepts S7 proposal refs without changing build custody", async () => {
  const fixture = await candidatePreviewFixture();
  const source = `git:${"a".repeat(40)}`;
  const base = `git:${"b".repeat(40)}`;
  const moved = `git:${"c".repeat(40)}`;
  for (const [proposal, expected] of [
    [null, "not checked against the latest proposal"],
    [
      { headRevision: source, baseRevision: base, buildBaseRevision: base },
      "matched when this preview opened",
    ],
    [
      { headRevision: moved, baseRevision: base, buildBaseRevision: base },
      "The proposal changed after this build",
    ],
    [
      { headRevision: source, baseRevision: moved, buildBaseRevision: base },
      "The proposal changed after this build",
    ],
  ] as const) {
    const app = ownerApp(
      standaloneCandidatePreview({
        ...fixture.options,
        readProposal: () => Promise.resolve(proposal),
      }),
    );
    const response = await app.request(
      `${previewOrigin}/builds/job-fixture/preview`,
      {
        method: "POST",
        headers: { origin: previewOrigin },
      },
    );
    expect(response.status).toBe(200);
    const notice = await response.text();
    expect(notice).toContain(`build ${source.slice(4, 11)}`);
    expect(notice).toContain(expected);
    expect(notice).not.toContain("snapshot current");
    expect(fixture.build()?.installation).toBeNull();
  }
});

it("keeps the anonymous arrival private and shows a named Caps landing after owner admission", async () => {
  const fixture = await candidatePreviewFixture();
  const app = ownerApp(fixture.preview);
  const url = `${previewOrigin}/builds/job-fixture/preview`;
  const arrival = await app.request(url);
  const publicHtml = await arrival.text();
  expect(publicHtml).not.toContain("Garden Planner");
  expect(publicHtml).toContain("oyster");
  const response = await app.request(url, {
    method: "POST",
    headers: { origin: previewOrigin },
    body: new URLSearchParams({ intent: "prepare" }),
  });
  const landing = await response.text();
  expect(response.status).toBe(200);
  expect(landing).toContain(
    "Preview this change to Garden Planner before you merge it.",
  );
  expect(landing).toContain("caps-button");
  expect(landing).not.toContain("/private-builds/");
  const malformed = await app.request(url, {
    method: "POST",
    headers: { origin: previewOrigin, "content-type": "application/json" },
    body: "{}",
  });
  expect(malformed.status).toBe(403);
});
