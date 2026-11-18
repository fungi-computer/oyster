import { defineIdFamily } from "@fungi.computer/cairn";
import type { McpServersConnectionOptions } from "@fungi.computer/knapsack";
import {
  ConnectionsError,
  createConnections,
  createSealedCustody,
  type ConnectionProjection,
  answerEgressRequest,
  mcpAgentSource,
  type ConnectionSubject,
  type ConnectionView,
  type EgressRef,
  type HttpDestinations,
  type Placement,
  type McpRefusal,
  type McpRequestData,
  type SqlStore,
} from "@fungi.computer/veil/connections";
import * as Effect from "effect/Effect";
import {
  maxAgentConnections,
  type ConnectionAccess,
  type ConnectionAdded,
  type ConnectionInput,
  type ConnectionRefusal,
  type OysterConnection,
} from "../agents.js";

const ids = defineIdFamily({
  family: "oyster-connection",
  version: 1,
  kinds: { connection: { prefix: "conn" } },
});
/** The Oyster owner is the only actor that manages connections. */
const owner = "owner";

/** A secret grant the owner refuses: no such live subject, or a kind the Vault does not serve. */
type SecretGrantRefusal =
  ConnectionRefusal | Readonly<{ error: "unsupported_subject" }>;

/** Why the Vault could not change a stored credential; never its value. */
export type CredentialRefusal = Readonly<{
  error: "not_found" | "conflict" | "denied" | "invalid_input";
}>;
const credentialRefusal = (cause: unknown): CredentialRefusal => {
  if (cause instanceof ConnectionsError)
    switch (cause.code) {
      case "conflict":
        return { error: "conflict" };
      case "denied":
        return { error: "denied" };
      case "revoked":
      case "pending":
        return { error: "not_found" };
      case "invalid_input":
      case "unsupported":
        return { error: "invalid_input" };
      default:
        break;
    }
  throw cause;
};

/**
 * This instance's Agent MCP connections over Veil's connections core. The
 * owner holds every credential; an Agent receives a secret-free projection and
 * a fetch that only the owner side can complete.
 */
