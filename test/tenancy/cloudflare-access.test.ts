import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cloudflareAccess,
  cloudflareAccessIssuer,
} from "../../src/tenancy/cloudflare-access.js";
import {
  createTenancy,
  type AuthAdapter,
  type Tenant,
} from "../../src/tenancy/index.js";
import { ownerKey } from "../../src/tenancy/owner-key.js";
import { memoryRegistry } from "../../src/tenancy/registry.js";
import { hosts } from "../../src/tenancy/resolve.js";
import { tenantIdSchema } from "../../src/tenant.js";
import * as Schema from "effect/Schema";

const teamDomain = "team.cloudflareaccess.com";
const issuer = `https://${teamDomain}`;
const audience = "a".repeat(64);
const ownerSecret = "tenant-owner-secret-at-least-24-characters";
const ownerMember = "member-owner";
const tenantId = Schema.decodeUnknownSync(tenantIdSchema)("alpha");
type Pair = Awaited<ReturnType<typeof generateKeyPair>>;
let current: Pair;
let rotated: Pair;
let stranger: Pair;

async function publicJwk(pair: Pair, kid: string) {
  return { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256" };
}
beforeAll(async () => {
  [current, rotated, stranger] = await Promise.all([
    generateKeyPair("RS256"),
    generateKeyPair("RS256"),
    generateKeyPair("RS256"),
  ]);
});
afterEach(() => {
  vi.useRealTimers();
});

async function assertion(
  claims: JWTPayload = {},
  options: {
    key?: Pair | "stranger";
    kid?: string;
    issuer?: string;
    audience?: string | string[];
    expiration?: string | number;
  } = {},
) {
  return new SignJWT({ type: "app", email: "person@example.test", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "current" })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? [audience])
    .setSubject(claims.sub ?? "access-user-1")
    .setIssuedAt()
    .setExpirationTime(options.expiration ?? "1h")
    .sign(
      (options.key === "stranger" ? stranger : (options.key ?? current))
        .privateKey,
    );
}

async function fixture(keys?: () => Promise<JSONWebKeySet>) {
  const currentSet: JSONWebKeySet = {
    keys: [await publicJwk(current, "current")],
  };
  const fetchKeys = vi.fn<typeof fetch>(async (input) => {
    expect(new Request(input).url).toBe(`${issuer}/cdn-cgi/access/certs`);
    return Response.json(await (keys?.() ?? currentSet));
  });
  const access = cloudflareAccess({
    teamDomain,
    audience,
    fetch: fetchKeys,
  });
  const registry = memoryRegistry({
    tenants: [
      {
        id: tenantId,
        handle: tenantId,
        origin: "https://alpha.example.test",
        domains: ["alpha.example.test"],
        owners: [ownerMember],
        status: "active",
      },
    ],
    memberships: [
      {
        tenantId,
        identity: { provider: "standalone-owner", subject: "owner" },
        memberId: ownerMember,
        role: "owner",
      },
      // The explicit binding of an Access subject to the existing owner.
      {
        tenantId,
        identity: { provider: issuer, subject: "access-user-1" },
        memberId: ownerMember,
        role: "owner",
      },
    ],
  });
  const tenant = await registry.get(tenantId);
  if (tenant === null) throw new Error("fixture tenant missing");
  const owner = ownerKey({
    registry,
    keys: {
      get: () => Promise.resolve({ key: ownerSecret, memberId: ownerMember }),
    },
  });
  // The standalone chain ends in a terminal entry that refuses what remains.
  const terminal: AuthAdapter = {
    id: "terminal",
    authenticate: () => Promise.resolve({ kind: "refused", status: 401 }),
  };
  const tenancy = createTenancy({
    registry,
    resolve: hosts(registry),
    auth: [owner, access, terminal],
  });
  const request = (headers: Record<string, string>) =>
    new Request(tenant.origin, { headers });
  return { access, tenancy, tenant, request, fetchKeys, registry };
}

const admittedOwner = (tenant: Tenant) => ({
  kind: "admitted",
  tenant,
  principal: {
    actor: { kind: "member", memberId: ownerMember },
    role: "owner",
  },
});

