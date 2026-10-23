import { observeProviderStatus } from "@fungi.computer/mule/effect";
import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  standaloneTenancy,
  type StandaloneTenancy,
  type StandaloneTenancyEnv,
} from "./tenancy.js";
import { AcceptedSchema } from "@fungi.computer/shiitake/client";
import { createShiitakeClient } from "@fungi.computer/shiitake/client";
import {
  AgentCreateRefused,
  type AgentControlDirectory,
} from "@fungi.computer/shiitake/agent-control";
import {
  AgentDelegation,
  AgentDisclosureRefused,
  machineAgentCodecs,
} from "@fungi.computer/shiitake/delegation";
import type { createConversationAgents } from "@fungi.computer/shiitake-extensions/roster/conversation-agents";
import type { PostEnvelope } from "@fungi.computer/carrier/post";
import { FungiMessageMetaSchema } from "@fungi.computer/agar/agents";
import { agentMail } from "./agent-mail.js";
import {
  createStandaloneMachineEnrollment,
  standaloneMachineAgentHome,
  standaloneMachineLinkAuthority,
  type StandaloneMachineLinkBindings,
  type StandaloneMachineJoinResult,
} from "./machine-link.js";
import {
  createMachineLinkFences,
  MachineEnrollmentRefused,
  MachineLinkRefused,
  createMachineAgentClient,
  type MachineAgentSettlementPrincipal,
  type MachineAgentHome,
  type MachineEnrollment,
  type MachineLinkCaller,
  type MachineLinkIdentity,
} from "../machine-link/index.js";
import { memberInboxItemSchema } from "@fungi.computer/puffball/inbox";
/**
 * Agents on a standalone Oyster Worker. Each agent is Shiitake's public
 * Cloudflare host (`ShiitakeDO`), one Durable Object per agent; a directory
 * Durable Object names them and keeps the member's visits. The model comes
 * from a pluggable `ModelSource`; the default runs Workers AI through the
 * Worker's AI binding, with no API token.
 */
import { agentDirectoryForScope } from "./agent-directory.js";
import { DurableObject } from "cloudflare:workers";
import type { StandaloneComputerEnv } from "./computer.js";
import { ShiitakeDO } from "@fungi.computer/shiitake/cloudflare";
import { agentStoreKeeping } from "./agent-store.js";
import { standaloneBrowserSource } from "./browser.js";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import {
  configuredProviderEgress,
  providerFetch,
} from "@fungi.computer/veil/gatekeeper";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
  type AiBinding,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import * as Schema from "effect/Schema";
import { z } from "zod";
import {
  type FrameBindingMethods,
  type FrameBindingProps,
} from "../cloudflare.js";
import { AppInstanceError } from "../index.js";
import {
  createAgentAvatarStore,
  type AgentAvatarStore,
} from "../agent-avatars.js";
import type { Avatar } from "@fungi.computer/sprite/avatar";
import type { InvocationFrame } from "../invocation.js";
import type { OysterJson } from "../host.js";
import { defineIdFamily } from "@fungi.computer/cairn";
import {
  agentIds,
  createAgentDirectory,
  createFleetSessions,
  commandSettlementSchema,
  DirectoryError,
  type AgentGrant,
  type FleetMessage,
} from "@fungi.computer/shiitake/fleet";
import type { AppSurfaceCache } from "../mcp.js";
import { appToolPolicySchema, type AppToolPolicy } from "../apps/index.js";
import {
  oysterPrincipalIsOwner,
  oysterPrincipalId,
  type OysterPrincipal,
  type OysterHost,
} from "../host.js";
import {
  defaultTenant,
  tenantIdSchema,
  tenantScope,
  type TenantScope,
  type TenantId,
} from "../tenant.js";
import type { ReadonlyTenancy } from "../tenancy/index.js";
import type { HostActor } from "@fungi.computer/puffball/app";
import type { OysterWorkerEnv } from "../workers.js";
import { createCodemodeSandbox } from "@fungi.computer/mycelium/workers";
import type {
  McpServerConnection,
  UiConnection,
} from "@fungi.computer/knapsack";
import {
  maxAgentMcpServers,
  type AgentMcpServer,
  type AgentMcpServerInput,
  type AgentMcpServerRefusal,
} from "../agents.js";
import type {
  OysterAgent,
  AgentPolicyActor,
  OysterAgents,
  OysterInboxItem,
  OysterSessionRow,
} from "../agents.js";

/** The model door an agent runs on; Shiitake's own contract. */
export type StandaloneModelSource = CloudflareShiitakeOptions["model"];

/** Default Workers AI chat model: one that reliably calls tools. */
const defaultAgentModel = "@cf/moonshotai/kimi-k2.6";

/** Own transport evidence and exact-message decisions for one model lease. */
function observedModels(
  model: Model<Api>,
  defaults: SimpleStreamOptions,
): StandaloneModelSource {
  return {
    acquire: async ({ signal }) => {
      const streamSimple = await loadStreamSimple();
      const retryableMessages = new WeakSet<AssistantMessage>();
      return {
        model,
        retryable: (message) =>
          !signal.aborted &&
          message.stopReason === "error" &&
          retryableMessages.has(message),
        stream: (selected, context, options) => {
          const upstream = { ...options, ...defaults };
          const observed = observeProviderStatus(upstream);
          const response = streamSimple(selected, context, {
            ...upstream,
            fetch: observed.fetch,
            onProviderStreamEvent: observed.onProviderStreamEvent,
          });
          // Observe Pi's ordinary settled-result interface without replacing
          // its stream, iterator, result or transport.
          void response.result().then((message) => {
            if (
              message.stopReason === "error" &&
              !signal.aborted &&
              !upstream.signal?.aborted &&
              observed.rejection()?.code === "provider_unavailable"
            )
              retryableMessages.add(message);
          });
          return response;
        },
        release: () => Promise.resolve(),
      };
    },
  };
}

/**
 * Workers AI over the AI binding. Requests go through AI Gateway's
 * `workers-ai` passthrough on the binding, so no API token is needed.
 */
function workersAiModels(
  ai: AiBinding,
  options: WorkersAiOptions = {},
): StandaloneModelSource {
  const id = options.model ?? defaultAgentModel;
  const listed = cloudflareWorkersAIProvider()
    .getModels()
    .find((model) => model.id === id);
  if (listed === undefined)
    throw new Error(`Workers AI has no chat model ${id}`);
  const model = {
    ...listed,
    baseUrl: `https://workers-binding.ai/ai-gateway/gateways/${options.gateway ?? "default"}/workers-ai/v1`,
  };
  const fetch = createAiBindingFetch(ai);
  return observedModels(model, {
    fetch,
    apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
    headers: {
      "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
      // The binding carries identity; a request auth header would be
      // taken as a provider key that overrides the gateway's own.
      Authorization: null,
    },
  });
}

/**
 * Pi's dispatching `streamSimple` evaluates every provider's model catalog when
 * it loads; only a run needs it, so acquisition loads it instead of startup.
 */