export function createAgentMcpConnections(options: {
  store: SqlStore;
  vault: Parameters<typeof createSealedCustody>[0]["vault"];
  /** The checked public transport; credentials ride only on this one hop. */
  send: (request: Request) => Promise<Response>;
  hasAgent: (agentId: string) => boolean;
  /**
   * Whether a grant's subject still stands: the Agent or Computer exists, the
   * key exists and is live. Asked when a secret is granted and before every
   * send, so an ended subject cannot keep using a grant it held.
   */
  subjectLive: (subject: ConnectionSubject) => Promise<boolean>;
  /** Told after a change so the Agent drops captured tools. */
  notify: (agentId: string) => Promise<void>;
  ownerId: string;
  /** Where an authorization server returns the owner; shown to them to register their own app. */
  callbackUrl: string;
}) {
  const connections = createConnections({
    ownerId: options.ownerId,
    store: options.store,
    custody: createSealedCustody({
      vault: options.vault,
      send: options.send,
    }),
    authorize: (actor) => actor === owner,
    // The host's last word before every send: the subject must still stand.
    check: (_grantor, grant) =>
      grant.subject === null
        ? Promise.resolve(true)
        : options.subjectLive(grant.subject),
    oauth: { callbackUrl: options.callbackUrl, fetch: options.send },
    clock: () => Date.now(),
    ids: () => ids.connection.generate(),
  });
  const run = <A>(effect: Effect.Effect<A, ConnectionsError>) =>
    Effect.runPromise(effect);

  const projection = (agentId: string): Promise<ConnectionProjection> =>
    run(connections.projection({ kind: "agent", id: agentId }));

  const holdersOf = async (connectionId: string) =>
    (await run(connections.list(owner))).flatMap((row) =>
      row.connectionId === connectionId
        ? row.grants
            .filter((grant) => grant.subject.kind === "agent")
            .map((grant) => grant.subject.id)
        : [],
    );
  const toolsFor = (access: ConnectionAccess) =>
    access === "all"
      ? "all"
      : access === "read"
        ? { effect: "read" as const }
        : [...access];

  /** Every live connection with the Agents that may use it. */
  async function list(): Promise<readonly OysterConnection[]> {
    return (await run(connections.list(owner))).flatMap((row) =>
      row.state === "revoked" || row.surface.kind === "http"
        ? []
        : [
            {
              connectionId: row.connectionId,
              name: row.name,
              label: row.label,
              kind: row.surface.kind,
              url: row.surface.url,
              auth:
                row.credentialKind === "static"
                  ? "token"
                  : row.credentialKind === "oauth"
                    ? "oauth"
                    : "none",
              state: row.state === "active" ? "connected" : row.state,
              grants: row.grants
                .filter((grant) => grant.subject.kind === "agent")
                .map((grant) => ({
                  agentId: grant.subject.id,
                  access:
                    grant.tools === "all"
                      ? "all"
                      : Array.isArray(grant.tools)
                        ? grant.tools
                        : "read",
                })),
            } satisfies OysterConnection,
          ],
    );
  }

  /** Connect one MCP server. No Agent has it until the owner grants it. */
  async function add(
    input: ConnectionInput,
  ): Promise<ConnectionAdded | ConnectionRefusal> {
    // Abandoned sign-ins age out before names are compared.
    await run(connections.sweep());
    const url = new URL(input.url).href;
    try {
      const requestId = ids.connection.generate();
      const surface = { kind: "mcp", url } as const;
      const oauth = input.oauth;
      const begun = await run(
        oauth !== undefined
          ? connections.begin(owner, {
              requestId,
              name: input.name,
              surface,
              credential: {
                kind: "oauth",
                scope: oauth.scope,
                clientId: oauth.clientId,
              },
              secret: oauth.clientSecret,
            })
          : input.bearer === null
            ? connections.begin(owner, {
                requestId,
                name: input.name,
                surface,
                credential: { kind: "none" },
              })
            : connections.begin(owner, {
                requestId,
                name: input.name,
                surface,
                credential: { kind: "static", placement: "bearer" },
                secret: input.bearer,
              }),
      );
      return {
        connectionId: begun.connectionId,
        authorizeUrl: begun.authorizeUrl,
      };
    } catch (cause) {
      if (cause instanceof ConnectionsError) {
        if (cause.code === "conflict") return { error: "duplicate_name" };
        if (cause.code === "invalid_input" || cause.code === "denied")
          return { error: "invalid_endpoint" };
      }
      throw cause;
    }
  }

  /** Give an Agent access, or change how much it has; its next call sees the change. */
  async function grant(
    connectionId: string,
    agentId: string,
    access: ConnectionAccess,
  ): Promise<Readonly<{ ok: true }> | ConnectionRefusal> {
    if (!options.hasAgent(agentId)) return { error: "not_found" };
    const all = await list();
    const connection = all.find((row) => row.connectionId === connectionId);
    if (connection === undefined) return { error: "not_found" };
    const held = connection.grants.some((entry) => entry.agentId === agentId);
    if (
      !held &&
      all.filter((row) => row.grants.some((entry) => entry.agentId === agentId))
        .length >= maxAgentConnections
    )
      return { error: "limit" };
    try {
      await run(
        connections.grant(owner, {
          target: { kind: "connection", id: connectionId },
          subject: { kind: "agent", id: agentId },
          capability: "connector.call",
          tools: toolsFor(access),
        }),
      );
    } catch (cause) {
      if (cause instanceof ConnectionsError && cause.code === "invalid_input")
        return { error: "invalid_endpoint" };
      throw cause;
    }
    await options.notify(agentId);
    return { ok: true };
  }

  async function ungrant(
    connectionId: string,
    agentId: string,
  ): Promise<boolean> {
    if (!(await holdersOf(connectionId)).includes(agentId)) return false;
    await run(
      connections.ungrant(owner, {
        target: { kind: "connection", id: connectionId },
        subject: { kind: "agent", id: agentId },
        capability: "connector.call",
      }),
    );
    await options.notify(agentId);
    return true;
  }

  /** The tool names an MCP connection offers. */
  async function tools(
    connectionId: string,
  ): Promise<readonly string[] | ConnectionRefusal> {
    try {
      return await run(connections.tools(owner, connectionId));
    } catch (cause) {
      if (cause instanceof ConnectionsError) return { error: "not_found" };
      throw cause;
    }
  }

  /** The browser's return from the authorization server; the Agent drops stale tools. */
  async function complete(query: {
    state: string;
    code: string;
    iss: string | undefined;
  }): Promise<Readonly<{ ok: true }> | McpRefusal> {
    try {
      const { connectionId } = await run(connections.complete(owner, query));
      const holders = (await run(connections.list(owner))).flatMap((row) =>
        row.connectionId === connectionId
          ? row.grants
              .filter((grant) => grant.subject.kind === "agent")
              .map((grant) => grant.subject.id)
          : [],
      );
      await Promise.all(holders.map((holder) => options.notify(holder)));
      return { ok: true };
    } catch (cause) {
      if (cause instanceof ConnectionsError) return { error: cause.code };
      throw cause;
    }
  }

  async function remove(connectionId: string): Promise<boolean> {
    const holders = await holdersOf(connectionId);
    const known = (await run(connections.list(owner))).some(
      (row) => row.connectionId === connectionId && row.state !== "revoked",
    );
    if (!known) return false;
    await run(connections.revoke(owner, { connectionId }));
    await Promise.all(holders.map((holder) => options.notify(holder)));
    return true;
  }

  /** Complete one Agent request on the owner side: the only place a credential opens. */
  const fetchFor = (agentId: string, ref: EgressRef, data: McpRequestData) =>
    answerEgressRequest(
      connections.egress,
      { kind: "agent", id: agentId },
      ref,
      data,
    );

  /** Save one HTTP secret bound to exact destinations; no subject holds it until granted. */
  async function addSecret(
    input: Readonly<{
      name: string;
      label?: string | undefined;
      destinations: HttpDestinations;
      placement: Placement;
      secret: string;
    }>,
  ): Promise<Readonly<{ connectionId: string }> | ConnectionRefusal> {
    try {
      const begun = await run(
        connections.begin(owner, {
          requestId: ids.connection.generate(),
          name: input.name,
          label: input.label,
          surface: { kind: "http", destinations: input.destinations },
          credential: { kind: "static", placement: input.placement },
          secret: input.secret,
        }),
      );
      return { connectionId: begun.connectionId };
    } catch (cause) {
      if (cause instanceof ConnectionsError) {
        if (cause.code === "conflict") return { error: "duplicate_name" };
        if (cause.code === "invalid_input" || cause.code === "denied")
          return { error: "invalid_endpoint" };
      }
      throw cause;
    }
  }

  /** This instance's live secrets with their bindings and holders; never a value. */
  async function secrets(): Promise<readonly ConnectionView[]> {
    return (await run(connections.list(owner))).filter(
      (row) => row.surface.kind === "http" && row.state !== "revoked",
    );
  }

  /**
   * Let one Agent, Computer or Team key use a secret under the broker's
   * `secret.use` scope. The subject must stand now; Apps hold no Vault power.
   */
  async function grantSecret(
    connectionId: string,
    subject: ConnectionSubject,
  ): Promise<Readonly<{ ok: true }> | SecretGrantRefusal> {
    if (subject.kind === "app") return { error: "unsupported_subject" };
    if (
      (subject.kind === "agent" && !options.hasAgent(subject.id)) ||
      !(await options.subjectLive(subject))
    )
      return { error: "not_found" };
    try {
      await run(
        connections.grant(owner, {
          target: { kind: "secret", id: connectionId },
          subject,
          capability: "secret.use",
          tools: "all",
        }),
      );
    } catch (cause) {
      if (
        cause instanceof ConnectionsError &&
        (cause.code === "denied" || cause.code === "invalid_input")
      )
        return { error: "not_found" };
      if (cause instanceof ConnectionsError && cause.code === "unsupported")
        return { error: "unsupported_subject" };
      throw cause;
    }
    if (subject.kind === "agent") await options.notify(subject.id);
    return { ok: true };
  }

  async function ungrantSecret(
    connectionId: string,
    subject: ConnectionSubject,
  ): Promise<void> {
    await run(
      connections.ungrant(owner, {
        target: { kind: "secret", id: connectionId },
        subject,
        capability: "secret.use",
      }),
    );
    if (subject.kind === "agent") await options.notify(subject.id);
  }

  /** Every live credential this instance holds, of every kind; never a value. */
  async function credentials(): Promise<readonly ConnectionView[]> {
    return (await run(connections.list(owner))).filter(
      (row) => row.state !== "revoked",
    );
  }
  const live = async (connectionId: string) =>
    (await credentials()).find((row) => row.connectionId === connectionId);

  /**
   * The Vault's one write path for a stored credential, write-only: rotate its
   * value, rename it, rescope an HTTP secret, or give a Connection without one
   * a bearer value. Grants stay; a widened secret needs its value re-entered.
   */
  async function updateCredential(
    input: Readonly<{
      connectionId: string;
      expectedVersion: number;
      label?: string | undefined;
      destinations?: HttpDestinations | undefined;
      secret?: string | undefined;
    }>,
  ): Promise<Readonly<{ version: number }> | CredentialRefusal> {
    const view = await live(input.connectionId);
    if (view === undefined) return { error: "not_found" };
    // A signed-in Connection's tokens come from its sign-in, never a paste.
    if (input.secret !== undefined && view.credential.kind === "oauth")
      return { error: "invalid_input" };
    try {
      const done = await run(
        connections.update(owner, {
          requestId: ids.connection.generate(),
          connectionId: input.connectionId,
          expectedVersion: input.expectedVersion,
          label: input.label,
          destinations: input.destinations,
          // A rotation keeps the placement; a first value rides as a bearer.
          credential:
            input.secret === undefined
              ? undefined
              : view.credential.kind === "static"
                ? view.credential
                : { kind: "static", placement: "bearer" },
          secret: input.secret,
        }),
      );
      await notifyHolders(view);
      return { version: done.version };
    } catch (cause) {
      return credentialRefusal(cause);
    }
  }

  /** Take a Connection's pasted value out of custody; an HTTP secret is revoked whole instead. */
  async function clearCredential(
    input: Readonly<{ connectionId: string; expectedVersion: number }>,
  ): Promise<Readonly<{ version: number }> | CredentialRefusal> {
    const view = await live(input.connectionId);
    if (view === undefined) return { error: "not_found" };
    if (view.surface.kind === "http" || view.credential.kind !== "static")
      return { error: "invalid_input" };
    try {
      const done = await run(
        connections.update(owner, {
          requestId: ids.connection.generate(),
          connectionId: input.connectionId,
          expectedVersion: input.expectedVersion,
          credential: { kind: "none" },
        }),
      );
      await notifyHolders(view);
      return { version: done.version };
    } catch (cause) {
      return credentialRefusal(cause);
    }
  }
  const notifyHolders = (view: ConnectionView) =>
    Promise.all(
      view.grants
        .filter((grant) => grant.subject.kind === "agent")
        .map((grant) => options.notify(grant.subject.id)),
    );

  return {
    list,
    addSecret,
    secrets,
    credentials,
    updateCredential,
    clearCredential,
    grantSecret,
    ungrantSecret,
    /** Every recorded use and refusal of one credential, without its value. */
    secretUsage: (connectionId: string) =>
      run(connections.audit(owner, connectionId)),
    /** Complete one request with a secret on the owner side; the caller names its subject. */
    fetchSecret: (
      subject: ConnectionSubject,
      ref: EgressRef,
      data: McpRequestData,
    ) => answerEgressRequest(connections.egress, subject, ref, data),
    add,
    grant,
    ungrant,
    remove,
    tools,
    complete,
    projection,
    fetch: fetchFor,
  };
}

/**
 * The Agent half: Knapsack connects to each granted server through a fetch that
 * is completed by the owner. No header, token or locator is ever held here.
 */
export function agentMcpSourceOptions(input: {
  read: () => Promise<ConnectionProjection>;
  subscribe: McpServersConnectionOptions["subscribe"];
  onUnavailable: McpServersConnectionOptions["onUnavailable"];
  fetch: (ref: EgressRef, request: Request) => Promise<Response>;
}): McpServersConnectionOptions {
  return {
    id: "agent-mcp",
    ...mcpAgentSource({ read: input.read, fetch: input.fetch }),
    subscribe: input.subscribe,
    onUnavailable: input.onUnavailable,
  };
}
