import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import {
  rateLimit,
  durableObjectRegistry,
} from "../../src/tenancy/cloudflare.ts";

it("delegates only the canonical tenant/actor key and maps the native response", async () => {
  const limit = vi.fn(() => Promise.resolve({ success: false }));
  const policy = rateLimit({ limit }, { retryAfterSeconds: 60 });
  const context = {
    tenant: { id: "alpha" },
    principal: {
      actor: { kind: "member", memberId: "stored-member" },
      role: "owner",
    },
    request: new globalThis.Request("https://alpha.example.test/"),
  };
  await expect(policy(context)).resolves.toEqual({
    kind: "refuse",
    status: 429,
    retryAfter: 60,
  });
  expect(limit).toHaveBeenCalledWith({
    key: '["alpha","member","stored-member"]',
  });
  limit.mockResolvedValue({ success: true });
  await expect(policy(context)).resolves.toEqual({ kind: "allow" });
});
it("executes the native local binding without claiming global exact accounting", async () => {
  const policy = rateLimit(env.NATIVE_LIMITER, { retryAfterSeconds: 60 });
  await expect(
    policy({
      tenant: { id: "native-proof" },
      principal: { actor: { kind: "agent", agentId: "agent-native" } },
      request: new globalThis.Request("https://proof.example.test/"),
    }),
  ).resolves.toEqual({ kind: "allow" });
});

it("stores a canonical tenant and owner mapping in native durable storage", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const identity = {
    provider: "https://issuer.example.test/",
    subject: "external-subject",
  };
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: identity,
  });
  expect(tenant).toMatchObject({
    id: "alpha",
    handle: "alpha",
    origin: "https://alpha.example.test",
    status: "active",
    domains: ["alpha.example.test"],
  });
  expect(tenant.owners).toHaveLength(1);
  expect(tenant.owners[0]).toMatch(/^tenant_member_[a-z0-9]{21}$/);
  expect(await registry.membershipOf(tenant.id, identity)).toEqual({
    memberId: tenant.owners[0],
    role: "owner",
    membershipVersion: 1,
  });
  expect(await registry.get(tenant.id)).toEqual(tenant);
  expect(await registry.byHandle("alpha")).toEqual(tenant);
  expect(await registry.byDomain("alpha.example.test")).toEqual(tenant);
});
it("retains the declared domain order and canonical origin independently", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const tenant = await registry.create({
    handle: "ordered",
    origin: "https://a.example.test",
    domains: ["z.example.test", "a.example.test"],
    owner: { provider: "fixture", subject: "ordered" },
  });
  expect(await registry.get(tenant.id)).toEqual(tenant);
});

