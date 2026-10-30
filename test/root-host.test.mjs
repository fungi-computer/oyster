import { homePageFixture } from "./home-page.fixture.mjs";
import { computerHost } from "./computer-host.fixture.mjs";
import { standalonePermissionResources } from "../dist/standalone/permission-resources.js";
/* global Response */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HTTPException } from "hono/http-exception";
import { createOyster } from "../dist/host.js";
import { approvedInstallation } from "../dist/testing/index.js";
import {
  installationObservationSignal,
  observeInstallation,
} from "../dist/installation-client.js";
import {
  installationCommandIds,
  installationOperationSchema,
} from "../dist/installation-operations.js";

async function fixture(homeInstallationId, anonymous = false, computerId) {
  const calls = [];
  const desktop = await approvedInstallation({
    installationId: "desktop-fork",
    instanceId: null,
    release: {
      appId: "app_desktop",
      releaseId: "rel_desktop",
      artifact: {
        artifactRef: `artifact:sha256-${"a".repeat(64)}`,
        artifactDigest: `sha256:${"a".repeat(64)}`,
        provenance: {
          sourceRevision: `git:${"a".repeat(40)}`,
          sourceTreeDigest: `sha256:${"a".repeat(64)}`,
          buildRecipeDigest: `sha256:${"a".repeat(64)}`,
        },
      },
    },
    declaration: { capabilities: [], handlers: [], roles: [] },
  });
  const bonsai = { ...desktop, installationId: "bonsai" };
  const host = {
    auth: {
      authenticate: (request) =>
        Promise.resolve(
          anonymous
            ? { kind: "refused", status: 401 }
            : {
                kind: "admitted",
                principal:
                  request.headers.get("Authorization") === "owner"
                    ? {
                        actor: { kind: "member", memberId: "admitted-owner" },
                        role: "owner",
                      }
                    : { actor: { kind: "team-key", keyId: "admitted-owner" } },
              },
        ),
    },
    artifacts: {
      get: () => Promise.reject(new Error("Private Release read forbidden")),
      put: () => Promise.reject(new Error("Read only")),
    },
    installations: {
      list: () =>
        Promise.resolve([
          desktop,
          bonsai,
          {
            ...desktop,
            installationId: "disabled",
            status: "disabled",
          },
        ]),
      get: (id) =>
        Promise.resolve(id === desktop.installationId ? desktop : null),
    },
    instances: {
      get: () => {
        throw new Error("No Instance expected");
      },
    },
    workbench: {
      directory: () => {
        calls.push("directory");
        return Promise.resolve({ apps: [], roles: {} });
      },
      storage: (installationId, ownerId) => ({
        read: (key) => {
          calls.push({ installationId, ownerId, key });
          return Promise.resolve({ kind: "rejected", code: "undeclared_key" });
        },
        write: () => {
          throw new Error("Invalid write must not reach storage");
        },
        reset: () => {
          throw new Error("Invalid reset must not reach storage");
        },
        events: () =>
          Promise.resolve(new Response("event: ready\ndata: {}\n\n")),
      }),
    },
  };
  if (computerId !== undefined) host.computerId = computerId;
  if (homeInstallationId !== undefined)
    host.homeInstallationId = homeInstallationId;
  return { app: createOyster(host), calls };
}