const loadStreamSimple = async () =>
  (await import("@earendil-works/pi-ai/compat")).streamSimple;

/** Where Workers AI requests go: which model, through which gateway. */
type WorkersAiOptions = Readonly<{ model?: string; gateway?: string }>;

/** One directory entry: an agent's id, display name and own avatar. */
export type AgentEntry = Readonly<{
  agentId: string;
  createdBy: string | null;
  name: string;
  avatar: Avatar;
}>;

/** Bindings the agent host reads. */
export type StandaloneAgentsEnv = Readonly<{
  /** Configured standalone-owner identity subject; never a stored member ID. */
  OYSTER_OWNER_NAME?: string;
  /** Gateway custody remains in Veil; only the host receives these bindings. */
  AI_GATEWAY_AUTH_TOKEN?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  /** Workers AI, the default model door. */
  AI?: AiBinding;
  /** The model: `@fungi/luna` via AI Gateway, or a Workers AI id (default {@link defaultAgentModel}). */
  OYSTER_AGENT_MODEL?: string;
  /** The AI Gateway the binding routes through (default `default`). */
  OYSTER_AI_GATEWAY?: string;
  /** Maintained current-member authority; absent means no nondefault-tenant policy admission. */
  TENANCY?: Pick<ReadonlyTenancy, "memberById">;
  TENANTS?: StandaloneTenancyEnv["TENANTS"];
  KEYS?: StandaloneTenancyEnv["KEYS"];
  OYSTER_ORIGIN: string;
  OYSTER_OWNER_KEY?: string;
  AGENTS: DurableObjectNamespace<StandaloneAgentBase>;
  /** Host-only directory custody. Guest entrypoints expose operations, not this binding; Codemode receives only Mycelium modules. */
  AGENT_DIRECTORY: DurableObjectNamespace<AgentDirectory>;
}>;

/** An agent host's whole env: its own bindings and the Oyster's. */
export type StandaloneAgentEnv = StandaloneAgentsEnv &
  OysterWorkerEnv &
  StandaloneComputerEnv &
  StandaloneMachineLinkBindings;

const policyDirectorySchema = Schema.Struct({
  directoryName: Schema.NonEmptyString,
  tenantId: tenantIdSchema,
});

/** This Agent's remote MCP servers; the bearer stays in this Durable Object. */
const storedMcpServersSchema = Schema.Array(
  Schema.Struct({
    serverId: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    url: Schema.NonEmptyString,
    bearer: Schema.NullOr(Schema.NonEmptyString),
  }),
);
type StoredMcpServer = (typeof storedMcpServersSchema.Type)[number];
const mcpServersKey = "agent-mcp-servers";
const mcpServerIds = defineIdFamily({
  family: "oyster-mcp",
  version: 1,
  kinds: { server: { prefix: "mcp" } },
});
/** The Knapsack connection for one stored server; its bearer goes only to that endpoint. */
function mcpConnection(server: StoredMcpServer): McpServerConnection {
  const connection = {
    id: `mcp.${server.serverId}`,
    name: server.name,
    url: new URL(server.url),
  };
  if (server.bearer === null) return connection;
  return {
    ...connection,
    headers: { authorization: `Bearer ${server.bearer}` },
  };
}
const toMcpServer = (stored: StoredMcpServer): AgentMcpServer => ({
  serverId: stored.serverId,
  name: stored.name,
  url: stored.url,
  hasBearer: stored.bearer !== null,
});

const instructions = [
  "You are an agent on a personal Oyster: a small, self-hosted home for Apps.",
  "Your tool is execute: it runs JavaScript in an isolated sandbox. Each installed App is an env.<APP> module; dotted method names are nested properties, e.g. `return await env.BONSAI.repos.list({})`.",
  "Remote MCP servers the owner connected are env.mcp.<server> modules; call a tool as `return await env.mcp.<server>.<tool>({...})`.",
  "Discover what exists with `return await forage.list({limit:50})` and `return await forage.describe({path})` before calling a method you have not seen.",
  "Only the value your program returns is visible to you; console.log output is not. Always `return` the result.",
  "Be direct and brief. Say plainly when you cannot do something.",
].join("\n");

/** A row of this agent's own inbox, before the directory names the agent. */
export type AgentInboxRows = Readonly<{
  rows: readonly OysterSessionRow[];
  revision: number;
}>;

/** One agent: Shiitake's Cloudflare host over this Durable Object; its root supplies `hostFor`. */
export abstract class StandaloneAgentBase<
  Env extends StandaloneAgentEnv = StandaloneAgentEnv,
