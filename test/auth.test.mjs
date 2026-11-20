import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  lastUsedGranularityMs,
  ownerKeyAuth,
  ownerKeyCookieName,
  ownerOrKeyAuth,
} from "../dist/auth.js";

const { Request, URLSearchParams, btoa, console } = globalThis;

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

test("Git's Basic password admits the owner without consulting issued keys", async () => {
  const auth = ownerOrKeyAuth(key, ownerId, () => {
    throw new Error("The owner key must not reach the issued-key store");
  });
  for (const username of ["oyster", "git"]) {
    assert.deepEqual(
      await auth.authenticate(
        new Request(`${origin}/git/bonsai/pond.git/info/refs`, {
          headers: { Authorization: `Basic ${btoa(`${username}:${key}`)}` },
        }),
      ),
      {
        kind: "admitted",
        principal: {
          actor: { kind: "member", memberId: ownerId },
          role: "owner",
        },
      },
    );
  }
});

test("Basic auth refuses malformed credentials and a wrong owner password", async () => {
  const auth = ownerKeyAuth(key, ownerId);
  for (const authorization of [
    "Basic %%%",
    `Basic ${btoa("oyster")}`,
    `Basic ${btoa("oyster:")}`,
    `Basic ${btoa(`oyster:${key}x`)}`,
    `Basic ${btoa(`${key}:wrong`)}`,
  ]) {
    assert.deepEqual(
      await auth.authenticate(
        new Request(origin, { headers: { Authorization: authorization } }),
      ),
      { kind: "refused", status: 401 },
    );
  }
});

test("the session cookie drops Secure on loopback HTTP only", async () => {
  const auth = ownerKeyAuth(key, ownerId);
  assert.ok(auth.login);
  // The session cookie and the returning marker follow one Secure rule.
  const cookie = async (url) =>
    (
      await auth.login(
        new Request(url, {
          method: "POST",
          body: new URLSearchParams({ key }),
        }),
      )
    ).headers.getSetCookie();
  for (const url of [
    "http://127.0.0.1:8787/login",
    "http://localhost:8787/login",
    "http://[::1]:8787/login",
  ])
    for (const header of await cookie(url)) {
      assert.match(header, /HttpOnly; SameSite=Strict; Max-Age=\d+$/u, url);
      assert.doesNotMatch(header, /Secure/u, url);
    }
  for (const url of [
    "https://oyster.test/login",
    "https://127.0.0.1:8787/login",
    "http://192.168.1.5:8787/login",
    "http://oyster.example.test/login",
  ])
    for (const header of await cookie(url))
      assert.match(header, /HttpOnly; Secure; SameSite=Strict/u, url);
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

test("the owner cookie is read with the cookie grammar, keeping existing sessions", async () => {
  const auth = ownerKeyAuth(key, ownerId);
  // The value every existing session holds: the digest login has always set.
  const session = `sha256:${createHash("sha256").update(`oyster:${key}`).digest("hex")}`;
  const admitted = {
    kind: "admitted",
    principal: { actor: { kind: "member", memberId: ownerId }, role: "owner" },
  };
  const refused = { kind: "refused", status: 401 };
  const cases = [
    [`oyster_session=${session}`, admitted],
    [`oyster_returning=1; theme=a=b=c; oyster_session=${session}`, admitted],
    [`oyster_session="${session}"`, admitted],
    [`  other=1 ;  oyster_session = ${session}  `, admitted],
    [
      `oyster_session=${session}; oyster_session=sha256:${"0".repeat(64)}`,
      admitted,
    ],
    [
      `oyster_session=sha256:${"0".repeat(64)}; oyster_session=${session}`,
      refused,
    ],
    [`xoyster_session=${session}; oyster_session_old=${session}`, refused],
    [`oyster_session=sha256:${"0".repeat(64)}`, refused],
    ["oyster_returning=1", refused],
    ["", refused],
  ];
  for (const [cookie, expected] of cases)
    assert.deepEqual(
      await auth.authenticate(
        new Request(origin, {
          headers: cookie === "" ? {} : { Cookie: cookie },
        }),
      ),
      expected,
      cookie,
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

test("neutral login refuses a body that is not a form with 400", async () => {
  const auth = ownerKeyAuth(key, ownerId);
  assert.ok(auth.login);
  for (const init of [
    {
      body: JSON.stringify({ key }),
      headers: { "Content-Type": "application/json" },
    },
    { body: "key", headers: { "Content-Type": "text/plain" } },
    {},
  ]) {
    const response = await auth.login(
      new Request(`${origin}/login`, { method: "POST", ...init }),
    );
    assert.equal(response.status, 400);
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
  const touched = [];
  const touch = async (keyId) => {
    touched.push(keyId);
    return { kind: "ok", value: undefined };
  };
  const auth = ownerOrKeyAuth(key, ownerId, () => ({ verify, touch }));
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
  assert.deepEqual(touched, []);
  const matching = ownerOrKeyAuth(key, "a-different-owner", () => ({
    verify,
    touch,
  }));
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
  // Only an admitted call stamps last use: the refusal above never did.
  assert.deepEqual(touched, ["morel"]);
});

test("last use is stamped at most once per window and a failed stamp never fails the call", async () => {
  const principal = {
    keyId: "chanterelle",
    owner: "owner",
    name: "chanterelle",
    scope: { grants: [] },
    grantVersion: 1,
    expiresAt: null,
  };
  const verify = async () => ({ kind: "ok", value: principal });
  const calls = [];
  let failure = null;
  const touch = async (keyId) => {
    calls.push(keyId);
    if (failure === "throw") throw new Error("touch unavailable");
    if (failure === "refuse")
      return { kind: "error", error: { code: "denied" } };
    return { kind: "ok", value: undefined };
  };
  const auth = ownerOrKeyAuth(key, "owner", () => ({
    verify,
    touch,
  }));
  const call = () =>
    auth.authenticate(
      new Request("https://oyster.example/", {
        headers: { Authorization: "Bearer oyk_chanterelle" },
      }),
    );
  const realNow = Date.now;
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    let now = 1_000_000;
    Date.now = () => now;
    assert.equal((await call()).kind, "admitted");
    now += lastUsedGranularityMs - 1;
    assert.equal((await call()).kind, "admitted");
    assert.deepEqual(calls, ["chanterelle"]);
    now += 1;
    assert.equal((await call()).kind, "admitted");
    assert.deepEqual(calls, ["chanterelle", "chanterelle"]);
    // A throwing or refusing stamp still admits, and is reported.
    failure = "throw";
    now += lastUsedGranularityMs;
    assert.equal((await call()).kind, "admitted");
    failure = "refuse";
    now += lastUsedGranularityMs;
    assert.equal((await call()).kind, "admitted");
    assert.equal(calls.length, 4);
    assert.equal(logged.length, 2);
  } finally {
    Date.now = realNow;
    console.error = realError;
  }
});
