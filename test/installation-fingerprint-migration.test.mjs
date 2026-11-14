import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { URL } from "node:url";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { defaultTenant, tenantScope } from "../src/tenant.ts";

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
const { OysterRegistry } = await import("../src/workers.ts");
hooks.deregister();
const { applyGrantCommand, unstampedFingerprint } =
  await import("../src/apps/installation.ts");
const { deriveDeclaredOperations } = await import("../src/apps/operations.ts");
const { declaration, descriptors, release } = await import("./apps-fixture.ts");

const origin = "https://oyster.invalid";

function registryOver(db) {
  const storage = fromNodeSqlite(db);
  return new OysterRegistry(
    {
      id: { name: tenantScope(defaultTenant, origin).durableName("registry") },
      exports: {},
      storage: { ...storage, getAlarm: async () => null },
      blockConcurrencyWhile: (work) => work(),
    },
    { OYSTER_ORIGIN: origin },
  );
}

const grantsOf = (db) =>
  JSON.parse(db.prepare("SELECT record FROM installations").get().record)
    .authority.approvedGrants;

test("a registry written by Oyster 0.28.1 stays readable, keeps its approvals and is stamped on first selection", async () => {
  const snapshot = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  // The exact 0.28.1 stored shape: grants carry no fingerprints.
  const legacy = {
    installationId: "notes",
    instanceId: null,
    appId: release.appId,
    release,
    releasePin: "pinned",
    status: "enabled",
    authority: {
      authorityVersion: 2,
      declaredOperationsDigest: snapshot.digest,
      approvedGrants: snapshot.capabilities.map((row) => ({
        capability: row.capability,
        capabilityApproved: true,
        operations: row.operations,
        resources: "tenant-scope",
      })),
      approval: null,
    },
  };
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE installations (installation_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT",
  );
  db.prepare("INSERT INTO installations VALUES (?, ?)").run(
    "notes",
    JSON.stringify(legacy),
  );

  const registry = registryOver(db);
  // One legacy row never breaks the directory.
  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(
    listed[0].authority.approvedGrants.map((g) => [g.capability, g.operations]),
    snapshot.capabilities.map((row) => [row.capability, row.operations]),
  );
  // The legacy shape is gone from storage at once.
  for (const grant of grantsOf(db))
    assert.deepEqual(
      Object.values(grant.fingerprints),
      grant.operations.map(() => unstampedFingerprint),
    );

  // The first selection carries every approval by name and stamps the snapshot.
  const selected = applyGrantCommand(
    listed[0].authority,
    { kind: "select-release" },
    {
      principal: {
        actor: { kind: "member", memberId: "owner" },
        role: "owner",
      },
      expectedVersion: 2,
      declaration,
      declaredOperations: snapshot,
      now: 1,
    },
  );
  assert.equal(selected.success !== undefined, true);
  assert.deepEqual(
    selected.success.approvedGrants.map((g) => [g.capability, g.operations]),
    snapshot.capabilities.map((row) => [row.capability, row.operations]),
  );
  const written = await registry.compareAndPut(
    { ...listed[0], authority: selected.success },
    2,
    registry.generation(),
  );
  assert.deepEqual(written, { ok: true });
  const stored = grantsOf(db);
  assert.deepEqual(
    stored.map((g) => g.fingerprints),
    snapshot.capabilities.map((row) => row.fingerprints),
  );
  assert.equal(registry.list().length, 1);
});

test("retained installation commands carry the same migration", () => {
  const legacyInstallation = {
    installationId: "notes",
    authority: {
      authorityVersion: 1,
      approvedGrants: [
        {
          capability: "apps.open",
          capabilityApproved: true,
          operations: ["route:app.methods:open"],
          resources: "tenant-scope",
        },
      ],
    },
  };
  const db = new DatabaseSync(":memory:");
  registryOver(db);
  db.prepare(
    "INSERT INTO installation_commands(request_id, installation_id, command, provisional_outcome) VALUES (?,?,?,?)",
  ).run(
    "req_1",
    "notes",
    JSON.stringify({ baseline: legacyInstallation, plan: null }),
    JSON.stringify({ state: "succeeded", installation: legacyInstallation }),
  );
  registryOver(db);
  const row = db.prepare("SELECT * FROM installation_commands").get();
  const expected = {
    "route:app.methods:open": unstampedFingerprint,
  };
  assert.deepEqual(
    JSON.parse(row.command).baseline.authority.approvedGrants[0].fingerprints,
    expected,
  );
  assert.deepEqual(
    JSON.parse(row.provisional_outcome).installation.authority.approvedGrants[0]
      .fingerprints,
    expected,
  );
});
