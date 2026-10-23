import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import {
  appBackendActorHeader,
  appBackendComputerHeader,
} from "@fungi.computer/agar/backend";
import { createOyster } from "../dist/host.js";
import { invocationCallerContext } from "../dist/invocation.js";
import { parseAppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import { appSurfaceCache, oysterAppMethods } from "../dist/mcp.js";
import { computerHost } from "./computer-host.fixture.mjs";
import { Hono } from "hono";
import { computerSlots } from "../dist/computer.js";

test("the page's fresh admission reports current Computer permission and refuses disabled installations", async () => {
  const capabilities = [
    {
      ...computerSlots.terminal,
      permission: "computer.execute",
      routes: new Hono(),
    },
  ];
  const host = await computerHost(
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    "host-workspace",
    {},
    capabilities,
  );
  const app = createOyster(host);
  const request = () =>
    app.request("/apps/context-probe/?computerId=guest", {
      headers: { Accept: "application/json" },
    });
  const admitted = await (await request()).json();
  assert.equal(admitted.computerId, "host-workspace");
  assert.equal(admitted.authorityVersion, 1);
  assert.equal(admitted.capabilities[0].id, computerSlots.terminal.id);
  const installation = await host.installations.get("context-probe");
  host.installations.get = async () => ({
    ...installation,
    authority: {
      ...installation.authority,
      approvedGrants: [],
    },
  });
  assert.deepEqual((await (await request()).json()).capabilities, []);
  host.installations.get = async () => ({
    ...installation,
    status: "disabled",
  });
  assert.equal((await request()).status, 404);
});

test("App method context uses the host's Computer despite guest selector claims", async () => {
  for (const [principal, actor] of [
    [
      { actor: { kind: "member", memberId: "owner" }, role: "owner" },
      { kind: "member", memberId: "owner" },
    ],
    [
      { actor: { kind: "team-key", keyId: "key-one" } },
      { kind: "team-key", keyId: "key-one" },
    ],
  ]) {
    const host = await computerHost(principal, "host-workspace");
    if (principal.actor.kind === "team-key")
      host.keys = {
        live: async (keyId) => ({
          keyId,
          owner: "fixture-owner",
          grantVersion: 1,
          grants: [{ capability: "apps.read", targets: { kind: "all" } }],
        }),
      };
    const app = createOyster(host);
    const response = await app.request(
      "/apps/context-probe/methods/context?computerId=guest-query",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Computer-Id": "guest-header",
          "X-Oyster-Computer": "guest-header",
        },
        body: JSON.stringify({
          computerId: "guest-body",
          context: { computerId: "guest-context" },
        }),
      },
    );
    assert.equal(response.status, 200);
    const expected = { computerId: "host-workspace", actor };
    if ("role" in principal) expected.role = principal.role;
    assert.deepEqual(await response.json(), expected);
  }
});

