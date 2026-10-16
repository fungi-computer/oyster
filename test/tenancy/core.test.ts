import { describe, expect, it } from "vitest";
import { createTenancy } from "../../src/tenancy/index.js";
import { subdomain } from "../../src/tenancy/resolve.js";
import { memoryRegistry } from "../../src/tenancy/registry.js";

describe("tenant admission", () => {
  it("unknown hosts refuse instead of falling back to another tenant", async () => {
    const tenancy = createTenancy({
      resolve: subdomain("example.test"),
      registry: memoryRegistry(),
      auth: [],
    });
    await expect(
      tenancy.resolve(new Request("https://unknown.example.test/")),
    ).resolves.toBeNull();
    await expect(
      tenancy.resolve(new Request("https://example.test/")),
    ).resolves.toBeNull();
  });
});

it("only provisioned tenant hosts resolve, regardless of forwarded selectors", async () => {
  const registry = memoryRegistry();
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: { provider: "fixture", subject: "owner" },
  });
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [],
  });
  await expect(
    tenancy.resolve(new Request("https://alpha.example.test/api")),
  ).resolves.toEqual(tenant);
  await expect(
    tenancy.resolve(new Request("https://alpha--other.example.test/")),
  ).resolves.toBeNull();
  await expect(
    tenancy.resolve(
      new Request("https://unknown.example.test/", {
        headers: { "X-Forwarded-Host": "alpha.example.test" },
      }),
    ),
  ).resolves.toBeNull();
  await expect(
    tenancy.resolve(new Request("http://alpha.example.test/")),
  ).resolves.toBeNull();
  await registry.setStatus(tenant.id, "deleting");
  await expect(
    tenancy.resolve(new Request("https://alpha.example.test/")),
  ).resolves.toBeNull();
});

it("tries adapters in order, then takes the role and member id from the registry", async () => {
  const registry = memoryRegistry();
  const identity = { provider: "fixture", subject: "owner" };
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: identity,
  });
  const calls: string[] = [];
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [
      {
        id: "other",
        authenticate: () => {
          calls.push("other");
          return Promise.resolve({ kind: "pass" });
        },
      },
      {
        id: "identity",
        authenticate: () => {
          calls.push("identity");
          return Promise.resolve({ kind: "identity", identity });
        },
      },
      {
        id: "later",
        authenticate: () => {
          calls.push("later");
          return Promise.resolve({ kind: "refused", status: 401 });
        },
      },
    ],
  });
  await expect(
    tenancy.authenticate(new Request(tenant.origin), tenant),
  ).resolves.toEqual({
    kind: "admitted",
    tenant,
    principal: {
      actor: { kind: "member", memberId: tenant.owners[0] },
      role: "owner",
    },
  });
  expect(calls).toEqual(["other", "identity"]);
});

it("an explicit auth refusal never falls through to a later credential", async () => {
  const registry = memoryRegistry();
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: { provider: "fixture", subject: "owner" },
  });
  let later = false;
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [
      {
        id: "invalid",
        authenticate: () => Promise.resolve({ kind: "refused", status: 401 }),
      },
      {
        id: "later",
        authenticate: () => {
          later = true;
          return Promise.resolve({ kind: "pass" });
        },
      },
    ],
  });
  await expect(
    tenancy.authenticate(new Request(tenant.origin), tenant),
  ).resolves.toEqual({ kind: "refused", status: 401 });
  expect(later).toBe(false);
});

it("unknown membership and suspended tenants refuse without an abuse-policy bypass", async () => {
  const registry = memoryRegistry();
  const owner = { provider: "fixture", subject: "owner" };
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner,
  });
  let identity = { provider: "different", subject: "owner" };
  let policies = 0;
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [
      {
        id: "identity",
        authenticate: () => Promise.resolve({ kind: "identity", identity }),
      },
    ],
    policy: () => {
      policies += 1;
      return Promise.resolve({ kind: "refuse", status: 429, retryAfter: 60 });
    },
  });
  await expect(
    tenancy.authenticate(new Request(tenant.origin), tenant),
  ).resolves.toEqual({ kind: "refused", status: 403 });
  expect(policies).toBe(0);
  identity = owner;
  await expect(
    tenancy.authenticate(new Request(tenant.origin), tenant),
  ).resolves.toEqual({ kind: "refused", status: 429, retryAfter: 60 });
  expect(policies).toBe(1);
  await registry.setStatus(tenant.id, "suspended");
  await expect(
    tenancy.authenticate(new Request(tenant.origin), tenant),
  ).resolves.toEqual({ kind: "refused", status: 403 });
  expect(policies).toBe(1);
});

it("a tenant deleted while authentication is pending never admits a key principal", async () => {
  const registry = memoryRegistry();
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: { provider: "fixture", subject: "owner" },
  });
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [
      {
        id: "key",
        authenticate: async () => {
          await registry.setStatus(tenant.id, "deleting");
          return {
            kind: "principal",
            principal: { actor: { kind: "team-key", keyId: "stored-key" } },
          };
        },
      },
    ],
  });
  await expect(
    tenancy.authenticate(new Request(tenant.origin), tenant),
  ).resolves.toEqual({ kind: "refused", status: 404 });
});

it("empty authentication never creates an anonymous principal, and selected tenants cannot cross-bind", async () => {
  const registry = memoryRegistry();
  const owner = { provider: "fixture", subject: "owner" };
  const alpha = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner,
  });
  const beta = await registry.create({
    handle: "beta",
    origin: "https://beta.example.test",
    domains: ["beta.example.test"],
    owner,
  });
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [],
  });
  await expect(
    tenancy.authenticate(new Request(alpha.origin), alpha),
  ).resolves.toEqual({ kind: "refused", status: 401 });
  await expect(
    tenancy.authenticate(new Request(beta.origin), alpha),
  ).resolves.toEqual({ kind: "refused", status: 404 });
  await expect(
    tenancy.member(alpha.id, { ...owner, email: "changed@example.test" }),
  ).resolves.toEqual({
    actor: { kind: "member", memberId: alpha.owners[0] },
    role: "owner",
  });
});
