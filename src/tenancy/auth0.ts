import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import * as oauth from "oauth4webapi";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Hono } from "hono";
import { parse, serialize } from "hono/utils/cookie";
import type { TenantId } from "../tenant.js";
import type {
  AuthAdapter,
  Identity,
  ReadonlyTenantRegistry,
  ReadonlyTenancy,
} from "./contracts.js";

/** One short-lived, single-use browser authorization transaction. */
export type Auth0Transaction = Readonly<{
  /** Tenant selected at login by the host resolver. */
  tenantId: TenantId;
  /** Exact canonical callback URI supplied to the provider. */
  redirectUri: string;
  /** State bound to the browser transaction cookie. */
  state: string;
  /** Secret verifier held server-side until the one-use exchange. */
  codeVerifier: string;
  /** Absolute expiration time in milliseconds. */
  expiresAt: number;
}>;
/** Server-owned verified identity session; browsers receive only its random handle. */
export type Auth0Session = Readonly<{
  /** Tenant for which this identity was admitted at callback time. */
  tenantId: TenantId;
  /** Verified issuer/subject; live registry membership still applies per request. */
  identity: Identity;
  /** Absolute expiration, no later than the verified access token's expiry. */
  expiresAt: number;
}>;
/** Host ports for optional browser login; stored state must be shared across host instances. */
export type Auth0BrowserOptions = Readonly<{
  /** Full callback pathname, including the prefix used to mount routes. */
  callbackPath: string;
  /** Use the kit's resolver; never accept a tenant from callback query/body data. */
  resolveTenant: ReadonlyTenancy["resolve"];
  /** Current tenant and membership authority, checked before issuing a session. */
  registry: Pick<ReadonlyTenantRegistry, "get" | "membershipOf">;
  /** Host-owned transaction storage with atomic one-use consumption. */
  transactions: Readonly<{
    /** Store until expiresAt; reject duplicate handles. */
    put(id: string, transaction: Auth0Transaction): Promise<void>;
    /** Atomically remove and return the transaction, or null if missing/consumed. */
    take(id: string): Promise<Auth0Transaction | null>;
  }>;
  /** Host-owned session storage; expire and prune records at expiresAt. */
  sessions: Readonly<{
    /** Store a fresh opaque handle and verified identity until expiry. */
    put(id: string, session: Auth0Session): Promise<void>;
    /** Read a session by its opaque handle, or null after expiry/removal. */
    get(id: string): Promise<Auth0Session | null>;
  }>;
}>;
/** Auth0 issuer and audience configuration; browser login is opt-in. */
export type Auth0Options = Readonly<{
  /** Auth0 issuer hostname, including a configured custom hostname. */
  domain: string;
  /** Registered application's client identifier. */
  clientId: string;
  /** Identifier of the API for which access tokens are issued. */
  audience: string;
  /** Optional confidential-client secret; omit for a registered public PKCE client. */
  clientSecret?: string;
  /** Optional host-owned transport for issuer discovery, keys and token exchange. */
  fetch?: typeof globalThis.fetch;
  /** Browser routes and durable host-owned transaction/session storage. */
  browser?: Auth0BrowserOptions;
}>;

const subject = Schema.decodeUnknownOption(Schema.NonEmptyString);
const maxTokenLength = 16 * 1024;
const flowCookie = "__Host-tenancy-auth0-flow";
const sessionCookie = "__Host-tenancy-auth0";

