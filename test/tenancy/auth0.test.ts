import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { auth0 } from "../../src/tenancy/auth0.js";
import {
  createTenancy,
  type ReadonlyTenancy,
} from "../../src/tenancy/index.js";
import { memoryRegistry } from "../../src/tenancy/registry.js";
import { subdomain, hosts } from "../../src/tenancy/resolve.js";

const issuer = "https://identity.example.test/";
const audience = "https://api.example.test";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: JSONWebKeySet;

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = {
    keys: [
      { ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256" },
    ],
  };
});

async function token(
  options: {
    issuer?: string;
    audience?: string;
    subject?: string;
    expiration?: string;
  } = {},
) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setSubject(options.subject ?? "external-subject")
    .setIssuedAt()
    .setExpirationTime(options.expiration ?? "1h")
    .sign(keys.privateKey);
}

function fixture() {
  const registry = memoryRegistry();
  const fetchKeys = vi.fn<typeof fetch>((input) => {
    expect(new Request(input).url).toBe(`${issuer}.well-known/jwks.json`);
    return Promise.resolve(Response.json(jwks));
  });
  const adapter = auth0({
    domain: "identity.example.test",
    clientId: "application",
    audience,
    fetch: fetchKeys,
  });
  return { registry, adapter, fetchKeys };
}