> extends ShiitakeDO<Env> {
  /** The deployable root's host for this Agent's pinned tenant. */
  protected abstract hostFor(scope: TenantScope): Promise<OysterHost>;
  /** Each installed Release's verified catalog surface, built once per Release for this Agent's lifetime. */
  #appSurfaces: AppSurfaceCache | undefined;
  private uiOwner: UiConnection | undefined;
  private async machineClient() {
    const pin = await this.policyDirectory();
    const agentId = this.ctx.id.name;
    const identity = () =>
      pin === null || agentId === undefined
        ? null
        : { teamId: pin.directoryName, agentId };
    return createMachineAgentClient({
      identity,
      home: standaloneMachineAgentHome({
        identity,
        directory: this.env.AGENT_DIRECTORY,
      }),
      links: this.env.MACHINE_LINK,
      codecs: machineAgentCodecs,
      // Lend the client only the three hosted Agent entry points it routes to.
      hosted: {
        getByName: (agentId) => {
          const agent = this.env.AGENTS.getByName(agentId);
          return {
            deliver: (envelope) => agent.deliver(envelope),
            fetch: (request) => agent.fetch(request),
            settlement: (principal, sessionId, commandId) =>
              agent.settlement(principal, sessionId, commandId),
          };
        },
      },
    });
  }

  private async ui(): Promise<UiConnection> {
    const { Knapsack } = await import("@fungi.computer/knapsack");
    return (this.uiOwner ??= Knapsack.ui({
      id: "oyster-ui",
      hasSession: (sessionId) => this.hasStoredSession(sessionId),
    }));
  }

  protected override hostFetch(
    request: Request,
  ): Promise<Response> | undefined {
    return new URL(request.url).pathname.startsWith("/browser/")
      ? this.ui().then((connection) => connection.fetch(request))
      : undefined;
  }

  protected override async closeShiitake(): Promise<void> {
    try {
      await (await this.ui()).close();
    } finally {
      await super.closeShiitake();
    }
  }

  private controlDirectory(): AgentControlDirectory {
    const list = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const pin = await this.policyDirectory();
      if (pin === null) throw new Error("Agent directory is unavailable");
      const agents = await this.env.AGENT_DIRECTORY.getByName(
        pin.directoryName,
      ).list();
      if (!agents.some((agent) => agent.agentId === this.ctx.id.name))
        throw new Error("Agent is outside this scope");
      signal.throwIfAborted();
      return agents;
    };
    return {
      list,
      create: async (input, signal) => {
        await list(signal);
        const { assertOrdinaryAgentCreation } =
          await import("@fungi.computer/shiitake-extensions/roster/conversation-agents");
        assertOrdinaryAgentCreation(input);
        const pin = await this.policyDirectory();
        const createdBy = this.ctx.id.name;
        if (pin === null || createdBy === undefined)
          throw new AgentCreateRefused(
            "no_creator",
            "Agent directory is unavailable",
          );
        const directory = this.env.AGENT_DIRECTORY.getByName(pin.directoryName);
        const owner = await directory.readCreator(createdBy);
        if (owner === null)
          throw new AgentCreateRefused(
            "no_creator",
            "Agent credential owner is unavailable",
          );
        const entry = await directory.create(
          input.name ?? `Agent ${input.requestId}`,
          input.requestId,
          { actor: { kind: "member", memberId: owner }, role: "owner" },
          "owner-direct",
          undefined,
          createdBy,
        );
        await this.env.AGENTS.getByName(entry.agentId).usePolicyDirectory(pin);
        return entry;
      },
      send: (input, sessionId, signal, invocation) =>
        this.delegation().send(input, sessionId, signal, invocation),
      recall: (input, sessionId, signal) =>
        this.delegation().recall(input, sessionId, signal),
      open: async (agentId, signal) => {
        const admit = async () => {
          if (!(await list(signal)).some((agent) => agent.agentId === agentId))
            throw new Error("Agent is outside this scope");
        };
        await admit();
        const agent = createShiitakeClient({
          baseUrl: "https://agent.internal",
          fetch: async (input, init) => {
            await admit();
            const request = new Request(input, init);
            if (new URL(request.url).origin !== "https://agent.internal")
              throw new Error("Agent transport origin is invalid");
            return (await this.machineClient()).dispatch(agentId, request);
          },
        });
        return { agent, release: () => agent.close() };
      },
    };
  }

  private delegationOwner: AgentDelegation | undefined;
  private delegation(): AgentDelegation {
    return (this.delegationOwner ??= new AgentDelegation({
      storage: this.ctx.storage,
      expiresAt: () => Date.now() + 60_000,
      identity: async () => {
        const pin = await this.policyDirectory();
        const agentId = this.ctx.id.name;
        return pin === null || agentId === undefined
          ? null
          : { scopeId: pin.directoryName, agentId };
      },
      directory: () => this.controlDirectory(),
      deliver: (mail) => this.mail().deliver(mail),
      prepare: () => Promise.resolve(),
      accept: async (mail, reply) =>
        (await this.shiitake()).acceptMail(mail, mail.meta, reply),
    }));
  }

  /** Host-only mail admission; an HTTP caller never receives this binding. */
  async deliver(envelope: PostEnvelope) {
    return this.delegation().receive(envelope);
  }

  private mailOwner: ReturnType<typeof agentMail> | undefined;
  private conversationAgentsOwner:
    ReturnType<typeof createConversationAgents> | undefined;
  /** The Agents each of this Agent's conversations created or sent work to. */
  private async conversationAgents() {
    const { createConversationAgents } =
      await import("@fungi.computer/shiitake-extensions/roster/conversation-agents");
    return (this.conversationAgentsOwner ??= createConversationAgents(
      this.ctx.storage,
    ));
  }
  private mail() {
    return (this.mailOwner ??= agentMail({
      storage: this.ctx.storage,
      namespace: {
        getByName: (agentId) => ({
          deliver: async (envelope) =>
            (await this.machineClient()).namespace
              .getByName(agentId)
              .deliver(envelope),
        }),
      },
      identity: async () => {
        const pin = await this.policyDirectory();
        const agentId = this.ctx.id.name;
        return pin === null || agentId === undefined
          ? null
          : { scopeId: pin.directoryName, agentId };
      },
      replySettlement: async (mail) => {
        const pin = await this.policyDirectory();
        if (pin === null || mail.reply === undefined)
          throw new Error("Delegated reply identity is unavailable");
        return (await this.machineClient()).settlement(
          mail.from.agentId,
          mail.from.sessionId,
          mail.reply.commandId,
          mail.to.agentId,
        );
      },
      wake: () => this.wakeRuntime(),
    }));
  }

  /** Undefined is disclosure refusal; unavailable evidence fails before RPC. */
  async settlement(
    principal: MachineAgentSettlementPrincipal,
    sessionId: string,
    commandId: string,
  ): Promise<string | undefined> {
    const pin = await this.policyDirectory();
    if (pin?.directoryName !== principal.teamId) return undefined;
    try {
      const facts = await this.delegation().settlement(
        { scopeId: principal.teamId, agentId: principal.actor.id },
        sessionId,
        commandId,
        await this.shiitake(),
      );
      if (facts === undefined)
        throw new Error("Settled delegated command evidence is unavailable");
      return Schema.encodeSync(Schema.fromJsonString(commandSettlementSchema))(
        facts,
      );
    } catch (cause) {
      // A disclosure refusal is data before crossing the DO RPC boundary.
      if (cause instanceof AgentDisclosureRefused) return undefined;
      throw cause;
    }
  }

  /** The root host for this Agent's pinned policy directory; unpinned Agents have no App tools. */
  private async appHost(): Promise<OysterHost | null> {
    const stored = await this.ctx.storage.get("app-policy-directory");
    if (stored === undefined) return null;
    const pinned = Schema.decodeUnknownSync(policyDirectorySchema)(stored);
    const scope = tenantScope(pinned.tenantId, this.env.OYSTER_ORIGIN);
    return pinned.directoryName === scope.durableName("agents")
      ? this.hostFor(scope)
      : null;
  }

  /** Choose this agent's model door; override to plug in another. */
  protected modelSource(): StandaloneModelSource {
    if (this.env.OYSTER_AGENT_MODEL === "@fungi/luna") {
      const egress = configuredProviderEgress(this.env);
      const baseUrl = egress.baseUrl("ai-gateway");
      if (baseUrl === null)
        throw new Error(
          "Configure the Luna AI Gateway Worker secret and gateway",
        );
      return {
        acquire: async (input) => {
          const { openaiProvider } =
            await import("@earendil-works/pi-ai/providers/openai");
          const listed = openaiProvider()
            .getModels()
            .find((item) => item.id === "gpt-6-luna");
          if (listed === undefined)
            throw new Error("The OpenAI catalog has no Luna model");
          const model = { ...listed, id: "openai/gpt-6-luna", baseUrl };
          return observedModels(model, {
            apiKey: "oyster-provider-egress",
            fetch: providerFetch(egress, "ai-gateway"),
          }).acquire(input);
        },
      };
    }
    if (this.env.AI === undefined)
      throw new Error("Configure the AI binding to run agents");
    const options: {
      -readonly [K in keyof WorkersAiOptions]: WorkersAiOptions[K];
    } = {};
    if (this.env.OYSTER_AGENT_MODEL !== undefined)
      options.model = this.env.OYSTER_AGENT_MODEL;
    if (this.env.OYSTER_AI_GATEWAY !== undefined)
      options.gateway = this.env.OYSTER_AI_GATEWAY;
    return workersAiModels(this.env.AI, options);
  }

  /** Host-only initialization; Agent/App transports never receive this directory binding. */
  async usePolicyDirectory(input: {
    directoryName: string;
    tenantId: TenantId;
  }): Promise<void> {
    const directory = Schema.decodeUnknownSync(policyDirectorySchema)(input);
    const previous = await this.ctx.storage.get("app-policy-directory");
    if (previous !== undefined) {
      const pinned = Schema.decodeUnknownSync(policyDirectorySchema)(previous);
      if (
        pinned.directoryName !== directory.directoryName ||
        pinned.tenantId !== directory.tenantId
      )
        throw new Error("Agent policy directory mismatch");
      return;
    }
    await this.ctx.storage.put("app-policy-directory", directory);
  }

  /** Host-only policy pin read, used before an owner can approve tools. */
  async policyDirectory(): Promise<typeof policyDirectorySchema.Type | null> {
    const stored = await this.ctx.storage.get("app-policy-directory");
    return stored === undefined
      ? null
      : Schema.decodeUnknownSync(policyDirectorySchema)(stored);
  }

  /** Listeners from live codemode acquisitions, told when the server list changes. */
  private readonly mcpInvalidations = new Set<() => void>();

  private async storedMcpServers(): Promise<readonly StoredMcpServer[]> {
    const stored = await this.ctx.storage.get(mcpServersKey);
    return stored === undefined
      ? []
      : Schema.decodeUnknownSync(storedMcpServersSchema)(stored);
  }

  private async writeMcpServers(servers: readonly StoredMcpServer[]) {
    await this.ctx.storage.put(mcpServersKey, servers);
    for (const invalidate of this.mcpInvalidations) invalidate();
  }

  /** Host-only: this Agent's MCP servers, without their bearer tokens. */
  async mcpServers(): Promise<readonly AgentMcpServer[]> {
    return (await this.storedMcpServers()).map(toMcpServer);
  }

  /** Host-only: connect one remote MCP server, admitted by the owner route. */
  async addMcpServer(
    input: AgentMcpServerInput,
  ): Promise<AgentMcpServer | AgentMcpServerRefusal> {
    const servers = await this.storedMcpServers();
    if (servers.some((server) => server.name === input.name))
      return { error: "duplicate_name" };
    if (servers.length >= maxAgentMcpServers) return { error: "limit" };
    const added: StoredMcpServer = {
      serverId: mcpServerIds.server.generate(),
      name: input.name,
      url: new URL(input.url).href,
      bearer: input.bearer,
    };
    await this.writeMcpServers([...servers, added]);
    return toMcpServer(added);
  }

  /** Host-only: disconnect one MCP server. */
  async removeMcpServer(serverId: string): Promise<boolean> {
    const servers = await this.storedMcpServers();
    const kept = servers.filter((server) => server.serverId !== serverId);
    if (kept.length === servers.length) return false;
    await this.writeMcpServers(kept);
    return true;
  }

  protected override async shiitakeOptions(): Promise<CloudflareShiitakeOptions> {
    const [{ oysterAgentExtensions }, { Knapsack }] = await Promise.all([
      import("@fungi.computer/shiitake-extensions/roster/conversation-agents"),
      import("@fungi.computer/knapsack"),
    ]);
    const conversationAgents = await this.conversationAgents();
    const keeping = agentStoreKeeping(this.ctx.storage, (request) =>
      this.readColdSessions(request),
    );
    const principal = {
      actor: { kind: "agent", agentId: this.ctx.id.name ?? "agent" },
    } as const;
    return {
      model: this.modelSource(),
      meta: { schema: FungiMessageMetaSchema },
      ...this.mail().host,
      instructions: {
        load: () =>
          Promise.resolve({ revision: "oyster-4", text: instructions }),
      },
      tools: {
        sources: [
          {
            id: "oyster-apps",
            // Capture once per catalog acquisition, so the next run sees
            // changed Releases, installation authority and removals.
            acquire: async (context) => {
              const host = await this.appHost();
              if (host === null)
                return {
                  snapshot: { version: "unpinned", modules: [] },
                  release: () => Promise.resolve(),
                };
              const policy =
                (await host.appToolPolicy?.(principal.actor)) ?? null;
              const { appSurfaceCache, oysterAppMethods } =
                await import("../mcp.js");
              this.#appSurfaces ??= appSurfaceCache(host);
              const source = await oysterAppMethods(
                host,
                principal,
                policy === null ? null : { kind: "agent", policy },
                this.#appSurfaces,
              );
              return source.acquire(context);
            },
          },
          Knapsack.mcpServers({
            id: "agent-mcp",
            read: async () => {
              const servers = await this.storedMcpServers();
              return {
                // Secret-free: ids and endpoints, never the bearer.
                version: JSON.stringify(
                  servers.map((server) => [server.serverId, server.url]),
                ),
                servers: servers.map(mcpConnection),
              };
            },
            subscribe: (invalidate) => {
              this.mcpInvalidations.add(invalidate);
              return () => this.mcpInvalidations.delete(invalidate);
            },
            onUnavailable: (error) => {
              console.warn("agent MCP server unavailable", {
                serverId: error.serverId,
                reason: error.reason,
              });
            },
            // The Worker's own egress: public internet only.
            fetch: (url, init) => fetch(url, init),
          }),
          conversationAgents.control(() => this.controlDirectory()),
          (await this.ui()).source,
          standaloneBrowserSource(this.env.BROWSER, () => ({
            teamId: this.env.OYSTER_ORIGIN,
            agentId: principal.actor.agentId,
          })),
        ],
        sandbox: createCodemodeSandbox(this.env.LOADER, "oyster-workerd"),
      },
      extensions: oysterAgentExtensions(
        conversationAgents.source(this.controlDirectory()),
      ),
      ...keeping,
      hostWork: [...this.mail().host.hostWork, ...keeping.hostWork],
    };
  }

  /** Send an installation-admitted message through fleet Session operations. */
  async sendFromApp(
    installationId: string,
    sessionId: string,
    message: FleetMessage,
  ) {
    const id = this.ctx.id.name;
    if (id === undefined) throw new Error("Agent address is unnamed");
    const sessions = createFleetSessions(async () => ({
      agent: await this.shiitake(),
      release: () => Promise.resolve(),
    }));
    const grant: AgentGrant = {
      agents: [id],
      actions: ["send"],
      expiresAt: Date.now() + 60_000,
      provenance: { actor: installationId },
    };
    return sessions.send(grant, id, sessionId, message);
  }

  /** Latest inbox clock from the same Shiitake owner, without reading Session rows. */
  async revision(): Promise<number> {
    await this.shiitake();
    return this.readInboxRevision();
  }

  /** Every live Session of this agent, as inbox rows. */
  async inboxRows(): Promise<AgentInboxRows> {
    const changes = await this.readInboxChanges(0, 1_000);
    const rows: OysterSessionRow[] = [];
    for (const row of changes.rows) {
      if ("deleted" in row) continue;
      rows.push(row);
    }
    return { rows, revision: changes.latest };
  }
}