it("rolls back all provisioning when owner storage rejects the insert", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const object = env.TENANTS.getByName("registry");
  await runInDurableObject(object, async (_, state) => {
    state.storage.sql.exec(
      "CREATE TRIGGER reject_owner BEFORE INSERT ON memberships BEGIN SELECT RAISE(ABORT,'injected owner storage failure'); END;",
    );
  });
  const owner = { provider: "fixture", subject: "not-retained-on-failure" };
  await expect(
    registry.create({
      handle: "rollback",
      origin: "https://rollback.example.test",
      domains: ["rollback.example.test"],
      owner,
    }),
  ).rejects.toThrow();
  expect(await registry.get("rollback")).toBeNull();
  expect(await registry.byDomain("rollback.example.test")).toBeNull();
  expect(await registry.membershipOf("rollback", owner)).toBeNull();
  await runInDurableObject(object, async (_, state) => {
    expect(
      state.storage.sql
        .exec(
          "SELECT member_id FROM identities WHERE provider=? AND subject=?",
          owner.provider,
          owner.subject,
        )
        .toArray(),
    ).toHaveLength(0);
  });
});
it("serializes conflicting creates and leaves one complete record", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const input = {
    handle: "race",
    origin: "https://race.example.test",
    domains: ["race.example.test"],
    owner: { provider: "fixture", subject: "race" },
  };
  const results = await Promise.allSettled([
    registry.create(input),
    registry.create(input),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const tenant = await registry.get("race");
  expect(tenant.owners).toHaveLength(1);
  expect(await registry.membershipOf(tenant.id, input.owner)).toEqual({
    memberId: tenant.owners[0],
    role: "owner",
    membershipVersion: 1,
  });
});
it("refuses invalid canonical origins before storing a tenant", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  for (const origin of [
    "http://safe.example.test",
    "https://other.example.test",
    "https://safe.example.test/path",
  ]) {
    await expect(
      registry.create({
        handle: "invalid",
        origin,
        domains: ["safe.example.test"],
        owner: { provider: "fixture", subject: "invalid" },
      }),
    ).rejects.toThrow();
    expect(await registry.get("invalid")).toBeNull();
  }
});
it("preserves separate provider/subject identity tuples and reuses stored IDs", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const first = { provider: "a:b", subject: "c" };
  const second = { provider: "a", subject: "b:c" };
  const a = await registry.create({
    handle: "first",
    origin: "https://first.example.test",
    domains: ["first.example.test"],
    owner: first,
  });
  const b = await registry.create({
    handle: "second",
    origin: "https://second.example.test",
    domains: ["second.example.test"],
    owner: second,
  });
  const c = await registry.create({
    handle: "third",
    origin: "https://third.example.test",
    domains: ["third.example.test"],
    owner: first,
  });
  expect(a.owners).not.toEqual(b.owners);
  expect(c.owners).toEqual(a.owners);
  expect(await registry.membershipOf(a.id, second)).toBeNull();
});
it("deletes tenant admission and indexes without losing canonical identity mapping", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const owner = { provider: "fixture", subject: "recreated" };
  const tenant = await registry.create({
    handle: "removed",
    origin: "https://removed.example.test",
    domains: ["removed.example.test"],
    owner,
  });
  await registry.setStatus(tenant.id, "deleting");
  expect(await registry.status(tenant.id)).toBe("deleting");
  await registry.delete(tenant.id);
  expect(await registry.get(tenant.id)).toBeNull();
  expect(await registry.byHandle(tenant.handle)).toBeNull();
  expect(await registry.byDomain(tenant.domains[0])).toBeNull();
  expect(await registry.membershipOf(tenant.id, owner)).toBeNull();
  const recreated = await registry.create({
    handle: "recreated",
    origin: "https://removed.example.test",
    domains: tenant.domains,
    owner,
  });
  expect(recreated.owners).toEqual(tenant.owners);
});
it("exposes no mutation methods on the readonly facade", async () => {
  const read = durableObjectRegistry(env.TENANTS, { readonly: true });
  expect("create" in read).toBe(false);
  expect("delete" in read).toBe(false);
  expect("setStatus" in read).toBe(false);
  expect(await read.get("missing")).toBeNull();
});
it("separates tenant and canonical actor kinds in limiter keys", async () => {
  const limit = vi.fn(() => Promise.resolve({ success: true }));
  const policy = rateLimit({ limit }, { retryAfterSeconds: 17 });
  for (const [tenant, actor] of [
    ["alpha", { kind: "member", memberId: "same" }],
    ["beta", { kind: "member", memberId: "same" }],
    ["alpha", { kind: "agent", agentId: "same" }],
    ["alpha", { kind: "team-key", keyId: "same" }],
  ])
    await policy({
      tenant: { id: tenant },
      principal: { actor },
      request: new globalThis.Request("https://proof.example.test"),
    });
  expect(limit.mock.calls.map(([args]) => args.key)).toEqual([
    '["alpha","member","same"]',
    '["beta","member","same"]',
    '["alpha","agent","same"]',
    '["alpha","team-key","same"]',
  ]);
  for (const [args] of limit.mock.calls)
    expect(Object.keys(args)).toEqual(["key"]);
  limit.mockResolvedValue({ success: false });
  await expect(
    policy({
      tenant: { id: "alpha" },
      principal: { actor: { kind: "team-key", keyId: "same" } },
      request: new globalThis.Request("https://proof.example.test"),
    }),
  ).resolves.toEqual({ kind: "refuse", status: 429, retryAfter: 17 });
});

