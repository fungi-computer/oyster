import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { URL } from "node:url";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { defaultTenant } from "../src/tenant.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: new URL("../src/testing/workers-runtime.ts", import.meta.url).href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { TenancyRegistryDO } =
  await import("../src/tenancy/cloudflare/registry.ts");
hooks.deregister();

/** The registry tables exactly as the current release stores owner and member rows. */
function currentReleaseStore() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','suspended','deleting')));
    CREATE TABLE domains (host TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, ordinal INTEGER NOT NULL);
    CREATE TABLE identities (provider TEXT NOT NULL, subject TEXT NOT NULL, member_id TEXT UNIQUE NOT NULL, PRIMARY KEY(provider,subject));
    CREATE TABLE memberships (tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','member')), membership_version INTEGER NOT NULL DEFAULT 1 CHECK(membership_version BETWEEN 1 AND 9007199254740991), PRIMARY KEY(tenant_id,member_id));
    CREATE TABLE membership_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991));
    INSERT INTO membership_clock VALUES(1,2);
    INSERT INTO tenants VALUES('default','default','https://oyster.invalid','active');
    INSERT INTO domains VALUES('oyster.invalid','default',0);
    INSERT INTO identities VALUES('p','owner-subject','member-owner');
    INSERT INTO identities VALUES('p','member-subject','member-member');
    INSERT INTO memberships VALUES('default','member-owner','owner',1);
    INSERT INTO memberships VALUES('default','member-member','member',2);
  `);
  return db;
}

test("a store from the current release opens in place and reads its roles", async () => {
  const db = currentReleaseStore();
  const storage = fromNodeSqlite(db);
  const registry = new TenancyRegistryDO(
    {
      id: { name: "registry" },
      exports: {},
      storage: { ...storage, getAlarm: async () => null },
      blockConcurrencyWhile: (work) => work(),
    },
    {},
  );
  assert.deepEqual(
    await registry.membershipOf(defaultTenant, {
      provider: "p",
      subject: "owner-subject",
    }),
    { memberId: "member-owner", role: "owner", membershipVersion: 1 },
  );
  assert.deepEqual(await registry.memberById(defaultTenant, "member-member"), {
    memberId: "member-member",
    role: "member",
    membershipVersion: 2,
  });
  // Opening added triggers only; no rows were reset or rewritten.
  assert.equal(db.prepare("SELECT count(*) AS n FROM memberships").get().n, 2);
});
