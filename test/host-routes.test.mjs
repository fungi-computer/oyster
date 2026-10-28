/* global Response */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { Hono } from "hono";
import { createOyster } from "../dist/host.js";
import {
  createInstallationOperations,
  installationOperationsPort,
} from "../dist/installation-operations.js";
import { defaultTenant } from "../dist/tenant.js";
import { computerHost } from "./computer-host.fixture.mjs";
import { loadPageAssets, PageAssetsLoadError } from "../dist/page-assets.js";
import { sha256 } from "../dist/release.js";
import { fungiFaviconHref } from "@fungi.computer/sigils/favicon";

test("every Oyster page a person opens in a tab carries the Fungi sigil, under a policy that lets it load", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const app = createOyster({ ...host });
  const link = `<link rel="icon" type="image/svg+xml" href="${fungiFaviconHref}">`;
  for (const path of ["/login", "/", "/apps/context-probe/"]) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).includes(link), `${path} tab icon`);
    const policy = response.headers.get("Content-Security-Policy");
    // A page with a policy must name data: among its image sources.
    if (policy !== null)
      assert.match(
        policy,
        /img-src[^;]*\bdata:/u,
        `${path} allows data: icons`,
      );
  }
});

for (const location of ["command", "provisional_outcome"])
  test(`an obsolete preview ${location} returns a readable typed refusal over the status and admission doors`, async () => {
    const host = await computerHost(
      { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
      null,
    );
    const current = await host.installations.get("context-probe");
    const database = new DatabaseSync(":memory:");
    try {
      const runtime = await createInstallationOperations({
        owner: fromNodeSqlite(database),
        registryName: "registry",
        generation: () => "route-store",
        get: () => null,
        compareAndPut: async () => ({ ok: false, code: "stale_authority" }),
        execute: async () => ({
          state: "unconfirmed",
          outcome: "outcome_unknown",
        }),
        scheduleWake: () => Promise.resolve(),
      });
      const operations = installationOperationsPort(
        (request) => runtime.dispatch(request),
        { tenantId: defaultTenant, origin: "https://oyster.test" },
      );
      await operations.admit({
        requestId: "old-preview",
        installationId: "context-probe",
        release: current.release,
        actor: { kind: "member", memberId: "fixture" },
        intent: "install-or-select",
        origin: "owner-direct",
      });
      const command = await operations.load("old-preview");
      const outcome = {
        state: "succeeded",
        installation: current,
        creation: "fresh",
        uiCheck: {
          kind: "failed",
          code: "ui_mount_failed",
          diagnostics: {
            failedPredicate: "navigation_failed",
            finalUrlPath: "out-of-scope",
            consoleErrors: [],
            pageErrors: [],
            failedRequests: [],
            droppedCount: 0,
          },
        },
      };
      if (location === "command")
        database
          .prepare(
            "UPDATE installation_commands SET command=? WHERE request_id=?",
          )
          .run(
            JSON.stringify({
              ...command,
              operation: { ...command.operation, ...outcome },
            }),
            "old-preview",
          );
      else
        database
          .prepare(
            "UPDATE installation_commands SET provisional_outcome=? WHERE request_id=?",
          )
          .run(JSON.stringify(outcome), "old-preview");
      const app = createOyster({
        ...host,
        installations: {
          ...host.installations,
          operations,
        },
      });
      const responses = [
        await app.request(
          "/api/installations/context-probe/status?requestId=old-preview",
        ),
        await app.request("/api/installations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "old-preview",
          },
          body: JSON.stringify({
            installationId: "context-probe",
            release: current.release,
          }),
        }),
      ];
      for (const response of responses) {
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          error: "stored_operation_invalid",
          message:
            "Stored installation operation is incompatible or invalid; republish this standalone preview.",
        });
      }
    } finally {
      database.close();
    }
  });

test("installation POST admits before Instance preparation and returns its correlated status", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const current = await host.installations.get("context-probe");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const operation = {
    requestId: "route-admission",
    requestedInstallationId: "context-probe",
    installationId: "context-probe",
    release: current.release,
    state: "pending",
  };
  let admissions = 0;
  const app = createOyster({
    ...host,
    installations: {
      ...host.installations,
      generation: async () => "route-store",
      operations: {
        admit: async (input) => {
          admissions++;
          assert.equal(input.requestId, operation.requestId);
          assert.equal(input.installationId, "context-probe");
          return operation;
        },
        read: async () => operation,
      },
    },
    instances: {
      get: () => ({
        ...host.instances.get(current.instanceId),
        prepare: async () => {
          entered.resolve("preparation");
          await release.promise;
          return { ok: false, code: "ui_mount_failed" };
        },
      }),
    },
  });
  const posting = app.request("/api/installations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": operation.requestId,
    },
    body: JSON.stringify({
      installationId: "context-probe",
      release: current.release,
    }),
  });
  try {
    assert.equal(
      await Promise.race([posting.then(() => "admission"), entered.promise]),
      "admission",
      "the HTTP acknowledgement must not await preparation",
    );
    const response = await posting;
    assert.equal(response.status, 202);
    assert.equal(admissions, 1);
    assert.deepEqual(await response.json(), operation);
    const status = await app.request(
      "/api/installations/context-probe/status?requestId=route-admission",
    );
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), operation);
  } finally {
    release.resolve();
    await posting;
  }
});

