import {
  isRetryableProviderRejection,
  normalizeModel,
  observeProviderStatus,
  streamModel,
  type ProviderRejection,
} from "@fungi.computer/mule/effect";
import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
} from "@fungi.computer/mule/effect";
import {
  standaloneTenancy,
  type StandaloneTenancy,
  type StandaloneTenancyEnv,
} from "./tenancy.js";
import { AcceptedSchema } from "@fungi.computer/shiitake/client";
import { createShiitakeClient } from "@fungi.computer/shiitake/client";
import { ShiitakeError } from "@fungi.computer/shiitake";
import {
  AgentArchiveRefused,
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
  createChannelConversations,
  type ChannelConversation,
  type ChannelConversations,
} from "../channels/conversations.js";
import {
  transcriptLine,
  type WebsiteTranscript,
} from "@fungi.computer/nacre/website-channels";
import type { ConversationBinding } from "../channels/binding.js";
import {
  personChannelInstructions,
  type CreateWebsiteInput,
  type UpdateWebsiteInput,
  type WebsiteBinding,
} from "../channels/web-binding.js";
import { decideChannelRunSafely } from "../channels/run-decision.js";
import {
  createWebsiteChannelOwner,
  websiteOutcome,
  type WebsiteChannelOwner,
  type WebsiteRefusal,
  type WebsiteSite,
} from "./website-channels.js";
import { channelSessionDoor } from "./channel-session-door.js";
import { createAuthenticatedVisitorChannel } from "../channels/visitor-channel.js";
import { verifyVisitor, type ProvenVisitor } from "./visitor-proof.js";
import { createVisitorStreamSlots } from "../channels/visitor-stream-slots.js";
import type { VisitorReadOptions } from "../channels/conversations.js";
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
/** Workers AI binding surface used by the standalone provider adapter. */
export type AiBinding = {
  aiGatewayLogId: string | null;
  /** AI binding transport supplied by the Worker runtime. */
  fetch?: (
    input: Request | string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
};

/**
 * Agents on a standalone Oyster Worker. Each agent is Shiitake's public
 * Cloudflare host (`ShiitakeDO`), one Durable Object per agent; a directory
 * Durable Object names them and keeps the member's visits. The model comes
 * from a pluggable `ModelSource`; the default runs Workers AI through the
 * Worker's AI binding, with no API token.
 */
import { agentDirectoryForScope } from "./agent-directory.js";
import {
  createAgentComputers,
  type ComputerAttachmentInput,
} from "../agent-computers.js";
import {
  createAgentComputerSource,
  readAgentComputerConnections,
  type AgentComputerSnapshot,
  type AgentComputerConnection,
} from "../agent-computer-source.js";
import {
  standaloneAgentComputerPorts,
  standaloneBrowserSave,
  type StandaloneAgentComputerAccess,
  type StandaloneAgentComputerReply,
} from "./agent-computers.js";
import {
  FleetGrantRefused,
  type ComputerGrant,
} from "@fungi.computer/computer/fleet";
import {
  homeExtension,
  homeGrant,
} from "@fungi.computer/shiitake-extensions/home/host";
import { homeContract } from "@fungi.computer/shiitake-extensions/home";
import { DurableObject } from "cloudflare:workers";
import type { StandaloneComputerEnv } from "./computer.js";
import { ShiitakeDO } from "@fungi.computer/shiitake/cloudflare";
import { agentStoreKeeping } from "./agent-store.js";
import type {
  CredentialStorage,
  StoredCredential,
} from "@fungi.computer/veil/credential-store";
import {
  createInstanceCredentialStore,
  createModelKeyVault,
  ModelKeyRefused,
  type ModelKeyRecord,
  type ModelKeyRefusal,
  type ModelKeySealInput,
} from "./model-key-vault.js";
import { agentArchiveOwner } from "./agent-archive-owner.js";
import { agentArchiveProjection } from "../agent-archive-projection.js";
import {
  standaloneBrowserLiveView,
  standaloneBrowserSource,
} from "./browser.js";
import { standaloneWebSource } from "./web.js";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import {
  configuredProviderEgress,
  providerFetch,
} from "@fungi.computer/veil/gatekeeper";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  agentModelChoice,
  agentModelChoiceSchema,
  AgentModelRefused,
  selectAgentModel,
  type AgentModelChoice,
  type AgentModelRefusal,
} from "./agent-model-choice.js";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { agentModelListSchema } from "@fungi.computer/shiitake/model-list";
import * as Schema from "effect/Schema";
import { z } from "zod";
import {
  type FrameBindingMethods,
  type FrameBindingProps,
} from "../cloudflare.js";
import { AppInstanceError } from "../index.js";
import {
  agentScheduleBindingArgs,
  appAgentScheduleListInputSchema,
  agentSchedulePageSchema,
  agentScheduleControlReceiptSchema,
  type AppAgentScheduleListInput,
  type AgentSchedulePage,
  type AgentScheduleTarget,
  type AgentScheduleControlReceipt,
} from "../agent-schedules.js";
import {
  readAgentSchedulePage,
  controlAgentSchedule,
} from "@fungi.computer/shiitake-extensions/schedules/client";
import { agentScheduleTargetSchema } from "@fungi.computer/shiitake-extensions/schedules";
import {
  createAgentAvatarStore,
  type AgentAvatarStore,
} from "../agent-avatars.js";
import type { Avatar } from "@fungi.computer/sprite/avatar";
import type { InvocationFrame } from "../invocation.js";
import type { OysterJson } from "../host.js";
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
import {
  appToolPolicySchema,
  type AppToolPolicy,
  type Installation,
} from "../apps/index.js";
import { oysterPrincipalId, type OysterHost } from "../host.js";
import { agentCeiling, oysterPrincipalIsOwner } from "../authorization.js";
import {
  defaultTenant,
  tenantIdSchema,
  tenantScope,
  type TenantScope,
  type TenantId,
  type TenantPrincipal,
} from "../tenant.js";
import type { ReadonlyTenancy } from "../tenancy/index.js";
import type { HostActor } from "@fungi.computer/puffball/app";
import type { OysterWorkerEnv } from "../workers.js";
import { createCodemodeSandbox } from "@fungi.computer/mycelium/workers";
import { forageDiscoveryInstructions } from "@fungi.computer/mycelium/effect";
import type { UiConnection } from "@fungi.computer/knapsack";
import type { ConnectionAccess, ConnectionInput } from "../agents.js";
import type {
  EgressRef,
  McpRequestData,
} from "@fungi.computer/veil/connections";
import type { createAgentMcpConnections } from "./agent-connections.js";
import type {
  CapabilitySource,
  CapabilitySourceContext,
} from "@fungi.computer/mycelium";
import type {
  OysterAgent,
  AgentPolicyActor,
  OysterAgents,
  OysterInboxItem,
  OysterSessionRow,
} from "../agents.js";

/** The model door an agent runs on; Shiitake's own contract. */
export type StandaloneModelSource = CloudflareShiitakeOptions["model"];

/** Own transport evidence and exact-message decisions for one model lease. */
function observedModels(
  model: Model<Api>,
  defaults: SimpleStreamOptions,
): StandaloneModelSource {
  return {
    acquire: ({ signal }) => {
      const retryableMessages = new WeakSet<AssistantMessage>();
      const safeFailures = new WeakMap<AssistantMessage, string>();
      const failure = (
        message: AssistantMessage,
        rejection: ProviderRejection | undefined,
      ) => {
        // Pi can include raw response bodies in errorMessage. No provider
        // prose enters a Session, retry journal, model context or diagnostics.
        const safe = `Model request failed (${rejection?.code ?? "provider_rejected"}). Retry the request.`;
        const terminal: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: message.usage,
          stopReason: message.stopReason,
          errorMessage: safe,
          timestamp: message.timestamp,
        };
        safeFailures.set(terminal, safe);
        if (isRetryableProviderRejection(rejection))
          retryableMessages.add(terminal);
        return terminal;
      };
      return Promise.resolve({
        model,
        retryable: (message) =>
          !signal.aborted &&
          message.stopReason === "error" &&
          retryableMessages.has(message),
        failureReason: (message) => safeFailures.get(message),
        stream: (selected, context, options) => {
          const upstream = { ...options, ...defaults };
          const observed = observeProviderStatus(upstream);
          const events = createAssistantMessageEventStream();
          void (async () => {
            try {
              const response = await streamModel(selected, context, {
                ...upstream,
                fetch: observed.fetch,
                onProviderStreamEvent: observed.onProviderStreamEvent,
              });
              for await (const event of response) {
                if (event.type === "error") {
                  const terminal = failure(
                    event.error,
                    observed.rejection(event.error),
                  );
                  events.push({ ...event, error: terminal });
                  events.end(terminal);
                  return;
                }
                if (
                  event.type === "done" &&
                  (event.message.stopReason === "error" ||
                    event.message.stopReason === "aborted")
                ) {
                  const terminal = failure(
                    event.message,
                    observed.rejection(event.message),
                  );
                  events.push({ ...event, message: terminal });
                  events.end(terminal);
                  return;
                }
                events.push(event);
              }
              const result = await response.result();
              events.end(
                result.stopReason === "error" || result.stopReason === "aborted"
                  ? failure(result, observed.rejection(result))
                  : result,
              );
            } catch {
              // A transport exception can contain headers or provider text.
              const terminal = failure(
                {
                  role: "assistant",
                  content: [],
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      total: 0,
                    },
                  },
                  stopReason: signal.aborted ? "aborted" : "error",
                  timestamp: Date.now(),
                },
                { code: "provider_unavailable" },
              );
              events.push({
                type: "error",
                reason: signal.aborted ? "aborted" : "error",
                error: terminal,
              });
              events.end(terminal);
            }
          })();
          return events;
        },
        release: () => Promise.resolve(),
      });
    },
  };
}