beforeEach(async () => {
  await runInDurableObject(
    env.TENANTS.getByName("registry"),
    async (_, state) => {
      state.storage.sql.exec(`DROP TRIGGER IF EXISTS reject_owner;
      DELETE FROM memberships; DELETE FROM domains; DELETE FROM tenants; DELETE FROM identities; UPDATE membership_clock SET revision=0 WHERE id=1;`);
    },
  );
});
it("does not admit an equal subject from a different verified provider", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const first = { provider: "issuer-one", subject: "same-subject" };
  const second = { provider: "issuer-two", subject: "same-subject" };
  const a = await registry.create({
    handle: "issuerone",
    origin: "https://issuerone.example.test",
    domains: ["issuerone.example.test"],
    owner: first,
  });
  const b = await registry.create({
    handle: "issuertwo",
    origin: "https://issuertwo.example.test",
    domains: ["issuertwo.example.test"],
    owner: second,
  });
  expect(a.owners).not.toEqual(b.owners);
  expect(await registry.membershipOf(a.id, second)).toBeNull();
  expect(await registry.membershipOf(b.id, first)).toBeNull();
});

it("reads current member roles by canonical ID through the native registry owner", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const tenant = await registry.create({
    handle: "replay",
    origin: "https://replay.example.test",
    domains: ["replay.example.test"],
    owner: { provider: "fixture", subject: "replay-owner" },
  });
  const memberId = tenant.owners[0];
  expect(await registry.memberById(tenant.id, memberId)).toEqual({
    memberId,
    role: "owner",
    membershipVersion: 1,
  });
  expect(await registry.memberById("foreign", memberId)).toBeNull();
  expect(await registry.memberById(tenant.id, "replay-owner")).toBeNull();
  await runInDurableObject(
    env.TENANTS.getByName("registry"),
    async (_, state) => {
      state.storage.sql.exec(
        "UPDATE memberships SET role='member' WHERE tenant_id=? AND member_id=?",
        tenant.id,
        memberId,
      );
    },
  );
  expect(await registry.memberById(tenant.id, memberId)).toEqual({
    memberId,
    role: "member",
    membershipVersion: 2,
  });
  await registry.delete(tenant.id);
  expect(await registry.memberById(tenant.id, memberId)).toBeNull();
});

it("advances stored membership authority across role changes and delete/recreate", async () => {
  const registry = durableObjectRegistry(env.TENANTS);
  const input = {
    handle: "revision",
    origin: "https://revision.example.test",
    domains: ["revision.example.test"],
    owner: { provider: "fixture", subject: "revision-owner" },
  };
  const tenant = await registry.create(input);
  const memberId = tenant.owners[0];
  const first = await registry.memberById(tenant.id, memberId);
  expect(first.membershipVersion).toBeGreaterThan(0);
  expect(await registry.memberById(tenant.id, memberId)).toEqual(first);
  await runInDurableObject(env.TENANTS.getByName("registry"), (_, ctx) => {
    ctx.storage.sql.exec(
      "UPDATE memberships SET role='member' WHERE tenant_id=? AND member_id=?",
      tenant.id,
      memberId,
    );
  });
  const changed = await registry.memberById(tenant.id, memberId);
  expect(changed.role).toBe("member");
  expect(changed.membershipVersion).toBeGreaterThan(first.membershipVersion);
  await registry.setStatus(tenant.id, "suspended");
  const suspended = await registry.memberById(tenant.id, memberId);
  expect(suspended.membershipVersion).toBeGreaterThan(
    changed.membershipVersion,
  );
  await registry.setStatus(tenant.id, "active");
  const restored = await registry.memberById(tenant.id, memberId);
  expect(restored.membershipVersion).toBeGreaterThan(
    suspended.membershipVersion,
  );
  await registry.delete(tenant.id);
  expect(await registry.memberById(tenant.id, memberId)).toBeNull();
  const recreated = await registry.create(input);
  expect(recreated.owners).toEqual([memberId]);
  const current = await registry.memberById(recreated.id, memberId);
  expect(current.role).toBe("owner");
  expect(current.membershipVersion).toBeGreaterThan(restored.membershipVersion);
});
