// Oyster is owner-only. A request with no credential reaches only sign-in,
// robots.txt and digest-pinned shell assets; every other door refuses it.
/* global Request */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcp, createMcpCatalog } from "@fungi.computer/mycelium/mcp";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { ownerOrKeyAuth } from "../dist/auth.js";
import { createOyster } from "../dist/host.js";
import { oysterMcpCatalogLoad } from "../dist/mcp.js";
import { computerHost } from "./computer-host.fixture.mjs";

const ownerKey = "owner-only-admission-owner-key";
const origin = "https://oyster.test";

async function oyster() {
  const fixture = await computerHost(null, null);
  const auth = ownerOrKeyAuth(ownerKey, "owner", () => ({
    verify: async () => ({ kind: "not_found" }),
  }));
  const gitExchanges = [];
  const data = { ...fixture, auth };
  const mcp = createMcp({
    catalog: createMcpCatalog({
      load: oysterMcpCatalogLoad(data),
      sandbox: directSandbox(() => Promise.resolve(null)),
    }),
    authenticate: async (request) => {
      const admission = await auth.authenticate(request);
      return admission.kind === "refused"
        ? admission
        : { kind: "admitted", principal: admission.principal };
    },
  });
  const app = createOyster({
    ...data,
    mcp,
    git: {
      writerOf: (principal) => ({ kind: "actor", actor: principal.actor }),
      git: async (installation) => {
        const reply = { status: 200, headers: {}, body: new Uint8Array() };
        return {
          read: async () => {
            gitExchanges.push(installation.installationId);
            return reply;
          },
          push: async () => {
            gitExchanges.push(installation.installationId);
            return reply;
          },
        };
      },
    },
  });
  return { app, gitExchanges };
}

const html = { Accept: "text/html" };
const anonymous = (app, path, init = {}) =>
  app.request(new Request(`${origin}${path}`, init));

test("an anonymous HTML GET of the home or an App goes to sign-in", async () => {
  const { app } = await oyster();
  for (const path of ["/", "/apps/context-probe/"]) {
    const response = await anonymous(app, path, { headers: html });
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("Location"), "/login", path);
    assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  }
});

test("anonymous App, API, MCP and Git requests are refused", async () => {
  const { app, gitExchanges } = await oyster();
  const json = { "Content-Type": "application/json" };
  const refused = [
    ["/", {}],
    ["/apps/context-probe/", { headers: { Accept: "application/json" } }],
    [
      "/apps/context-probe/methods/context",
      { method: "POST", headers: json, body: "{}" },
    ],
    ["/api/installations", {}],
    ["/api/installations/context-probe/grants", {}],
    [
      "/mcp",
      {
        method: "POST",
        headers: { ...json, Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "anonymous", version: "1" },
          },
        }),
      },
    ],
    ["/git/context-probe/source.git/info/refs?service=git-upload-pack", {}],
    ["/git/context-probe/source.git/info/refs?service=git-receive-pack", {}],
  ];
  for (const [path, init] of refused) {
    const response = await anonymous(app, path, init);
    assert.equal(response.status, 401, `${init.method ?? "GET"} ${path}`);
    assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  }
  assert.deepEqual(gitExchanges, [], "no anonymous request reaches Git");
});

test("sign-in, robots.txt and shell assets stay reachable without a credential", async () => {
  const { app } = await oyster();
  const login = await anonymous(app, "/login", { headers: html });
  assert.equal(login.status, 200);
  const robots = await anonymous(app, "/robots.txt");
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
  const stylesheet =
    /href="(\/_oyster\/assets\/[a-f0-9]{64}\/login-fonts\.css)"/u.exec(
      await login.text(),
    )?.[1];
  assert.ok(stylesheet, "the sign-in page links its digest-pinned stylesheet");
  assert.equal((await anonymous(app, stylesheet)).status, 200);
});

test("the owner still reaches the home, Apps and Git", async () => {
  const { app, gitExchanges } = await oyster();
  const owner = { Authorization: `Bearer ${ownerKey}` };
  const home = await anonymous(app, "/", { headers: { ...owner, ...html } });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /href="\/apps\/context-probe\/"/u);
  const call = await anonymous(app, "/apps/context-probe/methods/context", {
    method: "POST",
    headers: { ...owner, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(call.status, 200);
  const clone = await anonymous(
    app,
    "/git/context-probe/source.git/info/refs?service=git-upload-pack",
    { headers: owner },
  );
  assert.equal(clone.status, 200);
  assert.deepEqual(gitExchanges, ["context-probe"]);
});

test("the owner has no way to make an App public", async () => {
  const { app } = await oyster();
  const response = await anonymous(
    app,
    "/api/installations/context-probe/visibility",
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ownerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ visibility: "public" }),
    },
  );
  assert.equal(response.status, 404);
});