test("root selects an ordinary installed home without a particular App identity", async () => {
  const app = await homePageFixture({ declared: false });
  const response = await app.request("/", {
    headers: { Authorization: "owner" },
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/apps/desktop/");
});

test("only owner-direct grants HTML permits same-origin framing; the shell and App sandbox stay fenced", async () => {
  const app = await homePageFixture({ shellModule: true });
  const path = "/api/installations/desktop/grants";
  const html = await app.request(path);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("Content-Type"), /^text\/html/u);
  assert.match(
    html.headers.get("Content-Security-Policy"),
    /(?:^|; )frame-ancestors 'self'(?:;|$)/u,
  );
  const json = await app.request(path, {
    headers: { Accept: "application/json" },
  });
  assert.equal(json.status, 200);
  assert.equal(json.headers.get("Content-Security-Policy"), null);
  assert.equal((await json.json()).installationId, "desktop");
  const shell = await app.request("/apps/desktop/");
  assert.equal(shell.status, 200);
  assert.match(
    shell.headers.get("Content-Security-Policy"),
    /frame-ancestors 'none'/u,
  );
  const ui = await app.request("/ui/desktop/rel_desktop/index.html");
  assert.equal(ui.status, 200);
  assert.match(ui.headers.get("Content-Security-Policy"), /; sandbox /u);
  assert.doesNotMatch(
    ui.headers.get("Content-Security-Policy"),
    /allow-same-origin/u,
  );
  for (const headers of [
    { "x-who": "key" },
    { "X-Oyster-Installation": "desktop" },
  ]) {
    const refused = await app.request(path, { headers });
    assert.equal(refused.status, 403);
    assert.notEqual(
      refused.headers.get("Content-Security-Policy"),
      html.headers.get("Content-Security-Policy"),
    );
  }
  const anonymous = await app.request(path, {
    headers: { "x-who": "anonymous" },
  });
  assert.equal(anonymous.status, 401);
  const member = createOyster(
    await computerHost({
      actor: { kind: "member", memberId: "member" },
      role: "member",
    }),
  );
  assert.equal(
    (await member.request("/api/installations/context-probe/grants")).status,
    403,
  );
});

test("root directory is owner-only and contains no synthetic Hub administration", async () => {
  const { app, calls } = await fixture();
  assert.equal(
    (
      await app.request("/api/workbench/directory", {
        headers: { Authorization: "key" },
      })
    ).status,
    403,
  );
  assert.deepEqual(calls, []);
  const response = await app.request("/api/workbench/directory", {
    headers: { Authorization: "owner" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { apps: [], roles: {} });
});

test("owner workbench inventory projects the fixed Computer without Team grants or timestamps", async () => {
  const { app } = await fixture(undefined, false, "workspace");
  assert.equal(
    (
      await app.request("/api/workbench/directory", {
        headers: { Authorization: "key" },
      })
    ).status,
    403,
  );
  const response = await app.request("/api/workbench/directory", {
    headers: { Authorization: "owner" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    apps: [],
    roles: {},
    computer: { computerId: "workspace", name: "workspace" },
  });
});

test("storage uses admitted owner identity and the canonical key decoder", async () => {
  const { app, calls } = await fixture();
  const path =
    "/api/workbench/storage/desktop-fork/read?key=desktop&ownerId=forged";
  assert.equal(
    (await app.request(path, { headers: { Authorization: "key" } })).status,
    403,
  );
  assert.deepEqual(calls, []);
  const response = await app.request(path, {
    headers: { Authorization: "owner" },
  });
  assert.deepEqual(await response.json(), {
    kind: "rejected",
    code: "undeclared_key",
  });
  assert.deepEqual(calls, [
    {
      installationId: "desktop-fork",
      ownerId: "admitted-owner",
      key: "desktop",
    },
  ]);
  assert.equal(
    (
      await app.request("/api/workbench/storage/desktop-fork/read", {
        headers: { Authorization: "owner" },
      })
    ).status,
    400,
  );
});

test("storage rejects forged admission fields before calling its owner", async () => {
  const { app } = await fixture();
  const response = await app.request(
    "/api/workbench/storage/desktop-fork/write",
    {
      method: "POST",
      headers: { Authorization: "owner", "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "desktop",
        scope: "member",
        basedOn: null,
        value: {},
        ownerId: "forged",
      }),
    },
  );
  assert.equal(response.status, 400);
});

for (const { name, options, principal, workbench, storage } of [
  {
    name: "declared owner home",
    options: {},
    principal: "owner",
    workbench: true,
    storage: true,
  },
  {
    name: "admitted key",
    options: {},
    principal: "key",
    workbench: false,
    storage: false,
  },
  {
    name: "another installed App",
    options: { home: "other" },
    principal: "owner",
    workbench: false,
    storage: true,
  },
  {
    name: "undeclared workbench",
    options: { declared: false },
    principal: "owner",
    workbench: false,
    storage: true,
  },
  {
    name: "host without root data",
    options: { rootData: false },
    principal: "owner",
    workbench: false,
    storage: false,
  },
]) {
  test(`home composition admits only the ${name}'s actual services`, async () => {
    const app = await homePageFixture(options);
    const response = await app.request("https://oyster.test/apps/desktop/", {
      headers: { Accept: "application/json", "x-who": principal },
    });
    assert.equal(response.status, 200);
    const config = await response.json();
    assert.equal(config.workbench, workbench);
    assert.equal(config.storage, storage);
  });
}

test("the home shell page names its Release's own shell module, or none", async () => {
  for (const [shellModule, expected] of [
    [true, "/ui-entry/desktop/rel_desktop/shell.js"],
    [false, null],
  ]) {
    const app = await homePageFixture({ shellModule });
    const response = await app.request("https://oyster.test/apps/desktop/", {
      headers: { Accept: "application/json", "x-who": "owner" },
    });
    assert.equal(response.status, 200);
    const config = await response.json();
    assert.equal(config.workbench, true);
    assert.equal(config.shellModuleUrl, expected);
  }
  const app = await homePageFixture({ shellModule: true });
  const keyed = await app.request("https://oyster.test/apps/desktop/", {
    headers: { Accept: "application/json", "x-who": "key" },
  });
  assert.equal((await keyed.json()).shellModuleUrl, null);
  const entry = await app.request(
    "https://oyster.test/ui-entry/desktop/rel_desktop/shell.js",
  );
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get("content-type") ?? "", /^text\/javascript/u);
  assert.equal(
    await entry.text(),
    'export * from "/ui/desktop/rel_desktop/shell.js";\n',
  );
  const module = await app.request(
    "https://oyster.test/ui/desktop/rel_desktop/shell.js",
  );
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type") ?? "", /^text\/javascript/u);
  assert.match(await module.text(), /export const mountShell/u);
});

test("the shell entry and its module recheck current approval instead of immutable UI caching", async () => {
  const app = await homePageFixture({ shellModule: true });
  const shell = [
    "/ui-entry/desktop/rel_desktop/shell.js",
    "/ui/desktop/rel_desktop/shell.js",
  ];
  for (const path of shell) {
    const approved = await app.request(path);
    assert.equal(approved.status, 200);
    assert.equal(approved.headers.get("Cache-Control"), "no-store");
  }
  const projectionResponse = await app.request(
    "/api/installations/desktop/grants",
    { headers: { Accept: "application/json" } },
  );
  assert.equal(projectionResponse.status, 200);
  const projection = await projectionResponse.json();
  const revoked = await app.request("/api/installations/desktop/grants", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeGeneration: "fixture-generation",
      authorityVersion: projection.permissions.authority.authorityVersion,
      artifactDigest: projection.artifactDigest,
      command: {
        kind: "change-grants",
        changes: [{ capability: "team.workbenchHost", grant: null }],
      },
    }),
  });
  assert.equal(revoked.status, 200);
  for (const path of shell) {
    const refused = await app.request(path);
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("Cache-Control"), "no-store");
  }
  const missing = await app.request("/ui-entry/desktop/rel_other/shell.js");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("Cache-Control"), "no-store");
  const ordinary = await app.request("/ui/desktop/rel_desktop/index.html");
  assert.equal(ordinary.status, 200);
  assert.equal(
    ordinary.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
});

