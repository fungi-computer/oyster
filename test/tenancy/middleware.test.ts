import { Hono } from "hono";
import { expect, it } from "vitest";
import { createTenancy } from "../../src/tenancy/index.js";
import { subdomain } from "../../src/tenancy/resolve.js";
import { memoryRegistry } from "../../src/tenancy/registry.js";
import type { TenancyVariables } from "../../src/tenancy/contracts.js";
it("Hono receives admitted tenant and principal, and refuses unknown hosts first", async () => {
  const registry = memoryRegistry();
  const identity = { provider: "fixture", subject: "owner" };
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: identity,
  });
  let calls = 0;
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [
      {
        id: "identity",
        authenticate: () => {
          calls += 1;
          return Promise.resolve({ kind: "identity", identity });
        },
      },
    ],
  });
  const app = new Hono<{ Variables: TenancyVariables }>();
  app.use("*", tenancy.middleware({ role: "owner" }));
  app.get("/", (context) =>
    context.json({
      tenant: context.var.tenant.id,
      principal: context.var.principal,
    }),
  );
  const response = await app.request(tenant.origin);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    tenant: tenant.id,
    principal: {
      actor: { kind: "member", memberId: tenant.owners[0] },
      role: "owner",
    },
  });
  expect((await app.request("https://unknown.example.test/")).status).toBe(404);
  expect(calls).toBe(1);
});

it("role middleware does not elevate a member, Agent or key to owner", async () => {
  const registry = memoryRegistry();
  const identity = { provider: "fixture", subject: "owner" };
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: identity,
  });
  const memberRegistry = memoryRegistry({
    tenants: [tenant],
    memberships: [
      {
        tenantId: tenant.id,
        identity,
        memberId: "stored-member",
        role: "member",
      },
    ],
  });
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry: memberRegistry,
    auth: [
      {
        id: "identity",
        authenticate: () => Promise.resolve({ kind: "identity", identity }),
      },
    ],
  });
  const app = new Hono<{ Variables: TenancyVariables }>();
  app.use("*", tenancy.middleware({ role: "owner" }));
  app.get("/", (context) => context.text("owner-only"));
  expect((await app.request(tenant.origin)).status).toBe(403);

  for (const actor of [
    { kind: "agent", agentId: "agent-a" },
    { kind: "team-key", keyId: "key-a" },
  ] as const) {
    const scoped = createTenancy({
      resolve: subdomain("example.test"),
      registry,
      auth: [
        {
          id: "principal",
          authenticate: () =>
            Promise.resolve({ kind: "principal", principal: { actor } }),
        },
      ],
    });
    const scopedApp = new Hono<{ Variables: TenancyVariables }>();
    scopedApp.use("*", scoped.middleware({ role: "member" }));
    scopedApp.get("/", (context) => context.text("member-only"));
    expect((await scopedApp.request(tenant.origin)).status).toBe(403);
  }
});

it("abuse policy exposes the typed 429 and Retry-After without invoking the route", async () => {
  const registry = memoryRegistry();
  const identity = { provider: "fixture", subject: "owner" };
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: identity,
  });
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [
      {
        id: "identity",
        authenticate: () => Promise.resolve({ kind: "identity", identity }),
      },
    ],
    policy: () =>
      Promise.resolve({ kind: "refuse", status: 429, retryAfter: 60 }),
  });
  let dispatched = false;
  const app = new Hono<{ Variables: TenancyVariables }>();
  app.use("*", tenancy.middleware());
  app.get("/", (context) => {
    dispatched = true;
    return context.text("private");
  });
  const response = await app.request(tenant.origin);
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(await response.json()).toEqual({ error: "rate_limited" });
  expect(dispatched).toBe(false);
});
