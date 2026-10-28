import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createKeyStore } from "@fungi.computer/ear-tag/keys";
import { fromNodeSqlite } from "@fungi.computer/ear-tag/keys/node";
import { oysterKeyVocabulary } from "../dist/keys.js";
import {
  keySessionAuth,
  keySessionCookieName,
  ownerKeyAuth,
  ownerKeyCookieName,
  ownerOrKeyAuth,
} from "../dist/auth.js";

const { Headers, Request, URLSearchParams } = globalThis;

const key = "fixture-owner-key-1234567890"; //gitleaks:allow
const ownerId = "canonical-stored-owner";
const origin = "https://owner.example.test";

test("browser sessions recheck real key liveness, owner and explicit credentials on every request", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  let now = 1000;
  const store = createKeyStore({
    sql: fromNodeSqlite(database),
    commit: async (body) => body(),
    vocabulary: oysterKeyVocabulary,
    prefix: "oyk",
    authorizeIssuer: async () => ({ kind: "unrestricted" }),
    now: () => now,
  });
  const issue = async (keyId, owner = ownerId, expiresAt) => {
    const input = {
      keyId,
      name: keyId,
      grants: [{ capability: "apps.read", targets: { kind: "all" } }],
    };
    if (expiresAt !== undefined) input.expiresAt = expiresAt;
    const outcome = await store.issue(owner, input);
    assert.equal(outcome.kind, "ok");
    return outcome.value;
  };
  const issued = await issue("live-key");
  await issue("other-owner-key", "another-owner");
  await issue("expired-key", ownerId, 2000);
  const sessions = new Map([
    ["live-session", { keyId: "live-key" }],
    ["other-owner-session", { keyId: "other-owner-key" }],
    ["expired-session", { keyId: "expired-key" }],
    ["missing-key-session", { keyId: "no-such-key" }],
  ]);
  const keys = {
    verify: store.verify,
    live: async (keyId) => {
      const outcome = await store.live({ keyId });
      return outcome.kind === "ok"
        ? {
            keyId: outcome.value.keyId,
            owner: outcome.value.owner,
            grantVersion: outcome.value.grantVersion,
            grants: outcome.value.scope.grants,
          }
        : null;
    },
  };
  const auth = keySessionAuth(
    ownerOrKeyAuth(key, ownerId, () => keys),
    ownerId,
    () => keys,
    { resolve: async (value) => sessions.get(value) ?? null },
  );
  const browser = (value, authorization) => {
    const headers = new Headers({
      Cookie: `${keySessionCookieName}=${value}`,
    });
    if (authorization !== undefined)
      headers.set("Authorization", authorization);
    return new Request(origin, { headers });
  };
  const admitted = {
    kind: "admitted",
    principal: { actor: { kind: "team-key", keyId: "live-key" } },
  };
  const refused = { kind: "refused", status: 401 };
  assert.deepEqual(await auth.authenticate(browser("live-session")), admitted);
  await t.test(
    "GET and HEAD allow cookies even with cross-site provenance",
    async () => {
      for (const method of ["GET", "HEAD"]) {
        assert.deepEqual(
          await auth.authenticate(
            new Request(origin, {
              method,
              headers: {
                Cookie: `${keySessionCookieName}=live-session`,
                "Sec-Fetch-Site": "cross-site",
              },
            }),
          ),
          admitted,
        );
      }
    },
  );
  await t.test(
    "cross-site POSTs cannot use a valid ambient key session",
    async () => {
      for (const originHeaders of [
        {
          Origin: "https://attacker.example.test",
          "Sec-Fetch-Site": "cross-site",
        },
        {
          Origin: "https://sibling.example.test",
          "Sec-Fetch-Site": "same-site",
        },
        { "Sec-Fetch-Site": "cross-site" },
        { Origin: origin, "Sec-Fetch-Site": "cross-site" },
        { Origin: "null" },
      ]) {
        assert.deepEqual(
          await auth.authenticate(
            new Request(`${origin}/apps/showcase/methods/update`, {
              method: "POST",
              headers: {
                Cookie: `${keySessionCookieName}=live-session`,
                "Content-Type": "text/plain",
                ...originHeaders,
              },
              body: JSON.stringify({ value: "updated" }),
            }),
          ),
          refused,
        );
      }
    },
  );
  await t.test(
    "cookie POSTs admit matching Origin without cross-site provenance",
    async () => {
      for (const originHeaders of [
        { Origin: origin, "Sec-Fetch-Site": "same-origin" },
        { Origin: origin },
      ]) {
        assert.deepEqual(
          await auth.authenticate(
            new Request(`${origin}/apps/showcase/methods/update`, {
              method: "POST",
              headers: {
                Cookie: `${keySessionCookieName}=live-session`,
                "Content-Type": "text/plain",
                ...originHeaders,
              },
              body: JSON.stringify({ value: "updated" }),
            }),
          ),
          admitted,
        );
      }
    },
  );
  await t.test(
    "unsafe cookie-only requests without Origin are refused",
    async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const originHeaders of [{ "Sec-Fetch-Site": "same-origin" }, {}]) {
          assert.deepEqual(
            await auth.authenticate(
              new Request(`${origin}/apps/showcase/methods/update`, {
                method,
                headers: {
                  Cookie: `${keySessionCookieName}=live-session`,
                  "Content-Type": "text/plain",
                  ...originHeaders,
                },
                body: JSON.stringify({ value: "updated" }),
              }),
            ),
            refused,
          );
        }
      }
    },
  );
  assert.deepEqual(
    await auth.authenticate(
      new Request(origin, {
        headers: {
          Cookie: `${ownerKeyCookieName}=stale; ${keySessionCookieName}=live-session`,
        },
      }),
    ),
    admitted,
    "the generic decorator may fall back after an ordinary owner-cookie 401",
  );
  sessions.delete("live-session");
  assert.deepEqual(await auth.authenticate(browser("live-session")), refused);
  sessions.set("live-session", { keyId: "live-key" });
  // The same named key still works through the ordinary explicit bearer path.
  assert.deepEqual(
    await auth.authenticate(browser("unknown", `Bearer ${issued.key}`)),
    admitted,
  );
  for (const value of [
    "",
    "unknown",
    issued.key,
    "other-owner-session",
    "missing-key-session",
  ])
    assert.deepEqual(await auth.authenticate(browser(value)), refused, value);
  for (const authorization of ["Bearer wrong", "Basic invalid", ""])
    assert.deepEqual(
      await auth.authenticate(browser("live-session", authorization)),
      refused,
      "an explicit failed credential cannot fall back to an ambient cookie",
    );
  assert.deepEqual(
    await auth.authenticate(browser("live-session", `Bearer ${key}`)),
    {
      kind: "admitted",
      principal: {
        actor: { kind: "member", memberId: ownerId },
        role: "owner",
      },
    },
  );
  const revoked = await store.revoke(ownerId, {
    keyId: "live-key",
    requestId: "revoke-live-key",
  });
  assert.equal(revoked.kind, "ok");
  assert.deepEqual(await auth.authenticate(browser("live-session")), refused);
  now = 2000;
  assert.deepEqual(
    await auth.authenticate(browser("expired-session")),
    refused,
  );
  await issue("suspended-key");
  sessions.set("suspended-session", { keyId: "suspended-key" });
  assert.equal(
    (await auth.authenticate(browser("suspended-session"))).kind,
    "admitted",
  );
  assert.equal((await store.suspendOwner(ownerId, "suspend-owner")).kind, "ok");
  assert.deepEqual(
    await auth.authenticate(browser("suspended-session")),
    refused,
  );
});