test("App UI bytes come from the host's verified cache, filled by the first verified read", async () => {
  for (const shellModule of [false, true]) {
    const cached = new Map();
    const puts = [];
    const reads = [];
    const app = await homePageFixture({
      shellModule,
      onArtifactRead: (ref) => reads.push(ref),
      uiCache: {
        match: (digest) =>
          Promise.resolve(
            cached.has(digest) ? new Response(cached.get(digest)).body : null,
          ),
        put: (digest, bytes) => {
          puts.push(digest);
          cached.set(digest, bytes.slice());
          return Promise.resolve("stored");
        },
      },
    });
    const path = shellModule
      ? "/ui/desktop/rel_desktop/index.html"
      : "/ui/desktop/rel_desktop/";
    const first = await app.request(path);
    assert.equal(first.status, 200);
    assert.equal(
      first.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
    );
    // Server-Timing names the Registry hop the UI request waited on.
    assert.match(first.headers.get("Server-Timing") ?? "", /registry;dur=/u);
    const html = await first.text();
    assert.match(html, /Home fixture/u);
    assert.equal(puts.length, 1);
    const readsAfterFirst = reads.length;
    const second = await app.request(path);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), html);
    assert.equal(reads.length, readsAfterFirst, "a hit reads no artifact");
    assert.equal(puts.length, 1);
  }
});