/**
 * Workers AI over the AI binding. Requests go through AI Gateway's
 * `workers-ai` passthrough on the binding, so no API token is needed.
 */
function workersAiModels(
  ai: AiBinding,
  options: WorkersAiOptions,
): StandaloneModelSource {
  const id = options.model;
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
  const streamOptions: SimpleStreamOptions = {
    fetch,
    apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
    headers: {
      "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
      // The binding carries identity; a request auth header would be
      // taken as a provider key that overrides the gateway's own.
      Authorization: null,
    },
  };
  if (options.reasoning !== undefined)
    streamOptions.reasoning = options.reasoning;
  return observedModels(normalizeModel(model), streamOptions);
}

/** Where Workers AI requests go: which model, through which gateway. */
type WorkersAiOptions = Readonly<{
  model: string;
  gateway?: string;
  reasoning?: SimpleStreamOptions["reasoning"];
}>;

/** One directory entry: an agent's id, display name and own avatar. */
export type AgentEntry = Readonly<{
  agentId: string;
  createdBy: string | null;
  name: string;
  avatar: Avatar;
}>;

/** Bindings the agent host reads. */
export type StandaloneAgentsEnv = Readonly<{
  /**
   * Host secret (at least 32 bytes) that signs a website visitor's identity
   * between the public edge and its website Agent. Without it no website
   * Agent admits a visitor. Never sent to a browser.
   */
  OYSTER_WEBSITE_PROOF_KEY?: string;
  /** Configured standalone-owner identity subject; never a stored member ID. */
  OYSTER_OWNER_NAME?: string;
  /** Gateway custody remains in Veil; only the host receives these bindings. */
  AI_GATEWAY_AUTH_TOKEN?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  /** Optional owner-funded Parallel key for `web.search`; Veil holds custody. */
  PARALLEL_API_KEY?: string;
  /** Workers AI, the default model door. */
  AI?: AiBinding;
  /** The AI Gateway the binding routes through (default `default`). */
  OYSTER_AI_GATEWAY?: string;
  /** Maintained current-member authority; absent means no nondefault-tenant policy admission. */
  TENANCY?: Pick<ReadonlyTenancy, "memberById">;
  TENANTS?: StandaloneTenancyEnv["TENANTS"];
  KEYS?: StandaloneTenancyEnv["KEYS"];
  OYSTER_ORIGIN: string;
  OYSTER_OWNER_KEY?: string;
  /** Instance credential key (32 bytes, base64url) that seals model API keys; generated at install, never in the repository. */
  OYSTER_CREDENTIAL_KEY?: string;
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

const instructions = [
  forageDiscoveryInstructions,
  "Attached Computers are independent env.computers.<name> modules, including their Files and execute operations; no App is needed. Discover their exact operations before calling.",
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
  private archiveControlOwner: ReturnType<typeof agentArchiveOwner> | undefined;
  private archiveControl() {
    return (this.archiveControlOwner ??= agentArchiveOwner({
      storage: this.ctx.storage,
      agentId: () => this.ctx.id.name,
      agent: () => this.shiitake(),
      scheduledExtensions: true,
      refreshOutstanding: (agentId) =>
        this.delegation().refreshOutstanding((target, sessionId, commandId) =>
          this.machineClient().then((client) =>
            client.settlement(target, sessionId, commandId, agentId),
          ),
        ),
      record: async (agentId, archived, revision) => {
        const pin = await this.policyDirectory();
        if (pin === null) return false;
        return this.env.AGENT_DIRECTORY.getByName(
          pin.directoryName,
        ).recordArchive(agentId, archived, revision);
      },
      wake: () => this.wakeRuntime(),
      waitUntil: (task) => {
        this.ctx.waitUntil(task);
      },
    }));
  }

  /** Owner-local atomic transition. The caller checks human/creator authority. */
  setArchived(archived: boolean) {
    return this.archiveControl().setArchived(archived);
  }

  /** The deployable root's host for this Agent's pinned tenant. */
  protected abstract hostFor(scope: TenantScope): Promise<OysterHost>;
  private channelOwner: ChannelConversations | undefined;
  private channelDoor: ReturnType<typeof channelSessionDoor> | undefined;
  private readonly acquireChannelStream = createVisitorStreamSlots();
  /** The website bindings that name this Agent, as the directory last said. */
  private readonly websiteBindings = new Map<string, WebsiteBinding>();
  /** The owner's current record of one binding; hosts and tests supply it. */
  protected readChannelBinding(
    bindingId: string,
  ): Promise<WebsiteBinding | null> {
    return agentDirectoryForScope(
      this.env,
      tenantScope(defaultTenant, this.env.OYSTER_ORIGIN),
    ).websiteBinding(bindingId);
  }
  /**
   * Read one binding afresh from its owner: suspension, persona and edits are
   * never stale. A binding that names another Agent is not this Agent's.
   */
  protected async loadChannelBinding(
    bindingId: string,
  ): Promise<WebsiteBinding | null> {
    const binding = await this.readChannelBinding(bindingId);
    if (binding === null || binding.agentId !== this.ctx.id.name) {
      this.websiteBindings.delete(bindingId);
      return null;
    }
    this.websiteBindings.set(bindingId, binding);
    return binding;
  }
  /** A web host shares its edge's private assertion key with its Agent. */
  protected channelProofKey(): string | null {
    return this.env.OYSTER_WEBSITE_PROOF_KEY ?? null;
  }
  /**
   * The one per-Session decision, with the binding read afresh: an owner
   * Session is private, a visitor's runs only while its binding is active.
   * Tools and permissions stay the Agent's own either way.
   */
  private async channelRun(sessionId: string | undefined) {
    const conversation =
      sessionId === undefined
        ? null
        : this.channelConversations().sessionConversation(sessionId);
    if (conversation !== null)
      await this.loadChannelBinding(conversation.bindingId);
    return this.cachedChannelRun(sessionId);
  }
  /** The same decision from what this Agent already read; unknown denies. */
  private cachedChannelRun(sessionId: string | undefined) {
    return decideChannelRunSafely(
      () => {
        const conversation =
          sessionId === undefined
            ? null
            : this.channelConversations().sessionConversation(sessionId);
        return {
          conversationBindingId: conversation?.bindingId ?? null,
          binding:
            conversation === null
              ? null
              : (this.websiteBindings.get(conversation.bindingId) ?? null),
        };
      },
      sessionId ?? "none",
      (cause) => {
        console.error("channel run decision failed", cause);
      },
    );
  }
  /** Shiitake calls instructions.load at the start of the actual model turn.
   * Capture that command before any asynchronous guidance can change the
   * handoff version; participant projection otherwise hides its reply. A
   * visitor's Session adds the fixed channel rules and the owner's persona to
   * the Agent's own instructions, never replacing them. */
  protected channelInstructions(
    source: CloudflareShiitakeOptions["instructions"],
  ): CloudflareShiitakeOptions["instructions"] {
    return {
      load: async (input) => {
        const conversation = this.channelConversations().sessionConversation(
          input.sessionId,
        );
        if (conversation === null) return source.load(input);
        this.channelConversations().captureTurn(
          input.sessionId,
          input.commandId,
        );
        const decision = await this.channelRun(input.sessionId);
        if (decision.kind !== "channel")
          throw new Error("Website channel binding is unavailable");
        const base = await source.load(input);
        return {
          revision: `${base.revision}+website-${String(decision.binding.authorityVersion)}`,
          text: `${base.text}\n\n${personChannelInstructions(decision.binding.persona)}`,
        };
      },
    };
  }
  /** Owner read of one website's conversations; the host admits the owner first. */
  async websiteConversations(
    bindingId: string,
  ): Promise<readonly ChannelConversation[]> {
    const binding = await this.loadChannelBinding(bindingId);
    return binding === null ? [] : this.channelConversations().list(bindingId);
  }
  /** Owner read of one conversation of a website, from its Session. */
  async websiteTranscript(
    bindingId: string,
    sessionId: string,
  ): Promise<WebsiteTranscript | null> {
    const binding = await this.loadChannelBinding(bindingId);
    const conversation =
      this.channelConversations().sessionConversation(sessionId);
    if (binding === null || conversation?.bindingId !== bindingId) return null;
    const snapshot = await (
      await this.shiitake()
    )
      .session(sessionId)
      .read({ limit: 200 });
    return {
      sessionId,
      label: conversation.label,
      lines: snapshot.messages.flatMap((message) => {
        const line = transcriptLine(message);
        return line === null ? [] : [line];
      }),
    };
  }
  private channelBinding(bindingId: string): ConversationBinding | null {
    return this.websiteBindings.get(bindingId) ?? null;
  }
  private channelSessionDoor() {
    return (this.channelDoor ??= channelSessionDoor(
      () => this.shiitake(),
      () => {
        // A visitor's Session runs on this Agent's own tools; nothing to deliver.
      },
      () => this.channelConversations(),
    ));
  }
  /**
   * Compose Oyster's channel owner on this Agent's real store and Shiitake.
   * A host must supply its own binding lookup after authenticating its edge;
   * this does not install an inbound route or mint provider credentials.
   */
  protected channelConversations(): ChannelConversations {
    if (this.channelOwner !== undefined) return this.channelOwner;
    const owner = createChannelConversations({
      sql: this.ctx.storage.sql,
      transactionSync: (body) => this.ctx.storage.transactionSync(body),
      binding: (id) => this.channelBinding(id),
      door: this.channelSessionDoor(),
      now: () => Date.now(),
    });
    return (this.channelOwner = owner);
  }
  /**
   * Internal DO RPC only: the HTTP edge authenticates once in the central
   * visitor owner, then selects this Agent. No bearer or client-provided
   * visitor id enters this method. Its caller retains the SSE recheck callback.
   */
  private visitorConversation() {
    const conversations = this.channelConversations();
    return createAuthenticatedVisitorChannel({
      binding: (id) => this.channelBinding(id),
      conversations: () => conversations,
      sessionDoor: () => this.channelSessionDoor(),
      intake: (event) => conversations.receive(event),
      acquireStream: this.acquireChannelStream,
      now: () => Date.now(),
    });
  }
  private async verifiedVisitor(bindingId: string, visitor: ProvenVisitor) {
    const binding = await this.loadChannelBinding(bindingId);
    if (binding?.lifecycle !== "active")
      throw new Error("Website channel binding is unavailable");
    return verifyVisitor(bindingId, visitor, this.channelProofKey());
  }
  async sendChannelVisitor(
    bindingId: string,
    visitor: ProvenVisitor,
    requestId: string,
    text: string,
  ) {
    const verified = await this.verifiedVisitor(bindingId, visitor);
    return this.visitorConversation().send(
      bindingId,
      verified,
      requestId,
      text,
    );
  }
  async withdrawChannelVisitor(
    bindingId: string,
    visitor: ProvenVisitor,
    requestId: string,
  ) {
    const verified = await this.verifiedVisitor(bindingId, visitor);
    return this.visitorConversation().withdraw(bindingId, verified, requestId);
  }
  async latestPendingChannelVisitor(bindingId: string, visitor: ProvenVisitor) {
    const verified = await this.verifiedVisitor(bindingId, visitor);
    return this.visitorConversation().latestPending(bindingId, verified);
  }
  async openChannelVisitor(
    bindingId: string,
    visitor: ProvenVisitor,
    options: VisitorReadOptions,
  ) {
    const verified = await this.verifiedVisitor(bindingId, visitor);
    return this.visitorConversation().open(bindingId, verified, options);
  }
  /**
   * A stream is reauthorized at every beat by the central visitor owner, not
   * by a callback held across this Durable Object's RPC boundary: the site must
   * still be active and the visitor still live.
   */
  async watchChannelVisitor(bindingId: string, visitor: ProvenVisitor) {
    const verified = await this.verifiedVisitor(bindingId, visitor);
    return this.visitorConversation().watch(
      bindingId,
      verified,
      async (visitorId) => {
        const binding = await this.loadChannelBinding(bindingId);
        return (
          binding?.lifecycle === "active" &&
          (await this.channelVisitorLive(bindingId, visitorId))
        );
      },
    );
  }
  /** Whether the central visitor owner still serves this visitor. */
  protected channelVisitorLive(
    bindingId: string,
    visitorId: string,
  ): Promise<boolean> {
    return agentDirectoryForScope(
      this.env,
      tenantScope(defaultTenant, this.env.OYSTER_ORIGIN),
    ).websiteVisitorLive(bindingId, visitorId);
  }
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
  private computerSnapshot: AgentComputerSnapshot | null = null;
  private computerSnapshotLoad: Promise<AgentComputerSnapshot | null> | null =
    null;
  private computerSnapshotGeneration: number | null | undefined;
  private computerSnapshotRevision = 0;
  private readonly computerInvalidations = new Set<() => void>();

  /** Host invalidation drops captured discovery, not just its displayed names. */
  invalidateComputerConnections(): void {
    this.computerSnapshot = null;
    this.computerSnapshotLoad = null;
    this.computerSnapshotGeneration = undefined;
    this.computerSnapshotRevision += 1;
    for (const invalidate of this.computerInvalidations) invalidate();
  }

  private computerAccess(): StandaloneAgentComputerAccess {
    return {
      computer: (computerId) => this.env.COMPUTER.getByName(computerId),
      admit: async (captured) => {
        const pin = await this.policyDirectory();
        if (pin?.directoryName !== captured.scopeId)
          throw new FleetGrantRefused();
        return this.env.AGENT_DIRECTORY.getByName(
          pin.directoryName,
        ).admitAgentComputer(
          {
            scopeId: captured.scopeId,
            agentId: captured.agentId,
            attachment: captured.attachment,
          },
          pin.tenantId,
        );
      },
    };
  }

  private computerConnections() {
    return {
      read: () => this.computerSnapshot,
      connect: (connection: AgentComputerConnection) =>
        standaloneAgentComputerPorts(this.computerAccess(), connection),
    };
  }

  /** Revalidate the owner's generation before reusing a Home or tool snapshot. */
  private async preparedComputerSnapshot(): Promise<AgentComputerSnapshot | null> {
    for (;;) {
      const revision = this.computerSnapshotRevision;
      const generation = await this.readComputerGeneration();
      if (revision !== this.computerSnapshotRevision) continue;
      const cachedGeneration = this.computerSnapshotGeneration;
      if (
        generation !== null &&
        cachedGeneration !== null &&
        cachedGeneration !== undefined &&
        generation < cachedGeneration
      )
        continue;
      if (generation !== this.computerSnapshotGeneration) {
        this.computerSnapshot = null;
        this.computerSnapshotLoad = null;
        this.computerSnapshotGeneration = generation;
      }
      const load = (this.computerSnapshotLoad ??= this.readComputerSnapshot());
      try {
        const snapshot = await load;
        if (
          revision !== this.computerSnapshotRevision ||
          generation !== this.computerSnapshotGeneration
        )
          continue;
        if (snapshot !== null && snapshot.projection.revision !== generation) {
          this.computerSnapshotGeneration = undefined;
          this.computerSnapshotLoad = null;
          continue;
        }
        this.computerSnapshot = snapshot;
        return snapshot;
      } catch (error) {
        if (this.computerSnapshotLoad === load)
          this.computerSnapshotLoad = null;
        throw error;
      }
    }
  }

  private async readComputerGeneration(): Promise<number | null> {
    const pin = await this.policyDirectory();
    const agentId = this.ctx.id.name;
    return pin === null || agentId === undefined
      ? null
      : this.env.AGENT_DIRECTORY.getByName(
          pin.directoryName,
        ).agentComputerRevision(agentId, pin.tenantId);
  }

  private async readComputerSnapshot(): Promise<AgentComputerSnapshot | null> {
    const pin = await this.policyDirectory();
    const agentId = this.ctx.id.name;
    return pin === null || agentId === undefined
      ? null
      : this.env.AGENT_DIRECTORY.getByName(
          pin.directoryName,
        ).agentComputerSnapshot(agentId, pin.tenantId);
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
    const pathname = new URL(request.url).pathname;
    if (pathname === "/models" && request.method === "GET")
      return this.readAgentModels();
    if (pathname.startsWith("/cloud-browser/"))
      return standaloneBrowserLiveView(this.env.BROWSER, () => ({
        teamId: this.env.OYSTER_ORIGIN,
        agentId: this.ctx.id.name ?? "agent",
      }))(request);
    if (pathname.startsWith("/browser/"))
      return this.ui().then((connection) => connection.fetch(request));
    // The Home command reads attachments inside a synchronous state transaction.
    // Prepare its directory snapshot before Shiitake enters that transaction.
    if (
      request.method === "POST" &&
      pathname.startsWith("/sessions/") &&
      pathname.endsWith(`/extensions/${homeContract.id}/commands/home`)
    )
      return this.preparedComputerSnapshot().then(() =>
        this.runtimeOwner().fetch(request),
      );
    return undefined;
  }

  private async readAgentModels(): Promise<Response> {
    const pin = await this.policyDirectory();
    const agentId = this.ctx.id.name;
    if (
      pin === null ||
      agentId === undefined ||
      !(await this.env.AGENT_DIRECTORY.getByName(pin.directoryName).has(
        agentId,
      ))
    )
      return new Response("Agent scope is unavailable", { status: 403 });
    const choice = await this.readModelChoice();
    // The same owner checks the chosen source before reporting it as available.
    await this.sourceFor(choice);
    const model = await selectAgentModel(choice);
    return Response.json(
      agentModelListSchema.parse([
        {
          providerId: choice.model.providerId,
          providerName:
            choice.keySource === "byok"
              ? "Your provider key"
              : choice.keySource === "workers-ai"
                ? "Workers AI"
                : "Fungi Gateway",
          id: choice.model.modelId,
          name: model.name,
          reasoning: getSupportedThinkingLevels(model).filter(
            (level) => level !== "off",
          ),
        },
      ]),
    );
  }

  protected override async closeShiitake(): Promise<void> {
    try {
      await (await this.ui()).close();
    } finally {
      await super.closeShiitake();
    }
  }

  private controlDirectory(): AgentControlDirectory {
    const list: AgentControlDirectory["list"] = async (signal, options) => {
      signal.throwIfAborted();
      const pin = await this.policyDirectory();
      if (pin === null) throw new Error("Agent directory is unavailable");
      const directory = this.env.AGENT_DIRECTORY.getByName(pin.directoryName);
      const agents = await directory.list(options);
      if (
        this.ctx.id.name === undefined ||
        !(await directory.has(this.ctx.id.name))
      )
        throw new Error("Agent is outside this scope");
      signal.throwIfAborted();
      return agents;
    };
    const changeArchive = async (
      targetId: string,
      archived: boolean,
      signal: AbortSignal,
    ) => {
      await list(signal);
      const caller = this.ctx.id.name;
      const pin = await this.policyDirectory();
      if (caller === undefined || pin === null)
        throw new AgentArchiveRefused(
          "unreadable",
          "Agent scope is unavailable",
        );
      if (targetId === caller)
        throw new AgentArchiveRefused(
          "self",
          "An Agent cannot archive or restore itself",
        );
      const directory = this.env.AGENT_DIRECTORY.getByName(pin.directoryName);
      if ((await directory.createdBy(targetId)) !== caller)
        throw new AgentArchiveRefused(
          "not_creator",
          "An Agent can change only one it created",
        );
      const target = this.env.AGENTS.getByName(targetId);
      const targetPin = await target.policyDirectory();
      if (
        targetPin?.directoryName !== pin.directoryName ||
        targetPin.tenantId !== pin.tenantId
      )
        throw new AgentArchiveRefused(
          "unreadable",
          "Agent archive scope does not match",
        );
      signal.throwIfAborted();
      const result = await target.setArchived(archived);
      if ("error" in result)
        throw new AgentArchiveRefused(
          result.error,
          result.message ?? `Agent archive refused: ${result.error}`,
        );
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
      archive: (input, signal) => changeArchive(input.agentId, true, signal),
      unarchive: (input, signal) => changeArchive(input.agentId, false, signal),
      open: async (agentId, signal) => {
        const admit = async () => {
          if (
            !(await list(signal)).some((agent) => agent.agentId === agentId)
          ) {
            const pin = await this.policyDirectory();
            if (
              pin !== null &&
              (await this.env.AGENT_DIRECTORY.getByName(
                pin.directoryName,
              ).archived(agentId))
            )
              throw new ShiitakeError(
                "contract",
                "archived",
                "Agent is archived",
              );
            throw new Error("Agent is outside this scope");
          }
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
    const outbox = this.mail();
    const mailRoom = outbox.host.mailRoom;
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
      // Delegation custody and settlement still see archived identities;
      // Agent-control discovery keeps its active-only default. New sends
      // reach the recipient's admission door and get contract/archived.
      directory: () => {
        const control = this.controlDirectory();
        return {
          ...control,
          list: async (signal: AbortSignal) => [
            ...(await control.list(signal)),
            ...(await control.list(signal, { archived: true })),
          ],
        };
      },
      deliver: (mail) => this.mail().deliver(mail),
      prepare: () => Promise.resolve(),
      stageAcceptedNotice: (mail, scopeId) => {
        mailRoom.stageAcceptedNotice(mail, scopeId);
      },
      accept: async (mail, reply, stageAcceptedNotice) =>
        (await this.shiitake()).acceptMail(
          mail,
          mail.meta,
          reply,
          stageAcceptedNotice,
        ),
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
        if (mail.reply.outcome === "undeliverable") return undefined;
        if (mail.from.kind !== "agent")
          throw new Error("Delegated reply Agent identity is unavailable");
        return (await this.machineClient()).settlement(
          mail.from.agentId,
          mail.from.sessionId,
          mail.reply.commandId,
          mail.to.agentId,
        );
      },
      onUndeliverable: (original) =>
        this.delegation().localUndeliverable(original),
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

  /** The instance directory that owns this Agent's sealed model keys. */
  private async keyDirectory() {
    const pin = await this.policyDirectory();
    if (pin === null) throw new AgentModelRefused("key_not_connected");
    return this.env.AGENT_DIRECTORY.getByName(pin.directoryName);
  }

  /** The instance directory that owns this Agent's MCP connections and their credentials. */
  private async mcpDirectory() {
    const pin = await this.policyDirectory();
    if (pin === null) throw new Error("Agent directory is unavailable");
    return this.env.AGENT_DIRECTORY.getByName(pin.directoryName);
  }

  private agentName(): string {
    const name = this.ctx.id.name;
    if (name === undefined) throw new Error("Agent has no name");
    return name;
  }

  /** A byok choice must name a stored key of the chosen provider. */
  private async admitKey(choice: AgentModelChoice): Promise<void> {
    if (choice.keySource !== "byok" || choice.keyId === undefined) return;
    const record = await (await this.keyDirectory()).modelKey(choice.keyId);
    if (record === null) throw new AgentModelRefused("key_removed");
    if (record.provider !== choice.model.providerId)
      throw new AgentModelRefused("key_source_mismatch");
  }

  private choice() {
    return agentModelChoice(this.ctx.storage, async (choice) => {
      await this.admitKey(choice);
      if (
        choice.keySource === "ai-gateway" &&
        configuredProviderEgress(this.env).baseUrl("ai-gateway") === null
      )
        throw new AgentModelRefused("key_not_connected");
      if (choice.keySource === "workers-ai" && this.env.AI === undefined)
        throw new AgentModelRefused("key_not_connected");
    });
  }

  /** Secret-free default of this Agent; stored separately from Session history. */
  async readModelChoice(): Promise<AgentModelChoice> {
    return this.choice().read();
  }

  async setModelChoice(
    input: AgentModelChoice,
  ): Promise<AgentModelChoice | Readonly<{ error: AgentModelRefusal }>> {
    try {
      return await this.choice().set(input);
    } catch (error) {
      // DO RPC does not preserve Error prototypes. Transport a domain
      // refusal as data, not an exception the root must recognize by name.
      if (error instanceof AgentModelRefused) return { error: error.reason };
      throw error;
    }
  }

  /** Capture one model and credential source when the Agent's run acquires it. */
  protected modelSource(): StandaloneModelSource {
    return {
      acquire: async (input) => {
        input.signal.throwIfAborted();
        const choice = await this.readModelChoice();
        const preference = input.preference;
        if (
          preference !== null &&
          (preference.providerId !== choice.model.providerId ||
            preference.modelId !== choice.model.modelId)
        )
          throw new AgentModelRefused("key_source_mismatch");
        const selected = {
          ...choice,
          model: {
            ...choice.model,
            reasoning: preference?.reasoning ?? choice.model.reasoning,
          },
        };
        const source = await this.sourceFor(selected);
        return source.acquire(input);
      },
    };
  }

  private async sourceFor(
    choice: AgentModelChoice,
  ): Promise<StandaloneModelSource> {
    const modelChoice = await selectAgentModel(choice);
    if (choice.keySource === "byok" && choice.keyId !== undefined) {
      await this.admitKey(choice);
      const directory = await this.keyDirectory();
      const keyId = choice.keyId;
      const streamOptions: SimpleStreamOptions = {
        // Pi needs some credential to build its request; the vault replaces it.
        apiKey: "oyster-model-key",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const sent = await directory.sendModelKey(keyId, {
            url: request.url,
            method: request.method,
            headers: [...request.headers],
            body: request.body === null ? null : await request.text(),
          });
          if (!(sent instanceof Response))
            throw new AgentModelRefused(
              sent.error === "key_removed"
                ? "key_removed"
                : "key_not_connected",
            );
          return sent;
        },
      };
      if (choice.model.reasoning !== undefined)
        streamOptions.reasoning = choice.model.reasoning;
      return observedModels(normalizeModel(modelChoice), streamOptions);
    }
    if (choice.keySource === "ai-gateway") {
      const egress = configuredProviderEgress(this.env);
      const baseUrl = egress.baseUrl("ai-gateway");
      if (baseUrl === null) throw new AgentModelRefused("key_not_connected");
      return {
        acquire: async (input) => {
          const model = { ...modelChoice, id: "openai/gpt-6-luna", baseUrl };
          const streamOptions: SimpleStreamOptions = {
            apiKey: "oyster-provider-egress",
            fetch: providerFetch(egress, "ai-gateway"),
          };
          if (choice.model.reasoning !== undefined)
            streamOptions.reasoning = choice.model.reasoning;
          return observedModels(normalizeModel(model), streamOptions).acquire(
            input,
          );
        },
      };
    }
    if (this.env.AI === undefined)
      throw new AgentModelRefused("key_not_connected");
    let options: WorkersAiOptions = { model: modelChoice.id };
    if (this.env.OYSTER_AI_GATEWAY !== undefined)
      options = { ...options, gateway: this.env.OYSTER_AI_GATEWAY };
    if (choice.model.reasoning !== undefined)
      options = { ...options, reasoning: choice.model.reasoning };
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
    this.invalidateComputerConnections();
  }

  /** Host-only policy pin read, used before an owner can approve tools. */
  async policyDirectory(): Promise<typeof policyDirectorySchema.Type | null> {
    const stored = await this.ctx.storage.get("app-policy-directory");
    return stored === undefined
      ? null
      : Schema.decodeUnknownSync(policyDirectorySchema)(stored);
  }

  /** Borrow the native owner only after matching its real initialization pin. */
  private async scheduleOwner(
    expected: typeof policyDirectorySchema.Type,
    agentId: string,
  ) {
    const directory = Schema.decodeUnknownSync(policyDirectorySchema)(expected);
    const pin = await this.policyDirectory();
    if (
      agentId !== this.ctx.id.name ||
      pin?.directoryName !== directory.directoryName ||
      pin.tenantId !== directory.tenantId
    )
      throw new AppInstanceError("revoked");
    return this.shiitake();
  }

  /** One admitted Agent's bounded native schedule page; this is not a directory scan. */
  async readSchedules(
    directory: typeof policyDirectorySchema.Type,
    input: AppAgentScheduleListInput,
  ): Promise<AgentSchedulePage> {
    const { agentId, ...page } = appAgentScheduleListInputSchema.parse(input);
    const owner = await this.scheduleOwner(directory, agentId);
    return readAgentSchedulePage(agentId, owner, page);
  }

  /** Manage authority returns native identity/state only, never schedule content. */
  async controlSchedule(
    directory: typeof policyDirectorySchema.Type,
    input: AgentScheduleTarget,
    action: "pause" | "resume" | "delete",
  ): Promise<AgentScheduleControlReceipt> {
    const target = agentScheduleTargetSchema.parse(input);
    const owner = await this.scheduleOwner(directory, target.agentId);
    return controlAgentSchedule(owner, target, action);
  }

  /** Listeners from live codemode acquisitions, told when the server list changes. */
  private readonly mcpInvalidations = new Set<() => void>();

  /** Host-only: the directory told us this Agent's connections changed. */
  invalidateMcpConnections(): void {
    for (const invalidate of this.mcpInvalidations) invalidate();
  }

  /**
   * A full override must retain channelSource and channelInstructions:
   * dropping them removes a suspended website's run refusal and turn capture.
   */
  protected override async shiitakeOptions(): Promise<CloudflareShiitakeOptions> {
    const [
      { oysterAgentExtensions },
      { Knapsack },
      { agentMcpSourceOptions },
      { mcpRequestData },
    ] = await Promise.all([
      import("@fungi.computer/shiitake-extensions/roster/conversation-agents"),
      import("@fungi.computer/knapsack"),
      import("./agent-connections.js"),
      import("@fungi.computer/veil/connections"),
    ]);
    const conversationAgents = await this.conversationAgents();
    const computerSource = createAgentComputerSource({
      ...this.computerConnections(),
      subscribe: (invalidate) => {
        this.computerInvalidations.add(invalidate);
        return () => this.computerInvalidations.delete(invalidate);
      },
    });
    const extensions = oysterAgentExtensions(
      conversationAgents.source(this.controlDirectory()),
    );
    const keeping = agentStoreKeeping(this.ctx.storage, (request) =>
      this.readColdSessions(request),
    );
    const principal = {
      actor: { kind: "agent", agentId: this.ctx.id.name ?? "agent" },
    } as const;
    const channelSource = (source: CapabilitySource): CapabilitySource => ({
      ...source,
      acquire: async (context) =>
        (await this.channelRun(context.session?.sessionId)).kind !== "denied"
          ? source.acquire(context)
          : {
              snapshot: { version: "channel-denied", modules: [] },
              release: () => Promise.resolve(),
            },
    });
    return {
      model: this.modelSource(),
      meta: { schema: FungiMessageMetaSchema },
      ...this.mail().host,
      instructions: this.channelInstructions({
        load: async () => {
          const { appApprovalInstructions } = await import("../mcp.js");
          return {
            revision: "oyster-7",
            text: instructions + "\n" + appApprovalInstructions,
          };
        },
      }),
      tools: {
        sources: [
          {
            id: "oyster-apps",
            // Capture once per catalog acquisition, so the next run sees
            // changed Releases, installation authority and removals.
            acquire: async (context: CapabilitySourceContext) => {
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
          {
            id: computerSource.id,
            acquire: async (context: CapabilitySourceContext) => {
              await this.preparedComputerSnapshot();
              return computerSource.acquire(context);
            },
          },
          Knapsack.mcpServers(
            agentMcpSourceOptions({
              // Like attached Computers: an Agent not yet pinned to its
              // directory has no connections, rather than a failing source.
              read: async () =>
                (await this.policyDirectory()) === null
                  ? { revision: 0, connections: [] }
                  : (await this.mcpDirectory()).mcpProjection(this.agentName()),
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
              // Completed by the owner, which holds the credential.
              fetch: async (ref, request) => {
                const answer = await (
                  await this.mcpDirectory()
                ).mcpFetch(
                  this.agentName(),
                  ref,
                  await mcpRequestData(request),
                );
                if ("error" in answer)
                  throw new Error(`MCP connection refused: ${answer.error}`);
                return answer;
              },
            }),
          ),
          conversationAgents.control(() => this.controlDirectory()),
          (await this.ui()).source,
          standaloneWebSource(this.env),
          standaloneBrowserSource(
            this.env.BROWSER,
            () => ({
              teamId: this.env.OYSTER_ORIGIN,
              agentId: principal.actor.agentId,
            }),
            standaloneBrowserSave(
              {
                admit: this.computerAccess().admit,
                write: (computerId, grant, path, bytes) =>
                  this.env.COMPUTER.getByName(computerId).fileWrite(
                    grant,
                    path,
                    bytes,
                  ),
              },
              () => this.computerSnapshot,
            ),
          ),
        ].map(channelSource),
        sandbox: createCodemodeSandbox(this.env.LOADER, "oyster-workerd"),
      },
      extensions: {
        roster: [
          ...extensions.roster,
          homeExtension({
            computers: {
              prepare: async () => {
                await this.preparedComputerSnapshot();
              },
              read: ({ sessionId }) =>
                (this.cachedChannelRun(sessionId).kind !== "denied"
                  ? readAgentComputerConnections(this.computerConnections())
                  : []
                ).map(({ name, attachmentId, files }) => ({
                  name,
                  attachmentId,
                  port: files.port,
                })),
            },
          }),
        ],
        grants: [...extensions.grants, homeGrant],
      },
      ...keeping,
      admission: {
        assertOpen: () => {
          this.archiveControl().assertOpen();
        },
      },
      hostWork: [...keeping.hostWork, this.archiveControl().work],
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
  private archiveProjectionOwner:
    ReturnType<typeof agentArchiveProjection> | undefined;
  private archiveProjection() {
    return (this.archiveProjectionOwner ??= agentArchiveProjection(
      this.ctx.storage.sql,
    ));
  }

  /** Apply the Agent DO's revisioned fact; an older repair cannot undo a newer one. */
  recordArchive(agentId: string, archived: boolean, revision: number): boolean {
    const projection = this.archiveProjection();
    return this.ctx.storage.transactionSync(() => {
      if (!this.has(agentId)) return false;
      const result = projection.record(agentId, archived, revision);
      if (result === "advanced") this.bump();
      // A replay after projection but before the Agent's ack still succeeds.
      return result !== "stale";
    });
  }

  /** Directory's bounded-stale projection, never the Agent's flag authority. */
  archived(agentId: string): boolean {
    return this.archiveProjection().archived(agentId);
  }

  private modelKeys() {
    const storage = this.ctx.storage;
    return createModelKeyVault({
      credentialKey: this.env.OYSTER_CREDENTIAL_KEY,
      storage: credentialStorage(storage),
    });
  }

  /** Domain refusals cross the DO RPC boundary as data, not as Error prototypes. */
  async sealModelKey(
    input: ModelKeySealInput,
  ): Promise<ModelKeyRecord | Readonly<{ error: ModelKeyRefusal }>> {
    try {
      return await this.modelKeys().seal(input);
    } catch (error) {
      if (error instanceof ModelKeyRefused) return { error: error.reason };
      throw error;
    }
  }

  listModelKeys(): Promise<readonly ModelKeyRecord[]> {
    return this.modelKeys().list();
  }

  modelKey(keyId: string): Promise<ModelKeyRecord | null> {
    return this.modelKeys().get(keyId);
  }

  removeModelKey(keyId: string): Promise<"deleted" | "absent"> {
    return this.modelKeys().remove(keyId);
  }

  /** Host-only: the one place a stored key meets a provider request. */
  async sendModelKey(
    keyId: string,
    request: Readonly<{
      url: string;
      method: string;
      headers: readonly (readonly [string, string])[];
      body: string | null;
    }>,
  ): Promise<Response | Readonly<{ error: ModelKeyRefusal }>> {
    try {
      return await this.modelKeys().send(
        keyId,
        new Request(request.url, {
          method: request.method,
          headers: request.headers.map(([name, value]) => [name, value]),
          body: request.body,
        }),
      );
    } catch (error) {
      if (error instanceof ModelKeyRefused) return { error: error.reason };
      throw error;
    }
  }

  private mcpOwner: ReturnType<typeof createAgentMcpConnections> | undefined;
  /** Loaded on the first MCP request: the SDK and OpenAPI decoders stay out of startup. */
  private async mcpConnections() {
    const { createAgentMcpConnections } =
      await import("./agent-connections.js");
    const storage = this.ctx.storage;
    return (this.mcpOwner ??= createAgentMcpConnections({
      ownerId: this.ctx.id.name ?? "agents",
      store: storage,
      vault: createInstanceCredentialStore({
        credentialKey: this.env.OYSTER_CREDENTIAL_KEY,
        storage: credentialStorage(storage),
      }),
      // The Worker's own egress: public internet only.
      send: (request) => fetch(request),
      hasAgent: (agentId) => this.has(agentId),
      notify: (agentId) =>
        this.env.AGENTS.getByName(agentId).invalidateMcpConnections(),
      callbackUrl: mcpCallbackUrl(this.env.OYSTER_ORIGIN),
    }));
  }

  /** Host-only: every connection with the Agents that may use it, never a credential. */
  async connections() {
    return (await this.mcpConnections()).list();
  }

  async addConnection(input: ConnectionInput) {
    return (await this.mcpConnections()).add(input);
  }

  async grantConnection(
    connectionId: string,
    agentId: string,
    access: ConnectionAccess,
  ) {
    return (await this.mcpConnections()).grant(connectionId, agentId, access);
  }

  async ungrantConnection(connectionId: string, agentId: string) {
    return (await this.mcpConnections()).ungrant(connectionId, agentId);
  }

  async removeConnection(connectionId: string) {
    return (await this.mcpConnections()).remove(connectionId);
  }

  async connectionTools(connectionId: string) {
    return (await this.mcpConnections()).tools(connectionId);
  }

  async completeMcpConnection(query: {
    state: string;
    code: string;
    iss: string | undefined;
  }) {
    return (await this.mcpConnections()).complete(query);
  }

  /** Secret-free grants for one Agent: ids, versions and endpoints. */
  async mcpProjection(agentId: string) {
    return (await this.mcpConnections()).projection(agentId);
  }

  /** Host-only: complete one Agent MCP request; the credential opens only here. */
  async mcpFetch(agentId: string, ref: EgressRef, request: McpRequestData) {
    return (await this.mcpConnections()).fetch(agentId, ref, request);
  }

  private readonly computers: ReturnType<typeof createAgentComputers>;
  private readonly computerNames = new Map<string, string>();
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
    this.computers = createAgentComputers({
      sql: ctx.storage.sql,
      transactionSync: (body) => ctx.storage.transactionSync(body),
      readComputerName: (computerId) => {
        const name = this.computerNames.get(computerId);
        if (name === undefined) throw new FleetGrantRefused();
        return name;
      },
      revoke: (_requestId, attachment) => {
        ctx.waitUntil(
          env.AGENTS.getByName(
            attachment.agentId,
          ).invalidateComputerConnections(),
        );
      },
      enqueueProjection: (agentId) => {
        this.bump();
        ctx.waitUntil(
          env.AGENTS.getByName(agentId).invalidateComputerConnections(),
        );
      },
    });
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

  private async computerOwner(
    agentId: string,
    tenantId: TenantId,
    principal?: TenantPrincipal,
  ) {
    const scope = tenantScope(tenantId, this.env.OYSTER_ORIGIN);
    if (this.ctx.id.name !== scope.durableName("agents")) return null;
    if (!this.has(agentId)) return null;
    const creator = this.readCreator(agentId);
    if (creator === null) return null;
    const member = await this.currentMember(tenantId, creator);
    if (member === null || !oysterPrincipalIsOwner(member)) return null;
    if (
      principal !== undefined &&
      (!oysterPrincipalIsOwner(principal) ||
        oysterPrincipalId(principal) !== creator)
    )
      return null;
    return member;
  }

  private async loadComputerNames(
    agentId: string,
    tenantId: TenantId,
    memberId: string,
    extra?: string,
  ): Promise<boolean> {
    const scope = tenantScope(tenantId, this.env.OYSTER_ORIGIN);
    const bindings: StandaloneComputerEnv = this.env;
    const registry = bindings.REGISTRY.getByName(scope.durableName("registry"));
    const ids = new Set(this.computers.attachedComputers(agentId));
    if (extra !== undefined) ids.add(extra);
    for (const computerId of ids) {
      const admitted = await registry.computerFleet(memberId, {
        operation: "resolve",
        computerId,
      });
      if (
        admitted === null ||
        !("computerId" in admitted) ||
        admitted.computerId !== computerId
      )
        return false;
      const computer =
        computerId === this.env.OYSTER_COMPUTER_ID
          ? { name: computerId }
          : await registry.computerFleet(memberId, {
              operation: "read",
              computerId,
            });
      if (computer === null || !("name" in computer)) return false;
      this.computerNames.set(computerId, computer.name);
    }
    return true;
  }

  /** Check the existing transactional revision without resolving fleet names. */
  async agentComputerRevision(
    agentId: string,
    tenantId: TenantId = defaultTenant,
  ): Promise<number | null> {
    return (await this.computerOwner(agentId, tenantId)) === null
      ? null
      : this.computers.revision(agentId);
  }

  /** Read the shared owner only after current membership and real fleet lookup. */
  async agentComputerSnapshot(
    agentId: string,
    tenantId: TenantId = defaultTenant,
  ): Promise<AgentComputerSnapshot | null> {
    if (this.computers.attachedComputers(agentId).length === 0) return null;
    const owner = await this.computerOwner(agentId, tenantId);
    if (
      owner === null ||
      !(await this.loadComputerNames(
        agentId,
        tenantId,
        oysterPrincipalId(owner),
      ))
    )
      return null;
    return {
      scopeId: tenantScope(tenantId, this.env.OYSTER_ORIGIN).durableName(
        "agents",
      ),
      agentId,
      projection: this.computers.read(agentId),
    };
  }

  private async computerCommand(
    operation: "attach" | "detach" | "read",
    agentId: string,
    principal: TenantPrincipal,
    tenantId: TenantId,
    command?: ComputerAttachmentInput,
  ): Promise<StandaloneAgentComputerReply> {
    const owner = await this.computerOwner(agentId, tenantId, principal);
    if (owner === null) return { kind: "refused", error: "not_granted" };
    if (
      !(await this.loadComputerNames(
        agentId,
        tenantId,
        oysterPrincipalId(owner),
        operation === "attach" ? command?.computerId : undefined,
      ))
    )
      return { kind: "refused", error: "not_found" };
    try {
      const projection =
        operation === "read"
          ? this.computers.read(agentId)
          : operation === "attach" && command !== undefined
            ? this.computers.attachComputer(command)
            : operation === "detach" && command !== undefined
              ? this.computers.detachComputer(command)
              : null;
      if (projection === null) throw new Error("Missing attachment command");
      return { kind: "ok", projection };
    } catch (error) {
      const refusal = z
        .object({
          code: z.enum([
            "request_conflict",
            "attachment_identity_conflict",
            "not_attached",
          ]),
        })
        .safeParse(error);
      if (!refusal.success) throw error;
      return {
        kind: "refused",
        error:
          refusal.data.code === "not_attached"
            ? "not_found"
            : refusal.data.code,
      };
    }
  }

  /** Owner attachment commands retain the shared owner's receipts and versions. */
  attachComputer(
    command: ComputerAttachmentInput,
    principal: TenantPrincipal,
    tenantId: TenantId = defaultTenant,
  ) {
    return this.computerCommand(
      "attach",
      command.agentId,
      principal,
      tenantId,
      command,
    );
  }

  /** Detach advances the owner version and invalidates the Agent's held discovery. */
  detachComputer(
    command: ComputerAttachmentInput,
    principal: TenantPrincipal,
    tenantId: TenantId = defaultTenant,
  ) {
    return this.computerCommand(
      "detach",
      command.agentId,
      principal,
      tenantId,
      command,
    );
  }

  /** The owner HTTP read uses the same projection as direct discovery. */
  readAgentComputers(
    agentId: string,
    principal: TenantPrincipal,
    tenantId: TenantId = defaultTenant,
  ) {
    return this.computerCommand("read", agentId, principal, tenantId);
  }

  /** Every captured native call rechecks the exact live attachment and credential owner. */
  async admitAgentComputer(
    captured: Pick<
      AgentComputerConnection,
      "scopeId" | "agentId" | "attachment"
    >,
    tenantId: TenantId,
  ): Promise<Omit<ComputerGrant, "egress">> {
    const owner = await this.computerOwner(captured.agentId, tenantId);
    const scope = tenantScope(tenantId, this.env.OYSTER_ORIGIN);
    const held = captured.attachment;
    if (
      owner === null ||
      captured.scopeId !== scope.durableName("agents") ||
      !this.computers
        .attachments()
        .some(
          (current) =>
            current.agentId === captured.agentId &&
            current.attachmentId === held.attachmentId &&
            current.computerId === held.computerId &&
            current.version === held.version,
        )
    )
      throw new FleetGrantRefused();
    const bindings: StandaloneComputerEnv = this.env;
    const computer = await bindings.REGISTRY.getByName(
      scope.durableName("registry"),
    ).computerFleet(oysterPrincipalId(owner), {
      operation: "resolve",
      computerId: held.computerId,
    });
    if (
      computer === null ||
      !("computerId" in computer) ||
      computer.computerId !== held.computerId
    )
      throw new FleetGrantRefused();
    return {
      computerId: held.computerId,
      actions: new Set([
        "files.read",
        "files.readBytes",
        "files.list",
        "files.glob",
        "files.grep",
        "files.edit",
        "files.write",
        "mkdir",
        "bash",
        "exec",
        "processStart",
        "processList",
        "processKill",
      ]),
      expiresAt: Date.now() + 60_000,
      provenance: { actor: oysterPrincipalId(owner), via: captured.agentId },
    };
  }

  private websiteChannelsOwner: WebsiteChannelOwner | undefined;
  private websites(): WebsiteChannelOwner {
    return (this.websiteChannelsOwner ??= createWebsiteChannelOwner({
      sql: this.ctx.storage.sql,
      transactionSync: (body) => this.ctx.storage.transactionSync(body),
      agentExists: (agentId) => this.has(agentId),
      agentIdentity: (agentId) => {
        const id = agentIds.agent.parse(agentId);
        if (!id.ok || this.archived(agentId)) return null;
        const entry = this.directory.read(this.grant(), id.value);
        return entry === null
          ? null
          : { name: entry.name, avatar: this.avatars.read(agentId) };
      },
    }));
  }

  /** Owner read of every website bound to one of this tenant's Agents. */
  websiteList(
    principal: TenantPrincipal,
  ): readonly WebsiteBinding[] | WebsiteRefusal {
    if (!oysterPrincipalIsOwner(principal)) return { error: "not_granted" };
    return this.websites().bindings.list();
  }

  /** Owner-only: put a chosen Agent behind a new site key. */
  websiteCreate(
    principal: TenantPrincipal,
    input: CreateWebsiteInput,
    requestId: string,
  ): WebsiteBinding | WebsiteRefusal {
    if (!oysterPrincipalIsOwner(principal)) return { error: "not_granted" };
    return websiteOutcome(() =>
      this.websites().bindings.create(input, requestId),
    );
  }

  /** Owner-only edit, fenced by the version the owner last read. */
  websiteUpdate(
    principal: TenantPrincipal,
    bindingId: string,
    input: UpdateWebsiteInput,
  ): WebsiteBinding | WebsiteRefusal {
    if (!oysterPrincipalIsOwner(principal)) return { error: "not_granted" };
    return websiteOutcome(() =>
      this.websites().bindings.update(bindingId, input),
    );
  }

  /** Host-only: the binding a website Agent serves, read fresh on every use. */
  websiteBinding(bindingId: string): WebsiteBinding | null {
    return this.websites().bindings.read(bindingId);
  }

  /** Host-only public lookup: a site key resolves to its site, or to nothing. */
  websiteSite(siteKey: string): WebsiteSite | null {
    return this.websites().site(siteKey);
  }

  websiteMint(bindingId: string, siteKey: string, addressHash: string) {
    return this.websites().visitors.mint(
      this.websites().bindings.read(bindingId),
      siteKey,
      addressHash,
    );
  }

  websiteRefresh(bindingId: string, refreshSecret: string) {
    return this.websites().visitors.refresh(
      this.websites().bindings.read(bindingId),
      refreshSecret,
    );
  }

  websiteRotate(
    bindingId: string,
    siteKey: string,
    accessToken: string,
    addressHash: string,
  ) {
    return this.websites().visitors.rotate(
      this.websites().bindings.read(bindingId),
      siteKey,
      accessToken,
      addressHash,
    );
  }

  websiteVisitorLive(bindingId: string, visitorId: string): boolean {
    return this.websites().visitors.live(bindingId, visitorId);
  }

  websiteAuthenticate(bindingId: string, accessToken: string) {
    return this.websites().visitors.authenticate(bindingId, accessToken);
  }

  list(options?: Readonly<{ archived?: boolean }>): readonly AgentEntry[] {
    const archived = this.archiveProjection().archivedIds();
    return this.directory
      .list(this.grant())
      .toReversed()
      .filter(({ agentId }) =>
        options?.archived === true
          ? archived.has(agentId)
          : !archived.has(agentId),
      )
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

  /** Immutable creating Agent, distinct from the human credential owner. */
  createdBy(agentId: string): string | null {
    const id = agentIds.agent.parse(agentId);
    return id.ok
      ? (this.directory.read(this.grant(), id.value)?.createdBy ?? null)
      : null;
  }

  /** Owner-only rename; refuses a name already held by another Agent. */
  rename(
    agentId: string,
    name: string,
    principal: TenantPrincipal,
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
    principal: TenantPrincipal,
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
    principal: TenantPrincipal,
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
    principal: TenantPrincipal,
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

/** Where an authorization server returns the owner after a sign-in. */
const mcpCallbackUrl = (origin: string) =>
  new URL("/api/connections/callback", origin).href;

/** The directory's Durable Object storage as the credential store's key-value port. */
const credentialStorage = (
  storage: DurableObjectStorage,
): CredentialStorage => ({
  get: (key) => storage.get<StoredCredential>(key),
  put: (key, value) => storage.put(key, value),
  delete: (key) => storage.delete(key),
  list: async (prefix) =>
    new Map(await storage.list<StoredCredential>({ prefix })),
});

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
    list: async (options) => (await directory().list(options)).map(toAgent),
    setArchived: async (agentId, archived, principal) => {
      if (!oysterPrincipalIsOwner(principal)) return { error: "not_granted" };
      if (!(await directory().has(agentId))) return { error: "not_found" };
      const agent = env.AGENTS.getByName(agentId);
      const pin = await agent.policyDirectory();
      if (
        pin?.directoryName !== directoryName ||
        pin.tenantId !== (scope?.tenantId ?? defaultTenant)
      )
        return { error: "not_found" };
      return agent.setArchived(archived);
    },
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
    readModelChoice: async (agentId) =>
      (await directory().has(agentId))
        ? env.AGENTS.getByName(agentId).readModelChoice()
        : null,
    decodeModelChoice: (json) => {
      const parsed = Schema.decodeUnknownOption(
        Schema.fromJsonString(agentModelChoiceSchema),
        { onExcessProperty: "error" },
      )(json);
      return parsed._tag === "None" ? null : parsed.value;
    },
    setModelChoice: async (agentId, choice, principal) => {
      if (!oysterPrincipalIsOwner(principal)) return { error: "not_granted" };
      if (!(await directory().has(agentId))) return { error: "not_found" };
      const pinned = await env.AGENTS.getByName(agentId).policyDirectory();
      if (
        pinned?.directoryName !== directoryName ||
        pinned.tenantId !== (scope?.tenantId ?? defaultTenant)
      )
        return { error: "not_found" };
      return env.AGENTS.getByName(agentId).setModelChoice(choice);
    },
    modelKeys: () => directory().listModelKeys(),
    sealModelKey: (input) => directory().sealModelKey(input),
    removeModelKey: (keyId) => directory().removeModelKey(keyId),
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
    connections: () => directory().connections(),
    addConnection: (input) => directory().addConnection(input),
    grantConnection: (connectionId, agentId, access) =>
      directory().grantConnection(connectionId, agentId, access),
    ungrantConnection: (connectionId, agentId) =>
      directory().ungrantConnection(connectionId, agentId),
    removeConnection: (connectionId) =>
      directory().removeConnection(connectionId),
    connectionTools: (connectionId) =>
      directory().connectionTools(connectionId),
    completeMcpConnection: (query) => directory().completeMcpConnection(query),
    mcpCallbackUrl: () => mcpCallbackUrl(env.OYSTER_ORIGIN),
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
      requestedResource: (raw) => ({
        kind: "agent",
        id: agentBindingArgs.INBOX.visit.parse(raw)[0].agentId,
      }),
    },
  },
  AGENTS: {
    schedules: {
      decodeArgs: (raw) => agentScheduleBindingArgs.schedules.parse(raw),
      decodeResult: Schema.decodeUnknownSync(agentSchedulePageSchema, {
        onExcessProperty: "error",
      }),
      requiredOperations: () => ["schedules"],
      requestedResource: (raw) => ({
        kind: "agent",
        id: agentScheduleBindingArgs.schedules.parse(raw)[0].agentId,
      }),
    },
    pauseSchedule: {
      decodeArgs: (raw) => agentScheduleBindingArgs.pauseSchedule.parse(raw),
      decodeResult: Schema.decodeUnknownSync(
        agentScheduleControlReceiptSchema,
        {
          onExcessProperty: "error",
        },
      ),
      requiredOperations: () => ["pauseSchedule"],
      requestedResource: (raw) => ({
        kind: "agent",
        id: agentScheduleBindingArgs.pauseSchedule.parse(raw)[0].agentId,
      }),
    },
    resumeSchedule: {
      decodeArgs: (raw) => agentScheduleBindingArgs.resumeSchedule.parse(raw),
      decodeResult: Schema.decodeUnknownSync(
        agentScheduleControlReceiptSchema,
        {
          onExcessProperty: "error",
        },
      ),
      requiredOperations: () => ["resumeSchedule"],
      requestedResource: (raw) => ({
        kind: "agent",
        id: agentScheduleBindingArgs.resumeSchedule.parse(raw)[0].agentId,
      }),
    },
    deleteSchedule: {
      decodeArgs: (raw) => agentScheduleBindingArgs.deleteSchedule.parse(raw),
      decodeResult: Schema.decodeUnknownSync(
        agentScheduleControlReceiptSchema,
        {
          onExcessProperty: "error",
        },
      ),
      requiredOperations: () => ["deleteSchedule"],
      requestedResource: (raw) => ({
        kind: "agent",
        id: agentScheduleBindingArgs.deleteSchedule.parse(raw)[0].agentId,
      }),
    },
    send: {
      decodeArgs: (raw) => agentBindingArgs.AGENTS.send.parse(raw),
      decodeResult: decodeAgentAccepted,
      requiredOperations: () => ["send"],
      requestedResource: (raw) => ({
        kind: "agent",
        id: agentBindingArgs.AGENTS.send.parse(raw)[0].agentId,
      }),
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
  admitted: Installation,
): Promise<OysterJson> {
  frame.signal.throwIfAborted();
  if (frame.facts.selection.owner.kind !== "installation")
    throw new AppInstanceError("revoked");
  const installationId = frame.facts.selection.owner.id;
  const directory = agentDirectoryForScope(env, scope);
  let result:
    | { items: readonly OysterInboxItem[]; next: null; cursor: number }
    | { visited: true }
    | AgentSchedulePage
    | AgentScheduleControlReceipt
    | Pick<
        Awaited<ReturnType<StandaloneAgentBase["sendFromApp"]>>,
        "status" | "commandId"
      >;
  if (props.binding === "INBOX" && method === "page") {
    agentBindingArgs.INBOX.page.parse(args);
    const read = admitted.authority.approvedGrants.find(
      (grant) => grant.capability === "agent.read",
    );
    if (read === undefined) throw new AppInstanceError("binding_not_granted");
    const ceiling = agentCeiling(read.resources);
    const inbox = await standaloneAgents(env, scope).inbox();
    result =
      ceiling === "all"
        ? { items: inbox.items, next: null, cursor: inbox.revision }
        : {
            items: inbox.items.filter(
              (item) => "agentId" in item && ceiling.has(item.agentId),
            ),
            next: null,
            // The global revision also moves for Agents outside the selection;
            // with no scoped change stream, a narrowed App sees neither it nor their rows.
            cursor: 0,
          };
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
  } else if (
    props.binding === "AGENTS" &&
    (method === "schedules" ||
      method === "pauseSchedule" ||
      method === "resumeSchedule" ||
      method === "deleteSchedule")
  ) {
    const [input] = agentScheduleBindingArgs[method].parse(args);
    if (!(await directory.has(input.agentId))) throw new Error("No such agent");
    const home = await directory.agentHome(input.agentId);
    if (home?.kind === "machine")
      throw new MachineLinkRefused("actor_not_allowed");
    if (home === null) throw new AppInstanceError("revoked");
    frame.signal.throwIfAborted();
    const agent = env.AGENTS.getByName(input.agentId);
    const pin = {
      directoryName: scope.durableName("agents"),
      tenantId: scope.tenantId,
    };
    if (method === "schedules") {
      result = await agent.readSchedules(
        pin,
        agentScheduleBindingArgs.schedules.parse(args)[0],
      );
    } else {
      result = await agent.controlSchedule(
        pin,
        agentScheduleBindingArgs[method].parse(args)[0],
        method === "pauseSchedule"
          ? "pause"
          : method === "resumeSchedule"
            ? "resume"
            : "delete",
      );
    }
  } else {
    throw new AppInstanceError("revoked");
  }
  frame.signal.throwIfAborted();
  return Schema.decodeUnknownSync(
    Schema.Union([
      inboxPageSchema,
      inboxVisitSchema,
      AcceptedSchema,
      agentSchedulePageSchema,
      agentScheduleControlReceiptSchema,
    ]),
    { onExcessProperty: "error" },
  )(result);
}