function invalidCredential(cause: unknown): boolean {
  return (
    cause instanceof errors.JWTInvalid ||
    cause instanceof errors.JWTExpired ||
    cause instanceof errors.JWTClaimValidationFailed ||
    cause instanceof errors.JWSInvalid ||
    cause instanceof errors.JWSSignatureVerificationFailed ||
    cause instanceof errors.JOSEAlgNotAllowed ||
    cause instanceof errors.JWKSNoMatchingKey
  );
}
function invalidOAuth(cause: unknown): boolean {
  return (
    cause instanceof oauth.AuthorizationResponseError ||
    cause instanceof oauth.ResponseBodyError ||
    cause instanceof oauth.OperationProcessingError ||
    cause instanceof oauth.WWWAuthenticateChallengeError
  );
}
function cookie(
  name: typeof flowCookie | typeof sessionCookie,
  value: string,
  maxAge: number,
): string {
  return serialize(name, value, {
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
}

/** Verify Auth0 identities; the registry alone supplies canonical membership and role. */
export function auth0(options: Auth0Options): AuthAdapter {
  const issuer = new URL(`https://${options.domain}/`);
  if (
    issuer.host !== options.domain.toLowerCase() ||
    issuer.pathname !== "/" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    options.clientId.length === 0 ||
    options.audience.length === 0
  )
    throw new TypeError(
      "Configure an Auth0 hostname, client ID and API audience",
    );
  const transport =
    options.fetch === undefined ? {} : { [customFetch]: options.fetch };
  const oauthTransport =
    options.fetch === undefined
      ? {}
      : {
          [oauth.customFetch]: (
            url: string,
            init: oauth.CustomFetchOptions<
              "GET" | "POST",
              URLSearchParams | undefined
            >,
          ) => {
            const { body, ...rest } = init;
            return (options.fetch ?? globalThis.fetch)(
              url,
              body === undefined ? rest : { ...rest, body },
            );
          },
        };
  const jwks = createRemoteJWKSet(
    new URL(".well-known/jwks.json", issuer),
    transport,
  );
  const verify = async (token: string) => {
    if (token.length === 0 || token.length > maxTokenLength) return null;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: issuer.href,
        audience: options.audience,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat"],
      });
      const decoded = subject(payload.sub);
      if (Option.isNone(decoded) || payload.exp === undefined) return null;
      return {
        identity: { provider: issuer.href, subject: decoded.value },
        expiresAt: payload.exp * 1000,
      };
    } catch (cause) {
      if (invalidCredential(cause)) return null;
      throw cause;
    }
  };
  const browser = options.browser;
  const routes = new Hono();
  if (browser !== undefined) {
    const callback = new URL(browser.callbackPath, "https://callback.invalid");
    if (
      !browser.callbackPath.startsWith("/") ||
      callback.origin !== "https://callback.invalid" ||
      callback.pathname !== browser.callbackPath ||
      callback.search ||
      callback.hash
    )
      throw new TypeError("Configure a canonical absolute callback pathname");
    const client: oauth.Client = { client_id: options.clientId };
    const clientAuth =
      options.clientSecret === undefined
        ? oauth.None()
        : oauth.ClientSecretPost(options.clientSecret);
    const discover = () =>
      oauth
        .discoveryRequest(issuer, oauthTransport)
        .then((response) => oauth.processDiscoveryResponse(issuer, response));
    routes.get("/login", async (context) => {
      const tenant = await browser.resolveTenant(context.req.raw);
      if (tenant === null) return context.json({ error: "not_found" }, 404);
      if (tenant.status !== "active")
        return context.json({ error: "forbidden" }, 403);
      const server = await discover();
      if (server.authorization_endpoint === undefined)
        throw new Error("Auth0 issuer has no authorization endpoint");
      const state = oauth.generateRandomState();
      const codeVerifier = oauth.generateRandomCodeVerifier();
      const redirectUri = new URL(browser.callbackPath, tenant.origin).href;
      const authorization = new URL(server.authorization_endpoint);
      authorization.searchParams.set("client_id", client.client_id);
      authorization.searchParams.set("redirect_uri", redirectUri);
      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("scope", "openid");
      authorization.searchParams.set("audience", options.audience);
      authorization.searchParams.set("state", state);
      authorization.searchParams.set("code_challenge_method", "S256");
      authorization.searchParams.set(
        "code_challenge",
        await oauth.calculatePKCECodeChallenge(codeVerifier),
      );
      await browser.transactions.put(state, {
        tenantId: tenant.id,
        state,
        codeVerifier,
        redirectUri,
        expiresAt: Date.now() + 300_000,
      });
      context.header("Set-Cookie", cookie(flowCookie, state, 300));
      context.header("Cache-Control", "no-store");
      return context.redirect(authorization.href, 302);
    });
    routes.get("/callback", async (context) => {
      context.header("Cache-Control", "no-store");
      context.header("Set-Cookie", cookie(flowCookie, "", 0));
      const flow = parse(context.req.header("Cookie") ?? "")[flowCookie];
      if (flow === undefined || flow.length > 128)
        return context.json({ error: "unauthorized" }, 401);
      const transaction = await browser.transactions.take(flow);
      const tenant = await browser.resolveTenant(context.req.raw);
      const actual = new URL(context.req.url);
      if (
        transaction === null ||
        transaction.expiresAt <= Date.now() ||
        tenant?.id !== transaction.tenantId ||
        tenant.status !== "active" ||
        `${actual.origin}${actual.pathname}` !== transaction.redirectUri
      )
        return context.json({ error: "unauthorized" }, 401);
      try {
        const server = await discover();
        const params = oauth.validateAuthResponse(
          server,
          client,
          actual,
          transaction.state,
        );
        const response = await oauth.authorizationCodeGrantRequest(
          server,
          client,
          clientAuth,
          params,
          transaction.redirectUri,
          transaction.codeVerifier,
          oauthTransport,
        );
        const result = await oauth.processAuthorizationCodeResponse(
          server,
          client,
          response,
        );
        const verified = await verify(result.access_token);
        if (verified === null)
          return context.json({ error: "unauthorized" }, 401);
        const current = await browser.registry.get(tenant.id);
        if (
          current?.status !== "active" ||
          (await browser.registry.membershipOf(
            tenant.id,
            verified.identity,
          )) === null
        )
          return context.json({ error: "forbidden" }, 403);
        const id = oauth.generateRandomState();
        const expiresAt = Math.min(verified.expiresAt, Date.now() + 3_600_000);
        await browser.sessions.put(id, {
          tenantId: tenant.id,
          identity: verified.identity,
          expiresAt,
        });
        context.header(
          "Set-Cookie",
          cookie(
            sessionCookie,
            id,
            Math.floor((expiresAt - Date.now()) / 1000),
          ),
          { append: true },
        );
        return context.redirect(tenant.origin, 303);
      } catch (cause) {
        if (invalidOAuth(cause))
          return context.json({ error: "unauthorized" }, 401);
        throw cause;
      }
    });
  }
  const adapter: AuthAdapter = {
    id: "auth0",
    async authenticate(request, tenant) {
      const authorization = request.headers.get("Authorization");
      if (authorization?.startsWith("Bearer ") === true) {
        const verified = await verify(authorization.slice(7));
        return verified === null
          ? { kind: "refused", status: 401 }
          : { kind: "identity", identity: verified.identity };
      }
      if (browser !== undefined) {
        const id = parse(request.headers.get("Cookie") ?? "")[sessionCookie];
        if (id !== undefined) {
          const session =
            id.length > 128 ? null : await browser.sessions.get(id);
          if (
            session?.tenantId !== tenant.id ||
            session.expiresAt <= Date.now()
          )
            return { kind: "refused", status: 401 };
          return { kind: "identity", identity: session.identity };
        }
      }
      return { kind: "pass" };
    },
  };
  return browser === undefined ? adapter : { ...adapter, routes };
}