test("an App page learns apps.open only from its own Release declaration", async () => {
  for (const opens of [true, false]) {
    const app = await homePageFixture({ opens });
    const response = await app.request("https://oyster.test/apps/desktop/", {
      headers: { Accept: "application/json", "x-who": "owner" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).appsOpen, opens);
  }
});

test("a deployable root supplies its browser composition without a core App import", async () => {
  const app = await homePageFixture();
  const html = await (
    await app.request("/apps/desktop/", { headers: { "x-who": "owner" } })
  ).text();
  const path = /<script type="module" src="([^"]+)"/u.exec(html)?.[1];
  const response = await app.request(path);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "// trusted root composition");
});

test("the installed shell admits its bundled data fonts", async () => {
  const app = await homePageFixture();
  const response = await app.request("https://oyster.test/apps/desktop/", {
    headers: { "x-who": "owner" },
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("Content-Security-Policy"),
    /font-src data:/u,
  );
});

test("an anonymous home lists no App and sends the browser to sign-in", async () => {
  const { app, calls } = await fixture("desktop-fork", true);
  const page = await app.request("/", { headers: { Accept: "text/html" } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("Location"), "/login");
  const json = await app.request("/", {
    headers: { Accept: "application/json" },
  });
  assert.equal(json.status, 401);
  assert.doesNotMatch(await json.text(), /bonsai|desktop-fork/u);
  assert.deepEqual(calls, []);
  for (const path of ["/api/workbench/directory", "/api/installations"]) {
    assert.equal((await app.request(path)).status, 401);
  }
  // This host declares no key routes, so none is served.
  assert.equal((await app.request("/api/keys")).status, 404);
  const appPage = await app.request("/apps/bonsai/", {
    headers: { Accept: "text/html" },
  });
  assert.equal(appPage.status, 302);
  assert.equal(appPage.headers.get("Location"), "/login");
  const login = await app.request("/login");
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Owner key/u);
});

test("host bundles are digest-pinned immutable assets", async () => {
  const app = await homePageFixture();
  const shell = await app.request("/apps/desktop/", {
    headers: { "x-who": "owner" },
  });
  const html = await shell.text();
  const script = /<script type="module" src="([^"]+)"/u.exec(html)?.[1];
  assert.match(script, /^\/_oyster\/assets\/[a-f0-9]{64}\/page.js$/u);
  const response = await app.request(script);
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(await response.text(), "// trusted root composition");
  const fonts = /<link rel="stylesheet" href="([^"]+fonts.css)"/u.exec(
    html,
  )?.[1];
  assert.match(fonts, /^\/_oyster\/assets\/[a-f0-9]{64}\/fonts.css$/u);
  assert.equal(
    (await app.request(fonts)).headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    (await app.request(`/_oyster/assets/${"0".repeat(64)}/page.js`)).status,
    404,
  );
  assert.equal((await app.request("/_oyster/page.js")).status, 404);
});