test("first page-asset use returns the exact generated sources, including fonts and consent", async () => {
  const sources = await loadPageAssets();
  const generated = await import("../dist/page-script.js");
  assert.deepEqual(Object.keys(sources).sort(), Object.keys(generated).sort());
  for (const name of Object.keys(generated)) {
    assert.ok(sources[name].length > 0, name);
    assert.equal(sources[name], generated[name], name);
  }
});

test("concurrent page-asset use retains the maintained module's source identity", async () => {
  const [first, second] = await Promise.all([
    loadPageAssets(),
    loadPageAssets(),
  ]);
  assert.equal(second, first);
  assert.equal(await loadPageAssets(), first);
});

test("page-source failure is an explicit private refusal and retries only on a later request", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  let attempts = 0;
  let available = false;
  const app = createOyster({
    ...host,
    pageAssets: async () => {
      attempts++;
      if (!available)
        throw new PageAssetsLoadError(
          new Error("fixture private loader detail"),
        );
      return loadPageAssets();
    },
  });
  assert.equal(attempts, 0, "host construction must not acquire page sources");
  for (let request = 1; request <= 2; request++) {
    const refused = await app.request("/login");
    assert.equal(refused.status, 503);
    assert.equal(await refused.text(), "Host page assets unavailable");
    assert.equal(refused.headers.get("Cache-Control"), "no-store");
    assert.equal(attempts, request, "a failed request must not retry itself");
  }
  available = true;
  const recovered = await app.request("/login");
  assert.equal(recovered.status, 200);
  assert.match(await recovered.text(), /Sign in/);
  assert.equal(attempts, 3);
  assert.equal((await app.request("/login")).status, 200);
  assert.equal(attempts, 3, "successful acquisition stays memoized");
});

test("concurrent first page and asset failures share one attempt and recover on the next asset request", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const sources = await loadPageAssets();
  const assetPath = `/_oyster/assets/${(await sha256(new globalThis.TextEncoder().encode(sources.fontStyles))).slice(7)}/fonts.css`;
  let attempts = 0;
  let rejectLoad;
  const unavailable = new Promise((_, reject) => {
    rejectLoad = reject;
  });
  const app = createOyster({
    ...host,
    pageAssets: () => {
      attempts++;
      return attempts === 1 ? unavailable : loadPageAssets();
    },
  });
  const page = app.request("/login");
  const asset = app.request(assetPath);
  assert.equal(attempts, 1);
  rejectLoad(new Error("fixture private loader detail"));
  for (const refused of await Promise.all([page, asset])) {
    assert.equal(refused.status, 503);
    assert.equal(await refused.text(), "Host page assets unavailable");
    assert.equal(refused.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(attempts, 1);
  const recovered = await app.request(assetPath);
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), sources.fontStyles);
  assert.equal(
    recovered.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(attempts, 2);
});

test("first host page requests serve exact digest-addressed assets and preserve a page override", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const override = "/* fixture page override */";
  const app = createOyster({ ...host, pageScript: override });
  const sources = await loadPageAssets();
  const path = async (name, source) =>
    `/_oyster/assets/${(await sha256(new globalThis.TextEncoder().encode(source))).slice(7)}/${name}`;
  const expected = await Promise.all(
    [
      ["page.js", override, "text/javascript; charset=utf-8"],
      [
        "public-home.js",
        sources.publicHomeScript,
        "text/javascript; charset=utf-8",
      ],
      [
        "grant-consent.js",
        sources.grantConsentScript,
        "text/javascript; charset=utf-8",
      ],
      ["fonts.css", sources.fontStyles, "text/css; charset=utf-8"],
      ["login-fonts.css", sources.loginFontStyles, "text/css; charset=utf-8"],
      ["styles.css", sources.shellStyles, "text/css; charset=utf-8"],
    ].map(async ([name, source, contentType]) => ({
      path: await path(name, source),
      source,
      contentType,
    })),
  );
  const [first, concurrent] = await Promise.all([
    app.request("/login"),
    app.request("/login"),
  ]);
  assert.equal(first.status, 200);
  assert.equal(concurrent.status, 200);
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  const html = await first.text();
  assert.equal(await concurrent.text(), html);
  for (const asset of expected) {
    if (
      asset.path.endsWith("login-fonts.css") ||
      asset.path.endsWith("styles.css")
    )
      assert.ok(html.includes(asset.path), asset.path);
    const response = await app.request(asset.path);
    assert.equal(response.status, 200, asset.path);
    assert.equal(await response.text(), asset.source, asset.path);
    assert.equal(response.headers.get("Content-Type"), asset.contentType);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(
      response.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
    );
  }
  assert.equal(
    (await app.request(await path("page.js", sources.pageScript))).status,
    404,
  );
  assert.equal(
    (await app.request("/_oyster/assets/missing/page.js")).status,
    404,
  );
});