test("a browser session cannot undo a host's explicit refusal", async () => {
  for (const status of [403, 404, 429]) {
    const refusal = {
      kind: "refused",
      status,
    };
    if (status === 429) refusal.retryAfter = 30;
    const auth = keySessionAuth(
      { ...ownerKeyAuth(key, ownerId), authenticate: async () => refusal },
      ownerId,
      () => ({ live: async () => assert.fail("No key lookup after refusal") }),
      { resolve: async () => assert.fail("No session lookup after refusal") },
    );
    assert.deepEqual(
      await auth.authenticate(
        new Request(origin, {
          headers: { Cookie: `${keySessionCookieName}=opaque-session` },
        }),
      ),
      refusal,
    );
  }
});

test("neutral owner auth preserves explicit owner identity and bearer refusals", async () => {
  assert.throws(() => ownerKeyAuth("short", ownerId), /at least 24/);
  const auth = ownerKeyAuth(key, ownerId);
  assert.deepEqual(
    await auth.authenticate(
      new Request(origin, { headers: { Authorization: `Bearer ${key}` } }),
    ),
    {
      kind: "admitted",
      principal: {
        actor: { kind: "member", memberId: ownerId },
        role: "owner",
      },
    },
  );
  for (const value of ["wrong-key-123456789012345678", `${key}x`]) {
    assert.deepEqual(
      await auth.authenticate(
        new Request(origin, { headers: { Authorization: `Bearer ${value}` } }),
      ),
      { kind: "refused", status: 401 },
    );
  }
  assert.deepEqual(await auth.authenticate(new Request(origin)), {
    kind: "refused",
    status: 401,
  });
});