describe("Cloudflare Access admission", () => {
  it("admits a valid assertion for the bound owner, scoped to the issuer", async () => {
    const { access, tenancy, tenant, request, fetchKeys } = await fixture();
    const headers = { "Cf-Access-Jwt-Assertion": await assertion() };
    await expect(
      access.authenticate(request(headers), tenant),
    ).resolves.toEqual({
      kind: "identity",
      identity: {
        provider: issuer,
        subject: "access-user-1",
        email: "person@example.test",
      },
    });
    await expect(
      tenancy.authenticate(request(headers), tenant),
    ).resolves.toEqual(admittedOwner(tenant));
    // The signing keys are cached across requests.
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it("does not use email as identity", async () => {
    const { tenancy, tenant, request, registry } = await fixture();
    const headers = {
      "Cf-Access-Jwt-Assertion": await assertion({
        sub: "someone-else",
        email: "owner@example.test",
      }),
    };
    await expect(
      tenancy.authenticate(request(headers), tenant),
    ).resolves.toEqual({ kind: "refused", status: 403 });
    await expect(
      registry.membershipOf(tenant.id, {
        provider: issuer,
        subject: "someone-else",
      }),
    ).resolves.toBeNull();
  });

  it.each([
    ["issuer", { issuer: "https://other.cloudflareaccess.com" }, {}],
    ["issuer with a trailing slash", { issuer: `${issuer}/` }, {}],
    ["audience", { audience: ["b".repeat(64)] }, {}],
    ["expiry", { expiration: Math.floor(Date.now() / 1000) - 60 }, {}],
    ["signature", { key: "stranger" as const }, {}],
    ["type", {}, { type: "org" }],
    ["subject", {}, { sub: "" }],
  ])("refuses an assertion with the wrong %s", async (_, options, claims) => {
    const { access, tenancy, tenant, request } = await fixture();
    const headers = {
      "Cf-Access-Jwt-Assertion": await assertion(claims, options),
    };
    await expect(
      access.authenticate(request(headers), tenant),
    ).resolves.toEqual({ kind: "refused", status: 401 });
    await expect(
      tenancy.authenticate(request(headers), tenant),
    ).resolves.toEqual({ kind: "refused", status: 401 });
  });

  it("refuses a token with an unsupported critical header instead of failing", async () => {
    const { access, tenant, request } = await fixture();
    // The signer refuses an unknown crit, so graft the header onto a real token.
    const [, body = "", signature = ""] = (await assertion()).split(".");
    const header = btoa(
      JSON.stringify({
        alg: "RS256",
        kid: "current",
        crit: ["x-unknown"],
        "x-unknown": true,
      }),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const token = `${header}.${body}.${signature}`;
    await expect(
      access.authenticate(
        request({ "Cf-Access-Jwt-Assertion": token }),
        tenant,
      ),
    ).resolves.toEqual({ kind: "refused", status: 401 });
  });

  it("accepts an audience array holding the tag among others", async () => {
    const { access, tenant, request } = await fixture();
    const headers = {
      "Cf-Access-Jwt-Assertion": await assertion(
        {},
        { audience: ["c".repeat(64), audience] },
      ),
    };
    await expect(
      access.authenticate(request(headers), tenant),
    ).resolves.toMatchObject({ kind: "identity" });
  });

  it("refuses a not-yet-valid assertion", async () => {
    const { access, tenant, request } = await fixture();
    const token = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "current" })
      .setIssuer(issuer)
      .setAudience([audience])
      .setSubject("access-user-1")
      .setIssuedAt()
      .setNotBefore(Math.floor(Date.now() / 1000) + 600)
      .setExpirationTime("1h")
      .sign(current.privateKey);
    await expect(
      access.authenticate(
        request({ "Cf-Access-Jwt-Assertion": token }),
        tenant,
      ),
    ).resolves.toEqual({ kind: "refused", status: 401 });
  });

  it("refuses garbage and an alg-none token without verifying anything else", async () => {
    const { access, tenant, request } = await fixture();
    const none = `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ iss: issuer, aud: audience, sub: "access-user-1", type: "app", exp: 9999999999 }))}.`;
    for (const value of ["not-a-jwt", none])
      await expect(
        access.authenticate(
          request({ "Cf-Access-Jwt-Assertion": value }),
          tenant,
        ),
      ).resolves.toEqual({ kind: "refused", status: 401 });
  });

  it("refuses a valid assertion for a subject with no binding, creating no member", async () => {
    const { tenancy, tenant, request, registry } = await fixture();
    const headers = {
      "Cf-Access-Jwt-Assertion": await assertion({ sub: "unbound-user" }),
    };
    await expect(
      tenancy.authenticate(request(headers), tenant),
    ).resolves.toEqual({ kind: "refused", status: 403 });
    await expect(
      registry.membershipOf(tenant.id, {
        provider: issuer,
        subject: "unbound-user",
      }),
    ).resolves.toBeNull();
  });

  it("never turns a service token into a human member", async () => {
    const { access, tenancy, tenant, request } = await fixture();
    // Access signs service tokens with a client ID and an empty subject.
    const service = await assertion({
      sub: "",
      common_name: "client-id.access",
    });
    const headers = { "Cf-Access-Jwt-Assertion": service };
    await expect(
      access.authenticate(request(headers), tenant),
    ).resolves.toEqual({ kind: "pass" });
    await expect(
      tenancy.authenticate(request(headers), tenant),
    ).resolves.toEqual({ kind: "refused", status: 401 });
    // Even naming a bound human subject, a client ID marks it as a service.
    const spoofed = await assertion({
      sub: "access-user-1",
      common_name: "client-id.access",
    });
    await expect(
      tenancy.authenticate(
        request({ "Cf-Access-Jwt-Assertion": spoofed }),
        tenant,
      ),
    ).resolves.toEqual({ kind: "refused", status: 401 });
  });

  it("passes when an explicit valid owner key is present, even beside an invalid assertion", async () => {
    const { access, tenancy, tenant, request, fetchKeys } = await fixture();
    const headers = {
      Authorization: `Bearer ${ownerSecret}`,
      "Cf-Access-Jwt-Assertion": "not-a-jwt",
    };
    await expect(
      access.authenticate(request(headers), tenant),
    ).resolves.toEqual({ kind: "pass" });
    await expect(
      tenancy.authenticate(request(headers), tenant),
    ).resolves.toEqual(admittedOwner(tenant));
    expect(fetchKeys).not.toHaveBeenCalled();
  });

  it("leaves an invalid explicit key to the key path, never admitting by Access", async () => {
    const { access, tenancy, tenant, request } = await fixture();
    const valid = await assertion();
    const credentials: Record<string, string>[] = [
      { Authorization: "Bearer wrong-key-wrong-key-wrong-key" },
      { Authorization: `Basic ${btoa("oyster:wrong-key")}` },
      { Authorization: "Bearer" },
      { Cookie: "oyster_session=wrong" },
    ];
    for (const credential of credentials) {
      const headers = { ...credential, "Cf-Access-Jwt-Assertion": valid };
      await expect(
        access.authenticate(request(headers), tenant),
      ).resolves.toEqual({ kind: "pass" });
      await expect(
        tenancy.authenticate(request(headers), tenant),
      ).resolves.toEqual({ kind: "refused", status: 401 });
    }
  });

  it("passes with no assertion, without fetching keys", async () => {
    const { access, tenant, request, fetchKeys } = await fixture();
    await expect(access.authenticate(request({}), tenant)).resolves.toEqual({
      kind: "pass",
    });
    expect(fetchKeys).not.toHaveBeenCalled();
  });

  it("ignores the CF_Authorization cookie; only the header is read", async () => {
    const { access, tenant, request } = await fixture();
    await expect(
      access.authenticate(
        request({ Cookie: `CF_Authorization=${await assertion()}` }),
        tenant,
      ),
    ).resolves.toEqual({ kind: "pass" });
  });

  it("refetches the signing keys when a key ID is missing (rotation)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let published: JSONWebKeySet = {
      keys: [await publicJwk(current, "current")],
    };
    const { access, tenant, request, fetchKeys } = await fixture(() =>
      Promise.resolve(published),
    );
    const before = { "Cf-Access-Jwt-Assertion": await assertion() };
    await expect(
      access.authenticate(request(before), tenant),
    ).resolves.toMatchObject({ kind: "identity" });
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    // Cloudflare rotates: the new key signs, the previous stays published.
    published = {
      keys: [
        await publicJwk(rotated, "rotated"),
        await publicJwk(current, "current"),
      ],
    };
    const after = {
      "Cf-Access-Jwt-Assertion": await assertion(
        {},
        { key: rotated, kid: "rotated" },
      ),
    };
    // Inside the library's refetch cooldown an unknown kid is refused.
    await expect(access.authenticate(request(after), tenant)).resolves.toEqual({
      kind: "refused",
      status: 401,
    });
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 60_000);
    await expect(
      access.authenticate(request(after), tenant),
    ).resolves.toMatchObject({ kind: "identity" });
    expect(fetchKeys).toHaveBeenCalledTimes(2);
    // The previous key still verifies from the refreshed set.
    await expect(
      access.authenticate(request(before), tenant),
    ).resolves.toMatchObject({ kind: "identity" });
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it("rejects a key ID the refreshed set still does not publish", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { access, tenant, request, fetchKeys } = await fixture();
    await access.authenticate(
      request({ "Cf-Access-Jwt-Assertion": await assertion() }),
      tenant,
    );
    vi.setSystemTime(Date.now() + 60_000);
    await expect(
      access.authenticate(
        request({
          "Cf-Access-Jwt-Assertion": await assertion(
            {},
            { key: stranger, kid: "unknown" },
          ),
        }),
        tenant,
      ),
    ).resolves.toEqual({ kind: "refused", status: 401 });
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });
});

describe("Cloudflare Access configuration", () => {
  it.each([
    "",
    "cloudflareaccess.com",
    "team.example.com",
    "team.cloudflareaccess.com/path",
    "team.cloudflareaccess.com:8443",
    "user@team.cloudflareaccess.com",
    "https://team.cloudflareaccess.com",
  ])("rejects the team domain %j", (domain) => {
    expect(() => cloudflareAccessIssuer(domain)).toThrow(TypeError);
  });

  it("names the exact issuer and requires an AUD tag", () => {
    expect(cloudflareAccessIssuer("Team.CloudflareAccess.com")).toBe(issuer);
    expect(() => cloudflareAccess({ teamDomain, audience: "" })).toThrow(
      TypeError,
    );
  });
});
