import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { OysterAuth, OysterAuthResult } from "./host.js";
import { presentedGitKey } from "./git-auth.js";
import { sha256 } from "./release.js";
import type { OysterKeyStore } from "./keys.js";

/** Cookie emitted by ownerKeyAuth, for composing credential-specific adapters. */
export const ownerKeyCookieName = "oyster_session";
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
      // A body that is not a form is a malformed sign-in, not a server fault.
      const fields = await request.formData().catch((cause: unknown) => {
        if (cause instanceof TypeError) return null;
        throw cause;
      });
      if (fields === null)
        return new Response("Expected a sign-in form", { status: 400 });
      const form = Schema.decodeUnknownOption(loginFormSchema)(
        Object.fromEntries(fields),
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
