import * as Schema from "effect/Schema";
import { tenantIdSchema } from "@fungi.computer/oyster/tenant";
import { describe, expect, it } from "vitest";
import { loopbackAliasLocation } from "../../src/tenancy/registry-record.js";
import { memoryRegistry } from "../../src/tenancy/registry.js";
const owner = { provider: "issuer-a", subject: "same-subject" };
const input = {
  handle: "alpha",
  origin: "https://alpha.example.test",
  domains: ["alpha.example.test"],
  owner,
};
describe("registry authority", () => {
  it("creates the tenant and canonical owner membership in one transition", async () => {
    const registry = memoryRegistry();
    const tenant = await registry.create(input);
    expect(await registry.get(tenant.id)).toEqual(tenant);
    expect(await registry.byHandle("alpha")).toEqual(tenant);
    expect(await registry.byDomain("alpha.example.test")).toEqual(tenant);
    expect(await registry.membershipOf(tenant.id, owner)).toEqual({
      memberId: tenant.owners[0],
      role: "owner",
      membershipVersion: 1,
    });
    expect(
      await registry.membershipOf(tenant.id, {
        provider: "issuer-b",
        subject: "same-subject",
      }),
    ).toBeNull();
  });
});

it.each([
  "http://alpha.example.test",
  "https://different.example.test",
  "https://alpha.example.test/other",
  "https://user:secret@alpha.example.test",
])("invalid canonical origin %s writes no tenant", async (origin) => {
  const registry = memoryRegistry();
  await expect(registry.create({ ...input, origin })).rejects.toThrow(
    "Tenant origin",
  );
  expect(await registry.byHandle("alpha")).toBeNull();
  expect(await registry.byDomain("alpha.example.test")).toBeNull();
});

it.each([
  ["http://127.0.0.1:8787", "127.0.0.1:8787"],
  ["http://localhost:8787", "localhost:8787"],
  ["http://[::1]:8787", "[::1]:8787"],
])("admits plain HTTP only on loopback: %s", async (origin, domain) => {
  const registry = memoryRegistry();
  const tenant = await registry.create({ ...input, origin, domains: [domain] });
  expect(tenant.origin).toBe(origin);
});

it.each([
  "http://192.168.1.5:8787",
  "http://alpha.example.test:8787",
  "http://127.0.0.1.example.test",
])("still refuses plain HTTP off loopback: %s", async (origin) => {
  const registry = memoryRegistry();
  await expect(
    registry.create({ ...input, origin, domains: [new URL(origin).host] }),
  ).rejects.toThrow("Tenant origin");
});

it("concurrent duplicate creates leave one atomic owner mapping", async () => {
  const registry = memoryRegistry();
  const results = await Promise.allSettled([
    registry.create(input),
    registry.create(input),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  const tenant = await registry.byHandle("alpha");
  if (tenant === null) throw new Error("Missing created tenant");
  expect(await registry.membershipOf(tenant.id, owner)).toEqual({
    memberId: tenant.owners[0],
    role: "owner",
    membershipVersion: 1,
  });
  const second = await registry.create({
    ...input,
    handle: "beta",
    origin: "https://beta.example.test",
    domains: ["beta.example.test"],
  });
  expect(second.owners).toEqual(tenant.owners);
});

it("looks up only a stored canonical membership in the selected tenant", async () => {
  const registry = memoryRegistry();
  const tenant = await registry.create(input);
  const memberId = tenant.owners[0];
  if (memberId === undefined)
    throw new Error("Missing stored owner membership");
  expect(await registry.memberById(tenant.id, memberId)).toEqual({
    memberId,
    role: "owner",
    membershipVersion: 1,
  });
  expect(await registry.memberById(tenant.id, owner.subject)).toBeNull();
  expect(
    await registry.memberById(
      Schema.decodeUnknownSync(tenantIdSchema)("foreign"),
      memberId,
    ),
  ).toBeNull();
  await registry.delete(tenant.id);
  expect(await registry.memberById(tenant.id, memberId)).toBeNull();
});

it("does not reuse a removed membership revision", async () => {
  const registry = memoryRegistry();
  const tenant = await registry.create(input);
  const memberId = tenant.owners[0];
  if (memberId === undefined) throw new Error("Missing owner");
  const first = await registry.memberById(tenant.id, memberId);
  if (first === null) throw new Error("Missing initial membership");
  await registry.delete(tenant.id);
  const recreated = await registry.create(input);
  const current = await registry.memberById(recreated.id, memberId);
  if (current === null) throw new Error("Missing recreated membership");
  expect(current.membershipVersion).toBeGreaterThan(first.membershipVersion);
});

it.each([
  ["http://localhost:8787/apps/x/?a=1", "http://127.0.0.1:8787/apps/x/?a=1"],
  ["http://[::1]:8787/login", "http://127.0.0.1:8787/login"],
])("sends a loopback alias to the canonical origin: %s", (request, to) => {
  expect(loopbackAliasLocation(new URL(request), "http://127.0.0.1:8787")).toBe(
    to,
  );
});

it.each([
  ["http://127.0.0.1:8787/login", "http://127.0.0.1:8787"],
  ["http://localhost:9999/login", "http://127.0.0.1:8787"],
  ["http://192.168.1.5:8787/login", "http://127.0.0.1:8787"],
  ["http://localhost:8787/login", "https://oyster.test"],
  ["https://localhost:8787/login", "http://127.0.0.1:8787"],
])("does not redirect %s against %s", (request, canonical) => {
  expect(loopbackAliasLocation(new URL(request), canonical)).toBeNull();
});
