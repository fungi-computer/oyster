import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
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
const { OysterRegistry } = await import("../dist/workers.js");
hooks.deregister();

function fixture() {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const ctx = {
    id: { name: "registry-fixture" },
    storage: {
      ...storage,
      transactionSync: (work) => storage.transactionSync(work),
    },
    blockConcurrencyWhile: (work) => work(),
  };
  const registry = new OysterRegistry(ctx, {
    OYSTER_ORIGIN: "https://oyster.example",
    RELEASES: {},
  });
  return { database, registry };
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