const actingInstallationSchema = Schema.Union([
  Schema.Literal("owner-direct"),
  Schema.Struct({ installationId: Schema.NonEmptyString }),
]);
const approverVersionSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const storedPolicySchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
    level: Schema.Literals(["read", "write"]),
    revision: Schema.NonEmptyString,
    actingInstallation: actingInstallationSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    policy: appToolPolicySchema,
    membershipVersion: approverVersionSchema,
    actingInstallation: actingInstallationSchema,
  }),
]);
type StoredPolicy = typeof storedPolicySchema.Type;

const visitRow = Schema.Struct({
  agent_id: Schema.String,
  session_id: Schema.String,
  visited_at: Schema.Number,
});
const counterRow = Schema.Struct({ value: Schema.Number });

/** Names this Oyster's agents and remembers which Sessions the member opened. */
export class AgentDirectory extends DurableObject<StandaloneAgentEnv> {
  private readonly directory: ReturnType<typeof createAgentDirectory>;
  private readonly avatars: AgentAvatarStore;
  private composedTenancy: Promise<StandaloneTenancy> | undefined;
  private machineEnrollmentOwner:
    ReturnType<typeof createStandaloneMachineEnrollment> | undefined;
  private machineFencesOwner:
    ReturnType<typeof createMachineLinkFences> | undefined;

