import * as Schema from "effect/Schema";
import { tenantIdSchema } from "@fungi.computer/oyster/tenant";
import { expect, it } from "vitest";
import { createTenancy } from "../../src/tenancy/index.js";
import { memoryRegistry } from "../../src/tenancy/registry.js";
import { subdomain, path } from "../../src/tenancy/resolve.js";

it("origin tenancy preserves its stored owner actor and refuses a foreign tenant before auth", async () => {
  const registry = memoryRegistry();
  const identity = { provider: "fixture", subject: "canonical-owner" };
  const tenant = await registry.create({
    handle: "aa",
    origin: "https://aa.oyster.test",
    domains: ["aa.oyster.test"],
    owner: identity,
  });
  const api = createTenancy({
    registry,
    resolve: subdomain("oyster.test"),
    auth: [
      {
        id: "fixture",
        authenticate: () => Promise.resolve({ kind: "identity", identity }),
      },
    ],
  });
  const oyster = api.oyster();
  expect(
    await oyster.resolve(new Request("https://unknown.oyster.test")),
  ).toBeNull();
  const resolved = await oyster.resolve(new Request("https://aa.oyster.test"));
  expect(resolved?.scope.origin).toBe(tenant.origin);
  const principal = {
    actor: { kind: "member", memberId: tenant.owners[0] },
    role: "owner",
  };
  expect(
    await resolved?.auth.authenticate(new Request("https://aa.oyster.test")),
  ).toEqual({ kind: "admitted", principal });
  expect(
    await resolved?.auth.authenticate(
      new Request("https://unknown.oyster.test"),
    ),
  ).toEqual({ kind: "refused", status: 404 });
});

it("path tenancy exposes no Oyster adapter", () => {
  const api = createTenancy({
    registry: memoryRegistry(),
    resolve: path("/t/:tenant"),
    auth: [],
  });
  expect("oyster" in api).toBe(false);
});

it("resolves replay membership without credentials or promoting a named key", async () => {
  const tenant = {
    id: Schema.decodeUnknownSync(tenantIdSchema)("alpha"),
    handle: "alpha",
    origin: "https://alpha.oyster.test",
    domains: ["alpha.oyster.test"],
    owners: ["member-owner"],
    status: "active" as const,
  };
  const registry = memoryRegistry({
    tenants: [tenant],
    memberships: [
      {
        tenantId: tenant.id,
        memberId: "member-owner",
        role: "owner",
        identity: { provider: "fixture", subject: "owner-subject" },
      },
      {
        tenantId: tenant.id,
        memberId: "member-editor",
        role: "member",
        identity: { provider: "fixture", subject: "editor-subject" },
      },
    ],
  });
  let authenticationCalls = 0;
  const api = createTenancy({
    registry,
    resolve: subdomain("oyster.test"),
    auth: [
      {
        id: "fixture",
        authenticate: () => {
          authenticationCalls += 1;
          return Promise.resolve({ kind: "pass" });
        },
      },
    ],
  });
  const selected = await api.oyster().resolve(new Request(tenant.origin));
  if (selected === null) throw new Error("Missing selected tenant");
  expect(
    await selected.auth.resolve({ kind: "member", memberId: "member-owner" }),
  ).toEqual({
    actor: { kind: "member", memberId: "member-owner" },
    role: "owner",
    membershipVersion: 1,
  });
  expect(
    await selected.auth.resolve({ kind: "member", memberId: "member-editor" }),
  ).toEqual({
    actor: { kind: "member", memberId: "member-editor" },
    role: "member",
    membershipVersion: 2,
  });
  expect(
    await selected.auth.resolve({ kind: "member", memberId: "absent" }),
  ).toBeNull();
  expect(
    await selected.auth.resolve({ kind: "team-key", keyId: "member-owner" }),
  ).toBeNull();
  expect(
    await selected.auth.resolve({ kind: "agent", agentId: "member-owner" }),
  ).toBeNull();
  expect(authenticationCalls).toBe(0);
  await registry.setStatus(tenant.id, "suspended");
  expect(
    await selected.auth.resolve({ kind: "member", memberId: "member-owner" }),
  ).toBeNull();
  await registry.delete(tenant.id);
  expect(
    await selected.auth.resolve({ kind: "member", memberId: "member-owner" }),
  ).toBeNull();
});

it("member lookup matches stored IDs exactly without trimming, case folding or Unicode normalization", async () => {
  const tenant = {
    id: Schema.decodeUnknownSync(tenantIdSchema)("exact"),
    handle: "exact",
    origin: "https://exact.oyster.test",
    domains: ["exact.oyster.test"],
    owners: ["member-owner", "mémber-owner"],
    status: "active" as const,
  };
  const registry = memoryRegistry({
    tenants: [tenant],
    memberships: tenant.owners.map((memberId) => ({
      tenantId: tenant.id,
      memberId,
      role: "owner" as const,
      identity: { provider: "fixture", subject: memberId },
    })),
  });
  const api = createTenancy({
    registry,
    resolve: subdomain("oyster.test"),
    auth: [],
  });
  for (const memberId of tenant.owners)
    expect(await api.memberById(tenant.id, memberId)).not.toBeNull();
  for (const memberId of [
    " member-owner",
    "Member-Owner",
    "mémber-owner".normalize("NFD"),
  ]) {
    expect(await api.memberById(tenant.id, memberId)).toBeNull();
  }
});
