import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parse } from "hono/utils/cookie";
import type { OysterAuth, OysterAuthResult, OysterHost } from "./host.js";
import { presentedGitKey } from "./git-auth.js";
import { sha256 } from "./release.js";
import type { OysterKeyStore } from "./keys.js";
import { sameOriginRequest } from "./request-origin.js";

/** Cookie emitted by ownerKeyAuth, for composing credential-specific adapters. */
export const ownerKeyCookieName = "oyster_session";
/** Host-minted opaque sessions for named keys, separate from the owner cookie. */
export const keySessionCookieName = "oyster_key_session";

/**
 * The host owns session minting, hashing/storage and expiry.
 * A session resolves only to a key id, never to owner or grant authority.
 * Hosts should use Path=/, HttpOnly, Secure and SameSite=Lax (or stricter)
 * as defense in depth; Oyster independently checks request provenance.
 * Cookie-only admission allows GET/HEAD navigation. Every other method requires
 * Origin to be present and equal the request URL's origin, and Sec-Fetch-Site
 * not to be cross-site. Missing Origin is refused.
 */
export type OysterKeySessionResolver = Readonly<{
  /** Resolve an opaque host session to its named key, or null when unavailable. */
  resolve: (value: string) => Promise<Readonly<{ keyId: string }> | null>;
}>;
const loginFormSchema = Schema.Struct({ key: Schema.String });

/** Compare two secrets through their fixed-length digests, in constant time. */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    sha256(new TextEncoder().encode(a)),
    sha256(new TextEncoder().encode(b)),
  ]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/**
 * Single-owner sign-in: a bearer token or a session cookie holding the
 * owner key's digest. The key itself is never stored in the browser.
 */
export function ownerKeyAuth(ownerKey: string, ownerId = "owner"): OysterAuth {
  if (ownerKey.length < 24)
    throw new Error("OYSTER_OWNER_KEY must be at least 24 characters");
  const sessionValue = sha256(new TextEncoder().encode(`oyster:${ownerKey}`));
  const owner: Extract<OysterAuthResult, { kind: "admitted" }> = {
    kind: "admitted",
    principal: { actor: { kind: "member", memberId: ownerId }, role: "owner" },
  };
  return {
    resolve: (actor) =>
      Promise.resolve(
        actor.kind === "member" && actor.memberId === ownerId
          ? owner.principal
          : null,
      ),
    async authenticate(request) {
      const authorization = request.headers.get("Authorization");
      if (authorization?.startsWith("Bearer ") === true)
        return (await constantTimeEqual(authorization.slice(7), ownerKey))
          ? owner
          : { kind: "refused", status: 401 };
      const cookie = (request.headers.get("Cookie") ?? "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${ownerKeyCookieName}=`));
      if (
        cookie !== undefined &&
        (await constantTimeEqual(
          cookie.slice(ownerKeyCookieName.length + 1),
          await sessionValue,
        ))
      )
        return owner;
      return { kind: "refused", status: 401 };
    },
    async login(request) {
      const form = Schema.decodeUnknownOption(loginFormSchema)(
        Object.fromEntries(await request.formData()),
      );
      if (
        Option.isNone(form) ||
        !(await constantTimeEqual(form.value.key, ownerKey))
      )
        return new Response("Wrong key", { status: 401 });
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `${ownerKeyCookieName}=${await sessionValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
        },
      });
    },
  };
}

/** The owner key, or a named key admitted as its canonical Team-key actor. */
export function ownerOrKeyAuth(
  ownerKey: string,
  ownerId: string,
  keys: () => Pick<OysterKeyStore, "verify">,
): OysterAuth {
  const owner = ownerKeyAuth(ownerKey, ownerId);
  return {
    resolve: (actor) => owner.resolve(actor),
    async authenticate(request) {
      const result = await owner.authenticate(request);
      if (result.kind === "admitted") return result;
      const presented = presentedGitKey(request);
      if (presented.kind !== "key") return result;
      const verified = await keys().verify(presented.value);
      // A revoked or expired key, or one belonging to a different owner (a
      // presented secret can never prove that on its own), authenticates as
      // no one; the owner-key result above still stands.
      return verified.kind === "ok" && verified.value.owner === ownerId
        ? {
            kind: "admitted",
            principal: {
              actor: { kind: "team-key", keyId: verified.value.keyId },
            },
          }
        : result;
    },
    login: (request) =>
      owner.login?.(request) ??
      Promise.resolve(
        new Response("Sign-in is not available", { status: 404 }),
      ),
  };
}

/**
 * Add host-owned browser sessions to ownerOrKeyAuth. Explicit credentials and
 * non-401 refusals keep their ordinary result; ambient cookies cannot undo them.
 * Every cookie admission rechecks the key's liveness and canonical owner.
 */
export function keySessionAuth(
  auth: OysterAuth,
  ownerId: string,
  keys: () => NonNullable<OysterHost["keys"]>,
  sessions: OysterKeySessionResolver,
): OysterAuth {
  return {
    ...auth,
    async authenticate(request) {
      const result = await auth.authenticate(request);
      if (
        result.kind === "admitted" ||
        result.status !== 401 ||
        request.headers.has("Authorization")
      )
        return result;
      if (
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        !sameOriginRequest(request)
      )
        return result;
      const value = parse(
        request.headers.get("Cookie") ?? "",
        keySessionCookieName,
      )[keySessionCookieName];
      if (value === undefined || value.length === 0) return result;
      const session = await sessions.resolve(value);
      if (session === null) return result;
      const key = await keys().live(session.keyId);
      return key !== null && key.owner === ownerId
        ? {
            kind: "admitted",
            principal: { actor: { kind: "team-key", keyId: key.keyId } },
          }
        : result;
    },
  };
}
