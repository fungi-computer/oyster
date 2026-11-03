import { defineIdFamily } from "@fungi.computer/cairn";
import type { McpServersConnectionOptions } from "@fungi.computer/knapsack";
import {
  ConnectionsError,
  createConnections,
  createSealedCustody,
  type ConnectionProjection,
  type EgressRef,
  type SqlStore,
} from "@fungi.computer/veil/connections";
import * as Effect from "effect/Effect";
import {
  maxAgentMcpServers,
  type AgentMcpServer,
  type AgentMcpServerInput,
  type AgentMcpServerRefusal,
} from "../agents.js";

const ids = defineIdFamily({
  family: "oyster-connection",
  version: 1,
  kinds: { connection: { prefix: "conn" } },
});
/** The Oyster owner is the only actor that manages connections. */
const owner = "owner";

/** One Agent MCP request as plain data, so it can cross the Durable Object RPC boundary. */
export type McpRequestData = Readonly<{
  url: string;
  method: string;
  headers: readonly (readonly [string, string])[];
  body: ArrayBuffer | null;
}>;
/** A refusal crosses RPC as data: a stable code, never a message. */
type McpFetchRefusal = Readonly<{ error: string }>;

export async function mcpRequestData(
  request: Request,
): Promise<McpRequestData> {
  return {
    url: request.url,
    method: request.method,
    headers: [...request.headers],
    body: request.body === null ? null : await request.arrayBuffer(),
  };
}

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
}) {
  const connections = createConnections({
    ownerId: options.ownerId,
    store: options.store,
    custody: createSealedCustody({
      vault: options.vault,
      send: options.send,
    }),
    authorize: (actor) => actor === owner,
    clock: () => Date.now(),
    ids: () => ids.connection.generate(),
  });
  const run = <A>(effect: Effect.Effect<A, ConnectionsError>) =>
    Effect.runPromise(effect);

  const projection = (agentId: string): Promise<ConnectionProjection> =>
    run(connections.projection(agentId));

  async function servers(
    agentId: string,
  ): Promise<readonly AgentMcpServer[] | null> {
    if (!options.hasAgent(agentId)) return null;
    const [granted, listed] = await Promise.all([
      projection(agentId),
      run(connections.list(owner)),
    ]);
    return granted.connections.flatMap((connection) =>
      connection.surface.kind === "mcp"
        ? [
            {
              serverId: connection.connectionId,
              name: connection.name,
              url: connection.surface.url,
              hasBearer:
                listed.find(
                  (row) => row.connectionId === connection.connectionId,
                )?.credentialKind === "static",
            },
          ]
        : [],
    );
  }

  async function add(
    agentId: string,
    input: AgentMcpServerInput,
  ): Promise<AgentMcpServer | AgentMcpServerRefusal> {
    const current = await servers(agentId);
    if (current === null) return { error: "not_found" };
    const url = new URL(input.url).href;
    if (
      current.some((server) => server.name === input.name || server.url === url)
    )
      return { error: "duplicate_name" };
    if (current.length >= maxAgentMcpServers) return { error: "limit" };
    try {
      const draft = {
        requestId: ids.connection.generate(),
        name: input.name,
        surface: { kind: "mcp", url },
      } as const;
      const { connectionId } = await run(
        input.bearer === null
          ? connections.begin(owner, { ...draft, credential: { kind: "none" } })
          : connections.begin(owner, {
              ...draft,
              credential: { kind: "static", placement: "bearer" },
              secret: input.bearer,
            }),
      );
      await run(
        connections.grant(owner, { connectionId, agentId, tools: "all" }),
      );
      await options.notify(agentId);
      return {
        serverId: connectionId,
        name: input.name,
        url,
        hasBearer: input.bearer !== null,
      };
    } catch (cause) {
      if (
        cause instanceof ConnectionsError &&
        (cause.code === "invalid_input" || cause.code === "denied")
      )
        return { error: "invalid_endpoint" };
      throw cause;
    }
  }

  async function remove(agentId: string, serverId: string): Promise<boolean> {
    const current = await servers(agentId);
    if (current?.some((server) => server.serverId === serverId) !== true)
      return false;
    const holders = (await run(connections.list(owner))).flatMap((row) =>
      row.connectionId === serverId ? row.grants.map((g) => g.agentId) : [],
    );
    await run(connections.revoke(owner, { connectionId: serverId }));
    await Promise.all(holders.map((holder) => options.notify(holder)));
    return true;
  }

  /** Complete one Agent request on the owner side: the only place a credential opens. */
  async function fetchFor(
    agentId: string,
    ref: EgressRef,
    data: McpRequestData,
  ): Promise<Response | McpFetchRefusal> {
    try {
      const init: RequestInit = {
        method: data.method,
        headers: data.headers.map(([name, value]) => [name, value]),
        redirect: "error",
      };
      if (data.body !== null) init.body = data.body;
      return await connections.egress(
        agentId,
        ref,
      )(new Request(data.url, init));
    } catch (cause) {
      if (cause instanceof ConnectionsError) return { error: cause.code };
      throw cause;
    }
  }

  return { servers, add, remove, projection, fetch: fetchFor };
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
  const refs = new Map<string, EgressRef>();
  return {
    id: "agent-mcp",
    read: async () => {
      const granted = await input.read();
      refs.clear();
      const list = granted.connections.flatMap((connection) => {
        if (connection.surface.kind !== "mcp") return [];
        refs.set(new URL(connection.surface.url).href, {
          connectionId: connection.connectionId,
          grantVersion: connection.grantVersion,
        });
        return [
          {
            id: `mcp.${connection.connectionId}`,
            name: connection.name,
            url: new URL(connection.surface.url),
          },
        ];
      });
      return {
        // Secret-free: ids, versions and endpoints.
        version: JSON.stringify(
          granted.connections.map((c) => [
            c.connectionId,
            c.grantVersion,
            c.authorityVersion,
          ]),
        ),
        servers: list,
      };
    },
    subscribe: input.subscribe,
    onUnavailable: input.onUnavailable,
    fetch: (url, init) => {
      const request = new Request(url, init);
      const ref = refs.get(request.url);
      return ref === undefined
        ? Promise.reject(new Error("MCP server is not connected"))
        : input.fetch(ref, request);
    },
  };
}