test("a key without an attested App tool policy is refused before Computer-context dispatch", async () => {
  const host = await computerHost(
    { actor: { kind: "team-key", keyId: "key-without-policy" } },
    "host-workspace",
  );
  let dispatches = 0;
  host.instances.get = () => {
    dispatches += 1;
    throw new Error("Unapproved key reached the Instance");
  };
  const response = await createOyster(host).request(
    "/apps/context-probe/methods/context",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(response.status, 403);
  assert.equal(dispatches, 0);
});

test("an old App tool policy without grantedBy requires re-approval before dispatch", async () => {
  const host = await computerHost(
    { actor: { kind: "team-key", keyId: "old-policy-key" } },
    "host-workspace",
  );
  host.appToolPolicy = async () => ({
    level: "write",
    revision: "legacy-approved-1",
  });
  let dispatches = 0;
  host.instances.get = () => {
    dispatches += 1;
    throw new Error("Legacy policy reached the Instance");
  };
  const response = await createOyster(host).request(
    "/apps/context-probe/methods/context",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(response.status, 403);
  assert.equal(dispatches, 0);
});

test("backend forwarding replaces forged context headers with the host's selection", async () => {
  const app = createOyster(
    await computerHost(
      { actor: { kind: "member", memberId: "owner" }, role: "owner" },
      "host-workspace",
    ),
  );
  const response = await app.request("/apps/context-probe/backend", {
    method: "PUT",
    headers: {
      [appBackendComputerHeader]: "guest-computer",
      [appBackendActorHeader]: "guest-actor",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    computerId: "host-workspace",
    actorId: "owner",
  });
  assert.equal(
    (await app.request("/apps/missing/backend", { method: "PUT" })).status,
    404,
  );
});

test("an unconfigured Oyster does not adopt a Computer from method input", async () => {
  const app = createOyster(
    await computerHost({
      actor: { kind: "member", memberId: "owner" },
      role: "owner",
    }),
  );
  const response = await app.request("/apps/context-probe/methods/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ computerId: "guest-computer" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    computerId: null,
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  });
});

test("a visitor receives no Computer even when the host configured one", () => {
  assert.deepEqual(
    invocationCallerContext({ actor: { kind: "visitor" } }, "host-workspace"),
    {
      computerId: null,
      actor: { kind: "team-key", keyId: "visitor" },
    },
  );
});

test("a tenant principal's registry facts never enter the caller grammar", () => {
  const context = invocationCallerContext(
    {
      actor: { kind: "member", memberId: "tenant_member_ada" },
      role: "owner",
      membershipVersion: 3,
    },
    "host-workspace",
  );
  assert.deepEqual(context, {
    computerId: "host-workspace",
    actor: { kind: "member", memberId: "tenant_member_ada" },
    role: "owner",
  });
  assert.deepEqual(parseAppMethodCallContext(context, true), context);
});

test("a host-attested sole member reaches the caller grammar", () => {
  const context = invocationCallerContext(
    {
      actor: { kind: "member", memberId: "tenant_member_ada" },
      role: "owner",
      soleMember: true,
    },
    null,
  );
  assert.deepEqual(context, {
    computerId: null,
    actor: { kind: "member", memberId: "tenant_member_ada" },
    role: "owner",
    soleMember: true,
  });
  assert.deepEqual(parseAppMethodCallContext(context, true), context);
  assert.throws(
    () =>
      parseAppMethodCallContext({
        computerId: null,
        actor: { kind: "agent", agentId: "agent-one" },
        soleMember: true,
      }),
    /sole member/u,
  );
});

test("internal Agent calls keep Agent attribution and the host-selected Computer", async () => {
  const principal = { actor: { kind: "agent", agentId: "agent-one" } };
  const host = await computerHost(principal, "host-workspace");
  const replies = [];
  const policy = {
    level: "write",
    revision: "fixture-agent-1",
    grantedBy: "fixture-owner",
  };
  host.appToolPolicy = async () => policy;
  const runtime = await Mycelium.make({
    sources: [
      await oysterAppMethods(
        host,
        principal,
        { kind: "agent", policy },
        appSurfaceCache(host),
      ),
    ],
    sandbox: directSandbox(async (bindings) => {
      replies.push(
        await bindings.CONTEXT_PROBE.context({ computerId: "guest-computer" }),
      );
      return null;
    }),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "context-proof",
        name: "execute",
        arguments: { code: "return null" },
      }),
    );
    await Effect.runPromise(Stream.runCollect(prepared.execute()));
    assert.deepEqual(replies, [
      {
        computerId: "host-workspace",
        actor: { kind: "agent", agentId: "agent-one" },
      },
    ]);
  } finally {
    await lease.release();
    await runtime.close();
  }
});

test("the App page receives the host's Computer selection, never a query selector", async () => {
  const app = createOyster(
    await computerHost(
      { actor: { kind: "member", memberId: "owner" }, role: "owner" },
      "host-workspace",
    ),
  );
  const response = await app.request(
    "/apps/context-probe/?computerId=guest-computer",
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"computerId":"host-workspace"/u);
});
