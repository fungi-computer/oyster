import { describe, expect, it, vi } from "vitest";
import { ownerKey } from "../../src/tenancy/owner-key.js";
import { memoryRegistry } from "../../src/tenancy/registry.js";
import { ownerKeyAuth } from "@fungi.computer/oyster/auth";

const key = "tenant-owner-secret-at-least-24-characters";
async function fixture() {
  const registry = memoryRegistry();
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: { provider: "fixture", subject: "owner" },
  });
  const memberId = present(tenant.owners[0]);
  const get = vi.fn(() => Promise.resolve({ key, memberId }));
  return {
    tenant,
    memberId,
    get,
    adapter: ownerKey({ keys: { get }, registry }),
  };
}

describe("owner key admission", () => {
  it("uses the stored canonical owner identity and the selected tenant lookup", async () => {
    const { tenant, adapter, memberId, get } = await fixture();
    await expect(
      adapter.authenticate(
        new Request(tenant.origin, {
          headers: { Authorization: `Bearer ${key}` },
        }),
        tenant,
      ),
    ).resolves.toEqual({
      kind: "principal",
      principal: {
        actor: { kind: "member", memberId },
        role: "owner",
      },
    });
    expect(get).toHaveBeenCalledWith(tenant.id);
  });
});

it("uses Oyster's digest cookie, refuses rotation and invalid recognized cookies", async () => {
  const { tenant, adapter, memberId, get } = await fixture();
  const login = await present(ownerKeyAuth(key, memberId).login)(
    new Request(`${tenant.origin}/login`, {
      method: "POST",
      body: new URLSearchParams({ key }),
    }),
  );
  const cookie = present(
    present(login.headers.get("Set-Cookie")).split(";")[0],
  );
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, { headers: { Cookie: cookie } }),
      tenant,
    ),
  ).resolves.toMatchObject({ kind: "principal" });
  get.mockResolvedValue({
    key: "rotated-owner-secret-at-least-24-characters",
    memberId,
  });
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, { headers: { Cookie: cookie } }),
      tenant,
    ),
  ).resolves.toEqual({ kind: "refused", status: 401 });
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, {
        headers: { Cookie: "oyster_session=invalid" },
      }),
      tenant,
    ),
  ).resolves.toEqual({ kind: "refused", status: 401 });
});
it("does not turn a stored non-owner member into an owner", async () => {
  const { tenant, adapter, get } = await fixture();
  get.mockResolvedValue({ key, memberId: "not-a-current-owner" });
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, {
        headers: { Authorization: `Bearer ${key}` },
      }),
      tenant,
    ),
  ).resolves.toEqual({ kind: "refused", status: 403 });
});
it("passes absent and unrelated bearer credentials but stops an invalid owner cookie", async () => {
  const { tenant, adapter, get } = await fixture();
  await expect(
    adapter.authenticate(new Request(tenant.origin), tenant),
  ).resolves.toEqual({ kind: "pass" });
  expect(get).not.toHaveBeenCalled();
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, {
        headers: { Authorization: "Bearer other-adapter-token" },
      }),
      tenant,
    ),
  ).resolves.toEqual({ kind: "pass" });
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, { headers: { Cookie: "oyster_session=" } }),
      tenant,
    ),
  ).resolves.toEqual({ kind: "refused", status: 401 });
});
it("rechecks current owners after asynchronous verification-material lookup", async () => {
  const { tenant, memberId } = await fixture();
  const current = { ...tenant, owners: [] };
  const adapter = ownerKey({
    keys: { get: () => Promise.resolve({ key, memberId }) },
    registry: { get: () => Promise.resolve(current) },
  });
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, {
        headers: { Authorization: `Bearer ${key}` },
      }),
      tenant,
    ),
  ).resolves.toEqual({ kind: "refused", status: 403 });
});
it("routes login through Oyster for the host-selected current owner", async () => {
  const { tenant, memberId, get } = await fixture();
  const registry = { get: () => Promise.resolve(tenant) };
  const adapter = ownerKey({
    keys: { get },
    registry,
    login: { resolveTenant: () => Promise.resolve(tenant) },
  });
  const response = await present(adapter.routes).request(
    `${tenant.origin}/login`,
    {
      method: "POST",
      body: new URLSearchParams({ key }),
    },
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("Set-Cookie")).toContain("oyster_session=");
  expect(response.headers.get("Set-Cookie")).not.toContain(key);
  const cookie = present(
    present(response.headers.get("Set-Cookie")).split(";")[0],
  );
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, { headers: { Cookie: cookie } }),
      tenant,
    ),
  ).resolves.toEqual({
    kind: "principal",
    principal: { actor: { kind: "member", memberId }, role: "owner" },
  });
});
it("never selects a tenant or owner from login form fields", async () => {
  const { tenant, get, memberId } = await fixture();
  const adapter = ownerKey({
    keys: { get },
    registry: { get: () => Promise.resolve(tenant) },
    login: { resolveTenant: () => Promise.resolve(tenant) },
  });
  const response = await present(adapter.routes).request(
    `${tenant.origin}/login`,
    {
      method: "POST",
      body: new URLSearchParams({
        key,
        tenantId: "beta",
        memberId: "attacker",
      }),
    },
  );
  expect(response.status).toBe(303);
  expect(get).toHaveBeenCalledWith(tenant.id);
  expect(memberId).not.toBe("attacker");
});
it("does not issue an owner cookie after owner removal", async () => {
  const { tenant, get } = await fixture();
  const adapter = ownerKey({
    keys: { get },
    registry: { get: () => Promise.resolve({ ...tenant, owners: [] }) },
    login: { resolveTenant: () => Promise.resolve(tenant) },
  });
  const response = await present(adapter.routes).request(
    `${tenant.origin}/login`,
    {
      method: "POST",
      body: new URLSearchParams({ key }),
    },
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("Set-Cookie")).toBeNull();
});

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Expected fixture value");
  return value;
}
