import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { defaultTenant, tenantScope } from "@fungi.computer/oyster/tenant";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "cloudflare:workers" ||
      specifier === "cloudflare:workflows"
    )
      return {
        url: import.meta
          .resolve("@fungi.computer/oyster/testing/workers-runtime"),
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { StandaloneTenants, standaloneTenancy } =
  await import("../../src/standalone/tenancy.ts");
const { StandaloneRegistry } = await import("../../src/standalone/registry.ts");
const { StandaloneAgent } = await import("../../src/standalone/worker.ts");
hooks.deregister();

/** The standalone root's one composition at the default tenant, reached through a root door. */
class RootDoor extends StandaloneAgent {
  hostAt(scope) {
    return this.hostFor(scope);
  }
}
const rootHost = (env) =>
  new RootDoor({}, env).hostAt(tenantScope(defaultTenant, env.OYSTER_ORIGIN));

// Exercise the named host hook used by OysterRegistry's Agent storage owner.
class RegistryProbe extends StandaloneRegistry {
  ownerForCreator(memberId, tenantId) {
    return this.currentOwner(memberId, tenantId);
  }
}

function state(database) {
  const storage = fromNodeSqlite(database);
  storage.sql.exec(
    "CREATE TABLE fixture_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  return {
    storage: {
      ...storage,
      get: async (key) => {
        const row = storage.sql
          .exec("SELECT value FROM fixture_kv WHERE key=?", key)
          .toArray()[0];
        return row === undefined ? undefined : JSON.parse(row.value);
      },
      put: async (key, value) => {
        storage.sql.exec(
          "INSERT INTO fixture_kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          key,
          JSON.stringify(value),
        );
      },
    },
    blockConcurrencyWhile: (work) => work(),
  };
}

test("the root owner hook uses live canonical registry membership, never its configured label", async () => {
  const tenantsDatabase = new DatabaseSync(":memory:");
  const registryDatabase = new DatabaseSync(":memory:");
  const tenants = new StandaloneTenants(state(tenantsDatabase));
  const env = {
    OYSTER_ORIGIN: "https://registry-root.test",
    OYSTER_OWNER_NAME: "configured-owner",
    OYSTER_OWNER_KEY: "registry-proof-owner-key-24-characters",
    OYSTER_COMPUTER_ID: "workspace",
    TENANTS: {
      getByName: (name) => {
        assert.equal(name, "registry");
        return tenants;
      },
    },
    KEYS: { getByName: () => assert.fail("No credential lookup expected") },
  };
  try {
    const shared = await standaloneTenancy(env);
    const owner = await shared.owner();
    assert.ok(owner);
    assert.notEqual(owner.actor.memberId, env.OYSTER_OWNER_NAME);
    const registry = new RegistryProbe(state(registryDatabase), env);
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      owner.actor.memberId,
    );
    assert.equal(
      await registry.ownerForCreator(env.OYSTER_OWNER_NAME, shared.tenantId),
      null,
    );
    assert.equal(
      await registry.ownerForCreator(
        owner.actor.memberId,
        tenantScope("other-tenant", "https://other.test").tenantId,
      ),
      null,
    );
    // Registry-owned create mints the second identity; fixture writes change
    // retained membership rows, which the real registry decodes and versions.
    const other = await tenants.create({
      handle: "other-owner",
      origin: "https://other-owner.test",
      domains: ["other-owner.test"],
      owner: { provider: "standalone-owner", subject: "second-owner" },
    });
    const otherOwner = await tenants.membershipOf(other.id, {
      provider: "standalone-owner",
      subject: "second-owner",
    });
    assert.ok(otherOwner);
    const sql = fromNodeSqlite(tenantsDatabase).sql;
    sql.exec(
      "INSERT INTO memberships (tenant_id,member_id,role) VALUES (?,?,?)",
      shared.tenantId,
      otherOwner.memberId,
      "owner",
    );
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      null,
    );
    sql.exec(
      "DELETE FROM memberships WHERE tenant_id=? AND member_id=?",
      shared.tenantId,
      otherOwner.memberId,
    );
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      owner.actor.memberId,
    );
    sql.exec(
      "UPDATE memberships SET role=? WHERE tenant_id=? AND member_id=?",
      "member",
      shared.tenantId,
      owner.actor.memberId,
    );
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      null,
    );
    sql.exec(
      "UPDATE memberships SET role=? WHERE tenant_id=? AND member_id=?",
      "owner",
      shared.tenantId,
      owner.actor.memberId,
    );
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      owner.actor.memberId,
    );
    const missing = new RegistryProbe(
      { storage: fromNodeSqlite(registryDatabase) },
      { ...env, TENANTS: undefined },
    );
    await assert.rejects(
      missing.ownerForCreator(owner.actor.memberId, shared.tenantId),
    );
    const restoredOwner = await shared.owner();
    assert.ok(restoredOwner);
    const host = rootHost(env);
    const principal = await host.auth.resolve(owner.actor);
    assert.equal(principal?.actor.memberId, owner.actor.memberId);
    assert.equal(principal?.membershipVersion, restoredOwner.membershipVersion);
    assert.equal(
      await host.auth.resolve({
        kind: "member",
        memberId: env.OYSTER_OWNER_NAME,
      }),
      null,
    );
    await tenants.setStatus(shared.tenantId, "suspended");
    assert.equal(
      await registry.ownerForCreator(owner.actor.memberId, shared.tenantId),
      null,
    );
    assert.equal(await host.auth.resolve(owner.actor), null);
    const coldHost = rootHost(env);
    assert.equal(await coldHost.auth.resolve(owner.actor), null);
  } finally {
    registryDatabase.close();
    tenantsDatabase.close();
  }
});
