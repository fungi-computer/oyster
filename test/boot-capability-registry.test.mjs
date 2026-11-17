import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { BOOT_CHECK_VERSION } from "../src/browser/boot.ts";
import { bootPeer } from "./browser/boot-peer.fixture.ts";
import { defaultTenant, tenantScope } from "../dist/tenant.js";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: new globalThis.URL(
          "../dist/testing/workers-runtime.js",
          import.meta.url,
        ).href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { OysterRegistry, OysterInstallationExecutor, oysterWorkerHost } =
  await import("../dist/workers.js");
hooks.deregister();

function fixture(name = "registry") {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const ctx = {
    id: { name },
    storage: {
      ...storage,
      transactionSync: (work) => storage.transactionSync(work),
      transaction: (work) => work(ctx.storage),
      getAlarm: () => Promise.resolve(null),
      setAlarm: () => Promise.resolve(),
    },
    blockConcurrencyWhile: (work) => work(),
  };
  const env = { OYSTER_ORIGIN: "https://oyster.example", RELEASES: {} };
  const registry = new OysterRegistry(ctx, env);
  return { database, registry, ctx, env };
}

function grant(id, token, expiresAt = Date.now() + 5000) {
  const bytes = new globalThis.TextEncoder().encode("<p>candidate</p>");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {
    lease: {
      id,
      identity: {
        appId: "app_registry",
        releaseId: "rel_registry",
        surfaceId: "host-boot",
      },
      base: "./",
      expiresAt,
      assets: [
        {
          path: "/index.html",
          contentType: "text/html; charset=utf-8",
          artifactRef: "artifact:registry-index",
          digest,
          byteLength: bytes.byteLength,
        },
      ],
    },
    tokenDigest: createHash("sha256").update(token).digest("hex"),
  };
}

test("registry persists only token digests and resolves exact unexpired capability leases", () => {
  const { database, registry } = fixture();
  const token = randomBytes(32).toString("base64url");
  const capability = grant("lease-registry", token);

  registry.bootCapability({ kind: "issue", grant: capability });
  assert.deepEqual(
    registry.bootCapability({
      kind: "resolve",
      tokenDigest: capability.tokenDigest,
      now: Date.now(),
    }),
    capability.lease,
  );
  assert.equal(
    registry.bootCapability({
      kind: "resolve",
      tokenDigest: createHash("sha256").update("wrong").digest("hex"),
      now: Date.now(),
    }),
    null,
  );
  const rows = database
    .prepare("SELECT token_digest, record FROM boot_capabilities")
    .all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_digest, capability.tokenDigest);
  assert.equal(rows[0].record.includes(token), false);
  assert.equal(JSON.stringify(rows).includes(token), false);
  assert.equal(
    registry.bootCapability({
      kind: "resolve",
      tokenDigest: capability.tokenDigest,
      now: capability.lease.expiresAt,
    }),
    null,
  );

  registry.bootCapability({ kind: "revoke", id: capability.lease.id });
  assert.equal(
    registry.bootCapability({
      kind: "resolve",
      tokenDigest: capability.tokenDigest,
      now: Date.now(),
    }),
    null,
  );
  database.close();
});

test("registry bounds active capability leases and rejects oversized asset authority", () => {
  const { database, registry } = fixture();
  for (let index = 0; index < 8; index += 1)
    registry.bootCapability({
      kind: "issue",
      grant: grant(`lease-${index}`, `token-${index}`),
    });
  assert.throws(
    () =>
      registry.bootCapability({
        kind: "issue",
        grant: grant("lease-over-capacity", "token-over-capacity"),
      }),
    /capacity/,
  );

  assert.throws(() =>
    registry.bootCapability({
      kind: "issue",
      grant: {
        ...grant("bad-asset", "token-bad-asset"),
        lease: {
          ...grant("bad-asset", "token-bad-asset").lease,
          assets: [
            {
              ...grant("bad-asset", "token-bad-asset").lease.assets[0],
              byteLength: 200_000_000,
            },
          ],
        },
      },
    }),
  );
  database.close();
});

