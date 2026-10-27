import assert from "node:assert/strict";
import test from "node:test";
import {
  ownerKeyAuth,
  ownerKeyCookieName,
  ownerOrKeyAuth,
} from "../dist/auth.js";

const { Request, URLSearchParams } = globalThis;

const key = "fixture-owner-key-1234567890"; //gitleaks:allow
const ownerId = "canonical-stored-owner";
const origin = "https://owner.example.test";

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
