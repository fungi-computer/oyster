// A local standalone run of the real, compiled `StandaloneRegistry`: forking
// a published platform App's source registers a new App bound to its own
// repository in the calling installation's Git, and registers that
// repository as the new App's build source with the template's recipe. Only two seams are substituted (`cloudflare:workers`'s platform
// base classes, and burrow's `createCloudflareArtifacts`); the registry's own
// SQLite storage, the fork algorithm (`forkAppSource`, unchanged from A4),
// and `StandaloneRegistry.forkApp`/`publishSource` (the seed claim) all run as
// compiled, with no live Artifacts account and no real Git wire protocol.
import assert from "node:assert/strict";
import { log } from "node:console";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { normalizeAppPublisherRecipe } from "@fungi.computer/oyster/build-contract";
import { seed as seedArtifacts } from "./app-fork-artifacts.fixture.mjs";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "cloudflare:workers" ||
      specifier === "cloudflare:workflows"
    )
      return {
        url: new URL("./app-fork-workers.fixture.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    if (specifier === "@fungi.computer/burrow/cloudflare")
      return {
        url: new URL("./app-fork-artifacts.fixture.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { OysterRegistry: StandaloneRegistry } =
  await import("../../src/standalone/worker.ts");
const { StandaloneTenants } = await import("../../src/standalone/tenancy.ts");
hooks.deregister();

/** A Durable Object state over one SQLite database, with the KV the tenancy uses. */
function state(database) {
  const storage = fromNodeSqlite(database);
  storage.sql.exec(
    "CREATE TABLE fixture_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  return {
    id: { name: "registry" },
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

const platformAppId = "app_demoproof";
const teamId = "tenant-fixture";
const seedHead = "a".repeat(40);
seedArtifacts(`template-${platformAppId.slice("app_".length)}`, seedHead);

function fixtureRegistry() {
  const database = new DatabaseSync(":memory:");
  const tenants = new StandaloneTenants(state(new DatabaseSync(":memory:")));
  const env = {
    OYSTER_OWNER_NAME: "fixture-owner",
    OYSTER_COMPUTER_ID: "workspace",
    TENANTS: { getByName: () => tenants },
    // A fork registers a build source; it never starts a build here.
    COMPUTER: {
      idFromName: () => ({ toString: () => "computer-object" }),
      getByName: () => assert.fail("No build runs in the fork proof"),
    },
    RELEASES: {},
    INSTANCES: { getByName: () => ({ revoke: () => Promise.resolve() }) },
    MCP: {},
    LOADER: {},
    OYSTER_OWNER_KEY: "x".repeat(24),
    OYSTER_ORIGIN: "https://fixture.test",
    // Any truthy value short-circuits `artifactsOf`; the fake
    // `createCloudflareArtifacts` never reads it.
    ARTIFACTS: {},
    KEYS: {},
    WEBHOOKS: {},
  };
  const ctx = state(database);
  return {
    database,
    registry: new StandaloneRegistry(ctx, env),
  };
}

// The operator pushed the platform App's source; its template's main is
// `seedHead`. Claiming that head runs `StandaloneRegistry.publishSource` as
// compiled: it records the seed receipt and registers the platform App's own
// publisher, which `forkApp` authorizes against.
async function registerPlatform(registry) {
  const claim = {
    appId: platformAppId,
    sourceRevision: `git:${"0".repeat(40)}`,
    sourceTreeDigest: `sha256:${"c".repeat(64)}`,
    seedRevision: `git:${seedHead}`,
    recipe: platformRecipe.recipe,
  };
  // A claim for a commit the template's main does not name is refused.
  assert.deepEqual(
    await registry.publishSource(
      platformAppId,
      { ...claim, seedRevision: `git:${"b".repeat(40)}` },
      teamId,
    ),
    { kind: "conflict" },
  );
  const published = await registry.publishSource(platformAppId, claim, teamId);
  assert.equal(published.kind, "recorded", JSON.stringify(published));
  assert.equal(
    published.receipt.buildRecipeDigest,
    platformRecipe.buildRecipeDigest,
  );
  const replay = await registry.publishSource(platformAppId, claim, teamId);
  assert.equal(replay.kind, "existing");
}

const platformRecipe = normalizeAppPublisherRecipe({
  appId: platformAppId,
  recipe: {
    entry: "apps/shed/index.html",
    backend: null,
    maxOutputBytes: 100_000,
  },
});

const { database, registry } = fixtureRegistry();
try {
  await registerPlatform(registry);

  const forkInput = {
    teamId,
    platformAppId,
    installationId: "bonsai",
    repositoryPrefix: "bonsai--",
    name: "my-demo",
  };
  const first = await registry.forkApp(forkInput);
  assert.equal(first.kind, "forked", JSON.stringify(first));
  const forkedAppId = first.appId;
  assert.equal(first.repository, "my-demo");
  log(`forked ${platformAppId} -> ${forkedAppId} (${first.repository})`);

  // The forked App is its own App, with its own installation-free
  // registration record distinct from the platform App's.
  const registration = await registry.appRegistrations.read(forkedAppId);
  assert.equal(registration.kind, "found");
  assert.equal(registration.registration.appId, forkedAppId);
  assert.equal(registration.registration.source.repository, "bonsai--my-demo");
  assert.notEqual(forkedAppId, platformAppId);
  log("fork is registered as its own App, bound to its own repository");

  // The fork's repository is the new App's build source, pinned to the
  // template's own recipe, so a merged commit builds without setup.
  const sources = database
    .prepare("SELECT source FROM oyster_build_sources WHERE app_id = ?")
    .all(forkedAppId);
  assert.equal(sources.length, 1);
  const source = JSON.parse(sources[0].source);
  assert.deepEqual(source.location, {
    kind: "installation",
    installationId: "bonsai",
    repository: "my-demo",
  });
  assert.equal(source.buildRecipeDigest, platformRecipe.buildRecipeDigest);
  log("the fork's repository is registered as its build source");

  // A fork of an unpublished platform App is refused, typed -- the real
  // `StandaloneRegistry.forkApp` dispatch path, not just `forkAppSource`.
  const refused = await registry.forkApp({
    ...forkInput,
    platformAppId: "app_unpublished",
    name: "other-demo",
  });
  assert.equal(refused.kind, "unauthorized");
  log("a fork of an unpublished App is refused, typed");

  log("OK: local standalone run proves a fork is its own App");
} finally {
  database.close();
}