  private machineScope() {
    return tenantScope(defaultTenant, this.env.OYSTER_ORIGIN);
  }

  private machineEnrollment() {
    const env = this.env;
    const scope = this.machineScope();
    return (this.machineEnrollmentOwner ??= createStandaloneMachineEnrollment({
      owner: this.ctx.storage,
      scopeId: scope.durableName("agents"),
      ownerId: async () => {
        if (env.TENANTS === undefined) return null;
        if (this.ctx.id.name !== scope.durableName("agents")) return null;
        // An inactive/missing scope must not cold-start tenancy's seed path.
        const tenant =
          await env.TENANTS.getByName("registry").get(defaultTenant);
        if (tenant?.status !== "active") return null;
        const tenancy = await standaloneTenancy({
          ...env,
          TENANTS: env.TENANTS,
        });
        return (await tenancy.owner())?.actor.memberId ?? null;
      },
      liveKey: (keyId) =>
        env.KEYS.getByName(scope.durableName("keys")).live(keyId),
      onAgentCreated: () => {
        this.bump();
      },
    }));
  }

  /** Host-only join: consumption, enrollment and directory share one commit. */
  async enrollMachine(
    keyId: string,
    input: MachineEnrollment,
  ): Promise<StandaloneMachineJoinResult> {
    try {
      return {
        kind: "enrolled",
        value: await this.machineEnrollment().enrollWithKey(keyId, input),
      };
    } catch (cause) {
      if (cause instanceof MachineEnrollmentRefused)
        return {
          kind: "refused",
          error:
            cause.reason === "request_conflict" || cause.reason === "capacity"
              ? cause.reason
              : "not_allowed",
        };
      if (cause instanceof MachineLinkRefused)
        return { kind: "refused", error: "not_allowed" };
      if (cause instanceof DOMException && cause.name === "DataError")
        return { kind: "refused", error: "invalid_enrollment" };
      throw cause;
    }
  }

  machineDevice(id: MachineLinkIdentity) {
    return this.machineEnrollment().admitDevice(id);
  }

  machineFence(id: MachineLinkIdentity) {
    return this.machineEnrollment().currentFence(id);
  }

  machineDirectory(id: MachineLinkIdentity) {
    return this.machineEnrollment().publicDirectory(id);
  }

  machineTarget(
    caller: MachineLinkCaller,
    agentId: string,
    requester: string | null,
  ) {
    return this.machineEnrollment().target(caller, agentId, requester);
  }

  machineKeyRetired(deviceId: string) {
    return this.machineEnrollment().keyRetired(deviceId);
  }

  /** Catalog home only; no hosted DO is opened to discover a machine home. */
  agentHome(agentId: string): Promise<MachineAgentHome | null> {
    if (!this.has(agentId)) return Promise.resolve(null);
    if (
      this.ctx.id.name !==
      tenantScope(defaultTenant, this.env.OYSTER_ORIGIN).durableName("agents")
    )
      return Promise.resolve({ kind: "hosted" });
    return Promise.resolve(
      this.machineEnrollment().home(agentId) ?? { kind: "hosted" },
    );
  }

