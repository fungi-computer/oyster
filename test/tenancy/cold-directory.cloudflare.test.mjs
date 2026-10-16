import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { coldTenantDirectory } from "../../src/tenancy/cold-directory.ts";
import { tenantScope } from "@fungi.computer/oyster/tenant";
import { durableObjectRegistry } from "../../src/tenancy/cloudflare.ts";

async function select(instance, tenant) {
  await runInDurableObject(instance, (_instance, ctx) => {
    ctx.storage.sql.exec(
      "INSERT INTO oyster_tenant (id,tenant_id,origin) VALUES (1,?,?)",
      tenant.id,
      tenant.origin,
    );
  });
}

it("rebuilds the real kit root host from durable tenant authority after cold eviction", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const tenant = await registry.create({
    handle: "cold-alpha",
    origin: "https://cold-alpha.example.test",
    domains: ["cold-alpha.example.test"],
    owner: { provider: "fixture", subject: "cold-alpha-owner" },
  });
  const instance = env.INSTANCES.getByName("cold-alpha-instance");
  await select(instance, tenant);
  const actor = { kind: "member", memberId: tenant.owners[0] };
  const membership = await registry.memberById(tenant.id, actor.memberId);
  expect(membership.membershipVersion).toBeGreaterThan(0);
  const expected = {
    actor,
    role: "owner",
    membershipVersion: membership.membershipVersion,
  };
  expect(await instance.memberForTest(actor)).toEqual(expected);
  await evictDurableObject(instance);
  await evictDurableObject(env.TENANTS.getByName("registry"));
  expect(
    await env.INSTANCES.getByName("cold-alpha-instance").memberForTest(actor),
  ).toEqual(expected);
  await registry.setStatus(tenant.id, "suspended");
  expect(await instance.memberForTest(actor)).toBeNull();
  await registry.setStatus(tenant.id, "active");
  const resumed = await registry.memberById(tenant.id, actor.memberId);
  expect(resumed.membershipVersion).toBeGreaterThan(
    membership.membershipVersion,
  );
  expect(await instance.memberForTest(actor)).toEqual({
    ...expected,
    membershipVersion: resumed.membershipVersion,
  });
  await registry.delete(tenant.id);
  expect(await instance.memberForTest(actor)).toBeNull();
});

it("never substitutes the root owner, foreign membership, Agent or named key", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const create = (handle) =>
    registry.create({
      handle,
      origin: `https://${handle}.example.test`,
      domains: [`${handle}.example.test`],
      owner: { provider: "fixture", subject: `${handle}-owner` },
    });
  const alpha = await create("isolated-alpha");
  const beta = await create("isolated-beta");
  const instance = env.INSTANCES.getByName("isolated-alpha-instance");
  await select(instance, alpha);
  for (const actor of [
    { kind: "member", memberId: "root-owner" },
    { kind: "member", memberId: beta.owners[0] },
    { kind: "agent", agentId: alpha.owners[0] },
    { kind: "team-key", keyId: alpha.owners[0] },
  ])
    expect(await instance.memberForTest(actor)).toBeNull();
  const wrongOrigin = env.INSTANCES.getByName("wrong-origin-instance");
  await select(wrongOrigin, { ...alpha, origin: beta.origin });
  expect(
    await wrongOrigin.memberForTest({
      kind: "member",
      memberId: alpha.owners[0],
    }),
  ).toBeNull();
  await runInDurableObject(env.TENANTS.getByName("registry"), (_owner, ctx) => {
    ctx.storage.sql.exec(
      "DELETE FROM memberships WHERE tenant_id=? AND member_id=?",
      alpha.id,
      alpha.owners[0],
    );
  });
  expect(
    await instance.memberForTest({ kind: "member", memberId: alpha.owners[0] }),
  ).toBeNull();
});

it("refuses a serialized membership without its stored revision", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const tenant = await registry.create({
    handle: "missing-revision",
    origin: "https://missing-revision.example.test",
    domains: ["missing-revision.example.test"],
    owner: { provider: "fixture", subject: "missing-revision-owner" },
  });
  const actor = { kind: "member", memberId: tenant.owners[0] };
  const directory = coldTenantDirectory({
    get: (id) => registry.get(id),
    status: (id) => registry.status(id),
    memberById: async () => ({ memberId: actor.memberId, role: "owner" }),
  });
  const selected = await directory.resolve(
    tenantScope(tenant.id, tenant.origin),
  );
  expect(await selected.auth.resolve(actor)).toBeNull();
});