test("login keeps its ordinary owner-key POST and uses the responsive Caps form", async () => {
  const app = await homePageFixture();
  const response = await app.request("/login");
  const html = await response.text();
  assert.match(html, /name="viewport" content="width=device-width/u);
  assert.match(html, /class="caps-centered-card/u);
  assert.match(html, /class="caps-form"/u);
  assert.match(html, /method="post" action="\/login"/u);
  assert.match(html, /name="key"/u);
  assert.match(html, /type="password"/u);
  assert.match(html, /autocomplete="current-password"/iu);
  assert.match(html, /caps-input/u);
  assert.match(html, /caps-button/u);
  assert.match(
    html,
    /<link rel="stylesheet" href="\/_oyster\/assets\/[a-f0-9]{64}\/styles.css"/u,
  );
});

test("login ships only the sans font family it renders", async () => {
  const app = await homePageFixture();
  const html = await (await app.request("/login")).text();
  const fonts = /<link rel="stylesheet" href="([^"]+login-fonts.css)"/u.exec(
    html,
  )?.[1];
  assert.match(fonts, /^\/_oyster\/assets\/[a-f0-9]{64}\/login-fonts.css$/u);
  assert.doesNotMatch(html, /\/fonts.css"/u);
  const response = await app.request(fonts);
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  const css = await response.text();
  const families = new Set(
    [...css.matchAll(/font-family:\s*"?([^";}]+?)"?\s*[;}]/gu)].map(
      (match) => match[1],
    ),
  );
  assert.deepEqual([...families], ["Nunito"]);
  const shared = await (
    await app.request(
      /<link rel="stylesheet" href="([^"]+\/fonts.css)"/u.exec(
        await (
          await app.request("/apps/desktop/", { headers: { "x-who": "owner" } })
        ).text(),
      )?.[1],
    )
  ).text();
  assert.ok(css.length < shared.length / 4);
});

test("owner permission reads use the host resource directory, never an App's claimed identities", async () => {
  const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
  const host = await computerHost(owner, null);
  const resources = [
    { kind: "computer", id: "computer-a", label: "Work Computer" },
    { kind: "agent", id: "agent-a", label: "Research" },
  ];
  const readers = [];
  const app = createOyster({
    ...host,
    permissionResources: async (principal) => {
      readers.push(principal);
      return resources;
    },
  });
  const response = await app.request(
    "/api/installations/context-probe/grants",
    {
      headers: { Accept: "application/json" },
    },
  );
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.canEdit, true);
  assert.deepEqual(view.resources, resources);
  assert.deepEqual(readers, [owner]);
  const appOrigin = await app.request(
    "/api/installations/context-probe/grants",
    {
      headers: {
        Accept: "application/json",
        "X-Oyster-Installation": "context-probe",
      },
    },
  );
  assert.equal(appOrigin.status, 403);
  assert.equal(readers.length, 1);
});