describe("Auth0 identity admission", () => {
  it("verifies the token then resolves a stored canonical member, never the external subject", async () => {
    const { registry, adapter, fetchKeys } = fixture();
    const tenant = await registry.create({
      handle: "alpha",
      origin: "https://alpha.example.test",
      domains: ["alpha.example.test"],
      owner: { provider: issuer, subject: "external-subject" },
    });
    const tenancy = createTenancy({
      registry,
      resolve: subdomain("example.test"),
      auth: [adapter],
    });
    const request = new Request(tenant.origin, {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    await expect(tenancy.authenticate(request, tenant)).resolves.toEqual({
      kind: "admitted",
      tenant,
      principal: {
        actor: { kind: "member", memberId: tenant.owners[0] },
        role: "owner",
      },
    });
    expect(tenant.owners[0]).not.toBe("external-subject");
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["issuer", { issuer: "https://other.example.test/" }],
    ["audience", { audience: "https://other-api.example.test" }],
    ["expiration", { expiration: "-1s" }],
    ["empty subject", { subject: "" }],
  ])("refuses a token with the wrong %s", async (_, claims) => {
    const { registry, adapter } = fixture();
    const tenant = await registry.create({
      handle: "alpha",
      origin: "https://alpha.example.test",
      domains: ["alpha.example.test"],
      owner: { provider: issuer, subject: "external-subject" },
    });
    await expect(
      adapter.authenticate(
        new Request(tenant.origin, {
          headers: { Authorization: `Bearer ${await token(claims)}` },
        }),
        tenant,
      ),
    ).resolves.toEqual({ kind: "refused", status: 401 });
  });

  it("does not create membership for an otherwise valid foreign subject", async () => {
    const { registry, adapter } = fixture();
    const tenant = await registry.create({
      handle: "alpha",
      origin: "https://alpha.example.test",
      domains: ["alpha.example.test"],
      owner: { provider: issuer, subject: "external-subject" },
    });
    const tenancy = createTenancy({
      registry,
      resolve: subdomain("example.test"),
      auth: [adapter],
    });
    await expect(
      tenancy.authenticate(
        new Request(tenant.origin, {
          headers: {
            Authorization: `Bearer ${await token({ subject: "stranger" })}`,
          },
        }),
        tenant,
      ),
    ).resolves.toEqual({ kind: "refused", status: 403 });
    await expect(
      registry.membershipOf(tenant.id, {
        provider: issuer,
        subject: "stranger",
      }),
    ).resolves.toBeNull();
  });

  it("passes absent credentials without fetching keys", async () => {
    const { registry, adapter, fetchKeys } = fixture();
    const tenant = await registry.create({
      handle: "alpha",
      origin: "https://alpha.example.test",
      domains: ["alpha.example.test"],
      owner: { provider: issuer, subject: "external-subject" },
    });
    await expect(
      adapter.authenticate(new Request(tenant.origin), tenant),
    ).resolves.toEqual({
      kind: "pass",
    });
    expect(fetchKeys).not.toHaveBeenCalled();
  });
});

async function browserFixture() {
  const registry = memoryRegistry();
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: { provider: issuer, subject: "external-subject" },
  });
  const beta = await registry.create({
    handle: "beta",
    origin: "https://beta.example.test",
    domains: ["beta.example.test"],
    owner: { provider: issuer, subject: "external-subject" },
  });
  const transactions = new Map<
    string,
    import("../../src/tenancy/auth0.js").Auth0Transaction
  >();
  const sessions = new Map<
    string,
    import("../../src/tenancy/auth0.js").Auth0Session
  >();
  const exchange = vi.fn(async (body: URLSearchParams) => {
    expect(body.get("code")).toBe("fixture-code");
    expect(body.get("client_id")).toBe("application");
    const verifier = present(body.get("code_verifier"));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    return Response.json({
      access_token: await token(),
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const localRequest = new Request(input, init);
    const url = new URL(localRequest.url);
    if (url.pathname === "/.well-known/jwks.json") return Response.json(jwks);
    if (url.pathname === "/.well-known/openid-configuration")
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}oauth/token`,
        jwks_uri: `${issuer}.well-known/jwks.json`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/oauth/token")
      return exchange(new URLSearchParams(await localRequest.text()));
    throw new Error(`Unexpected local endpoint ${url.pathname}`);
  });
  const adapter = auth0({
    domain: "identity.example.test",
    clientId: "application",
    audience,
    fetch: transport,
    browser: {
      callbackPath: "/auth/callback",
      registry,
      resolveTenant: (request) => tenancy.resolve(request),
      transactions: {
        put: (id, value) => {
          transactions.set(id, value);
          return Promise.resolve();
        },
        take: (id) => {
          const value = transactions.get(id) ?? null;
          transactions.delete(id);
          return Promise.resolve(value);
        },
      },
      sessions: {
        put: (id, value) => {
          sessions.set(id, value);
          return Promise.resolve();
        },
        get: (id) => Promise.resolve(sessions.get(id) ?? null),
      },
    },
  });
  const tenancy: ReadonlyTenancy = createTenancy({
    registry,
    resolve: hosts(registry),
    auth: [adapter],
  });
  return {
    adapter,
    tenant,
    beta,
    transactions,
    sessions,
    exchange,
    transport,
    registry,
    tenancy,
  };
}

it("completes code+PKCE login with a host-selected tenant and opaque cookie", async () => {
  const { adapter, tenant, transactions, exchange } = await browserFixture();
  const start = await present(adapter.routes).request(`${tenant.origin}/login`);
  expect(start.status).toBe(302);
  const authorization = new URL(present(start.headers.get("Location")));
  expect(authorization.origin).toBe(new URL(issuer).origin);
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("audience")).toBe(audience);
  const transaction = present([...transactions.values()][0]);
  const { calculatePKCECodeChallenge } = await import("oauth4webapi");
  expect(authorization.searchParams.get("code_challenge")).toBe(
    await calculatePKCECodeChallenge(transaction.codeVerifier),
  );
  const cookie = present(
    present(start.headers.get("Set-Cookie")).split(";")[0],
  );
  const callback = `${tenant.origin}/auth/callback?code=fixture-code&state=${present(authorization.searchParams.get("state"))}`;
  // The adapter is mounted at /auth: its routes are relative /login and /callback.
  const app = new (await import("hono")).Hono().route(
    "/auth",
    present(adapter.routes),
  );
  const result = await app.request(callback, { headers: { Cookie: cookie } });
  expect(result.status).toBe(303);
  expect(result.headers.get("Location")).toBe(tenant.origin);
  expect(exchange).toHaveBeenCalledTimes(1);
  const sessionCookie = present(
    present(
      result.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Host-tenancy-auth0=")),
    ).split(";")[0],
  );
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, { headers: { Cookie: sessionCookie } }),
      tenant,
    ),
  ).resolves.toEqual({
    kind: "identity",
    identity: { provider: issuer, subject: "external-subject" },
  });
  expect(result.headers.get("Set-Cookie")).not.toContain("external-subject");
  expect(
    (await app.request(callback, { headers: { Cookie: cookie } })).status,
  ).toBe(401);
  expect(exchange).toHaveBeenCalledTimes(1);
});

it.each(["wrong state", "wrong tenant", "expired", "missing cookie"])(
  "refuses %s before token exchange",
  async (mode) => {
    const { adapter, tenant, beta, transactions, exchange } =
      await browserFixture();
    const start = await present(adapter.routes).request(
      `${tenant.origin}/login`,
    );
    const authorization = new URL(present(start.headers.get("Location")));
    const cookie = present(
      present(start.headers.get("Set-Cookie")).split(";")[0],
    );
    const state = present(authorization.searchParams.get("state"));
    if (mode === "expired") {
      const current = present(transactions.get(state));
      transactions.set(state, { ...current, expiresAt: Date.now() - 1 });
    }
    const app = new (await import("hono")).Hono().route(
      "/auth",
      present(adapter.routes),
    );
    const response = await app.request(
      `${mode === "wrong tenant" ? beta.origin : tenant.origin}/auth/callback?code=fixture-code&state=${mode === "wrong state" ? "other" : state}`,
      { headers: mode === "missing cookie" ? {} : { Cookie: cookie } },
    );
    expect(response.status).toBe(401);
    expect(exchange).not.toHaveBeenCalled();
  },
);
it("refuses an otherwise valid token for an unregistered member at callback", async () => {
  const { adapter, tenant, exchange, sessions } = await browserFixture();
  exchange.mockImplementation(async () =>
    Response.json({
      access_token: await token({ subject: "foreign" }),
      token_type: "Bearer",
      expires_in: 3600,
    }),
  );
  const start = await present(adapter.routes).request(`${tenant.origin}/login`);
  const state = present(
    new URL(present(start.headers.get("Location"))).searchParams.get("state"),
  );
  const app = new (await import("hono")).Hono().route(
    "/auth",
    present(adapter.routes),
  );
  const result = await app.request(
    `${tenant.origin}/auth/callback?code=fixture-code&state=${state}`,
    {
      headers: {
        Cookie: present(present(start.headers.get("Set-Cookie")).split(";")[0]),
      },
    },
  );
  expect(result.status).toBe(403);
  expect(sessions.size).toBe(0);
});
it("does not reuse a browser identity session across tenants or after expiry", async () => {
  const { adapter, tenant, beta, sessions } = await browserFixture();
  sessions.set("opaque-session", {
    tenantId: tenant.id,
    identity: { provider: issuer, subject: "external-subject" },
    expiresAt: Date.now() + 60000,
  });
  const request = new Request(beta.origin, {
    headers: { Cookie: "__Host-tenancy-auth0=opaque-session" },
  });
  await expect(adapter.authenticate(request, beta)).resolves.toEqual({
    kind: "refused",
    status: 401,
  });
  sessions.set("opaque-session", {
    tenantId: tenant.id,
    identity: { provider: issuer, subject: "external-subject" },
    expiresAt: Date.now() - 1,
  });
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, {
        headers: { Cookie: "__Host-tenancy-auth0=opaque-session" },
      }),
      tenant,
    ),
  ).resolves.toEqual({ kind: "refused", status: 401 });
});
it("propagates a JWKS infrastructure outage instead of advancing the auth chain", async () => {
  const registry = memoryRegistry();
  const tenant = await registry.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: { provider: issuer, subject: "external-subject" },
  });
  const outage = new Error("local transport unavailable");
  const adapter = auth0({
    domain: "identity.example.test",
    clientId: "application",
    audience,
    fetch: () => Promise.reject(outage),
  });
  await expect(
    adapter.authenticate(
      new Request(tenant.origin, {
        headers: { Authorization: `Bearer ${await token()}` },
      }),
      tenant,
    ),
  ).rejects.toBe(outage);
});

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Expected fixture value");
  return value;
}

it("refuses a callback after its registered host is reassigned to another tenant", async () => {
  const { adapter, tenant, registry, exchange, sessions } =
    await browserFixture();
  const start = await present(adapter.routes).request(`${tenant.origin}/login`);
  const state = present(
    new URL(present(start.headers.get("Location"))).searchParams.get("state"),
  );
  await registry.delete(tenant.id);
  await registry.create({
    handle: "replacement",
    origin: tenant.origin,
    domains: tenant.domains,
    owner: { provider: issuer, subject: "external-subject" },
  });
  const app = new (await import("hono")).Hono().route(
    "/auth",
    present(adapter.routes),
  );
  const result = await app.request(
    `${tenant.origin}/auth/callback?code=fixture-code&state=${state}`,
    {
      headers: {
        Cookie: present(present(start.headers.get("Set-Cookie")).split(";")[0]),
      },
    },
  );
  expect(result.status).toBe(401);
  expect(exchange).not.toHaveBeenCalled();
  expect(sessions.size).toBe(0);
});

it("reads current membership for a browser session instead of caching its role", async () => {
  const { adapter, tenant, sessions, registry, tenancy } =
    await browserFixture();
  sessions.set("opaque-session", {
    tenantId: tenant.id,
    identity: { provider: issuer, subject: "external-subject" },
    expiresAt: Date.now() + 60000,
  });
  const request = new Request(tenant.origin, {
    headers: { Cookie: "__Host-tenancy-auth0=opaque-session" },
  });
  await expect(tenancy.authenticate(request, tenant)).resolves.toMatchObject({
    kind: "admitted",
    principal: {
      actor: { kind: "member", memberId: tenant.owners[0] },
      role: "owner",
    },
  });
  vi.spyOn(registry, "membershipOf").mockResolvedValue(null);
  await expect(tenancy.authenticate(request, tenant)).resolves.toEqual({
    kind: "refused",
    status: 403,
  });
  await expect(adapter.authenticate(request, tenant)).resolves.toMatchObject({
    kind: "identity",
  });
});
