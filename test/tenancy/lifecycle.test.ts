import { expect, it } from "vitest";
import { createTenancy } from "../../src/tenancy/index.js";
import { subdomain } from "../../src/tenancy/resolve.js";
import { memoryRegistry } from "../../src/tenancy/registry.js";
const input = {
  handle: "alpha",
  origin: "https://alpha.example.test",
  domains: ["alpha.example.test"],
  owner: { provider: "fixture", subject: "owner" },
};
it("teardown sees the stored origin and deletion waits for successful cleanup", async () => {
  const registry = memoryRegistry();
  const phases: string[] = [];
  let fail = true;
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [],
    on: {
      "tenant.created": async ({ tenant }) => {
        expect(await registry.get(tenant.id)).toEqual(tenant);
        phases.push("created");
      },
      "tenant.deleting": async ({ tenant, scope }) => {
        expect(await registry.status(tenant.id)).toBe("deleting");
        expect(scope.origin).toBe("https://alpha.example.test");
        phases.push("cleanup");
        if (fail) throw new Error("Teardown unavailable");
      },
    },
  });
  const tenant = await tenancy.create(input);
  await expect(tenancy.delete(tenant.id)).rejects.toThrow(
    "Teardown unavailable",
  );
  expect(await registry.status(tenant.id)).toBe("deleting");
  await expect(tenancy.resolve(new Request(tenant.origin))).resolves.toBeNull();
  fail = false;
  await tenancy.delete(tenant.id);
  expect(await registry.get(tenant.id)).toBeNull();
  expect(await registry.membershipOf(tenant.id, input.owner)).toBeNull();
  expect(phases).toEqual(["created", "cleanup", "cleanup"]);
});

it("readonly registry hosts never expose create or delete", () => {
  const registry = memoryRegistry();
  const read = {
    get: registry.get,
    byHandle: registry.byHandle,
    status: registry.status,
    membershipOf: registry.membershipOf,
    memberById: registry.memberById,
  };
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry: read,
    auth: [],
  });
  expect(Object.hasOwn(tenancy, "create")).toBe(false);
  expect(Object.hasOwn(tenancy, "delete")).toBe(false);
  type HasCreate = "create" extends keyof typeof tenancy ? true : false;
  const hasCreate: HasCreate = false;
  expect(hasCreate).toBe(false);
});

it("parallel deletes on one instance wait for one cleanup before removing the record", async () => {
  const registry = memoryRegistry();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let calls = 0;
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [],
    on: {
      "tenant.deleting": async () => {
        calls += 1;
        entered.resolve(undefined);
        await release.promise;
      },
    },
  });
  const tenant = await tenancy.create(input);
  const first = tenancy.delete(tenant.id);
  const second = tenancy.delete(tenant.id);
  await entered.promise;
  expect(await registry.get(tenant.id)).not.toBeNull();
  expect(calls).toBe(1);
  release.resolve(undefined);
  await Promise.all([first, second]);
  expect(await registry.get(tenant.id)).toBeNull();
  expect(calls).toBe(1);
});