test("standalone Permissions follow native picker pages, including the configured Computer, and never publish a partial failed directory", async () => {
  const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
  const host = await computerHost(owner, null);
  const choices = Array.from({ length: 101 }, (_, index) => ({
    computerId: index === 0 ? "build" : `computer-${index}`,
    name: index === 0 ? "Build Computer" : `Computer ${index}`,
  }));
  const reads = [];
  let unavailable = false;
  const permissionResources = standalonePermissionResources(
    {
      computerFleet: async (memberId, request) => {
        assert.equal(memberId, "owner");
        assert.equal(request.operation, "choices");
        assert.equal(request.page.limit, 100);
        reads.push(request.page.offset);
        if (unavailable && request.page.offset === 100) return null;
        return {
          computers: choices.slice(
            request.page.offset,
            request.page.offset + 100,
          ),
          nextOffset: request.page.offset === 0 ? 100 : null,
        };
      },
    },
    { list: async () => [] },
  );
  const app = createOyster({ ...host, permissionResources });
  const read = () =>
    app.request("/api/installations/context-probe/grants", {
      headers: { Accept: "application/json" },
    });
  const response = await read();
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).resources,
    choices.map((computer) => ({
      kind: "computer",
      id: computer.computerId,
      label: computer.name,
    })),
  );
  assert.deepEqual(reads, [0, 100]);
  unavailable = true;
  const failed = await read();
  assert.equal(failed.status, 500);
});

for (const [appId, builtIn] of [
  ["app_tourtois", true],
  ["app_other", false],
]) {
  test(`only Tourtois receives the fresh home Shell pre-grant (${appId}); owner revocation survives re-selection`, async () => {
    const app = await homePageFixture({
      appId,
      home: "tourtois",
      approved: false,
      shellModule: true,
    });
    const [{ release }] = await (
      await app.request("/api/installations")
    ).json();
    const install = async (installationId) => {
      const requestId = installationCommandIds.request.generate();
      const admitted = await app.request("/api/installations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestId,
        },
        body: JSON.stringify({ installationId, release }),
      });
      assert.equal(admitted.status, 202);
      const initial = installationOperationSchema.parse(await admitted.json());
      const result = await observeInstallation({
        requestId,
        initial,
        signal: installationObservationSignal({}),
        read: async () => {
          const response = await app.request(
            `/api/installations/${installationId}/status?requestId=${requestId}`,
          );
          assert.equal(response.status, 200);
          return installationOperationSchema.parse(await response.json());
        },
      });
      assert.equal(result.state, "succeeded");
      return result.installation;
    };
    const thirdParty = await install("another-shell");
    assert.deepEqual(thirdParty.authority.approvedGrants, []);
    const home = await install("tourtois");
    assert.equal(
      home.authority.approvedGrants.some(
        (grant) => grant.capability === "team.workbenchHost",
      ),
      builtIn,
    );
    if (!builtIn) {
      const current = await (
        await app.request("/api/installations/tourtois/grants", {
          headers: { Accept: "application/json" },
        })
      ).json();
      assert.equal(current.canEdit, true);
      assert.deepEqual(current.permissions.authority.approvedGrants, []);
      return;
    }
    const page = await app.request("/apps/tourtois/", {
      headers: { Accept: "application/json" },
    });
    assert.equal(page.status, 200);
    assert.equal((await page.json()).workbench, true);
    const projection = await (
      await app.request("/api/installations/tourtois/grants", {
        headers: { Accept: "application/json" },
      })
    ).json();
    assert.equal(projection.canEdit, true);
    const revoked = await app.request("/api/installations/tourtois/grants", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeGeneration: projection.storeGeneration,
        authorityVersion: projection.permissions.authority.authorityVersion,
        artifactDigest: projection.artifactDigest,
        command: {
          kind: "change-grants",
          changes: [{ capability: "team.workbenchHost", grant: null }],
        },
      }),
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual((await install("tourtois")).authority.approvedGrants, []);
    const next = await app.request("/apps/tourtois/", {
      headers: { Accept: "application/json" },
    });
    assert.equal((await next.json()).workbench, false);
    const shell = await app.request("/ui-entry/tourtois/rel_desktop/shell.js");
    assert.equal(shell.status, 403);
    const root = await app.request("/");
    assert.equal(root.status, 200);
    assert.match(await root.text(), /App access/u);
  });
}

