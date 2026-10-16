import { expect, it } from "vitest";
import { createTenancy } from "@fungi.computer/oyster/tenancy";
import { memoryRegistry } from "@fungi.computer/oyster/tenancy/registry";
import { subdomain } from "@fungi.computer/oyster/tenancy/resolve";
import { createStandaloneWorkflowAuthorityReaders } from "../../src/standalone/workflow-authority-readers.js";

const unused = (): never => {
  throw new Error("Unexpected catalog read");
};

it("reads the current stored owner version and only the host-selected Computer", async () => {
  const registry = memoryRegistry();
  const tenant = await registry.create({
    handle: "readers",
    origin: "https://readers.oyster.test",
    domains: ["readers.oyster.test"],
    owner: { provider: "fixture", subject: "authenticated-owner" },
  });
  const tenancy = createTenancy({
    registry,
    resolve: subdomain("oyster.test"),
    auth: [],
  });
  const ownerId = tenant.owners[0];
  if (ownerId === undefined) throw new Error("Owner missing");
  const current = await tenancy.memberById(tenant.id, ownerId);
  if (current === null) throw new Error("Current owner missing");
  expect(current.membershipVersion).toBeGreaterThan(0);
  const readers = createStandaloneWorkflowAuthorityReaders({
    tenantId: tenant.id,
    tenancy,
    host: { computerId: "computer-selected" },
    libraryInstallationId: "workflows-installed",
    catalogHost: { admitLibrary: unused, catalogForLibrary: unused },
  });
  expect(await readers.member(ownerId)).toEqual({
    membershipVersion: current.membershipVersion,
  });
  expect(await readers.member("absent-member")).toBeNull();
  expect(await readers.memberComputer(ownerId, "computer-selected")).toBe(true);
  expect(await readers.memberComputer(ownerId, "computer-guest-selected")).toBe(
    false,
  );
  expect(
    await readers.memberComputer("absent-member", "computer-selected"),
  ).toBe(false);
  await registry.setStatus(tenant.id, "suspended");
  expect(await readers.member(ownerId)).toBeNull();
  expect(await readers.memberComputer(ownerId, "computer-selected")).toBe(
    false,
  );
});

it("refuses a stored non-owner before reading the library catalog", async () => {
  const provisioner = memoryRegistry();
  const tenant = await provisioner.create({
    handle: "nonowner",
    origin: "https://nonowner.oyster.test",
    domains: ["nonowner.oyster.test"],
    owner: { provider: "fixture", subject: "owner" },
  });
  const memberId = "stored-member";
  const registry = memoryRegistry({
    tenants: [tenant],
    memberships: [
      {
        tenantId: tenant.id,
        identity: { provider: "fixture", subject: "member" },
        memberId,
        role: "member",
      },
    ],
  });
  const readers = createStandaloneWorkflowAuthorityReaders({
    tenantId: tenant.id,
    tenancy: createTenancy({
      registry,
      resolve: subdomain("oyster.test"),
      auth: [],
    }),
    host: { computerId: "computer-selected" },
    libraryInstallationId: "workflows-installed",
    catalogHost: { admitLibrary: unused, catalogForLibrary: unused },
  });
  expect(await readers.member(memberId)).toBeNull();
  expect(await readers.memberComputer(memberId, "computer-selected")).toBe(
    false,
  );
  await expect(readers.catalog(memberId)).rejects.toMatchObject({
    code: "revoked",
  });
});

it("refuses Computer authority revoked between the two live membership reads", async () => {
  const registry = memoryRegistry();
  const tenant = await registry.create({
    handle: "revoked",
    origin: "https://revoked.oyster.test",
    domains: ["revoked.oyster.test"],
    owner: { provider: "fixture", subject: "owner" },
  });
  const ownerId = tenant.owners[0];
  if (ownerId === undefined) throw new Error("Owner missing");
  const tenancy = createTenancy({
    registry,
    resolve: subdomain("oyster.test"),
    auth: [],
  });
  let reads = 0;
  const readers = createStandaloneWorkflowAuthorityReaders({
    tenantId: tenant.id,
    tenancy: {
      async memberById(tenantId, memberId) {
        const current = await tenancy.memberById(tenantId, memberId);
        reads += 1;
        if (reads === 1) await registry.setStatus(tenant.id, "suspended");
        return current;
      },
    },
    host: { computerId: "computer-selected" },
    libraryInstallationId: "workflows-installed",
    catalogHost: { admitLibrary: unused, catalogForLibrary: unused },
  });
  expect(await readers.memberComputer(ownerId, "computer-selected")).toBe(
    false,
  );
  expect(reads).toBe(2);
});
