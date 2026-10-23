import { DurableObject } from "cloudflare:workers";
import { nanoid } from "@fungi.computer/cairn";
import type { Mcp, McpPersistence } from "@fungi.computer/mycelium/mcp";
import { createCodemodeSandbox } from "@fungi.computer/mycelium/workers";
import type { EventStore } from "@modelcontextprotocol/server";
import * as Schema from "effect/Schema";
import type { OysterHost, OysterMcp } from "./host.js";
import { tenantIdSchema, tenantScope, type TenantScope } from "./tenant.js";

/**
 * The MCP protocol SDK builds hundreds of schemas when it loads. Only the first
 * MCP request needs them, so the owner loads it then and the Worker's startup
 * (which every request and every deploy pays) never does.
 */
const loadMcpProtocol = async () => {
  const [mycelium, sdk, catalog] = await Promise.all([
    import("@fungi.computer/mycelium/mcp"),
    import("@modelcontextprotocol/server"),
    import("./mcp.js"),
  ]);
  return { mycelium, sdk, catalog };
};
type McpProtocol = Awaited<ReturnType<typeof loadMcpProtocol>>;
type McpEventProtocol = Readonly<{
  sdk: Pick<McpProtocol["sdk"], "serializeMessage" | "parseJSONRPCMessage">;
}>;

/** Worker Loader used by the existing Mycelium sandbox. */
export type OysterMcpOwnerEnv = Readonly<{ LOADER: WorkerLoader }>;
/** Serialized trusted tenant pin supplied by the selected host. */
export type OysterMcpTenantPin = Readonly<{ tenantId: string; origin: string }>;
const pinSchema = Schema.Struct({
  tenant_id: tenantIdSchema,
  origin: Schema.String,
});
const eventSchema = Schema.Struct({
  event_id: Schema.String,
  stream_id: Schema.String,
  message: Schema.String,
  sequence: Schema.Number,
});

/**
 * One tenant's live SDK transports; cold owners refuse old IDs without execution replay.
 * The persisted origin is a lifetime pin. Changing the configured origin requires
 * a fresh MCP namespace; an existing owner never retargets its retained pin.
 */
export class OysterMcpOwner<
  Env extends OysterMcpOwnerEnv = OysterMcpOwnerEnv,
