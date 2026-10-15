/* global Response */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createOyster } from "../dist/host.js";
import { computerHost } from "./computer-host.fixture.mjs";

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
    { ...installation, approvedGrants: [] },
    { ...installation, declaredOperationsDigest: `sha256:${"a".repeat(64)}` },
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
    approvedGrants: installed.approvedGrants.map((grant) => ({
      ...grant,
      capabilityApproved: false,
    })),
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