test("neutral login keeps the digest cookie attributes and rotates with the key", async () => {
  const auth = ownerKeyAuth(key, ownerId);
  assert.ok(auth.login);
  const response = await auth.login(
    new Request(`${origin}/login`, {
      method: "POST",
      body: new URLSearchParams({ key }),
    }),
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/");
  const header = response.headers.get("Set-Cookie");
  assert.ok(header);
  assert.equal(ownerKeyCookieName, "oyster_session");
  assert.match(header, /^oyster_session=sha256:[a-f0-9]{64};/);
  assert.match(header, /HttpOnly; Secure; SameSite=Strict; Max-Age=2592000/);
  assert.equal(header.includes(key), false);
  const request = new Request(origin, {
    headers: { Cookie: header.split(";")[0] },
  });
  assert.deepEqual(await auth.authenticate(request), {
    kind: "admitted",
    principal: { actor: { kind: "member", memberId: ownerId }, role: "owner" },
  });
  assert.deepEqual(
    await ownerKeyAuth(`${key}x`, ownerId).authenticate(request),
    {
      kind: "refused",
      status: 401,
    },
  );
});

test("neutral login refuses wrong and missing key input", async () => {
  const auth = ownerKeyAuth(key, ownerId);
  assert.ok(auth.login);
  for (const form of [{ key: "wrong" }, {}]) {
    const response = await auth.login(
      new Request(`${origin}/login`, {
        method: "POST",
        body: new URLSearchParams(form),
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.has("Set-Cookie"), false);
  }
});

test("background resolution uses the configured owner identity without bearer material or actor promotion", async () => {
  const auth = ownerKeyAuth(key, ownerId);
  assert.deepEqual(await auth.resolve({ kind: "member", memberId: ownerId }), {
    actor: { kind: "member", memberId: ownerId },
    role: "owner",
  });
  assert.equal(
    "membershipVersion" in
      (await auth.resolve({ kind: "member", memberId: ownerId })),
    false,
  );
  for (const actor of [
    { kind: "member", memberId: "removed-owner" },
    { kind: "agent", agentId: ownerId },
    { kind: "team-key", keyId: ownerId },
  ]) {
    assert.equal(await auth.resolve(actor), null);
  }
  const replaced = ownerKeyAuth(key, "current-owner");
  assert.equal(
    await replaced.resolve({ kind: "member", memberId: ownerId }),
    null,
  );
});

test("ownerOrKeyAuth admits a verified key only when its own owner matches, never a bare lookup", async () => {
  const keySecret = "fixture-named-key-secret";
  const verify = async (secret) =>
    secret === keySecret
      ? {
          kind: "ok",
          value: {
            keyId: "morel",
            owner: "a-different-owner",
            name: "morel",
            scope: { grants: [] },
            grantVersion: 1,
            expiresAt: null,
          },
        }
      : { kind: "error", error: { code: "denied" } };
  const auth = ownerOrKeyAuth(key, ownerId, () => ({ verify }));
  // The presented secret verifies to a real key, but that key's own stored
  // owner is not this host's configured owner: never admitted, the same as
  // an unrecognized secret.
  assert.deepEqual(
    await auth.authenticate(
      new Request(origin, {
        headers: { Authorization: `Bearer ${keySecret}` },
      }),
    ),
    { kind: "refused", status: 401 },
  );
  // The same secret, once its stored owner matches, admits as that key.
  const matching = ownerOrKeyAuth(key, "a-different-owner", () => ({ verify }));
  assert.deepEqual(
    await matching.authenticate(
      new Request(origin, {
        headers: { Authorization: `Bearer ${keySecret}` },
      }),
    ),
    {
      kind: "admitted",
      principal: { actor: { kind: "team-key", keyId: "morel" } },
    },
  );
});