test("registry admits two seconds of issuer-ahead skew, not more, and never replays an expired lease", () => {
  const { database, registry } = fixture();
  const originalNow = Date.now;
  const verifierNow = originalNow();
  Date.now = () => verifierNow;
  try {
    const within = grant(
      "skew-within",
      "skew-token",
      verifierNow + 12_000 + 2_000,
    );
    registry.bootCapability({ kind: "issue", grant: within });
    assert.deepEqual(
      registry.bootCapability({
        kind: "resolve",
        tokenDigest: within.tokenDigest,
        now: verifierNow,
      }),
      within.lease,
    );
    assert.throws(
      () =>
        registry.bootCapability({
          kind: "issue",
          grant: grant(
            "skew-beyond",
            "other-token",
            verifierNow + 12_000 + 2_001,
          ),
        }),
      /outside its deadline/,
    );
    assert.equal(
      registry.bootCapability({
        kind: "resolve",
        tokenDigest: within.tokenDigest,
        now: within.lease.expiresAt,
      }),
      null,
    );
  } finally {
    Date.now = originalNow;
    database.close();
  }
});

function standaloneFixture(t) {
  const home = fixture();
  t.after(() => home.database.close());
  const html = new globalThis.TextEncoder().encode("<h1>Booted</h1>");
  const digest = (bytes) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const root = new globalThis.TextEncoder().encode(
    JSON.stringify(
      createAppBuild(
        {
          artifactRef: "artifact:boot-html",
          digest: digest(html),
          byteLength: html.byteLength,
          version: "fixture",
          mediaType: "text/html; charset=utf-8",
        },
        null,
      ),
    ),
  );
  const release = {
    appId: "app_boot",
    releaseId: "rel_boot01",
    artifact: {
      artifactRef: "artifact:boot-root",
      artifactDigest: digest(root),
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: digest(root),
        buildRecipeDigest: digest(root),
      },
    },
  };
  const objects = new Map([
    ["artifact:boot-root", root],
    ["artifact:boot-html", html],
  ]);
  let sessions = 0;
  let closedSessions = 0;
  let peer;
  let origin = "https://preview.example.test";
  const browser = {
    async fetch(_url, init) {
      if (init?.method === "POST") {
        sessions++;
        peer = bootPeer({ origin });
        return globalThis.Response.json({ sessionId: "standalone-session" });
      }
      if (init?.method === "DELETE") {
        closedSessions++;
        return globalThis.Response.json({ status: "closed" });
      }
      assert.ok(peer, "a session must exist before its CDP upgrade");
      return Object.assign(new globalThis.Response(null), {
        webSocket: { ...peer.socket, accept: () => undefined },
      });
    },
  };
  Object.assign(home.env, {
    OYSTER_ORIGIN: origin,
    OYSTER_OWNER_KEY: "fixture-owner-key-not-a-real-secret",
    BROWSER: browser,
    REGISTRY: {
      getByName(name) {
        assert.equal(name, home.ctx.id.name);
        return home.registry;
      },
    },
    RELEASES: {
      async get(key) {
        const bytes = objects.get(key);
        return bytes === undefined
          ? null
          : {
              arrayBuffer: async () => bytes.buffer,
              body: new globalThis.Response(bytes).body,
            };
      },
      async head(key) {
        const bytes = objects.get(key);
        return bytes === undefined ? null : { size: bytes.byteLength };
      },
    },
  });
  home.ctx.exports = {
    OysterInstallationExecutor: ({ props }) =>
      new OysterInstallationExecutor({ props }, home.env),
  };
  home.registry = new OysterRegistry(home.ctx, home.env);
  return {
    ...home,
    release,
    async install(installationId) {
      const host = oysterWorkerHost(home.env, {});
      const requestId = `install-${installationId}`;
      await host.installations.operations.admit({
        requestId,
        installationId,
        release,
        actor: { kind: "member", memberId: "owner" },
        intent: "create-only",
        origin: "owner-direct",
      });
      await home.registry.alarm();
      const result = await host.installations.operations.read(
        requestId,
        installationId,
      );
      assert.equal(result.state, "succeeded", JSON.stringify(result));
      return result;
    },
    browser,
    sessions: () => sessions,
    closedSessions: () => closedSessions,
    reboot: () => {
      home.registry = new OysterRegistry(home.ctx, home.env);
    },
    host: (nextOrigin = origin) => {
      origin = nextOrigin;
      return oysterWorkerHost(
        home.env,
        {},
        { scope: tenantScope(defaultTenant, origin) },
      );
    },
  };
}

