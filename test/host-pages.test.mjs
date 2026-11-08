import assert from "node:assert/strict";
import { test } from "node:test";
import { createOyster } from "../dist/host.js";
import { ownerKeyAuth } from "../dist/auth.js";
import { startSignInLink } from "../dist/standalone/sign-in-link.js";
import { computerHost } from "./computer-host.fixture.mjs";
import { homePageFixture } from "./home-page.fixture.mjs";
import { routes } from "../dist/authorization.js";
import { computerSlots } from "../dist/computer.js";

const key = "oooooooooooooooooooooooooooooooo";
const documentHeaders = { Accept: "text/html" };
const { Request, URLSearchParams, fetch } = globalThis;

test("capability APIs and transport children preserve their refusals even when a browser asks for HTML", async () => {
  const capabilities = Object.values(computerSlots).map((slot) => ({
    ...slot,
    permission: "computer.execute",
    routes: routes(),
  }));
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
    {},
    capabilities,
  );
  const app = createOyster(host);
  for (const path of [
    "/computer/ports",
    "/computer/processes",
    "/computer/terminal",
    "/computer/terminal/events",
  ]) {
    const machine = await app.request(path, {
      headers: { Accept: "application/json" },
    });
    const browser = await app.request(path, { headers: documentHeaders });
    assert.equal(browser.status, machine.status, path);
    assert.ok(browser.status >= 400, path);
    assert.equal(
      browser.headers.get("Content-Type"),
      machine.headers.get("Content-Type"),
      path,
    );
    assert.equal(await browser.text(), await machine.text(), path);
  }
});

test("a browser gets the accessible wrong-key form; machine login keeps its original refusal", async () => {
  const host = await computerHost(null, null);
  const app = createOyster({ ...host, auth: ownerKeyAuth(key) });
  for (const headers of [{}, documentHeaders]) {
    const response = await app.request("/login", {
      method: "POST",
      headers,
      body: new URLSearchParams({ key: "private-wrong-key" }),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.has("Set-Cookie"), false);
    const body = await response.text();
    assert.equal(body.includes("private-wrong-key"), false);
    if (headers.Accept) {
      assert.match(body, /That key didn’t open it/);
      assert.match(body, /role="alert"/);
      assert.match(body, /name="key"/);
      assert.match(body, /type="submit"/);
      assert.match(body, /action="\/login"/);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    } else assert.equal(body, "Wrong key");
  }
  const malformed = await app.request("/login", {
    method: "POST",
    headers: { ...documentHeaders, "Content-Type": "text/plain" },
    body: key,
  });
  assert.equal(malformed.status, 400);
  assert.match(await malformed.text(), /That key didn’t open it/);
  const signedIn = await app.request("/login", {
    method: "POST",
    headers: documentHeaders,
    body: new URLSearchParams({ key }),
  });
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get("Location"), "/");
  // The app's default origin is http://localhost: loopback HTTP, no Secure.
  assert.match(
    signedIn.headers.get("Set-Cookie"),
    /oyster_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict/,
  );
  assert.doesNotMatch(signedIn.headers.get("Set-Cookie"), /Secure/);
  const overHttps = await app.request("https://owner.example.test/login", {
    method: "POST",
    headers: documentHeaders,
    body: new URLSearchParams({ key }),
  });
  assert.equal(overHttps.status, 303);
  assert.match(
    overHttps.headers.get("Set-Cookie"),
    /HttpOnly; Secure; SameSite=Strict/,
  );
});

test("the sign-in page welcomes a first visit, welcomes a returning browser back, and explains a used link", async () => {
  const host = await computerHost(null, null);
  const app = createOyster({ ...host, auth: ownerKeyAuth(key) });
  const first = await (
    await app.request("/login", { headers: documentHeaders })
  ).text();
  assert.match(first, /Welcome\./);
  assert.doesNotMatch(first, /Welcome back/);
  assert.doesNotMatch(first, /This link was already used/);
  const signedIn = await app.request("/login", {
    method: "POST",
    headers: documentHeaders,
    body: new URLSearchParams({ key }),
  });
  assert.match(signedIn.headers.get("Set-Cookie") ?? "", /oyster_returning=1/);
  const returning = await (
    await app.request("/login?link=used", {
      headers: { ...documentHeaders, Cookie: "oyster_returning=1" },
    })
  ).text();
  assert.match(returning, /Welcome back\./);
  assert.match(
    returning,
    /This link was already used\. Paste the key from <code>\.oyster-owner<\/code>/,
  );
  const missing = await (
    await app.request("/missing", { headers: documentHeaders })
  ).text();
  assert.match(missing, /Page not found/);
  assert.doesNotMatch(missing, /We’ll reconnect/);
});

