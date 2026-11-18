import {
  migrateCredentialEnvelopes,
  type CredentialKeyring,
  type CredentialStorage,
} from "@fungi.computer/veil/credential-store";
import type { SqlStore } from "@fungi.computer/veil/connections";

/**
 * Oyster credential migration 001: the old `instance`-sealed model, Discord
 * and MCP rows move to owner envelopes without changing ids or references.
 * Operators retain `instance` in the configured keyring during this conversion.
 * Veil records completion; subsequent boots only rewrap the owner's data key.
 */
export async function migrateCredentialRows001(options: {
  owner: SqlStore;
  storage: CredentialStorage;
  ownerId: string;
  keyring: CredentialKeyring | undefined;
}): Promise<void> {
  await migrateCredentialEnvelopes({
    ...options,
    domain: "fungi.oyster.credentials.v1",
  });
}
