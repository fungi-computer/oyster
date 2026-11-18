import type {
  ConnectionSubject,
  ConnectionUsage,
  ConnectionView,
  HttpDestinations,
  Placement,
} from "@fungi.computer/veil/connections";
import type {
  CredentialRefusal,
  createAgentMcpConnections,
} from "./agent-connections.js";
import type { ModelKeyRecord } from "./model-key-vault.js";
import type { ModelKeyUsage } from "./model-key-usage.js";

/** One stored credential as the Vault page lists it. No value, ever. */
export type VaultCredential = Readonly<{
  connectionId: string;
  name: string;
  label: string;
  kind: "secret" | "mcp" | "openapi";
  origin: string;
  destinations: HttpDestinations | null;
  credential: "value" | "sign-in" | "none";
  placement: Placement | null;
  state: Exclude<ConnectionView["state"], "revoked">;
  version: number;
  subjects: readonly ConnectionSubject[];
}>;

const credentialOf = (view: ConnectionView): VaultCredential[] =>
  view.state === "revoked"
    ? []
    : [
        {
          connectionId: view.connectionId,
          name: view.name,
          label: view.label,
          kind: view.surface.kind === "http" ? "secret" : view.surface.kind,
          origin: view.surface.origin,
          destinations: view.surface.destinations ?? null,
          credential:
            view.credential.kind === "static"
              ? "value"
              : view.credential.kind === "oauth"
                ? "sign-in"
                : "none",
          placement:
            view.credential.kind === "static"
              ? view.credential.placement
              : null,
          state: view.state,
          version: view.version,
          subjects: view.grants.map((grant) => grant.subject),
        },
      ];

/** One owner request to the instance Vault; values travel in, never out. */
export type VaultCommand =
  | Readonly<{ op: "read" }>
  | Readonly<{
      op: "addSecret";
      name: string;
      label?: string | undefined;
      destinations: HttpDestinations;
      placement: Placement;
      secret: string;
    }>
  | Readonly<{
      op: "updateCredential";
      connectionId: string;
      expectedVersion: number;
      label?: string | undefined;
      destinations?: HttpDestinations | undefined;
      secret?: string | undefined;
    }>
  | Readonly<{
      op: "revokeCredential";
      connectionId: string;
      expectedVersion: number;
    }>
  | Readonly<{
      op: "grantSecret" | "ungrantSecret";
      connectionId: string;
      subject: ConnectionSubject;
    }>
  | Readonly<{ op: "usage"; connectionId: string }>
  | Readonly<{ op: "modelKeyUsage"; keyId: string }>;

/** Why the Vault refused a command; never a stored value. */
export type VaultRefusal = Readonly<{
  error:
    | CredentialRefusal["error"]
    | "duplicate_name"
    | "limit"
    | "invalid_endpoint"
    | "unsupported_subject";
}>;

/** The Vault page listing: every stored credential and model key, with no value. */
export type VaultView = Readonly<{
  /** The owner is the only actor on an Oyster: everything is theirs to manage. */
  role: Readonly<{ manageTeam: true; managePersonal: true }>;
  modelKeys: readonly ModelKeyRecord[];
  credentials: readonly VaultCredential[];
  /** Oyster derives fingerprints from every stored value: always complete. */
  coverage: Readonly<{ state: "complete" }>;
}>;

/** What one Vault command answers: a listing, an id, a version, usage or a refusal. */
export type VaultResult =
  | VaultView
  | Readonly<{ connectionId: string }>
  | Readonly<{ version: number }>
  | Readonly<{ ok: true }>
  | Readonly<{ usage: readonly ConnectionUsage[] | readonly ModelKeyUsage[] }>
  | VaultRefusal;

/** The instance's Vault: its connections' credentials and model keys, write-only. */
export function createInstanceVault(owners: {
  connections: ReturnType<typeof createAgentMcpConnections>;
  modelKeys: () => Promise<readonly ModelKeyRecord[]>;
  modelKeyUsage: (keyId: string) => readonly ModelKeyUsage[];
}) {
  const { connections } = owners;
  return async (command: VaultCommand): Promise<VaultResult> => {
    switch (command.op) {
      case "read":
        return {
          role: { manageTeam: true, managePersonal: true },
          modelKeys: await owners.modelKeys(),
          credentials: (await connections.credentials()).flatMap(credentialOf),
          coverage: { state: "complete" },
        };
      case "addSecret":
        return connections.addSecret(command);
      case "updateCredential":
        return connections.updateCredential(command);
      case "revokeCredential": {
        const held = (await connections.credentials()).find(
          (view) => view.connectionId === command.connectionId,
        );
        if (held === undefined) return { error: "not_found" };
        if (held.version !== command.expectedVersion)
          return { error: "conflict" };
        // An HTTP secret is revoked whole; a Connection only loses its value.
        if (held.surface.kind !== "http")
          return connections.clearCredential(command);
        return (await connections.remove(command.connectionId))
          ? { ok: true }
          : { error: "not_found" };
      }
      case "grantSecret":
        return connections.grantSecret(command.connectionId, command.subject);
      case "ungrantSecret":
        await connections.ungrantSecret(command.connectionId, command.subject);
        return { ok: true };
      case "usage":
        return { usage: await connections.secretUsage(command.connectionId) };
      case "modelKeyUsage":
        return { usage: owners.modelKeyUsage(command.keyId) };
    }
  };
}