  private machineFences() {
    if (this.env.TENANTS === undefined)
      throw new MachineLinkRefused("actor_not_allowed");
    const env = { ...this.env, TENANTS: this.env.TENANTS };
    const enrollment = this.machineEnrollment();
    const authority = () => standaloneMachineLinkAuthority(env);
    return (this.machineFencesOwner ??= createMachineLinkFences({
      owner: this.ctx.storage,
      enrollment,
      readFact: (deviceId) =>
        authority().currentFence({
          teamId: this.machineScope().durableName("agents"),
          deviceId,
        }),
      push: (fact) => authority().deliverControlFact(fact),
      wakeNow: () => {
        this.ctx.waitUntil(
          this.ctx.storage.setAlarm(Date.now()).catch((cause: unknown) => {
            console.error("machine-link.first-fence-wake", cause);
          }),
        );
      },
      retryDelayMs: (failures) =>
        Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)),
      report: (operation, cause) => {
        console.error(operation, cause);
      },
    }));
  }

  private async armMachineFenceAlarm() {
    const due = this.machineFences().family.nextDue();
    if (due === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(due);
  }

  /** Only the current canonical owner can retire a device, before fence push. */
  async revokeMachineDevice(memberId: string, deviceId: string) {
    if (this.env.TENANTS === undefined)
      throw new MachineLinkRefused("actor_not_allowed");
    const owner = await (
      await standaloneTenancy({ ...this.env, TENANTS: this.env.TENANTS })
    ).owner();
    if (owner?.actor.memberId !== memberId)
      throw new MachineLinkRefused("actor_not_allowed");
    try {
      return await this.machineFences().revoke(memberId, deviceId);
    } finally {
      await this.armMachineFenceAlarm();
    }
  }

  override async alarm() {
    try {
      await this.machineFences().family.deliver();
    } finally {
      await this.armMachineFenceAlarm();
    }
  }

  private grant(): AgentGrant {
    return {
      agents: "all",
      actions: ["create", "read", "manage"],
      expiresAt: Date.now() + 60_000,
      provenance: { actor: this.env.OYSTER_OWNER_NAME ?? "owner" },
    };
  }

  constructor(ctx: DurableObjectState, env: StandaloneAgentEnv) {
    super(ctx, env);
    this.directory = createAgentDirectory(ctx.storage.sql);
    this.avatars = createAgentAvatarStore(ctx.storage.sql);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS visits (agent_id TEXT NOT NULL, session_id TEXT NOT NULL, visited_at INTEGER NOT NULL, PRIMARY KEY (agent_id, session_id)) STRICT",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS app_tool_policies (agent_id TEXT PRIMARY KEY, policy TEXT NOT NULL) STRICT",
    );
  }

  list(): readonly AgentEntry[] {
    return this.directory
      .list(this.grant())
      .toReversed()
      .map(({ agentId, name, createdBy }) => ({
        agentId,
        createdBy,
        name,
        avatar: this.avatars.read(agentId),
      }));
  }

  has(agentId: string): boolean {
    const id = agentIds.agent.parse(agentId);
    return id.ok && this.directory.read(this.grant(), id.value) !== null;
  }

  /** Resolve the existing recorded creator for host-side owner admission. */
  readCreator(agentId: string): string | null {
    return this.directory.readCreator(this.grant(), agentId);
  }

  /** Owner-only rename; refuses a name already held by another Agent. */
  rename(
    agentId: string,
    name: string,
    principal: OysterPrincipal,
  ):
    | AgentEntry
    | Readonly<{ error: "not_found" | "name_taken" | "not_granted" }> {
    if (!oysterPrincipalIsOwner(principal)) return { error: "not_granted" };
    const id = agentIds.agent.parse(agentId);
    if (!id.ok) return { error: "not_found" };
    return this.ctx.storage.transactionSync(() => {
      try {
        const renamed = this.directory.rename(this.grant(), id.value, {
          name,
        });
        this.bump();
        return {
          agentId: renamed.agentId,
          createdBy: renamed.createdBy,
          name: renamed.name,
          avatar: this.avatars.read(renamed.agentId),
        };
      } catch (cause) {
        if (cause instanceof DirectoryError && cause.code === "not_found")
          return { error: "not_found" } as const;
        if (cause instanceof DirectoryError && cause.code === "name_taken")
          return { error: "name_taken" } as const;
        throw cause;
      }
    });
  }

  /** Owner-only avatar change; the Agent wears it in every App and list. */
  setAvatar(
    agentId: string,
    avatar: Avatar,
    principal: OysterPrincipal,
  ): AgentEntry | Readonly<{ error: "not_found" | "not_granted" }> {
    if (!oysterPrincipalIsOwner(principal)) return { error: "not_granted" };
    const id = agentIds.agent.parse(agentId);
    if (!id.ok) return { error: "not_found" };
    return this.ctx.storage.transactionSync(() => {
      const agent = this.directory.read(this.grant(), id.value);
      if (agent === null) return { error: "not_found" } as const;
      this.avatars.write(agent.agentId, avatar);
      this.bump();
      return {
        agentId: agent.agentId,
        createdBy: agent.createdBy,
        name: agent.name,
        avatar: this.avatars.read(agent.agentId),
      };
    });
  }

  create(
    name: string,
    requestId: string,
    principal: OysterPrincipal,
    actor: AgentPolicyActor,
    avatar?: Avatar,
    createdBy: string | null = null,
  ): AgentEntry & { policyRevision: string | null } {
    if (!oysterPrincipalIsOwner(principal))
      throw new Error("Only the authenticated owner creates Agents");
    if (
      createdBy !== null &&
      (!this.has(createdBy) ||
        this.readCreator(createdBy) !== oysterPrincipalId(principal))
    )
      throw new AgentCreateRefused(
        "no_creator",
        "Agent is outside this credential owner's scope",
      );
    return this.ctx.storage.transactionSync(() => {
      const { agent, fact } = this.directory.create(
        {
          ...this.grant(),
          provenance: { actor: oysterPrincipalId(principal) },
        },
        { name, requestId, configuration: "none", createdBy },
      );
      if (fact !== null) {
        if (avatar !== undefined) this.avatars.write(agent.agentId, avatar);
        this.bump();
        this.writePolicy(agent.agentId, {
          status: "pending",
          level: "write",
          revision: `${agent.agentId}:${String(this.revision())}`,
          actingInstallation: actor,
        });
      }
      const stored = this.storedPolicy(agent.agentId);
      return {
        agentId: agent.agentId,
        createdBy: agent.createdBy,
        name: agent.name,
        avatar: this.avatars.read(agent.agentId),
        policyRevision:
          stored === null
            ? null
            : stored.status === "pending"
              ? stored.revision
              : null,
      };
    });
  }

  private writePolicy(agentId: string, policy: StoredPolicy): void {
    const encoded = Schema.encodeSync(
      Schema.fromJsonString(storedPolicySchema),
    )(policy);
    this.ctx.storage.sql.exec(
      "INSERT INTO app_tool_policies(agent_id,policy) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET policy=excluded.policy",
      agentId,
      encoded,
    );
  }
  private storedPolicy(agentId: string): StoredPolicy | null {
    if (!this.has(agentId)) return null;
    return this.readPolicy(
      "SELECT policy FROM app_tool_policies WHERE agent_id=?",
      agentId,
    );
  }
  private readPolicy(query: string, id: string): StoredPolicy | null {
    const row = this.ctx.storage.sql.exec(query, id).toArray()[0];
    if (row === undefined) return null;
    const stored = Schema.decodeUnknownSync(
      Schema.Struct({ policy: Schema.String }),
    )(row);
    const parsed = Schema.decodeUnknownOption(
      Schema.fromJsonString(storedPolicySchema),
      { onExcessProperty: "error" },
    )(stored.policy);
    return parsed._tag === "Some" ? parsed.value : null;
  }
  /** Current revision for the direct owner's compare-and-swap request. */
  policyRevision(agentId: string): string | null {
    const stored = this.storedPolicy(agentId);
    return stored === null
      ? null
      : stored.status === "pending"
        ? stored.revision
        : stored.policy.revision;
  }
  /** Whether this Agent's App-tool policy still awaits the owner's approval. */
  policyStatus(
    agentId: string,
  ): Readonly<{ status: "pending" | "approved"; revision: string }> | null {
    const stored = this.storedPolicy(agentId);
    if (stored === null) return null;
    return stored.status === "pending"
      ? { status: "pending", revision: stored.revision }
      : { status: "approved", revision: stored.policy.revision };
  }
  private async currentMember(tenantId: TenantId, memberId: string) {
    if (this.env.TENANCY !== undefined)
      return this.env.TENANCY.memberById(tenantId, memberId);
    // KEYS is always present on StandaloneAgentEnv (via StandaloneComputerEnv).
    if (this.env.TENANTS === undefined) return null;
    let configured: StandaloneTenancyEnv = {
      TENANTS: this.env.TENANTS,
      KEYS: this.env.KEYS,
      OYSTER_ORIGIN: this.env.OYSTER_ORIGIN,
      OYSTER_OWNER_KEY: this.env.OYSTER_OWNER_KEY,
    };
    if (this.env.OYSTER_OWNER_NAME !== undefined)
      configured = {
        ...configured,
        OYSTER_OWNER_NAME: this.env.OYSTER_OWNER_NAME,
      };
    const pending = (this.composedTenancy ??= standaloneTenancy(configured));
    const composed = await pending.catch((cause: unknown) => {
      if (this.composedTenancy === pending) this.composedTenancy = undefined;
      throw cause;
    });
    const owner = await composed.owner();
    if (
      owner === null ||
      tenantId !== composed.tenantId ||
      owner.actor.memberId !== memberId
    )
      return null;
    return composed.tenancy.memberById(tenantId, memberId);
  }

  /** Approval stays revoked after any membership authority revision. */
  async appToolPolicy(
    actor: Extract<HostActor, { kind: "agent" }>,
    tenantId: TenantId = defaultTenant,
  ): Promise<AppToolPolicy | null> {
    const stored = this.storedPolicy(actor.agentId);
    if (stored?.status !== "approved") return null;
    const current = await this.currentMember(tenantId, stored.policy.grantedBy);
    return current !== null &&
      oysterPrincipalIsOwner(current) &&
      oysterPrincipalId(current) === stored.policy.grantedBy &&
      current.membershipVersion === stored.membershipVersion
      ? stored.policy
      : null;
  }
  /** Only direct human approval records an authenticated canonical grantor. */
  async approveAppToolPolicy(
    agentId: string,
    principal: OysterPrincipal,
    level: AppToolPolicy["level"],
    expectedRevision: string | null,
    actor: AgentPolicyActor,
    tenantId: TenantId,
  ): Promise<Awaited<ReturnType<OysterAgents["approveAppToolPolicy"]>>> {
    if (!oysterPrincipalIsOwner(principal)) return { error: "not_granted" };
    if (!this.has(agentId)) return { error: "not_found" };
    const member =
      actor === "owner-direct"
        ? await this.currentMember(tenantId, oysterPrincipalId(principal))
        : null;
    if (
      actor === "owner-direct" &&
      (member === null ||
        !oysterPrincipalIsOwner(member) ||
        !Schema.is(approverVersionSchema)(member.membershipVersion) ||
        oysterPrincipalId(member) !== oysterPrincipalId(principal))
    )
      return { error: "not_granted" };
    return this.ctx.storage.transactionSync(() => {
      const current = this.storedPolicy(agentId);
      const revision =
        current === null
          ? null
          : current.status === "pending"
            ? current.revision
            : current.policy.revision;
      if (revision !== expectedRevision) return { error: "revision_conflict" };
      this.bump();
      const nextRevision = `${agentId}:${String(this.revision())}`;
      if (actor !== "owner-direct" || member === null) {
        this.writePolicy(agentId, {
          status: "pending",
          level,
          revision: nextRevision,
          actingInstallation: actor,
        });
        return { status: "pending", revision: nextRevision };
      }
      const policy = {
        level,
        revision: nextRevision,
        grantedBy: oysterPrincipalId(member),
      };
      this.writePolicy(agentId, {
        status: "approved",
        policy,
        membershipVersion: member.membershipVersion,
        actingInstallation: actor,
      });
      return policy;
    });
  }

  visit(agentId: string, sessionId: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO visits(agent_id, session_id, visited_at) VALUES(?,?,?) ON CONFLICT(agent_id, session_id) DO UPDATE SET visited_at=excluded.visited_at",
      agentId,
      sessionId,
      Date.now(),
    );
    this.bump();
  }

  visits(): readonly Readonly<{
    agentId: string;
    sessionId: string;
    visitedAt: number;
  }>[] {
    return this.ctx.storage.sql
      .exec("SELECT agent_id, session_id, visited_at FROM visits")
      .toArray()
      .map((row) => {
        const decoded = Schema.decodeUnknownSync(visitRow)(row);
        return {
          agentId: decoded.agent_id,
          sessionId: decoded.session_id,
          visitedAt: decoded.visited_at,
        };
      });
  }

  /** Grows on every directory change (a new agent, a visit). */
  revision(): number {
    const row = this.ctx.storage.sql
      .exec("SELECT value FROM counters WHERE name='revision'")
      .toArray()[0];
    return row === undefined
      ? 0
      : Schema.decodeUnknownSync(counterRow)(row).value;
  }

  private bump(): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO counters(name, value) VALUES('revision', 1) ON CONFLICT(name) DO UPDATE SET value=value+1",
    );
  }
}

