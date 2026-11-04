import { defineIdFamily } from "@fungi.computer/cairn";
import type { McpServersConnectionOptions } from "@fungi.computer/knapsack";
import {
  ConnectionsError,
  createConnections,
  createSealedCustody,
  type ConnectionProjection,
  answerMcpRequest,
  mcpAgentSource,
  type EgressRef,
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
    oauth: { callbackUrl: options.callbackUrl, fetch: options.send },
    clock: () => Date.now(),
    ids: () => ids.connection.generate(),
  });
  const run = <A>(effect: Effect.Effect<A, ConnectionsError>) =>
    Effect.runPromise(effect);

  const projection = (agentId: string): Promise<ConnectionProjection> =>
    run(connections.projection(agentId));

  const holdersOf = async (connectionId: string) =>
    (await run(connections.list(owner))).flatMap((row) =>
      row.connectionId === connectionId
        ? row.grants.map((grant) => grant.agentId)
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
      row.state === "revoked"
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
              grants: row.grants.map((grant) => ({
                agentId: grant.agentId,
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
          connectionId,
          agentId,
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
    await run(connections.ungrant(owner, { connectionId, agentId }));
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
          ? row.grants.map((grant) => grant.agentId)
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
    const known = (await list()).some(
      (row) => row.connectionId === connectionId,
    );
    if (!known) return false;
    await run(connections.revoke(owner, { connectionId }));
    await Promise.all(holders.map((holder) => options.notify(holder)));
    return true;
  }

  /** Complete one Agent request on the owner side: the only place a credential opens. */
  const fetchFor = (agentId: string, ref: EgressRef, data: McpRequestData) =>
    answerMcpRequest(connections.egress, agentId, ref, data);

  return {
    list,
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
