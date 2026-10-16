import * as Schema from "effect/Schema";
import { tenantIdSchema, tenantScope } from "@fungi.computer/oyster/tenant";
import { expect, it, vi } from "vitest";
import { coldTenantDirectory } from "../../src/tenancy/cold-directory.js";
import { memoryRegistry } from "../../src/tenancy/registry.js";
import type { Tenant } from "../../src/tenancy/contracts.js";

function fixture() {
  const tenant: Tenant = {
    id: Schema.decodeUnknownSync(tenantIdSchema)("alpha"),
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test", "other.example.test"],
    owners: ["stored-owner"],
    status: "active",
  };
  const registry = memoryRegistry({
    tenants: [tenant],
    memberships: [
      {
        tenantId: tenant.id,
        identity: { provider: "fixture", subject: "external-owner" },
        memberId: "stored-owner",
        role: "owner",
      },
      {
        tenantId: tenant.id,
        identity: { provider: "fixture", subject: "external-member" },
        memberId: "stored-member",
        role: "member",
      },
    ],
  });
  return { tenant, registry, scope: tenantScope(tenant.id, tenant.origin) };
}

it("reconstructs a cold selection from the live directory without identity lookup", async () => {
  const { registry, scope } = fixture();
  const identity = vi.spyOn(registry, "membershipOf");
  const first = await coldTenantDirectory(registry).resolve(scope);
  const fresh = await coldTenantDirectory(registry).resolve(scope);
  expect(first?.scope).toEqual(scope);
  expect(fresh?.scope).toEqual(scope);
  expect(
    await fresh?.auth.resolve({ kind: "member", memberId: "stored-member" }),
  ).toEqual({
    actor: { kind: "member", memberId: "stored-member" },
    role: "member",
    membershipVersion: 2,
  });
  expect(
    await fresh?.auth.resolve({ kind: "member", memberId: "stored-owner" }),
  ).toEqual({
    actor: { kind: "member", memberId: "stored-owner" },
    role: "owner",
    membershipVersion: 1,
  });
  expect(identity).not.toHaveBeenCalled();
  expect(
    await fresh?.auth.authenticate(
      new Request(scope.origin, {
        headers: { authorization: "Bearer ignored-foreground-credential" },
      }),
    ),
  ).toEqual({ kind: "refused", status: 401 });
});

it("refuses an absent or foreign tenant and a noncanonical origin without root fallback", async () => {
  const { registry, scope, tenant } = fixture();
  const directory = coldTenantDirectory(registry);
  expect(
    await directory.resolve(
      tenantScope(
        Schema.decodeUnknownSync(tenantIdSchema)("missing"),
        scope.origin,
      ),
    ),
  ).toBeNull();
  expect(
    await directory.resolve(
      tenantScope(tenant.id, "https://other.example.test"),
    ),
  ).toBeNull();
  vi.spyOn(registry, "get").mockResolvedValue({
    ...tenant,
    id: Schema.decodeUnknownSync(tenantIdSchema)("foreign"),
  });
  expect(await directory.resolve(scope)).toBeNull();
});

it.each(["suspended", "deleting"] as const)(
  "refuses %s tenants",
  async (status) => {
    const { registry, scope, tenant } = fixture();
    await registry.setStatus(tenant.id, status);
    expect(await coldTenantDirectory(registry).resolve(scope)).toBeNull();
  },
);

it("rechecks membership and preserves its current role instead of the owners list", async () => {
  const { registry, scope } = fixture();
  const selected = await coldTenantDirectory(registry).resolve(scope);
  const membership = vi.spyOn(registry, "memberById");
  membership.mockResolvedValue({
    memberId: "stored-owner",
    role: "member",
    membershipVersion: 9,
  });
  expect(
    await selected?.auth.resolve({ kind: "member", memberId: "stored-owner" }),
  ).toEqual({
    actor: { kind: "member", memberId: "stored-owner" },
    role: "member",
    membershipVersion: 9,
  });
  membership.mockResolvedValue(null);
  expect(
    await selected?.auth.resolve({ kind: "member", memberId: "stored-owner" }),
  ).toBeNull();
  membership.mockResolvedValue({
    memberId: "different-member",
    role: "owner",
    membershipVersion: 10,
  });
  expect(
    await selected?.auth.resolve({ kind: "member", memberId: "stored-owner" }),
  ).toBeNull();
  expect(
    await selected?.auth.resolve({ kind: "agent", agentId: "stored-owner" }),
  ).toBeNull();
  expect(
    await selected?.auth.resolve({ kind: "team-key", keyId: "stored-owner" }),
  ).toBeNull();
});

it("rechecks tenant authority after the asynchronous member lookup", async () => {
  const { registry, tenant, scope } = fixture();
  const selected = await coldTenantDirectory(registry).resolve(scope);
  vi.spyOn(registry, "memberById").mockImplementation(async () => {
    await registry.setStatus(tenant.id, "suspended");
    return { memberId: "stored-owner", role: "owner", membershipVersion: 11 };
  });
  expect(
    await selected?.auth.resolve({ kind: "member", memberId: "stored-owner" }),
  ).toBeNull();
});

it("refuses changed origins after the asynchronous member lookup", async () => {
  const { registry, tenant, scope } = fixture();
  const selected = await coldTenantDirectory(registry).resolve(scope);
  vi.spyOn(registry, "memberById").mockImplementation(() => {
    vi.spyOn(registry, "get").mockResolvedValue({
      ...tenant,
      origin: "https://other.example.test",
    });
    return Promise.resolve({
      memberId: "stored-owner",
      role: "owner",
      membershipVersion: 12,
    });
  });
  expect(
    await selected?.auth.resolve({ kind: "member", memberId: "stored-owner" }),
  ).toBeNull();
});

it("propagates a directory outage instead of manufacturing root authority", async () => {
  const { registry, scope } = fixture();
  const outage = new Error("directory unavailable");
  vi.spyOn(registry, "get").mockRejectedValue(outage);
  await expect(coldTenantDirectory(registry).resolve(scope)).rejects.toBe(
    outage,
  );
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
  "refuses invalid stored membership revision %s without a default",
  async (membershipVersion) => {
    const { registry, scope } = fixture();
    vi.spyOn(registry, "memberById").mockResolvedValue({
      memberId: "stored-owner",
      role: "owner",
      membershipVersion,
    });
    const selected = await coldTenantDirectory(registry).resolve(scope);
    expect(
      await selected?.auth.resolve({
        kind: "member",
        memberId: "stored-owner",
      }),
    ).toBeNull();
  },
);