test("the empty home names the next step: install Apps with npx oyster install-apps", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const app = createOyster({
    ...host,
    auth: {
      authenticate: () =>
        Promise.resolve({
          kind: "admitted",
          principal: {
            actor: { kind: "member", memberId: "fixture" },
            role: "owner",
          },
        }),
    },
    installations: { ...host.installations, list: async () => [] },
  });
  const html = await (await app.request("/")).text();
  assert.match(html, /No Apps installed yet\./);
  assert.match(html, /Install Apps with <code>npx oyster install-apps<\/code>/);
});

test("owner API routes stay private without blocking an admitted key's App requests", async () => {
  const ownerRoutes = new Hono().post(
    "/api/keys",
    () => new Response("created"),
  );
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const installed = await host.installations.get("context-probe");
  const app = createOyster({
    ...host,
    keys: {
      live: async (keyId) => ({
        keyId,
        owner: "fixture",
        grantVersion: 1,
        grants: [{ capability: "apps.use", targets: { kind: "all" } }],
      }),
    },
    auth: {
      authenticate: (request) =>
        Promise.resolve({
          kind: "admitted",
          principal:
            request.headers.get("Authorization") === "owner"
              ? {
                  actor: { kind: "member", memberId: "fixture" },
                  role: "owner",
                }
              : { actor: { kind: "team-key", keyId: "fixture" } },
        }),
    },
    installations: {
      get: async () => ({ ...installed, installationId: "bonsai" }),
    },
    instances: {
      get: () => ({
        fetch: () => Promise.resolve(new Response("App reached")),
      }),
    },
    ownerRoutes,
  });
  assert.equal(
    (
      await app.request("/api/keys", {
        method: "POST",
        headers: { Authorization: "owner" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request("/api/keys", {
        method: "POST",
        headers: { Authorization: "agent-key" },
      })
    ).status,
    403,
  );
  const response = await app.request("/apps/bonsai/backend", {
    method: "PUT",
    headers: { Authorization: "agent-key" },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "App reached");
});

test("owner desktop reads a declared Gill using only the host Computer", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    "computer_fixture",
    {
      backend: {
        bindings: [
          { name: "COMPUTER", operations: ["processes", "processStart"] },
        ],
      },
      gills: [
        {
          id: "context",
          source: "context",
          title: "Context",
          params: [
            {
              key: "computer",
              label: "Computer",
              kind: "computer",
              required: true,
            },
          ],
        },
      ],
    },
    [],
    ["computer.execute"],
  );
  const calls = [];
  const app = createOyster({
    ...host,
    instances: {
      get: () => ({
        gill: async (facts, _api, source, input) => {
          calls.push({ facts, source, input });
          return {
            ok: true,
            value: {
              viewId: "context",
              title: "Context",
              state: "full",
              rows: [{ id: "one", title: facts.subject.context.computerId }],
            },
          };
        },
      }),
    },
  });
  const response = await app.request("/apps/context-probe/gills", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      viewId: "context",
      params: { computer: "computer_fixture" },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rows[0].title, "computer_fixture");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "context");
  assert.deepEqual(calls[0].facts.grants, [
    { binding: "COMPUTER", operations: ["processes"] },
  ]);
  assert.equal(calls[0].facts.subject.context.actor.memberId, "fixture");
});

test("desktop Gill refuses key, visitor, foreign Computer and undeclared parameters before dispatch", async () => {
  let dispatched = 0;
  for (const [principal, params, status] of [
    [
      { actor: { kind: "member", memberId: "member" }, role: "member" },
      {},
      403,
    ],
    [{ actor: { kind: "agent", agentId: "agent" } }, {}, 403],
    [
      { actor: { kind: "team-key", keyId: "named" } },
      { computer: "computer_fixture" },
      403,
    ],
    [null, { computer: "computer_fixture" }, 401],
    [
      { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
      { computer: "computer_other" },
      403,
    ],
    [
      { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
      { arbitrary: "value" },
      400,
    ],
  ]) {
    const host = await computerHost(principal, "computer_fixture", {
      gills: [
        {
          id: "context",
          source: "context",
          title: "Context",
          params: [
            {
              key: "computer",
              label: "Computer",
              kind: "computer",
              required: true,
            },
          ],
        },
      ],
    });
    const app = createOyster({
      ...host,
      instances: {
        get: () => ({
          gill: () => {
            dispatched++;
            throw new Error("Refused Gill reached Instance");
          },
        }),
      },
    });
    const response = await app.request("/apps/context-probe/gills", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewId: "context", params }),
    });
    assert.equal(response.status, status);
  }
  assert.equal(dispatched, 0);
});

