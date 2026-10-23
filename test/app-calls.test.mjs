import assert from "node:assert/strict";
import { test } from "node:test";
import { createOyster } from "../dist/host.js";
import { approvedBindingGrants } from "../dist/apps/index.js";
import { verifyRelease } from "../dist/release.js";
import { approvedInstallation } from "../dist/testing/index.js";
import { computerHost } from "./computer-host.fixture.mjs";

async function fixture({
  principal = {
    actor: { kind: "member", memberId: "member-a" },
    role: "owner",
  },
  methods = ["context"],
  targets = 1,
  grant = true,
  onList = null,
  targetBindings = false,
  reply = { kind: "ok", value: { text: "hello" } },
} = {}) {
  const caller = await computerHost(principal, null, {
    capabilities: ["apps.call", "agent.list"],
    backend: { bindings: [{ name: "AGENTS", operations: ["list"] }] },
    calls: [{ appId: "app_contextprobe", methods }],
  });
  const target = await computerHost(
    principal,
    null,
    targetBindings
      ? {
          capabilities: ["agent.read"],
          backend: { bindings: [{ name: "INBOX", operations: ["page"] }] },
        }
      : {},
    [],
    targetBindings ? ["agent.read"] : [],
  );
  const targetDeclaration = (
    await verifyRelease(
      target.artifacts,
      (await target.installations.get("context-probe")).release,
    )
  ).declaration;
  let resolvedPrincipal = principal;
  const source = await caller.installations.get("context-probe");
  const targetSource = await target.installations.get("context-probe");
  const declared = (await verifyRelease(caller.artifacts, source.release))
    .declaration;
  const callerInstallation = await approvedInstallation({
    installationId: "inkcap",
    instanceId: source.instanceId,
    release: { ...source.release, appId: "app_inkcap" },
    declaration: declared,
    descriptors: [],
  });
  if (!grant) callerInstallation.authority.approvedGrants = [];
  const targetInstallations = Array.from({ length: targets }, (_, i) => ({
    ...targetSource,
    installationId: `bonsai-${i}`,
  }));
  const rows = [callerInstallation, ...targetInstallations];
  const calls = [];
  const host = createOyster({
    ...caller,
    auth: { ...caller.auth, resolve: async () => resolvedPrincipal },
    appToolPolicy: () => ({
      level: "write",
      revision: "owner-approved",
      grantedBy: "member-a",
    }),
    artifacts: {
      get: async (ref) =>
        (await caller.artifacts.get(ref)) ?? (await target.artifacts.get(ref)),
    },
    installations: {
      get: async (id) => rows.find((row) => row.installationId === id) ?? null,
      list: async () => {
        const snapshot = [...rows];
        onList?.(rows);
        return snapshot;
      },
    },
    instances: {
      get: (id) => ({
        call: async (facts, _api, method, input) => {
          calls.push({ id, facts, method, input });
          return { ok: true, value: reply };
        },
      }),
    },
  });
  const request = (method = "context", body = "{}") =>
    host.request(`/apps/inkcap/calls/app_contextprobe/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  return {
    request,
    calls,
    targetSource,
    callerInstallation,
    host,
    rows,
    targetDeclaration,
    setResolved: (value) => {
      resolvedPrincipal = value;
    },
  };
}

test("a declared member call reaches only the target with member facts and no caller grants", async () => {
  const {
    request,
    calls,
    targetSource,
    callerInstallation,
    targetDeclaration,
  } = await fixture({ targetBindings: true });
  assert.ok(
    callerInstallation.authority.approvedGrants.some(
      (grant) => grant.capability === "agent.list",
    ),
  );
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "hello" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, targetSource.instanceId);
  assert.deepEqual(calls[0].facts.ancestry, []);
  const targetGrants = approvedBindingGrants(targetSource, targetDeclaration);
  assert.ok(targetGrants.length > 0);
  assert.deepEqual(calls[0].facts.grants, targetGrants);
  assert.deepEqual(calls[0].facts.subject.context.actor, {
    kind: "member",
    memberId: "member-a",
  });
});

test("an App's typed refusal keeps its code and status through the method dispatch", async () => {
  for (const [code, status] of [
    ["conflict", 409],
    ["not_found", 404],
    ["invalid", 400],
    ["forbidden", 403],
    ["unavailable", 503],
  ]) {
    const { request, calls } = await fixture({
      reply: { kind: "refused", code, message: "The App declined" },
    });
    const response = await request();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), {
      error: code,
      message: "The App declined",
    });
    assert.equal(calls.length, 1);
  }
});

test("undeclared merge and approve never reach the target", async () => {
  for (const method of ["changes.merge", "changes.approve"]) {
    const { request, calls } = await fixture();
    assert.equal((await request(method)).status, 403);
    assert.equal(calls.length, 0);
  }
});

test("anonymous requests, Agents and approved keys cannot use the member deputy", async () => {
  for (const [principal, status] of [
    [null, 401],
    [{ actor: { kind: "team-key", keyId: "foreign" } }, 403],
    [{ actor: { kind: "agent", agentId: "foreign" } }, 403],
  ]) {
    const { request, calls } = await fixture({ principal });
    assert.equal((await request()).status, status);
    assert.equal(calls.length, 0);
  }
});

test("missing or ambiguous target Apps refuse without dispatch", async () => {
  for (const targets of [0, 2]) {
    const { request, calls } = await fixture({ targets });
    assert.equal((await request()).status, 409);
    assert.equal(calls.length, 0);
  }
});

test("declared calls still require current installation approval", async () => {
  const { request, calls, host } = await fixture({ grant: false });
  assert.equal((await request()).status, 403);
  assert.equal(calls.length, 0);
  const config = await (
    await host.request("/apps/inkcap/", {
      headers: { Accept: "application/json" },
    })
  ).json();
  assert.equal(
    config.capabilities.some((cap) => cap.id === "apps.call"),
    false,
  );
});
test("caller approval revoked while resolving the target stops dispatch", async () => {
  const { request, calls } = await fixture({
    onList(rows) {
      rows[0] = {
        ...rows[0],
        authority: {
          ...rows[0].authority,
          approvedGrants: [],
          authorityVersion: rows[0].authority.authorityVersion + 1,
        },
      };
    },
  });
  assert.equal((await request()).status, 403);
  assert.equal(calls.length, 0);
});
test("a changed or disabled target after the directory read stops dispatch", async () => {
  for (const status of ["enabled", "disabled"]) {
    const { request, calls } = await fixture({
      onList(rows) {
        const before = [...rows];
        rows[1] = {
          ...rows[1],
          status,
          authority: {
            ...rows[1].authority,
            authorityVersion: rows[1].authority.authorityVersion + 1,
          },
        };
        return before;
      },
    });
    const response = await request();
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "stale_authority" });
    assert.equal(calls.length, 0);
  }
});
test("target method admission rejects malformed JSON and undeclared target methods", async () => {
  for (const [method, body, code] of [
    ["context", "not JSON", 400],
    ["context", "[]", 400],
    ["missing", "{}", 403],
  ]) {
    const { request, calls } = await fixture({
      methods: ["context", "missing"],
    });
    assert.equal((await request(method, body)).status, code);
    assert.equal(calls.length, 0);
  }
});

test("body attribution cannot replace the authenticated member or add caller grants", async () => {
  const { request, calls } = await fixture();
  assert.equal(
    (
      await request(
        "context",
        JSON.stringify({
          actor: { kind: "agent", agentId: "forged" },
          grants: [{ binding: "AGENTS", operations: ["send"] }],
          ancestry: ["forged"],
        }),
      )
    ).status,
    200,
  );
  assert.deepEqual(calls[0].facts.subject.context.actor, {
    kind: "member",
    memberId: "member-a",
  });
  assert.deepEqual(calls[0].facts.grants, []);
  assert.deepEqual(calls[0].facts.ancestry, []);
});

test("revoked caller is refused before consuming its body", async () => {
  let bodyReads = 0;
  const { host, calls } = await fixture({
    onList(rows) {
      rows[0] = {
        ...rows[0],
        authority: {
          ...rows[0].authority,
          approvedGrants: [],
          authorityVersion: rows[0].authority.authorityVersion + 1,
        },
      };
    },
  });
  const body = new globalThis.ReadableStream(
    {
      pull(controller) {
        bodyReads++;
        controller.enqueue(new globalThis.TextEncoder().encode("{}"));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const response = await host.request(
    new globalThis.Request(
      "http://localhost/apps/inkcap/calls/app_contextprobe/context",
      {
        method: "POST",
        body,
        duplex: "half",
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
  assert.equal(response.status, 403);
  assert.equal(bodyReads, 0);
  assert.equal(calls.length, 0);
});

test("body-read revocation of either installation refuses before target dispatch", async () => {
  for (const index of [0, 1]) {
    const { host, calls, rows } = await fixture();
    const body = new globalThis.ReadableStream(
      {
        pull(controller) {
          rows[index] = {
            ...rows[index],
            status: "disabled",
            authorityVersion: rows[index].authority.authorityVersion + 1,
          };
          controller.enqueue(new globalThis.TextEncoder().encode("{}"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await host.request(
      new globalThis.Request(
        "http://localhost/apps/inkcap/calls/app_contextprobe/context",
        {
          method: "POST",
          body,
          duplex: "half",
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
  }
});

test("removed, demoted or different member during body read cannot dispatch", async () => {
  for (const fresh of [
    null,
    { actor: { kind: "member", memberId: "member-a" }, role: "member" },
    { actor: { kind: "member", memberId: "member-b" }, role: "owner" },
  ]) {
    const { host, calls, setResolved } = await fixture();
    const body = new globalThis.ReadableStream(
      {
        pull(controller) {
          setResolved(fresh);
          controller.enqueue(new globalThis.TextEncoder().encode("{}"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await host.request(
      new globalThis.Request(
        "http://localhost/apps/inkcap/calls/app_contextprobe/context",
        { method: "POST", body, duplex: "half" },
      ),
    );
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
  }
});

test("both method routes refuse streamed bodies above 64 KiB without target details", async () => {
  for (const path of [
    "/apps/inkcap/calls/app_contextprobe/context",
    "/apps/bonsai-0/methods/context",
  ]) {
    const { host, calls } = await fixture();
    const input = JSON.stringify({ text: "x".repeat(64 * 1024) });
    const response = await host.request(path, { method: "POST", body: input });
    assert.equal(response.status, 413);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(await response.text(), /bonsai|contextprobe|context/u);
  }
});

test("removed member is refused without consuming the body", async () => {
  const { host, calls, setResolved } = await fixture();
  setResolved(null);
  let bodyReads = 0;
  const body = new globalThis.ReadableStream(
    {
      pull(controller) {
        bodyReads++;
        controller.enqueue(new globalThis.TextEncoder().encode("{}"));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const response = await host.request(
    new globalThis.Request(
      "http://localhost/apps/inkcap/calls/app_contextprobe/context",
      { method: "POST", body, duplex: "half" },
    ),
  );
  assert.equal(response.status, 403);
  assert.equal(bodyReads, 0);
  assert.equal(calls.length, 0);
});