test("separate standalone installs reuse a Release UI verdict after registry restart", async (t) => {
  const fixture = standaloneFixture(t);
  const first = await fixture.install("first");
  assert.equal(fixture.sessions(), 1);
  fixture.reboot();
  const second = await fixture.install("second");
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(fixture.sessions(), 1);
  assert.equal(fixture.closedSessions(), 1);
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS count FROM oyster_boot_results")
      .get().count,
    1,
  );
});

test("standalone verdicts never cross origins, tenants or check versions", async (t) => {
  const fixture = standaloneFixture(t);
  const key = {
    tenantId: "default",
    origin: fixture.env.OYSTER_ORIGIN,
    releaseId: fixture.release.releaseId,
    artifactDigest: fixture.release.artifact.artifactDigest,
    checkVersion: "old-check",
  };
  fixture.registry.bootUiResult({
    ...key,
    kind: "record",
    outcome: { kind: "passed" },
  });
  await fixture.host().bootUi(fixture.release);
  assert.equal(
    fixture.sessions(),
    1,
    "an old version cannot skip the current check",
  );
  await fixture.host("https://another.example.test").bootUi(fixture.release);
  assert.equal(fixture.sessions(), 2, "another origin must run its own check");
  assert.equal(
    fixture.registry.bootUiResult({
      ...key,
      kind: "read",
      checkVersion: "future-check",
    }),
    null,
  );
  assert.throws(
    () =>
      fixture.registry.bootUiResult({
        ...key,
        kind: "read",
        tenantId: "another",
      }),
    /namespace does not match tenant/,
  );
  assert.equal(
    fixture.registry.bootUiResult({
      ...key,
      kind: "read",
      checkVersion: BOOT_CHECK_VERSION,
      artifactDigest: `sha256:${"b".repeat(64)}`,
    }),
    null,
    "different bytes under the same Release id need their own verdict",
  );
  const other = fixtureForTenant(t);
  assert.equal(
    other.bootUiResult({
      ...key,
      tenantId: "another",
      checkVersion: BOOT_CHECK_VERSION,
      kind: "read",
    }),
    null,
  );
});

function fixtureForTenant(t) {
  const home = fixture("t.another.registry");
  t.after(() => home.database.close());
  return home.registry;
}

test("inconclusive standalone checks are retried after a browser becomes available", async (t) => {
  const fixture = standaloneFixture(t);
  delete fixture.env.BROWSER;
  assert.deepEqual(await fixture.host().bootUi(fixture.release), {
    kind: "not_checked",
    code: "boot_browser_binding_missing",
  });
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS count FROM oyster_boot_results")
      .get().count,
    0,
  );
  fixture.env.BROWSER = fixture.browser;
  assert.deepEqual(await fixture.host().bootUi(fixture.release), {
    kind: "passed",
  });
  assert.equal(fixture.sessions(), 1);
});

test("the registry keeps the first definitive verdict and rejects inconclusive writes", (t) => {
  const fixture = standaloneFixture(t);
  const key = {
    tenantId: "default",
    origin: fixture.env.OYSTER_ORIGIN,
    releaseId: fixture.release.releaseId,
    artifactDigest: fixture.release.artifact.artifactDigest,
    checkVersion: BOOT_CHECK_VERSION,
  };
  const failed = { kind: "failed", code: "ui_mount_failed" };
  assert.deepEqual(
    fixture.registry.bootUiResult({ ...key, kind: "record", outcome: failed }),
    failed,
  );
  assert.deepEqual(
    fixture.registry.bootUiResult({
      ...key,
      kind: "record",
      outcome: { kind: "passed" },
    }),
    failed,
  );
  assert.throws(
    () =>
      fixture.registry.bootUiResult({
        ...key,
        kind: "record",
        outcome: { kind: "not_checked", code: "boot_timeout" },
      }),
    /inconclusive/,
  );
});