test("document 404s and failures are designed, while API and App asset bodies keep their contracts", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const app = createOyster(host);
  for (const path of ["/missing", "/apps/missing/", "/apps/%ZZ/"]) {
    const response = await app.request(path, { headers: documentHeaders });
    assert.equal(response.status, 404);
    assert.match(await response.text(), /Nothing growing here/);
  }
  for (const path of [
    "/api/missing",
    "/ui/missing/rel_missing/index.html",
    "/_oyster/assets/missing/missing.css",
  ]) {
    const response = await app.request(path, { headers: documentHeaders });
    assert.equal(response.status, 404);
    assert.equal(
      (response.headers.get("Content-Type") ?? "").includes("text/html"),
      false,
    );
    assert.equal(
      (await response.text()).includes("Nothing growing here"),
      false,
    );
  }
  for (const accept of [
    "application/json, text/html;q=0.5",
    "text/html;q=0, application/json",
  ]) {
    const response = await app.request("/apps/missing/", {
      headers: { Accept: accept },
    });
    assert.match(response.headers.get("Content-Type"), /application\/json/u);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  const broken = createOyster({
    ...host,
    installations: {
      ...host.installations,
      get: () => {
        throw new Error("fixture-private-diagnostic");
      },
    },
  });
  const error = await broken.request("/apps/context-probe/", {
    headers: documentHeaders,
  });
  assert.equal(error.status, 500);
  const errorBody = await error.text();
  assert.match(errorBody, /That didn’t go through/);
  assert.equal(errorBody.includes("fixture-private-diagnostic"), false);
  const unavailable = createOyster({
    ...host,
    pageAssets: () => Promise.reject(new Error("fixture-private-assets")),
  });
  const response = await unavailable.request("/login", {
    headers: documentHeaders,
  });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /That didn’t go through/);
});

test("home selection still redirects; missing, disabled and unapproved desktops leave owner recovery", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
    { displayName: "Hello <mushroom>" },
  );
  const ordinary = createOyster({
    ...host,
    homeInstallationId: "context-probe",
  });
  assert.equal(
    (await ordinary.request("/")).headers.get("Location"),
    "/apps/context-probe/",
  );
  const missing = createOyster({ ...host, homeInstallationId: "missing" });
  const body = await (await missing.request("/")).text();
  assert.match(body, /Your desktop needs a hand/);
  assert.match(body, /context-probe/);
  assert.match(body, /App access/);
  assert.equal(body.includes("rel_contextprobe"), false);
  const disabled = createOyster({
    ...host,
    homeInstallationId: "context-probe",
    installations: {
      ...host.installations,
      get: async (id) => {
        const current = await host.installations.get(id);
        return current && { ...current, status: "disabled" };
      },
      list: async () => [],
    },
  });
  assert.match(
    await (await disabled.request("/")).text(),
    /Your desktop needs a hand/,
  );
  const unapproved = await homePageFixture({
    shellModule: true,
    approved: false,
  });
  const response = await unapproved.request("/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /App access/);
});

test("the helper remains single-use, with a real manual POST and a key-free used-link page", async () => {
  const helper = await startSignInLink({
    oysterUrl: "http://127.0.0.1:8787",
    key,
  });
  try {
    assert.equal(helper.url.includes(key), false);
    const first = await fetch(helper.url);
    assert.equal(first.status, 200);
    const body = await first.text();
    assert.match(body, /Opening your Oyster/);
    assert.match(body, /action="http:\/\/127.0.0.1:8787\/login"/);
    assert.match(body, /type="submit"/);
    assert.ok(body.includes(key));
    const second = await fetch(helper.url, { redirect: "manual" });
    assert.equal(second.status, 302);
    assert.equal(
      second.headers.get("Location"),
      "http://127.0.0.1:8787/login?link=used",
    );
    assert.equal(second.headers.get("Cache-Control"), "no-store");
    assert.equal((await second.text()).includes(key), false);
    assert.equal(
      (await fetch(new Request(helper.url, { method: "POST" }))).status,
      404,
    );
  } finally {
    await helper.close();
  }
});

test("permissions documents show identity and a safe exit before scripts load; JSON remains the grant contract", async () => {
  const app = await homePageFixture({ approved: false });
  const path = "/api/installations/desktop/grants";
  const before = await (
    await app.request(path, { headers: { Accept: "application/json" } })
  ).json();
  const response = await app.request(path, { headers: documentHeaders });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Choose what this App can do/);
  assert.match(html, /Back to Apps/);
  assert.match(html, /<noscript>/);
  assert.match(html, /Needs review/);
  assert.match(html, /Full access to your Team and every App/);
  assert.match(html, /Only pick a shell you trust/);
  assert.match(
    html,
    /To decline, return to Apps without saving or confirming a change/,
  );
  assert.ok(html.includes(before.artifactDigest));
  assert.match(html, /login-fonts\.css/);
  assert.equal(
    html.includes('action="/api/installations/desktop/grants"'),
    false,
  );
  const after = await (
    await app.request(path, { headers: { Accept: "application/json" } })
  ).json();
  assert.deepEqual(
    after,
    before,
    "viewing or leaving consent grants no authority",
  );
});