test("non-owner permission resources are a typed 403 refusal before reading inventory", async () => {
  const member = {
    actor: { kind: "member", memberId: "reader" },
    role: "member",
  };
  const permissionResources = standalonePermissionResources(
    { computerFleet: async () => assert.fail("Non-owner fleet read") },
    { list: async () => assert.fail("Non-owner Agent read") },
  );
  await assert.rejects(permissionResources(member), (cause) => {
    assert.ok(cause instanceof HTTPException);
    assert.equal(cause.status, 403);
    return true;
  });
  const app = createOyster({
    ...(await computerHost(member, null)),
    permissionResources,
  });
  const response = await app.request(
    "/api/installations/context-probe/grants",
    {
      headers: { Accept: "application/json" },
    },
  );
  assert.equal(response.status, 403);
});

test("a deleted installation id is retired; a reinstall takes a new id", async () => {
  const app = await homePageFixture({ approved: false });
  const json = (method, body) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const [{ release }] = await (await app.request("/api/installations")).json();
  const install = async (body = {}) => {
    const requestId = installationCommandIds.request.generate();
    const admitted = await app.request("/api/installations", {
      ...json("POST", { release, ...body }),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
    });
    assert.equal(admitted.status, 202);
    const initial = installationOperationSchema.parse(await admitted.json());
    assert.equal(initial.requestId, requestId);
    assert.equal(
      initial.requestedInstallationId,
      body.installationId ?? "app-desktop",
    );
    const completed = await observeInstallation({
      requestId,
      initial,
      signal: installationObservationSignal({}),
      read: async () => {
        const response = await app.request(
          `/api/installations/${encodeURIComponent(initial.requestedInstallationId)}/status?requestId=${encodeURIComponent(requestId)}`,
        );
        assert.equal(response.status, 200);
        const operation = installationOperationSchema.parse(
          await response.json(),
        );
        assert.equal(operation.requestId, requestId);
        return operation;
      },
    });
    assert.equal(completed.state, "succeeded");
    return completed;
  };
  const first = await install();
  assert.equal(first.creation, "fresh");
  const named = first.installation;
  assert.equal(named.installationId, "app-desktop");
  const pins = await (
    await app.request("/api/installations/app-desktop/grants", {
      headers: { Accept: "application/json" },
    })
  ).json();
  assert.equal(
    (await app.request("/api/installations/app-desktop", { method: "DELETE" }))
      .status,
    204,
  );
  for (const response of [
    await app.request("/api/installations/app-desktop/release", {
      ...json("PUT", release),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": installationCommandIds.request.generate(),
      },
    }),
  ])
    assert.deepEqual(
      { status: response.status, body: await response.json() },
      { status: 409, body: { error: "unavailable" } },
    );
  const second = await install();
  assert.equal(second.creation, "reminted");
  const fresh = second.installation;
  assert.match(fresh.installationId, /^app-desktop-[a-z0-9]{21}$/u);
  const third = await install({ installationId: "app-desktop" });
  assert.equal(third.creation, "reminted");
  const another = third.installation;
  assert.match(another.installationId, /^app-desktop-[a-z0-9]{21}$/u);
  assert.notEqual(another.installationId, fresh.installationId);
  assert.equal(fresh.authority.authorityVersion, 1);
  assert.deepEqual(fresh.authority.approvedGrants, []);
  assert.equal(
    (await (await app.request("/api/installations")).json()).find(
      (row) => row.installationId === "app-desktop",
    ).status,
    "deleted",
  );
  // A save pinned to the retired installation is a typed stale refusal.
  const stale = await app.request(
    "/api/installations/app-desktop/grants",
    json("PUT", {
      storeGeneration: "fixture-generation",
      authorityVersion: pins.permissions.authority.authorityVersion,
      artifactDigest: pins.artifactDigest,
      command: {
        kind: "change-grants",
        changes: [{ capability: "team.workbenchHost", grant: null }],
      },
    }),
  );
  assert.deepEqual(
    { status: stale.status, body: await stale.json() },
    { status: 409, body: { error: "stale_authority" } },
  );
});