test("desktop Gill exposes missing placement and host-only Computer choices without dispatch", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    "computer_fixture",
    {
      gills: [
        {
          id: "context",
          source: "context",
          title: "Context",
          params: [
            {
              key: "computer",
              label: "Computer",
              kind: "computer",
              required: true,
            },
          ],
        },
      ],
    },
  );
  let dispatched = 0;
  const app = createOyster({
    ...host,
    instances: {
      get: () => ({
        gill: () => {
          dispatched++;
          throw new Error("Placement request reached Instance");
        },
      }),
    },
  });
  const send = (input) =>
    app.request("/apps/context-probe/gills", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  const missing = await send({ viewId: "context" });
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).reason, "params_required");
  assert.deepEqual(
    await (await send({ viewId: "context", options: "computer" })).json(),
    { options: [{ value: "computer_fixture", label: "computer_fixture" }] },
  );
  assert.equal(
    (await send({ viewId: "context", options: "arbitrary" })).status,
    400,
  );
  assert.equal(dispatched, 0);
});

test("Gill source requirements use the current explicit installation approval", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    "computer_fixture",
    {
      backend: { bindings: [{ name: "COMPUTER", operations: ["processes"] }] },
      gills: [{ id: "context", title: "Context", source: "context" }],
    },
    [],
    ["computer.execute"],
  );
  const installation = await host.installations.get("context-probe");
  let calls = 0;
  for (const altered of [
    {
      ...installation,
      authority: {
        ...installation.authority,
        approvedGrants: [],
      },
    },
    {
      ...installation,
      authority: {
        ...installation.authority,
        declaredOperationsDigest: `sha256:${"a".repeat(64)}`,
      },
    },
  ]) {
    const app = createOyster({
      ...host,
      installations: { ...host.installations, get: async () => altered },
      instances: {
        get: () => ({
          gill: async () => {
            calls++;
            throw new Error("Unapproved Gill must not dispatch");
          },
        }),
      },
    });
    const response = await app.request("/apps/context-probe/gills", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewId: "context" }),
    });
    assert.equal(response.status, 403);
  }
  assert.equal(calls, 0);
});

function gillRequest(app, input) {
  return gillBodyRequest(app, JSON.stringify(input));
}

function gillBodyRequest(app, body) {
  return app.request("/apps/context-probe/gills", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

test("placement replies enforce the consent marker before exposing choices", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    "computer_fixture",
    {
      backend: { bindings: [{ name: "COMPUTER", operations: ["processes"] }] },
      gills: [
        {
          id: "context",
          title: "Context",
          source: "context",
          params: [
            {
              key: "computer",
              kind: "computer",
              label: "Computer",
              required: true,
            },
          ],
        },
      ],
    },
    [],
    ["computer.execute"],
  );
  const installed = await host.installations.get("context-probe");
  const revoked = {
    ...installed,
    authority: {
      ...installed.authority,
      approvedGrants: installed.authority.approvedGrants.map((grant) => ({
        ...grant,
        capabilityApproved: false,
      })),
    },
  };
  let calls = 0;
  const app = createOyster({
    ...host,
    installations: { ...host.installations, get: async () => revoked },
    instances: {
      get: () => ({
        gill: async () => {
          calls++;
          throw new Error("Unapproved dispatch");
        },
      }),
    },
  });
  for (const input of [
    { viewId: "context" },
    { viewId: "context", options: "computer" },
    { viewId: "context", params: { computer: "computer_fixture" } },
  ])
    assert.equal((await gillRequest(app, input)).status, 403);
  assert.equal(calls, 0);
});

