/**
 * Oyster's own Ear Tag vocabulary: named keys an owner issues for its
 * installed Apps, its Computer or machine enrollment. A key's id is its name, so
 * forks and other name-derived identities stay stable across the cutover.
 */
import { defineGrants } from "@fungi.computer/ear-tag/grants";
import type {
  Grant,
  GrantVocabulary,
  Scope,
} from "@fungi.computer/ear-tag/grants";
import type {
  KeyPrincipal,
  KeyRecord,
  KeyStore,
} from "@fungi.computer/ear-tag/keys";
import type { AppToolPolicy } from "./apps/tools.js";

/** Every capability an Oyster key may carry. */
export type OysterKeyCapability =
  "apps.read" | "apps.use" | "computer.use" | "machine.enroll";

/**
 * `apps.use` also reaches `apps.read` (one level, per `defineGrants`'s own
 * `implies`): a key that may change an App's data may also read it.
 * `computer.use` has no narrower capability under it; the Computer is on or
 * off, host-wide.
 * `machine.enroll` admits enrollment only; it implies no App or Computer access.
 * The enrollment owner, not this vocabulary, owns one-use consumption.
 */
export const oysterKeyVocabulary: GrantVocabulary<OysterKeyCapability> =
  defineGrants({
    capabilities: ["apps.read", "apps.use", "computer.use", "machine.enroll"],
    implies: { "apps.use": ["apps.read"] },
  });

/** A grant reaching every current and future installation for `capability`. */
export function allInstallations(
  capability: "apps.read" | "apps.use",
): Grant<OysterKeyCapability> {
  return { capability, targets: { kind: "all" } };
}

/** The grant that turns on the Computer for a key, host-wide; there is no narrower target. */
export const computerUseGrant: Grant<OysterKeyCapability> = {
  capability: "computer.use",
  targets: { kind: "all" },
};

/** One key's durable record, in the shape a host's own App reads. */
export type OysterKeyRecord = KeyRecord<OysterKeyCapability>;
/** One key's live, authenticated principal. */
export type OysterKeyPrincipal = KeyPrincipal<OysterKeyCapability>;
/** One key's authority, as `defineGrants` canonicalizes it. */
export type OysterKeyScope = Scope<OysterKeyCapability>;
/** The Ear Tag store's own interface, closed over Oyster's capability vocabulary. */
export type OysterKeyStore = KeyStore<OysterKeyCapability>;

/**
 * The minimal live facts `OysterHost`'s `keys.live` port returns: enough to
 * gate one call, never the key's name or timestamps. `null` for an unknown,
 * revoked, expired or suspended key -- the same closed set `keyAppAccess`
 * and `keyAllowsComputerUse` already treat as no authority.
 */
export type LiveOysterKey = Readonly<{
  keyId: string;
  owner: string;
  grantVersion: number;
  grants: readonly Grant<OysterKeyCapability>[];
}>;

/**
 * One live key's access to one installation: `write` when its grants admit
 * `apps.use` there, `read` when they admit `apps.read`, otherwise `null` --
 * including for an installation added after the key was issued, unless the
 * key holds "All Apps" (`targets: {kind: "all"}`). The same shape as an
 * Agent's stored {@link AppToolPolicy}; its caller adds `bindingName` (which
 * varies by caller: the plain installation id for the gate, the uppercased
 * binding name for MCP) to reach the full `AppToolAccess`.
 */
export function keyAppAccess(
  key: LiveOysterKey,
  installationId: string,
): AppToolPolicy | null {
  const level = oysterKeyVocabulary.grantsAllow(
    key.grants,
    "apps.use",
    installationId,
  )
    ? "write"
    : oysterKeyVocabulary.grantsAllow(key.grants, "apps.read", installationId)
      ? "read"
      : null;
  if (level === null) return null;
  return {
    level,
    revision: `key:${key.keyId}:${String(key.grantVersion)}`,
    grantedBy: key.owner,
  };
}

/** Whether a live key's own grants turn its Computer access on. Off by default. */
export function keyAllowsComputerUse(key: LiveOysterKey): boolean {
  return oysterKeyVocabulary.grantsAllow(key.grants, "computer.use");
}

/** Whether a live key's grants permit a one-use device enrollment. */
export function keyAllowsMachineEnroll(key: LiveOysterKey): boolean {
  return (
    key.grants.length === 1 &&
    key.grants[0]?.capability === "machine.enroll" &&
    oysterKeyVocabulary.grantsAllow(key.grants, "machine.enroll")
  );
}
