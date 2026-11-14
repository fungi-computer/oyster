import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parse } from "hono/utils/cookie";
import { ownerKeyCookieName } from "../auth.js";
import type { AuthAdapter, Identity } from "./contracts.js";

/** Cloudflare Access settings for one Access application; the adapter is opt-in. */
export type CloudflareAccessOptions = Readonly<{
  /** The Zero Trust team domain, for example `team.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's Application Audience (AUD) tag. */
  audience: string;
  /** Optional host-owned transport for the team's signing keys. */
  fetch?: typeof globalThis.fetch;
}>;

/** The request header Cloudflare Access adds after it admits a request. */
export const cloudflareAccessAssertionHeader = "Cf-Access-Jwt-Assertion";

const nonEmpty = Schema.decodeUnknownOption(Schema.NonEmptyString);
const maxTokenLength = 16 * 1024;
const teamSuffix = ".cloudflareaccess.com";

function invalidCredential(cause: unknown): boolean {
  return (
    cause instanceof errors.JWTInvalid ||
    cause instanceof errors.JWTExpired ||
    cause instanceof errors.JWTClaimValidationFailed ||
    cause instanceof errors.JWSInvalid ||
    cause instanceof errors.JWSSignatureVerificationFailed ||
    cause instanceof errors.JOSEAlgNotAllowed ||
    cause instanceof errors.JOSENotSupported ||
    cause instanceof errors.JWKSMultipleMatchingKeys ||
    cause instanceof errors.JWKSNoMatchingKey
  );
}

/**
 * The exact `iss` Access signs, which is also the identity provider namespace.
 * Access omits the trailing slash; the match is exact.
 */
export function cloudflareAccessIssuer(teamDomain: string): string {
  const host = teamDomain.toLowerCase();
  const origin = new URL(`https://${host}`);
  if (
    origin.host !== host ||
    !host.endsWith(teamSuffix) ||
    host.length === teamSuffix.length ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new TypeError(
      "Configure a Cloudflare Access team domain (<team>.cloudflareaccess.com)",
    );
  return `https://${host}`;
}

/**
 * Verify a Cloudflare Access application token and return its issuer-scoped
 * identity. The registry alone maps that identity to a member: an Access user
 * with no explicit binding is refused by the kit, and nothing is created here.
 *
 * Precedence: any `Authorization` header or Oyster owner-key cookie is an
 * explicit Oyster credential, so this adapter passes and the key adapters
 * decide. Register it after the key adapters and before any terminal adapter.
 * Only the `Cf-Access-Jwt-Assertion` header is read, as Cloudflare recommends.
 */
export function cloudflareAccess(
  options: CloudflareAccessOptions,
): AuthAdapter {
  const issuer = cloudflareAccessIssuer(options.teamDomain);
  if (options.audience.length === 0)
    throw new TypeError("Configure the Cloudflare Access application AUD tag");
  const origin = new URL(issuer);
  const jwks = createRemoteJWKSet(
    new URL("/cdn-cgi/access/certs", origin),
    options.fetch === undefined ? {} : { [customFetch]: options.fetch },
  );
  return {
    id: "cloudflare-access",
    async authenticate(request) {
      // An explicit Oyster credential selects the key path, valid or not.
      if (
        request.headers.has("Authorization") ||
        Object.hasOwn(
          parse(request.headers.get("Cookie") ?? ""),
          ownerKeyCookieName,
        )
      )
        return { kind: "pass" };
      const token = request.headers.get(cloudflareAccessAssertionHeader);
      if (token === null) return { kind: "pass" };
      if (token.length === 0 || token.length > maxTokenLength)
        return { kind: "refused", status: 401 };
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: options.audience,
          algorithms: ["RS256"],
          requiredClaims: ["exp", "iat"],
        }));
      } catch (cause) {
        if (invalidCredential(cause)) return { kind: "refused", status: 401 };
        throw cause;
      }
      if (payload.type !== "app") return { kind: "refused", status: 401 };
      // A service token is not a human: it carries a client ID and an empty
      // subject. It is not this adapter's credential, so the key path decides.
      if (Option.isSome(nonEmpty(payload.common_name))) return { kind: "pass" };
      const subject = nonEmpty(payload.sub);
      if (Option.isNone(subject)) return { kind: "refused", status: 401 };
      // Email is display metadata only; the registry never looks it up.
      const email = nonEmpty(payload.email);
      const identity: Identity = Option.isSome(email)
        ? { provider: issuer, subject: subject.value, email: email.value }
        : { provider: issuer, subject: subject.value };
      return { kind: "identity", identity };
    },
  };
}