const everyOperation: OysterAgent["sessionOperations"] = [
  "agent.read",
  "agent.send",
  "agent.manage",
];

/** The `agents` adapter over a Worker's agent bindings. */
export function standaloneAgents(
  env: StandaloneAgentsEnv,
  scope?: TenantScope,
): OysterAgents {
  const directoryName =
    scope === undefined ? "agents" : scope.durableName("agents");
  const directory = () =>
    scope === undefined
      ? env.AGENT_DIRECTORY.getByName(directoryName)
      : agentDirectoryForScope(env, scope);
  const toAgent = (entry: AgentEntry): OysterAgent => ({
    agentId: entry.agentId,
    name: entry.name,
    avatar: entry.avatar,
    sessionOperations: everyOperation,
  });
  return {
    list: async () => (await directory().list()).map(toAgent),
    create: async (name, requestId, principal, actor, avatar) => {
      const entry = await directory().create(
        name,
        requestId,
        principal,
        actor,
        avatar,
      );
      await env.AGENTS.getByName(entry.agentId).usePolicyDirectory({
        directoryName,
        tenantId: scope?.tenantId ?? defaultTenant,
      });
      if (actor === "owner-direct" && entry.policyRevision !== null) {
        // Best-effort: a stale membership lookup leaves the Agent pending
        // rather than failing its creation. Grove's "Allow App tools"
        // control recovers it through the same approval path.
        await directory().approveAppToolPolicy(
          entry.agentId,
          principal,
          "write",
          entry.policyRevision,
          actor,
          scope?.tenantId ?? defaultTenant,
        );
      }
      return toAgent(entry);
    },
    rename: async (agentId, name, principal) => {
      const result = await directory().rename(agentId, name, principal);
      return "error" in result ? result : toAgent(result);
    },
    setAvatar: async (agentId, avatar, principal) => {
      const result = await directory().setAvatar(agentId, avatar, principal);
      return "error" in result ? result : toAgent(result);
    },
    policyStatus: async (agentId) => directory().policyStatus(agentId),
    appToolPolicy: (actor) =>
      directory().appToolPolicy(actor, scope?.tenantId ?? defaultTenant),
    policyRevision: (agentId) => directory().policyRevision(agentId),
    approveAppToolPolicy: async (
      agentId,
      principal,
      level,
      expectedRevision,
      actor,
    ) => {
      if (!(await directory().has(agentId))) return { error: "not_found" };
      const pinned = await env.AGENTS.getByName(agentId).policyDirectory();
      if (
        pinned?.directoryName !== directoryName ||
        pinned.tenantId !== (scope?.tenantId ?? defaultTenant)
      )
        return { error: "not_found" };
      return directory().approveAppToolPolicy(
        agentId,
        principal,
        level,
        expectedRevision,
        actor,
        scope?.tenantId ?? defaultTenant,
      );
    },
    mcpServers: async (agentId) =>
      (await directory().has(agentId))
        ? await env.AGENTS.getByName(agentId).mcpServers()
        : null,
    addMcpServer: async (agentId, input) =>
      (await directory().has(agentId))
        ? await env.AGENTS.getByName(agentId).addMcpServer(input)
        : { error: "not_found" },
    removeMcpServer: async (agentId, serverId) =>
      (await directory().has(agentId)) &&
      (await env.AGENTS.getByName(agentId).removeMcpServer(serverId)),
    fetch: async (agentId, request) => {
      const home = await directory().agentHome(agentId);
      if (home?.kind === "machine") {
        const refusal = new MachineLinkRefused("actor_not_allowed");
        return Response.json({ error: refusal.reason }, { status: 409 });
      }
      return home?.kind === "hosted"
        ? await env.AGENTS.getByName(agentId).fetch(request)
        : null;
    },
    inbox: async () => {
      const [agents, visits, directoryRevision] = await Promise.all([
        directory().list(),
        directory().visits(),
        directory().revision(),
      ]);
      const visited = new Map(
        visits.map((visit) => [
          `${visit.agentId}\u0000${visit.sessionId}`,
          visit.visitedAt,
        ]),
      );
      const items: OysterInboxItem[] = [];
      // Each agent's revision only grows, so their sum with the directory's does too.
      let revision = directoryRevision;
      const inboxes = await Promise.all(
        agents.map(async (agent) => {
          const agentHost: Pick<StandaloneAgentBase, "inboxRows"> =
            env.AGENTS.getByName(agent.agentId);
          return { agent, own: await agentHost.inboxRows() };
        }),
      );
      for (const { agent, own } of inboxes) {
        revision += own.revision;
        for (const row of own.rows) {
          const visitedAt = visited.get(
            `${agent.agentId}\u0000${row.sessionId}`,
          );
          if (row.state === "unavailable" || visitedAt === undefined)
            items.push({ ...row, agentId: agent.agentId });
          else items.push({ ...row, agentId: agent.agentId, visitedAt });
        }
      }
      return { items, revision };
    },
    revision: async () => {
      const [agents, directoryRevision] = await Promise.all([
        directory().list(),
        directory().revision(),
      ]);
      const revisions = await Promise.all(
        agents.map((agent) => env.AGENTS.getByName(agent.agentId).revision()),
      );
      return revisions.reduce(
        (total, revision) => total + revision,
        directoryRevision,
      );
    },
    visit: async (agentId, sessionId) => {
      if (!(await directory().has(agentId))) return false;
      await directory().visit(agentId, sessionId);
      return true;
    },
  };
}

