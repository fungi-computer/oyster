import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parse } from "hono/utils/cookie";
import type { OysterAuth, OysterAuthResult } from "./host.js";
import { presentedGitKey } from "./git-auth.js";
import { sha256 } from "./release.js";
import { sameOriginRequest } from "./request-origin.js";
import { isLoopbackHttp } from "./tenancy/registry-record.js";
import type { OysterKeyStore } from "./keys.js";
import {
  ownerSessionLifetimeMs,
  type OwnerSessions,
} from "./owner-sessions.js";

export {
  ownerSessionLifetimeMs,
  ownerSessionStore,
  type OwnerSessions,
  type OwnerSessionSql,
} from "./owner-sessions.js";

/** Cookie emitted by ownerKeyAuth, for composing credential-specific adapters. */
export const ownerKeyCookieName = "oyster_session";
/** Marks a browser that has signed in here before; it carries no authority. */
export const returningCookieName = "oyster_returning";
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
 * Whether `request` carries the owner key itself, as a Bearer token or a Git
 * Basic-auth password. `absent` means it carries neither.
 */
export async function ownerKeyCredential(
  ownerKey: string,
  request: Request,
): Promise<"owner" | "refused" | "absent"> {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ") === true)
    return (await constantTimeEqual(authorization.slice(7), ownerKey))
      ? "owner"
      : "refused";
  if (authorization?.startsWith("Basic ") === true) {
    const presented = presentedGitKey(request);
    return presented.kind === "key" &&
      (await constantTimeEqual(presented.value, ownerKey))
      ? "owner"
      : "refused";
  }
  return "absent";
}

/** The session id a browser presents, or null without one. */
function presentedSession(request: Request): string | null {
  const value = parse(request.headers.get("Cookie") ?? "", ownerKeyCookieName)[
    ownerKeyCookieName
  ];
  return value === undefined || value === "" ? null : value;
}

/**
 * What the server stores for a session id: an HMAC of it keyed by the owner
 * key, never the id itself. Rotating the owner key ends every session.
 */
async function sessionDigest(ownerKey: string, id: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(ownerKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(id)),
  );
  return `hmac-sha256:${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A new random session id: 32 bytes, base64url. */
function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/** Secure everywhere except loopback HTTP, where Safari would drop it and the traffic never leaves this machine. */
const cookieFlags = (request: Request) =>
  `Path=/; HttpOnly;${isLoopbackHttp(new URL(request.url)) ? "" : " Secure;"} SameSite=Strict`;

/**
 * Single-owner sign-in: a bearer token, a Git Basic-auth password, or a
 * browser session. A session is a random id in the cookie; `sessions` keeps
 * its digest, owner and expiry, and logging out revokes it.
 */
export function ownerKeyAuth(
  ownerKey: string,
  ownerId: string,
  sessions: OwnerSessions,
): OysterAuth {
  if (ownerKey.length < 24)
    throw new Error("OYSTER_OWNER_KEY must be at least 24 characters");
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
      const credential = await ownerKeyCredential(ownerKey, request);
      if (credential !== "absent")
        return credential === "owner"
          ? owner
          : { kind: "refused", status: 401 };
      const session = presentedSession(request);
      if (
        session !== null &&
        (await sessions.owner(
          await sessionDigest(ownerKey, session),
          Date.now(),
        )) === ownerId
      )
        return owner;
      return { kind: "refused", status: 401 };
    },
    async login(request) {
      // A body that is not a form is a malformed sign-in, not a server fault.
      const fields = await request.formData().catch((cause: unknown) => {
        if (cause instanceof TypeError) return null;
        throw cause;
      });
      if (fields === null)
        return new Response("Expected a sign-in form", { status: 400 });
      const form = Schema.decodeUnknownOption(loginFormSchema)({
        key: fields.get("key"),
      });
      if (
        Option.isNone(form) ||
        !(await constantTimeEqual(form.value.key, ownerKey))
      )
        return new Response("Wrong key", { status: 401 });
      const session = newSessionId();
      await sessions.open(
        ownerId,
        await sessionDigest(ownerKey, session),
        Date.now(),
      );
      const flags = cookieFlags(request);
      const headers = new Headers({ Location: "/" });
      headers.append(
        "Set-Cookie",
        `${ownerKeyCookieName}=${session}; ${flags}; Max-Age=${String(ownerSessionLifetimeMs / 1000)}`,
      );
      headers.append(
        "Set-Cookie",
        `${returningCookieName}=1; ${flags}; Max-Age=31536000`,
      );
      return new Response(null, { status: 303, headers });
    },
    async logout(request) {
      // A cross-site form must not be able to sign the owner out.
      if (!sameOriginRequest(request))
        return new Response("Same origin required", {
          status: 403,
          headers: { "Cache-Control": "no-store" },
        });
      const session = presentedSession(request);
      if (session !== null)
        await sessions.revoke(await sessionDigest(ownerKey, session));
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/login",
          "Set-Cookie": `${ownerKeyCookieName}=; ${cookieFlags(request)}; Max-Age=0`,
          "Cache-Control": "no-store",
        },
      });
    },
  };
}

/** How stale a key's last-used time may be: calls inside this window do not re-stamp it. */
export const lastUsedGranularityMs = 5 * 60 * 1000;

/** The owner key, or a named key admitted as its canonical Team-key actor. */
export function ownerOrKeyAuth(
  ownerKey: string,
  ownerId: string,
  sessions: OwnerSessions,
  keys: () => Pick<OysterKeyStore, "verify" | "touch">,
): OysterAuth {
  const owner = ownerKeyAuth(ownerKey, ownerId, sessions);
  // When this isolate last tried to stamp each key. A key's "Last used" is
  // accurate to `lastUsedGranularityMs`, so a burst of calls costs one write.
  const lastStamp = new Map<string, number>();
  const stampLastUsed = async (keyId: string): Promise<void> => {
    const now = Date.now();
    const last = lastStamp.get(keyId);
    if (last !== undefined && now - last < lastUsedGranularityMs) return;
    lastStamp.set(keyId, now);
    // The call is already admitted: a failed stamp is reported, never fatal.
    try {
      const touched = await keys().touch(keyId);
      if (touched.kind !== "ok")
        console.error("Oyster key last-used stamp refused", {
          keyId,
          code: touched.error.code,
        });
    } catch (error) {
      console.error("Oyster key last-used stamp failed", keyId, error);
    }
  };
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
      if (verified.kind !== "ok" || verified.value.owner !== ownerId)
        return result;
      // The one place a named key is admitted for every door (Git, MCP, HTTP):
      // stamp its Ear Tag last-used time here, so no caller can miss it.
      await stampLastUsed(verified.value.keyId);
      return {
        kind: "admitted",
        principal: {
          actor: { kind: "team-key", keyId: verified.value.keyId },
        },
      };
    },
    login: (request) =>
      owner.login?.(request) ??
      Promise.resolve(
        new Response("Sign-in is not available", { status: 404 }),
      ),
    logout: (request) =>
      owner.logout?.(request) ??
      Promise.resolve(
        new Response("Sign-out is not available", { status: 404 }),
      ),
  };
}
