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

/** An in-memory OwnerSessions port, with its rows visible to the test. */
function memorySessions() {
  const rows = new Map();
  return {
    rows,
    open: async (owner, digest, now) => {
      rows.set(digest, { owner, expiresAt: now + 2_592_000_000 });
    },
    owner: async (digest, now) => {
      const row = rows.get(digest);
      return row === undefined || row.expiresAt <= now ? null : row.owner;
    },
    revoke: async (digest) => {
      rows.delete(digest);
    },
    revokeOwner: async (owner) => {
      for (const [digest, session] of rows)
        if (session.owner === owner) rows.delete(digest);
    },
  };
}

async function signIn(auth, url = `${origin}/login`) {
  const response = await auth.login(
    new Request(url, { method: "POST", body: new URLSearchParams({ key }) }),
  );
  const header = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${ownerKeyCookieName}=`));
  return { response, header, cookie: header?.split(";")[0] };
}

const key = "fixture-owner-key-1234567890"; //gitleaks:allow
const ownerId = "canonical-stored-owner";
const origin = "https://owner.example.test";

test("neutral owner auth preserves explicit owner identity and bearer refusals", async () => {
  assert.throws(
    () => ownerKeyAuth("short", ownerId, memorySessions()),
    /at least 24/,
  );
  const auth = ownerKeyAuth(key, ownerId, memorySessions());
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
  const auth = ownerOrKeyAuth(key, ownerId, memorySessions(), () => {
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
  const auth = ownerKeyAuth(key, ownerId, memorySessions());
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
  const auth = ownerKeyAuth(key, ownerId, memorySessions());
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

test("sign-in opens a random server-side session that expires", async () => {
  const sessions = memorySessions();
  const auth = ownerKeyAuth(key, ownerId, sessions);
  const first = await signIn(auth);
  assert.equal(first.response.status, 303);
  assert.equal(first.response.headers.get("Location"), "/");
  assert.equal(ownerKeyCookieName, "oyster_session");
  assert.match(first.header, /^oyster_session=[A-Za-z0-9_-]{43};/u);
  assert.match(
    first.header,
    /Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/u,
  );
  assert.equal(first.header.includes(key), false);
  // Each sign-in is its own session, and the store never holds the cookie.
  const second = await signIn(auth);
  assert.notEqual(first.cookie, second.cookie);
  assert.equal(sessions.rows.size, 2);
  for (const digest of sessions.rows.keys())
    assert.equal(
      [first.cookie, second.cookie].some((cookie) => cookie.endsWith(digest)),
      false,
    );
  const [row] = sessions.rows.values();
  assert.equal(row.owner, ownerId);
  assert.ok(Math.abs(row.expiresAt - (Date.now() + 2_592_000_000)) < 60_000);
  const request = new Request(origin, { headers: { Cookie: first.cookie } });
  assert.deepEqual(await auth.authenticate(request), {
    kind: "admitted",
    principal: { actor: { kind: "member", memberId: ownerId }, role: "owner" },
  });
  // Past its expiry the server refuses the cookie, whatever the browser keeps.
  for (const stored of sessions.rows.values()) stored.expiresAt = Date.now();
  assert.deepEqual(await auth.authenticate(request), {
    kind: "refused",
    status: 401,
  });
});

test("a session signs in only its own owner", async () => {
  const sessions = memorySessions();
  const { cookie } = await signIn(ownerKeyAuth(key, ownerId, sessions));
  const other = ownerKeyAuth(key, "a-different-owner", sessions);
  assert.deepEqual(
    await other.authenticate(
      new Request(origin, { headers: { Cookie: cookie } }),
    ),
    { kind: "refused", status: 401 },
  );
});

test("rotating the owner key ends every session", async () => {
  const sessions = memorySessions();
  const { cookie } = await signIn(ownerKeyAuth(key, ownerId, sessions));
  const rotated = ownerKeyAuth(`${key}-rotated`, ownerId, sessions);
  assert.deepEqual(
    await rotated.authenticate(
      new Request(origin, { headers: { Cookie: cookie } }),
    ),
    { kind: "refused", status: 401 },
  );
});

test("logout revokes the session and clears the cookie", async () => {
  const sessions = memorySessions();
  const auth = ownerKeyAuth(key, ownerId, sessions);
  const { cookie } = await signIn(auth);
  const kept = await signIn(auth);
  assert.ok(auth.logout);
  // A cross-site or Origin-less POST cannot sign the owner out.
  for (const headers of [
    { Cookie: cookie },
    { Cookie: cookie, Origin: "https://attacker.example" },
    { Cookie: cookie, Origin: origin, "Sec-Fetch-Site": "cross-site" },
  ]) {
    const refused = await auth.logout(
      new Request(`${origin}/logout`, { method: "POST", headers }),
    );
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("Set-Cookie"), null);
  }
  assert.equal(
    (
      await auth.authenticate(
        new Request(origin, { headers: { Cookie: cookie } }),
      )
    ).kind,
    "admitted",
  );
  const response = await auth.logout(
    new Request(`${origin}/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin },
    }),
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/login");
  assert.match(
    response.headers.get("Set-Cookie"),
    /^oyster_session=; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=0$/u,
  );
  // A copy of the revoked cookie no longer signs in; other browsers stay.
  assert.deepEqual(
    await auth.authenticate(
      new Request(origin, { headers: { Cookie: cookie } }),
    ),
    { kind: "refused", status: 401 },
  );
  assert.equal(
    (
      await auth.authenticate(
        new Request(origin, { headers: { Cookie: kept.cookie } }),
      )
    ).kind,
    "admitted",
  );
  // Logging out without a session still clears the cookie.
  const bare = await auth.logout(
    new Request(`${origin}/logout`, {
      method: "POST",
      headers: { Origin: origin },
    }),
  );
  assert.equal(bare.status, 303);
});

test("the old key-digest cookie fails closed", async () => {
  const digest = `sha256:${createHash("sha256").update(`oyster:${key}`).digest("hex")}`;
  const auth = ownerKeyAuth(key, ownerId, memorySessions());
  assert.deepEqual(
    await auth.authenticate(
      new Request(origin, {
        headers: { Cookie: `${ownerKeyCookieName}=${digest}` },
      }),
    ),
    { kind: "refused", status: 401 },
  );
});

test("the owner cookie is read with the cookie grammar", async () => {
  const auth = ownerKeyAuth(key, ownerId, memorySessions());
  const session = (await signIn(auth)).cookie.slice(
    `${ownerKeyCookieName}=`.length,
  );
  const other = (
    await signIn(ownerKeyAuth(key, ownerId, memorySessions()))
  ).cookie.slice(`${ownerKeyCookieName}=`.length);
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
    [`oyster_session=${session}; oyster_session=${other}`, admitted],
    [`oyster_session=${other}; oyster_session=${session}`, refused],
    [`xoyster_session=${session}; oyster_session_old=${session}`, refused],
    [`oyster_session=${other}`, refused],
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
  const auth = ownerKeyAuth(key, ownerId, memorySessions());
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
  const auth = ownerKeyAuth(key, ownerId, memorySessions());
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
  const auth = ownerKeyAuth(key, ownerId, memorySessions());
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
  const replaced = ownerKeyAuth(key, "current-owner", memorySessions());
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
  const auth = ownerOrKeyAuth(key, ownerId, memorySessions(), () => ({
    verify,
    touch,
  }));
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
  const matching = ownerOrKeyAuth(
    key,
    "a-different-owner",
    memorySessions(),
    () => ({
      verify,
      touch,
    }),
  );
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
  const auth = ownerOrKeyAuth(key, "owner", memorySessions(), () => ({
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
