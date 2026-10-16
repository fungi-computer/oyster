import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { durableObjectRegistry } from "../../src/tenancy/cloudflare.ts";

it("keeps native persisted authority across object eviction", async () => {
  const owner = { provider: "issuer", subject: "retained" };
  const input = {
    handle: "retained",
    origin: "https://retained.example.test",
    domains: ["retained.example.test"],
    owner,
  };
  const create = await exports.default.fetch(
    new globalThis.Request("https://proof.example.test/create", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  const tenant = await create.json();
  const status = await exports.default.fetch(
    new globalThis.Request("https://proof.example.test/status", {
      method: "POST",
      body: JSON.stringify({ id: tenant.id, status: "suspended" }),
    }),
  );
  expect(status.status).toBe(204);
  await evictDurableObject(env.TENANTS.getByName("registry"));
  const restored = await exports.default.fetch(
    new globalThis.Request(`https://proof.example.test/get?id=${tenant.id}`),
  );
  expect(await restored.json()).toEqual({ ...tenant, status: "suspended" });
  const member = await exports.default.fetch(
    new globalThis.Request("https://proof.example.test/member", {
      method: "POST",
      body: JSON.stringify({ id: tenant.id, identity: owner }),
    }),
  );
  expect(await member.json()).toEqual({
    memberId: tenant.owners[0],
    role: "owner",
    membershipVersion: 2,
  });
  const registry = durableObjectRegistry(env.TENANTS);
  const before = await registry.memberById(tenant.id, tenant.owners[0]);
  await registry.delete(tenant.id);
  await evictDurableObject(env.TENANTS.getByName("registry"));
  const recreated = await registry.create(input);
  expect(recreated.owners).toEqual(tenant.owners);
  const current = await registry.memberById(recreated.id, recreated.owners[0]);
  expect(current.membershipVersion).toBeGreaterThan(before.membershipVersion);
});
