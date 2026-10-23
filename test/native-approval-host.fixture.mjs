import assert from "node:assert/strict";
import { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { registerHooks } from "node:module";
import { fromNodeSqlite as sqliteOwner } from "@fungi.computer/watchdog/node-sqlite";
import { OysterApprovalHome } from "../dist/approval-home.js";
import { defaultTenant, tenantScope } from "../dist/tenant.js";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: new URL("../dist/testing/workers-runtime.js", import.meta.url)
          .href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { OysterRegistry } = await import("../dist/workers.js");
hooks.deregister();

const storeOwners = new WeakMap();
const nativeHosts = new WeakMap();

/** Current host composition: real native approval home and current member admission. */
export function approvalHost(host) {
  const existing = nativeHosts.get(host);
  if (existing !== undefined) return existing;
  const owner = storeOwners.get(host.installations);
  assert.ok(owner, "Every fixture installation store must own native SQLite");
  const current = {
    ...host,
    auth: {
      resolve: (actor) =>
        Promise.resolve(
          actor.kind === "member" &&
            ["owner", "fixture-owner"].includes(actor.memberId)
            ? { actor, role: "owner" }
            : null,
        ),
      authenticate: () =>
        Promise.reject(new Error("Catalog admission is already host-bound")),
    },
  };
  const home = new OysterApprovalHome({
    owner,
    // This Node adapter proves execution, not a native alarm lifecycle.
    commit: (write) => write(),
    scope: tenantScope(defaultTenant, "https://catalog.fixture.invalid"),
    current: () => Promise.resolve(current),
  });
  const composed = {
    ...current,
    approvals: { submit: (call) => home.submit(call) },
  };
  nativeHosts.set(host, composed);
  return composed;
}

/** Each fake reader owns a real registry incarnation, just like the native host. */
export function installationStore(reader) {
  const database = new DatabaseSync(":memory:");
  after(() => database.close());
  const owner = sqliteOwner(database);
  const registry = new OysterRegistry(
    { id: { name: "registry" }, storage: owner },
    {},
  );
  const store = {
    get: async (id) =>
      (await reader.list()).find((row) => row.installationId === id) ?? null,
    ...reader,
    generation: () => Promise.resolve(registry.generation()),
    compareAndPut: () =>
      Promise.reject(new Error("Catalog fixture installation is fixed")),
  };
  storeOwners.set(store, owner);
  return store;
}