test("a malformed guest Gill reply is a typed private execution refusal", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
    {
      gills: [{ id: "context", title: "Context", source: "context" }],
    },
  );
  const app = createOyster({
    ...host,
    instances: {
      get: () => ({
        gill: async () => ({
          ok: true,
          value: {
            viewId: "context",
            title: "PRIVATE guest output",
            state: "full",
            rows: "bad",
          },
        }),
      }),
    },
  });
  const response = await gillRequest(app, { viewId: "context" });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "App execution failed" });
});

test("Gill refuses disabled, removed and unassigned Instances without dispatch", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
    {
      gills: [{ id: "context", title: "Context", source: "context" }],
    },
  );
  const installed = await host.installations.get("context-probe");
  let calls = 0;
  for (const [record, status] of [
    [{ ...installed, status: "disabled" }, 404],
    [null, 404],
    [{ ...installed, instanceId: null }, 403],
  ]) {
    const app = createOyster({
      ...host,
      installations: { ...host.installations, get: async () => record },
      instances: {
        get: () => ({
          gill: async () => {
            calls++;
            throw new Error("Unavailable dispatch");
          },
        }),
      },
    });
    assert.equal(
      (await gillRequest(app, { viewId: "context" })).status,
      status,
    );
  }
  assert.equal(calls, 0);
});

test("Gill refuses write and external sources before dispatch", async () => {
  let calls = 0;
  for (const effect of ["write", "external"]) {
    const host = await computerHost(
      { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
      null,
      {
        gills: [{ id: "context", title: "Context", source: "context" }],
        api: {
          methods: {
            context: {
              description: "Non-read",
              input: { type: "object" },
              output: { type: "object" },
              effect,
              requires: [],
            },
          },
        },
      },
    );
    const app = createOyster({
      ...host,
      instances: {
        get: () => ({
          gill: async () => {
            calls++;
            throw new Error("Non-read dispatch");
          },
        }),
      },
    });
    assert.equal((await gillRequest(app, { viewId: "context" })).status, 403);
  }
  assert.equal(calls, 0);
});

test("Gill bounds and decodes real request representations before dispatch", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
    {
      gills: [
        {
          id: "context",
          title: "Context",
          source: "context",
          params: [
            {
              key: "repository",
              kind: "repository",
              label: "Repository",
              required: false,
            },
          ],
        },
      ],
    },
  );
  let calls = 0;
  const app = createOyster({
    ...host,
    instances: {
      get: () => ({
        gill: async () => {
          calls++;
          throw new Error("Invalid dispatch");
        },
      }),
    },
  });
  for (const [body, status] of [
    ["{", 400],
    ["x".repeat(1024 * 1024 + 1), 413],
    [JSON.stringify({ viewId: "context", extra: true }), 400],
    [
      JSON.stringify({
        viewId: "context",
        params: { repository: "../foreign" },
      }),
      400,
    ],
  ])
    assert.equal((await gillBodyRequest(app, body)).status, status);
  assert.equal(calls, 0);
});

test("Gill options scope grants to the declared options source", async () => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
    {
      backend: { bindings: [{ name: "COMPUTER", operations: ["processes"] }] },
      gills: [
        {
          id: "context",
          title: "Context",
          source: "context",
          params: [
            {
              key: "repository",
              kind: "repository",
              label: "Repository",
              required: false,
              options: "choices",
            },
          ],
        },
      ],
      api: {
        methods: {
          choices: {
            description: "Choose",
            input: { type: "object" },
            output: { type: "object" },
            effect: "read",
            requires: [],
          },
        },
      },
    },
    [],
    ["computer.execute"],
  );
  let call;
  const app = createOyster({
    ...host,
    instances: {
      get: () => ({
        gill: async (facts, _api, source) => {
          call = { facts, source };
          return { ok: true, value: { options: [] } };
        },
      }),
    },
  });
  assert.equal(
    (await gillRequest(app, { viewId: "context", options: "repository" }))
      .status,
    200,
  );
  assert.equal(call.source, "choices");
  assert.deepEqual(call.facts.grants, []);
});

test("an Oyster serves a public robots.txt and marks every response noindex", async () => {
  const host = await computerHost(null, null);
  const app = createOyster({ ...host });
  const robots = await app.request("/robots.txt");
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
  assert.match(robots.headers.get("Content-Type") ?? "", /^text\/plain/u);
  assert.equal(robots.headers.get("X-Robots-Tag"), "noindex, nofollow");
  for (const path of ["/", "/login", "/api/installations"]) {
    const response = await app.request(path);
    assert.equal(
      response.headers.get("X-Robots-Tag"),
      "noindex, nofollow",
      path,
    );
  }
});
