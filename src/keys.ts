/**
 * Oyster's own Ear Tag vocabulary: named keys an owner issues for selected
 * Apps and Agents, its Computer or machine enrollment. App grants never imply
 * Agent access. A key's id is its name, so name-derived identities stay stable.
 * What a key reaches is decided only in `authorization.ts`.
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

/** Every capability an Oyster key may carry. */
export type OysterKeyCapability =
  "apps.read" | "apps.use" | "agents.use" | "computer.use" | "machine.enroll";

/**
 * `apps.use` also reaches `apps.read` (one level, per `defineGrants`'s own
 * `implies`): a key that may change an App's data may also read it.
 * `computer.use` has no narrower capability under it; the Computer is on or
 * off, host-wide.
 * `agents.use` selects Agent ids independently of App grants.
 * `machine.enroll` admits enrollment only; it implies no App or Computer access.
 * The enrollment owner, not this vocabulary, owns one-use consumption.
 */
export const oysterKeyVocabulary: GrantVocabulary<OysterKeyCapability> =
  defineGrants({
    capabilities: [
      "apps.read",
      "apps.use",
      "agents.use",
      "computer.use",
      "machine.enroll",
    ],
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
 * revoked, expired or suspended key, which `authorization.ts` treats as no
 * authority.
 */
export type LiveOysterKey = Readonly<{
  keyId: string;
  owner: string;
  grantVersion: number;
  grants: readonly Grant<OysterKeyCapability>[];
}>;