const agentTarget = z.strictObject({
  agentId: z.string(),
  sessionId: z.string(),
});
const agentBindingArgs = {
  INBOX: {
    page: z.tuple([
      z.strictObject({ after: z.string().nullable().optional() }).optional(),
    ]),
    visit: z.tuple([agentTarget]),
  },
  AGENTS: {
    send: z.tuple([
      agentTarget.extend({
        requestId: z
          .string()
          .min(1)
          .max(256)
          .refine((value) => new TextEncoder().encode(value).byteLength <= 256),
        text: z.string(),
        delivery: z.literal("followUp"),
      }),
    ]),
  },
};

const inboxPageSchema = Schema.Struct({
  items: Schema.Array(memberInboxItemSchema),
  next: Schema.Null,
  cursor: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const inboxVisitSchema = Schema.Struct({ visited: Schema.Literal(true) });
const decodeInboxPage = Schema.decodeUnknownSync(inboxPageSchema, {
  onExcessProperty: "error",
});
const decodeInboxVisit = Schema.decodeUnknownSync(inboxVisitSchema, {
  onExcessProperty: "error",
});
const decodeAgentAccepted = Schema.decodeUnknownSync(AcceptedSchema, {
  onExcessProperty: "error",
});

/** Shared packet codecs; the Instance alone admits the current frame's operations. */
export const agentFrameMethods = {
  INBOX: {
    page: {
      decodeArgs: (raw) => agentBindingArgs.INBOX.page.parse(raw),
      decodeResult: decodeInboxPage,
      requiredOperations: () => ["page"],
    },
    visit: {
      decodeArgs: (raw) => agentBindingArgs.INBOX.visit.parse(raw),
      decodeResult: decodeInboxVisit,
      requiredOperations: () => ["visit"],
    },
  },
  AGENTS: {
    send: {
      decodeArgs: (raw) => agentBindingArgs.AGENTS.send.parse(raw),
      decodeResult: decodeAgentAccepted,
      requiredOperations: () => ["send"],
    },
  },
} satisfies FrameBindingMethods<OysterJson>;

/** Provider effects are admitted by the originating Instance's live frame. */
export async function dispatchAgentBinding(
  env: StandaloneAgentsEnv,
  scope: TenantScope,
  frame: InvocationFrame,
  props: FrameBindingProps,
  method: string,
  args: readonly unknown[],
): Promise<OysterJson> {
  frame.signal.throwIfAborted();
  if (frame.facts.selection.owner.kind !== "installation")
    throw new AppInstanceError("revoked");
  const installationId = frame.facts.selection.owner.id;
  const directory = agentDirectoryForScope(env, scope);
  let result:
    | { items: readonly OysterInboxItem[]; next: null; cursor: number }
    | { visited: true }
    | Pick<
        Awaited<ReturnType<StandaloneAgentBase["sendFromApp"]>>,
        "status" | "commandId"
      >;
  if (props.binding === "INBOX" && method === "page") {
    agentBindingArgs.INBOX.page.parse(args);
    const inbox = await standaloneAgents(env, scope).inbox();
    result = { items: inbox.items, next: null, cursor: inbox.revision };
  } else if (props.binding === "INBOX" && method === "visit") {
    const [input] = agentBindingArgs.INBOX.visit.parse(args);
    if (!(await directory.has(input.agentId))) throw new Error("No such agent");
    frame.signal.throwIfAborted();
    await directory.visit(input.agentId, input.sessionId);
    result = { visited: true };
  } else if (props.binding === "AGENTS" && method === "send") {
    const [input] = agentBindingArgs.AGENTS.send.parse(args);
    if (!(await directory.has(input.agentId))) throw new Error("No such agent");
    const home = await directory.agentHome(input.agentId);
    if (home?.kind === "machine")
      throw new MachineLinkRefused("actor_not_allowed");
    if (home === null) throw new AppInstanceError("revoked");
    frame.signal.throwIfAborted();
    const accepted = await env.AGENTS.getByName(input.agentId).sendFromApp(
      installationId,
      input.sessionId,
      {
        requestId: input.requestId,
        text: input.text,
        delivery: input.delivery,
      },
    );
    result = { status: accepted.status, commandId: accepted.commandId };
  } else {
    throw new AppInstanceError("revoked");
  }
  frame.signal.throwIfAborted();
  return Schema.decodeUnknownSync(
    Schema.Union([inboxPageSchema, inboxVisitSchema, AcceptedSchema]),
    { onExcessProperty: "error" },
  )(result);
}