> extends DurableObject<Env> {
  #mcp: Promise<Mcp> | undefined;
  readonly #createHost: (
    env: Env,
    scope: TenantScope,
  ) => OysterHost | Promise<OysterHost>;
  constructor(
    ctx: DurableObjectState,
    env: Env,
    createHost: (
      env: Env,
      scope: TenantScope,
    ) => OysterHost | Promise<OysterHost>,
  ) {
    super(ctx, env);
    this.#createHost = createHost;
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS oyster_mcp_tenant (id INTEGER PRIMARY KEY CHECK(id=1), tenant_id TEXT NOT NULL, origin TEXT NOT NULL) STRICT",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS oyster_mcp_sessions (protocol_id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL, principal TEXT NOT NULL) STRICT",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS oyster_mcp_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, catalog_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, stream_id TEXT NOT NULL, message TEXT NOT NULL) STRICT",
    );
    // The SDK has no transport snapshot restore port. Expire SDK-only state,
    // retaining the trusted tenant pin and all host-owned business history.
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec("DELETE FROM oyster_mcp_events");
      ctx.storage.sql.exec("DELETE FROM oyster_mcp_sessions");
    });
  }

  #eventStore(catalogId: string, { sdk }: McpEventProtocol): EventStore {
    const sql = this.ctx.storage.sql;
    const find = (eventId: string) => {
      const row = sql
        .exec(
          "SELECT sequence, event_id, stream_id, message FROM oyster_mcp_events WHERE catalog_id=? AND event_id=?",
          catalogId,
          eventId,
        )
        .toArray()[0];
      return row === undefined
        ? undefined
        : Schema.decodeUnknownSync(eventSchema)(row);
    };
    return {
      storeEvent: (streamId, message) => {
        const id = nanoid();
        sql.exec(
          "INSERT INTO oyster_mcp_events (catalog_id, event_id, stream_id, message) VALUES (?,?,?,?)",
          catalogId,
          id,
          streamId,
          sdk.serializeMessage(message),
        );
        return Promise.resolve(id);
      },
      getStreamIdForEventId: (id) => Promise.resolve(find(id)?.stream_id),
      replayEventsAfter: async (id, { send }) => {
        const after = find(id);
        if (after === undefined) throw new Error("MCP event unavailable");
        const rows = sql
          .exec(
            "SELECT sequence, event_id, stream_id, message FROM oyster_mcp_events WHERE catalog_id=? AND stream_id=? AND sequence>? ORDER BY sequence",
            catalogId,
            after.stream_id,
            after.sequence,
          )
          .toArray();
        for (const raw of rows) {
          const row = Schema.decodeUnknownSync(eventSchema)(raw);
          await send(
            row.event_id,
            sdk.parseJSONRPCMessage(JSON.parse(row.message)),
          );
        }
        return after.stream_id;
      },
    };
  }

  /** Trusted host RPC: the namespace and pin are never selected by guest headers. */
  async serve(request: Request, tenant: OysterMcpTenantPin): Promise<Response> {
    const scope = tenantScope(
      Schema.decodeUnknownSync(tenantIdSchema)(tenant.tenantId),
      tenant.origin,
    );
    if (
      this.ctx.id.name !== scope.durableName("mcp") ||
      new URL(request.url).origin !== scope.origin
    )
      return new Response("Not found", { status: 404 });
    const sql = this.ctx.storage.sql;
    const raw = sql
      .exec("SELECT tenant_id, origin FROM oyster_mcp_tenant WHERE id=1")
      .toArray()[0];
    if (raw !== undefined) {
      const pin = Schema.decodeUnknownSync(pinSchema)(raw);
      if (pin.tenant_id !== scope.tenantId || pin.origin !== scope.origin)
        return new Response("Not found", { status: 404 });
    } else {
      sql.exec(
        "INSERT INTO oyster_mcp_tenant (id, tenant_id, origin) VALUES (1,?,?)",
        scope.tenantId,
        scope.origin,
      );
    }
    if (this.#mcp === undefined) {
      // Publish the flight before any await: live SDK sessions belong to one owner.
      this.#mcp = loadMcpProtocol()
        .then(async (protocol) => {
          const host = await this.#createHost(this.env, scope);
          const persistence: McpPersistence = {
            eventStore: (id) => this.#eventStore(id, protocol),
            initialized: (id, session) => {
              sql.exec(
                "INSERT INTO oyster_mcp_sessions (protocol_id, catalog_id, principal) VALUES (?,?,?)",
                id,
                session.id,
                JSON.stringify(session.principal),
              );
              return Promise.resolve();
            },
            closed: (id, session) => {
              this.ctx.storage.transactionSync(() => {
                sql.exec(
                  "DELETE FROM oyster_mcp_events WHERE catalog_id=?",
                  session.id,
                );
                sql.exec(
                  "DELETE FROM oyster_mcp_sessions WHERE protocol_id=?",
                  id,
                );
              });
              return Promise.resolve();
            },
          };
          return protocol.mycelium.createMcp({
            persistence,
            catalog: protocol.mycelium.createMcpCatalog({
              // Each acquisition captures the current durable selection. Existing
              // operation handles retain the Computer captured by their own catalog.
              load: async (principal) =>
                protocol.catalog.oysterMcpCatalogLoad(
                  await this.#createHost(this.env, scope),
                )(principal),
              sandbox: createCodemodeSandbox(this.env.LOADER),
            }),
            authenticate: async (incoming) => {
              const admission = await host.auth.authenticate(incoming);
              return admission.kind === "refused"
                ? admission
                : { kind: "admitted", principal: admission.principal };
            },
          });
        })
        .catch((error: unknown) => {
          this.#mcp = undefined;
          throw error;
        });
    }
    return (await this.#mcp).handleRequest(request);
  }
}

/** Bind the owner to the deployment's existing host factory and options. */
export function createOysterMcpOwner<Env extends OysterMcpOwnerEnv>(
  host: (env: Env, scope: TenantScope) => OysterHost | Promise<OysterHost>,
): new (ctx: DurableObjectState, env: Env) => OysterMcpOwner<Env> {
  return class extends OysterMcpOwner<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env, host);
    }
  };
}

/** Frontends own no SDK state and cannot close another isolate's sessions. */
export function remoteOysterMcp(
  binding: DurableObjectNamespace<OysterMcpOwner> | undefined,
  scope: TenantScope,
): OysterMcp {
  return {
    async handleRequest(request): Promise<Response> {
      if (binding === undefined)
        return new Response("MCP owner binding unavailable", { status: 503 });
      const response: Response = await binding
        .getByName(scope.durableName("mcp"))
        .serve(request, { tenantId: scope.tenantId, origin: scope.origin });
      return response;
    },
  };
}
