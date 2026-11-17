import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";

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
const { OysterRegistry } = await import("../../src/standalone/worker.ts");
const { standaloneComputerFleetRoutes } =
  await import("../../src/standalone/computer-fleet.ts");
const { serveHost } = await import("../../src/authorization.ts");
hooks.deregister();

// A local trial runs its folder as the Computer "workspace". The fleet never
// created it, so the registry reports it from configuration, never from a row.

function state(database) {
  const storage = fromNodeSqlite(database);
  storage.sql.exec(
    "CREATE TABLE fixture_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  return {
    id: { name: "registry" },
    storage: {
      ...storage,
      getAlarm: async () => null,
      setAlarm: () => Promise.resolve(),
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

async function trial(backend) {
  const tenants = new StandaloneTenants(state(new DatabaseSync(":memory:")));
  const registryDatabase = new DatabaseSync(":memory:");
  const env = {
    OYSTER_ORIGIN: "https://trial.test",
    OYSTER_OWNER_KEY: ["trial", "fixture", "owner", "key"]
      .join("-")
      .padEnd(40, "k"),
    OYSTER_COMPUTER_ID: "workspace",
    OYSTER_OWNER_NAME: "owner",
    TENANTS: { getByName: () => tenants },
    COMPUTER: {
      getByName: () => ({ initializeFleetBackings: () => Promise.resolve() }),
    },
  };
  if (backend !== undefined) env.OYSTER_COMPUTER_BACKEND = backend;
  const owner = await (await standaloneTenancy(env)).owner();
  const registry = new OysterRegistry(state(registryDatabase), env);
  const fleet = (request) =>
    registry.computerFleet(owner.actor.memberId, request);
  return {
    fleet,
    registry,
    /** The owner's own HTTP routes, as Settings reaches them. */
    routes: serveHost(
      standaloneComputerFleetRoutes(() => registry),
      () => Promise.resolve({ kind: "admitted", principal: owner }),
      { liveKey: () => Promise.resolve(null), appToolPolicy: () => null },
    ),
    fleetRows: () =>
      registryDatabase
        .prepare("SELECT COUNT(*) AS count FROM hub_team_computers")
        .get().count,
  };
}

const workspace = {
  computerId: "workspace",
  name: "workspace",
  size: "default",
  createdAt: 0,
  updatedAt: 0,
};
const everything = { limit: 100, offset: 0 };

test("a local trial lists its configured Computer in Settings", async () => {
  const { fleet } = await trial("local");
  assert.deepEqual(await fleet({ operation: "list", page: everything }), {
    computers: [workspace],
    nextOffset: null,
  });
});

test("a local trial reads its Computer by id with the facts the list gives", async () => {
  const { fleet } = await trial("local");
  assert.deepEqual(
    await fleet({ operation: "read", computerId: "workspace" }),
    workspace,
  );
});

test("the list and the picker's choices name the same Computer", async () => {
  const { fleet } = await trial("local");
  const listed = await fleet({ operation: "list", page: everything });
  const chosen = await fleet({ operation: "choices", page: everything });
  assert.deepEqual(
    listed.computers.map(({ computerId, name }) => ({ computerId, name })),
    chosen.computers,
  );
});

test("a local trial's Computer can be selected, and the default then reads back", async () => {
  const { fleet, registry } = await trial("local");
  assert.deepEqual(
    await fleet({ operation: "select", computerId: "workspace" }),
    workspace,
  );
  assert.equal(await registry.selectedComputer(), "workspace");
});

test("reporting the configured Computer never writes a fleet row", async () => {
  const { fleet, fleetRows } = await trial("local");
  await fleet({ operation: "list", page: everything });
  await fleet({ operation: "read", computerId: "workspace" });
  await fleet({ operation: "select", computerId: "workspace" });
  assert.equal(fleetRows(), 0);
});

test("the configured Computer pages first, then the Computers the owner created", async () => {
  const { fleet } = await trial("local");
  const created = await fleet({
    operation: "create",
    request: { name: "second", requestId: "second" },
  });
  assert.deepEqual(
    await fleet({ operation: "list", page: { limit: 1, offset: 0 } }),
    { computers: [workspace], nextOffset: 1 },
  );
  assert.deepEqual(
    await fleet({ operation: "list", page: { limit: 1, offset: 1 } }),
    { computers: [created], nextOffset: null },
  );
});

test("a hosted fleet's inventory stays the Computers it created", async () => {
  const { fleet } = await trial(undefined);
  assert.deepEqual(await fleet({ operation: "list", page: everything }), {
    computers: [],
    nextOffset: null,
  });
  assert.equal(
    await fleet({ operation: "read", computerId: "workspace" }),
    null,
  );
});

test("a caller that is not the owner is refused the configured Computer", async () => {
  const { registry } = await trial("local");
  assert.deepEqual(
    await registry.computerFleet("someone-else", {
      operation: "list",
      page: everything,
    }),
    { error: "owner_required" },
  );
});

test("a local trial's Computer reports both Settings switches as unavailable, not as a failed check", async () => {
  const { fleet } = await trial("local");
  for (const [read, set] of [
    ["read-internet-access", "set-internet-access"],
    ["read-keep-awake", "set-keep-awake"],
  ]) {
    assert.deepEqual(
      await fleet({ operation: read, computerId: "workspace" }),
      { error: "unavailable" },
    );
    assert.deepEqual(
      await fleet({ operation: set, computerId: "workspace", enabled: false }),
      { error: "unavailable" },
    );
  }
});

test("the unavailable switch reaches Settings as a typed 409", async () => {
  const { routes } = await trial("local");
  for (const path of ["internet-access", "keep-awake"]) {
    const response = await routes.request(`/api/computers/workspace/${path}`);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "unavailable" });
  }
});

test("a hosted fleet still finds no switches for the configured Computer", async () => {
  const { fleet } = await trial(undefined);
  assert.equal(
    await fleet({ operation: "read-keep-awake", computerId: "workspace" }),
    null,
  );
  assert.equal(
    await fleet({ operation: "read-internet-access", computerId: "workspace" }),
    null,
  );
  assert.equal(
    await fleet({
      operation: "set-internet-access",
      computerId: "workspace",
      enabled: false,
    }),
    null,
  );
});

test("every view of the configured Computer agrees on one identity", async () => {
  const { fleet, registry } = await trial("local");
  assert.equal(registry.ownsComputer("workspace"), true);
  assert.equal(registry.ownsComputer("other"), false);
  assert.equal(await registry.selectedComputer(), "workspace");
  const chosen = await fleet({ operation: "choices", page: everything });
  assert.deepEqual(chosen.computers, [
    { computerId: "workspace", name: "workspace" },
  ]);
});
