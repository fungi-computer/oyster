import type { AppSetup } from "@fungi.computer/agar";
/**
 * Agents for Apps on a standalone Oyster: one adapter shape and the routes
 * the App page calls. Apps reach agents through Agar's `agent.list`,
 * `agent.manage`, `agent.read` and `agent.send` contracts, so an App written
 * for the Hub (Grove) runs unchanged. Each agent's own transport is
 * Shiitake's HTTP routes (`/sessions…`, `/acp`) and Knapsack's Session browser
 * transport (`/browser/…`), served by the adapter behind the same App grants.
 */
import type { Env } from "hono";
import type { TenantPrincipal } from "./tenant.js";
import type {
  ModelKeyRecord,
  ModelKeyRefusal,
  ModelKeySealInput,
} from "./standalone/model-key-vault.js";
export type {
  ModelKeyRefusal,
  ModelKeySealInput,
} from "./standalone/model-key-vault.js";
import {
  agent,
  agents as agentCollection,
  owner,
  routes,
  type OwnerAdmission,
  type OwnerPrincipal,
  type Routes,
} from "./authorization.js";
import type { AppToolPolicy } from "./apps/tools.js";
import * as Schema from "effect/Schema";
import { z } from "zod";
import {
  type CapabilityEnv,
  type OysterCapability,
  type OysterEnv,
} from "./host.js";
import type { HostActor } from "@fungi.computer/puffball/app";
import type { Avatar } from "@fungi.computer/sprite/avatar";
import { agentAvatarSchema } from "./agent-avatars.js";
import type { StarterOutcome } from "./starter-agent.js";
export type { StarterOutcome };
import { computerTargetParam } from "./computer-target.js";
import type {
  AgentModelChoice,
  AgentModelRefusal,
} from "./standalone/agent-model-choice.js";
export type {
  AgentModelChoice,
  AgentModelRefusal,
} from "./standalone/agent-model-choice.js";
import {
  agentAvatar,
  agentList,
  agentManage,
  agentRename,
  agentSessionRead,
  agentSessionWrite,
  agentToolPolicy,
} from "@fungi.computer/agar/agents";

import type {
  MemberInboxItem,
  MemberInboxSession,
} from "@fungi.computer/puffball/inbox";

/** One agent as Apps see it, in Agar's `appAgentSchema` shape. */
export type OysterAgent = Readonly<{
  agentId: string;
  name: string;
  /** The Agent's own avatar: the owner's choice, else its seeded default. */
  avatar: Avatar;
  sessionOperations: readonly ("agent.read" | "agent.send" | "agent.manage")[];
}>;

/** An Agent owner's Session facts before the member identity and visit are added. */
export type OysterSessionRow =
  | Omit<
      Extract<MemberInboxSession, { title: string }>,
      "agentId" | "visitedAt"
    >
  | Omit<Extract<MemberInboxSession, { state: "unavailable" }>, "agentId">;

/** Both hosts expose the same Inbox item vocabulary. */
export type OysterInboxItem = MemberInboxItem;

/** The whole inbox at one revision; the revision only grows. */
export type OysterInbox = Readonly<{
  items: readonly OysterInboxItem[];
  revision: number;
}>;

/** Host-attested source of a policy request; request headers are not this fact. */
export type AgentPolicyActor =
  "owner-direct" | Readonly<{ installationId: string }>;
/** An App's requested tools await the owner's direct approval. */
export type PendingAgentPolicy = Readonly<{
  status: "pending";
  revision: string;
}>;
/** What an Agent may do with one connection: everything, only reads, or named tools. */
export type ConnectionAccess = "all" | "read" | readonly string[];
/** One connection as its owner sees it; no secret, locator or token ever appears. */
export type OysterConnection = Readonly<{
  connectionId: string;
  /** The guest calls an MCP server's tools as `env.mcp.<name>.<tool>()`. */
  name: string;
  label: string;
  kind: "mcp" | "openapi";
  url: string;
  auth: "none" | "token" | "oauth";
  /** `pending` waits for the owner to sign in at the server; `reconnect_required` needs a new sign-in. */
  state: "connected" | "pending" | "reconnect_required";
  grants: readonly Readonly<{ agentId: string; access: ConnectionAccess }>[];
}>;
/** A newly added connection; `authorizeUrl` is where the owner signs in, when the server uses OAuth. */
export type ConnectionAdded = Readonly<{
  connectionId: string;
  authorizeUrl: string | null;
}>;
/** Why a connection change was refused. */
export type ConnectionRefusal = Readonly<{
  error: "not_found" | "duplicate_name" | "limit" | "invalid_endpoint";
}>;
/** An owner's request to connect one remote MCP server. */
export type ConnectionInput = typeof connectionInputSchema.Type;
/** At most this many connections per Agent. */
export const maxAgentConnections = 16;
/** Owner input for one MCP connection: a guest identifier, an `https:` endpoint and an optional bearer. */
export const connectionInputSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,31}$/u)),
  url: Schema.String.check(
    Schema.isMaxLength(2_048),
    Schema.makeFilter((value) => {
      if (!URL.canParse(value)) return "Use an https:// MCP endpoint";
      const url = new URL(value);
      return url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.hash === ""
        ? undefined
        : "Use an https:// MCP endpoint without credentials or a fragment";
    }),
  ),
  bearer: Schema.NullOr(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4_096),
      Schema.isPattern(/^[\x21-\x7e]+$/u),
    ),
  ),
  /**
   * Sign in at the server instead of pasting a token. Without a client the
   * server's dynamic registration is used; with one, the secret is sealed.
   */
  oauth: Schema.optional(
    Schema.Struct({
      clientId: Schema.optional(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
      ),
      clientSecret: Schema.optional(
        Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(4_096),
          Schema.isPattern(/^[\x21-\x7e]+$/u),
        ),
      ),
      scope: Schema.optional(
        Schema.String.check(
          Schema.isMaxLength(512),
          Schema.isPattern(/^[\x21-\x7e ]+$/u),
        ),
      ),
    }),
  ),
});

/** This Agent's App-tool policy, in the shape Apps read it. */
export type AgentToolPolicyStatus = Readonly<{
  status: "pending" | "approved";
  revision: string;
}>;

/**
 * Where an Oyster's agents live and run. Archive is non-destructive: `list()`
 * hides archived agents, and `list({ archived: true })` shows only archives.
 * Archived agents keep existing reads, replays and settlements, but refuse new
 * Sessions, prompts and steers with `contract/archived`. Archive refuses
 * non-idle Session work or unsettled delegations; it pauses Almanac and Loop
 * schedules and restores only archive-paused schedules on unarchive.
 */
export type OysterAgents = Readonly<{
  /** Active agents by default; archived agents only by explicit selection. */
  list(
    options?: Readonly<{ archived?: boolean }>,
  ): Promise<readonly OysterAgent[]>;
  /**
   * Offer the owner their starter Agent on an empty Team's first owner read;
   * it creates through this host's ordinary `create` and never fails the read.
   */
  ensureStarter(principal: TenantPrincipal): Promise<StarterOutcome>;
  /** Owner-only HTTP transition; creator Agents use their own control tool. */
  setArchived(
    agentId: string,
    archived: boolean,
    principal: TenantPrincipal,
  ): Promise<
    | Readonly<{ archived: boolean; revision: number }>
    | Readonly<{
        error:
          | "not_found"
          | "not_granted"
          | "self"
          | "not_creator"
          | "running"
          | "pending"
          | "unreadable"
          | "archived";
        /** Safe refusal text; busy work names its command. */
        message?: string;
        /** A repair failure can follow an already-committed owner flag. */
        archived?: boolean;
        revision?: number;
      }>
  >;
  /**
   * Create an agent; retrying with the same `requestId` returns the same one.
   * With no `avatar` it wears its seeded default until the owner picks one.
   */
  create(
    name: string,
    requestId: string,
    principal: TenantPrincipal,
    actor: AgentPolicyActor,
    avatar?: Avatar,
  ): Promise<OysterAgent>;
  /** Owner-only rename; refuses a name already held by another Agent. */
  rename(
    agentId: string,
    name: string,
    principal: TenantPrincipal,
  ): Promise<
    | OysterAgent
    | Readonly<{ error: "not_found" | "name_taken" | "not_granted" }>
  >;
  /** Owner-only avatar change for an existing Agent. */
  setAvatar(
    agentId: string,
    avatar: Avatar,
    principal: TenantPrincipal,
  ): Promise<OysterAgent | Readonly<{ error: "not_found" | "not_granted" }>>;
  /** Owner-only, secret-free Agent default; an unknown Agent cannot be configured. */
  readModelChoice(agentId: string): Promise<AgentModelChoice | null>;
  /** Parse the owner's JSON through the deployable Agent's model preference schema. */
  decodeModelChoice(json: string): AgentModelChoice | null;
  /** Persist a supported model and source reference for this Agent, or return an explicit refusal. */
  setModelChoice(
    agentId: string,
    choice: AgentModelChoice,
    principal: TenantPrincipal,
  ): Promise<
    | AgentModelChoice
    | Readonly<{ error: "not_found" | "not_granted" | AgentModelRefusal }>
  >;
  /** This Agent's App-tool policy status, or `null` for no such Agent. */
  policyStatus(agentId: string): Promise<AgentToolPolicyStatus | null>;
  /** Read this Agent's stored App-tool approval; absence requires re-approval. A key's App access is its own grants (Ear Tag), not this policy. */
  appToolPolicy(
    actor: Extract<HostActor, { kind: "agent" }>,
  ): Promise<AppToolPolicy | null>;
  /** Read the current revision for direct owner approval. */
  policyRevision(agentId: string): Promise<string | null>;
  /** Replace an Agent's tool approval under its authenticated attaching human. */
  approveAppToolPolicy(
    agentId: string,
    principal: TenantPrincipal,
    level: AppToolPolicy["level"],
    expectedRevision: string | null,
    actor: AgentPolicyActor,
  ): Promise<
    | AppToolPolicy
    | PendingAgentPolicy
    | Readonly<{ error: "not_found" | "revision_conflict" | "not_granted" }>
  >;
  /**
   * Whether a model and an image provider are connected, so an App can say so
   * before it takes a prompt. Reads configuration; never reaches a provider.
   */
  setup(): Promise<
    Readonly<{ models: "ready" | "missing"; media: "ready" | "missing" }>
  >;
  /** The instance's sealed model keys, never their secrets. */
  modelKeys(): Promise<readonly ModelKeyRecord[]>;
  /** Validate with the provider, then seal one key; or an explicit refusal. */
  sealModelKey(
    input: ModelKeySealInput,
  ): Promise<ModelKeyRecord | Readonly<{ error: ModelKeyRefusal }>>;
  /** Remove one key; Agents that chose it then fail with `key_removed`. */
  removeModelKey(keyId: string): Promise<"deleted" | "absent">;
  /** Every connection with the Agents that may use it. */
  connections(): Promise<readonly OysterConnection[]>;
  /** Connect one remote MCP server; no Agent has it until the owner grants it. */
  addConnection(
    input: ConnectionInput,
  ): Promise<ConnectionAdded | ConnectionRefusal>;
  /** Give an Agent access to a connection, or change how much it has. */
  grantConnection(
    connectionId: string,
    agentId: string,
    access: ConnectionAccess,
  ): Promise<Readonly<{ ok: true }> | ConnectionRefusal>;
  /** End one Agent's access; `false` when it had none. */
  ungrantConnection(connectionId: string, agentId: string): Promise<boolean>;
  /** Disconnect for everyone; `false` when the connection is unknown. */
  removeConnection(connectionId: string): Promise<boolean>;
  /** The tool names an MCP connection offers, for choosing a narrower grant. */
  connectionTools(
    connectionId: string,
  ): Promise<readonly string[] | ConnectionRefusal>;
  /** Settle a sign-in: the authorization server's redirect, by state and code. */
  completeMcpConnection(
    query: Readonly<{ state: string; code: string; iss: string | undefined }>,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ error: string }>>;
  /** The exact redirect URL an owner registers with an OAuth app. */
  mcpCallbackUrl(): string;
  /** Serve this Agent's Shiitake and Knapsack Session browser transports. */
  fetch(agentId: string, request: Request): Promise<Response | null>;
  /** This member's Session and Workflow review rows, admitted by the host. */
  inbox(): Promise<OysterInbox>;
  /** Current inbox revision without enumerating Session rows. */
  revision(): Promise<number>;
  /** Record that the member opened a Session. */
  visit(agentId: string, sessionId: string): Promise<boolean>;
}>;

const createSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  requestId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,256}$/u)),
  avatar: Schema.optionalKey(Schema.Unknown),
});
const renameSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
const avatarInputSchema = z.object({ avatar: agentAvatarSchema });
const visitSchema = Schema.Struct({
  agentId: Schema.String,
  sessionId: Schema.String,
});
const agentIdPattern = /^[a-z0-9_-]{1,64}$/u;
/** Explicit owner-addressed settings remain reachable after list hides an archive. */
async function knownAgent(agents: OysterAgents, agentId: string) {
  if (!agentIdPattern.test(agentId)) return false;
  return (
    (await agents.list()).some((agent) => agent.agentId === agentId) ||
    (await agents.list({ archived: true })).some(
      (agent) => agent.agentId === agentId,
    )
  );
}
/** How often an open inbox stream re-reads the revision. */
const inboxPollMs = 2_000;
const maxAgentRequestBytes = 512 * 1024;

function refusal(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Agent adapters admitted against each App's declared capabilities. */
export function agentCapabilities(
  agents: OysterAgents,
): readonly OysterCapability[] {
  const shared = { base: "/", routes: createAgentRoutes(agents) };
  return [
    {
      ...shared,
      id: "agent.list",
      permission: "agent.list",
      version: agentList.version,
      methods: { list: { kind: "json", method: "GET", path: "agents" } },
    },
    {
      ...shared,
      id: "agent.manage",
      ownerDirect: routes<OysterEnv>()
        .include(ownerAgentRoutes<OysterEnv>(agents, "direct"))
        .include(cloudBrowserViewRoutes<OysterEnv>(agents)),
      permission: "agent.manage",
      version: agentManage.version,
      methods: {
        create: { kind: "json", method: "POST", path: "agents" },
        computers: { kind: "json", method: "GET", path: "agent-computers" },
        open: { kind: "transport", method: "ANY", path: "agents/:agentId" },
      },
    },
    {
      ...shared,
      id: "agent.rename",
      permission: "agent.rename",
      version: agentRename.version,
      methods: {
        rename: { kind: "json", method: "PUT", path: "agent-names/:agentId" },
      },
    },
    {
      ...shared,
      id: "agent.avatar",
      permission: "agent.avatar",
      version: agentAvatar.version,
      methods: {
        setAvatar: {
          kind: "json",
          method: "PUT",
          path: "agent-avatars/:agentId",
        },
      },
    },
    {
      ...shared,
      id: "agent.toolPolicy",
      permission: "agent.toolPolicy",
      version: agentToolPolicy.version,
      methods: {
        status: {
          kind: "json",
          method: "GET",
          path: "agent-policies/:agentId",
        },
        approve: {
          kind: "json",
          method: "PUT",
          path: "agent-policies/:agentId",
        },
      },
    },
    {
      ...shared,
      id: "agent.read",
      permission: "agent.read",
      version: agentSessionRead.version,
      methods: {
        open: { kind: "transport", method: "GET", path: "agents/:agentId" },
        openInbox: { kind: "transport", method: "GET", path: "member" },
      },
    },
    {
      ...shared,
      id: "agent.send",
      permission: "agent.send",
      version: agentSessionWrite.version,
      methods: {
        open: { kind: "transport", method: "ANY", path: "agents/:agentId" },
        openInbox: { kind: "transport", method: "ANY", path: "member" },
      },
    },
  ];
}

/**
 * The person's live view of a paused cloud-browser lease: the owner, direct
 * only (never an App acting for them), served by the Agent that holds the lease.
 */
function cloudBrowserViewRoutes<E extends Env>(
  agents: OysterAgents,
): Routes<E> {
  return routes<E>().on(
    ["GET", "POST"],
    "/agents/:agentId/cloud-browser/*",
    owner("direct"),
    async (context) => {
      const agentId = context.req.param("agentId");
      if (!agentIdPattern.test(agentId)) return refusal(404, "No such agent");
      const incoming = context.req.raw;
      const path = new URL(incoming.url).pathname.slice(
        `/agents/${agentId}`.length,
      );
      const response = await agents.fetch(
        agentId,
        new Request(`https://agent.internal${path}`, incoming),
      );
      return response ?? refusal(404, "No such agent");
    },
  );
}

/** The owner capability: create, archive and restore, never Session transport. */
function ownerAgentRoutes<E extends Env>(
  agents: OysterAgents,
  via: "direct" | "direct-or-app",
): Routes<E> {
  return routes<E>()
    .post("/agents", owner(via), async (context, { principal }) => {
      const body = Schema.decodeUnknownOption(createSchema)(
        await context.req.json(),
      );
      if (body._tag === "None") return refusal(400, "Name the agent");
      const avatar =
        body.value.avatar === undefined
          ? undefined
          : agentAvatarSchema.safeParse(body.value.avatar);
      if (avatar?.success === false)
        return refusal(400, "Choose a valid avatar");
      // The owner's own authenticated request creates this Agent; its App tools
      // are approved the same way direct owner approval is, with no second path.
      return Response.json(
        await agents.create(
          body.value.name,
          body.value.requestId,
          principal,
          "owner-direct",
          avatar?.data,
        ),
      );
    })
    .post("/agents/:agentId/archive", owner(via), (context, admission) =>
      changeArchive(agents, context.req.param("agentId"), true, admission),
    )
    .post("/agents/:agentId/unarchive", owner(via), (context, admission) =>
      changeArchive(agents, context.req.param("agentId"), false, admission),
    );
}

function createAgentRoutes(agents: OysterAgents): Routes<CapabilityEnv> {
  return (
    routes<CapabilityEnv>()
      .include(ownerAgentRoutes<CapabilityEnv>(agents, "direct-or-app"))
      // Standalone Agents choose no Computer at creation; the owner attaches one.
      .get("/agent-computers", owner("direct-or-app"), () =>
        Response.json(null),
      )
      .get(
        "/agents",
        agentCollection(),
        async (context, { reaches, everyAgent, authority }) => {
          const selected = context.req.query("archived");
          if (
            selected !== undefined &&
            selected !== "true" &&
            selected !== "false"
          )
            return refusal(400, "Choose a valid archive view");
          // The owner's own directory read is the starter Agent's one trigger.
          if (everyAgent && authority.kind === "owner" && selected !== "true")
            await agents.ensureStarter(authority.principal);
          const listed = await agents.list({ archived: selected === "true" });
          const reached: OysterAgent[] = [];
          for (const item of listed)
            if (await reaches(item.agentId)) reached.push(item);
          return Response.json(reached);
        },
      )
      .put(
        "/agent-names/:agentId",
        owner("direct-or-app"),
        async (context, { principal }) => {
          const agentId = context.req.param("agentId");
          if (!agentIdPattern.test(agentId))
            return refusal(404, "No such agent");
          const body = Schema.decodeUnknownOption(renameSchema)(
            await context.req.json(),
          );
          if (body._tag === "None") return refusal(400, "Name the agent");
          const result = await agents.rename(
            agentId,
            body.value.name,
            principal,
          );
          if ("error" in result)
            return refusal(
              result.error === "not_found"
                ? 404
                : result.error === "name_taken"
                  ? 409
                  : 403,
              result.error,
            );
          return Response.json(result);
        },
      )
      .put(
        "/agent-avatars/:agentId",
        owner("direct-or-app"),
        async (context, { principal }) => {
          const agentId = context.req.param("agentId");
          if (!agentIdPattern.test(agentId))
            return refusal(404, "No such agent");
          const body = avatarInputSchema.safeParse(await context.req.json());
          if (!body.success) return refusal(400, "Choose a valid avatar");
          const result = await agents.setAvatar(
            agentId,
            body.data.avatar,
            principal,
          );
          if ("error" in result)
            return refusal(
              result.error === "not_found" ? 404 : 403,
              result.error,
            );
          return Response.json(result);
        },
      )
      .get(
        "/agent-policies/:agentId",
        agent(),
        async (_context, { agentId }) => {
          if (!agentIdPattern.test(agentId))
            return refusal(404, "No such agent");
          const status = await agents.policyStatus(agentId);
          return status === null
            ? refusal(404, "No such agent")
            : Response.json(status);
        },
      )
      .put(
        "/agent-policies/:agentId",
        owner("direct-or-app"),
        async (context, { principal }) =>
          approvePolicy(
            agents,
            principal,
            "owner-direct",
            context.req.param("agentId"),
            await context.req.text(),
          ),
      )
      .all("/agents/:agentId/*", agent(), async (context, { agentId }) => {
        if (!agentIdPattern.test(agentId)) return refusal(404, "No such agent");
        const incoming = context.req.raw;
        const url = new URL(incoming.url);
        const path = url.pathname.slice(`/agents/${agentId}`.length);
        if (!(
          (path === "/models" && incoming.method === "GET") ||
          path === "/acp" ||
          path === "/sessions" ||
          path.startsWith("/sessions/") ||
          path.startsWith("/browser/")
        ))
          return refusal(404, "Not found");
        const length = Number(incoming.headers.get("content-length") ?? "0");
        if (length > maxAgentRequestBytes)
          return refusal(413, "Request too large");
        const target = new URL(`https://agent.internal${path}${url.search}`);
        // A desk window's Computer routing hint is the host's to admit; the
        // Agent's Session routes decode a closed query that refuses it.
        target.searchParams.delete(computerTargetParam);
        const response = await agents.fetch(
          agentId,
          new Request(target, incoming),
        );
        return response ?? refusal(404, "No such agent");
      })
      .get(
        "/member/inbox",
        agentCollection(),
        async (_context, { authority, everyAgent, reaches }) => {
          const inbox = await agents.inbox();
          if (everyAgent)
            return Response.json({
              items: inbox.items,
              next: null,
              cursor: inbox.revision,
            });
          const items: (typeof inbox.items)[number][] = [];
          for (const item of inbox.items)
            if ("agentId" in item && (await reaches(item.agentId)))
              items.push(item);
          return Response.json({
            items,
            next: null,
            // The global revision changes for ungranted Agents too. Key feeds have
            // no scoped event stream, so expose neither that revision nor its events.
            // An owner's narrowed App keeps the owner's change stream, which
            // announces only a `reset`, so it keeps the revision that stream resumes from.
            cursor: authority.kind === "owner" ? inbox.revision : 0,
          });
        },
      )
      .get("/member/inbox/notices", owner("direct-or-app"), () =>
        Response.json({ items: [], next: null }),
      )
      .post(
        "/member/inbox/visits",
        agent(
          async (facts) => (await facts.body(visitSchema))?.agentId ?? null,
        ),
        async (context, { agentId }) => {
          const body = Schema.decodeUnknownOption(visitSchema)(
            await context.req.json(),
          );
          if (body._tag === "None") return refusal(400, "Invalid visit");
          return (await agents.visit(agentId, body.value.sessionId))
            ? new Response(null, { status: 204 })
            : refusal(404, "No such Session");
        },
      )
      // The feed is small (one person's agents), so a change is announced as a
      // `reset` and the client re-reads the whole inbox. The unscoped revision
      // also changes for other Agents, so only the owner reads it.
      .get("/member/inbox/events", owner("direct-or-app"), (context) => {
        const after = Number(context.req.query("after") ?? "0");
        const signal = context.req.raw.signal;
        const encoder = new TextEncoder();
        let revision = after;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(": open\n\n"));
            while (!signal.aborted) {
              const current = await agents.revision();
              if (current !== revision) {
                revision = current;
                controller.enqueue(
                  encoder.encode("event: reset\ndata: {}\n\n"),
                );
              } else controller.enqueue(encoder.encode(": keep-alive\n\n"));
              await new Promise((resolve) => setTimeout(resolve, inboxPollMs));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
          },
        });
      })
  );
}

/** Owner-only archive transition; creator Agents use their own control tool. */
async function changeArchive(
  agents: OysterAgents,
  agentId: string,
  archived: boolean,
  { principal, delegatesAgent }: OwnerAdmission,
): Promise<Response> {
  if (!agentIdPattern.test(agentId)) return refusal(404, "No such agent");
  if (!delegatesAgent(agentId)) return refusal(403, "Agent access denied");
  const result = await agents.setArchived(agentId, archived, principal);
  if ("error" in result)
    return Response.json(result, {
      status:
        result.error === "not_found"
          ? 404
          : result.error === "not_granted"
            ? 403
            : result.archived !== undefined
              ? 503
              : 409,
    });
  return Response.json(result);
}

async function approvePolicy(
  agents: OysterAgents,
  principal: OwnerPrincipal,
  actor: AgentPolicyActor,
  agentId: string,
  body: string,
): Promise<Response> {
  const input = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        level: Schema.Literals(["read", "write"]),
        expectedRevision: Schema.NullOr(Schema.NonEmptyString),
      }),
    ),
    { onExcessProperty: "error" },
  )(body);
  if (input._tag === "None") return refusal(400, "Choose read or write tools");
  if (!(await knownAgent(agents, agentId)))
    return refusal(404, "No such agent");
  const result = await agents.approveAppToolPolicy(
    agentId,
    principal,
    input.value.level,
    input.value.expectedRevision,
    actor,
  );
  const failureStatuses = {
    not_found: 404,
    not_granted: 403,
    revision_conflict: 409,
  };
  return "error" in result
    ? refusal(failureStatuses[result.error], result.error)
    : Response.json(result);
}

/** Host-owned direct approval under the admitted owner; never an App capability. */
export function agentApprovalRoutes(agents: OysterAgents): Routes<OysterEnv> {
  return (
    routes<OysterEnv>()
      // One owner read for the settings panel: every Agent with its model choice.
      .get("/api/agent-models", owner("direct"), async () => {
        const rows = await Promise.all(
          (await agents.list()).map(async (item) => ({
            agentId: item.agentId,
            name: item.name,
            choice: await agents.readModelChoice(item.agentId),
          })),
        );
        return Response.json({ agents: rows });
      })
      .get("/api/agent-models/:agentId", owner("direct"), async (context) => {
        const agentId = context.req.param("agentId");
        if (!agentIdPattern.test(agentId)) return refusal(404, "No such agent");
        const choice = await agents.readModelChoice(agentId);
        return choice === null
          ? refusal(404, "No such agent")
          : Response.json(choice);
      })
      .put(
        "/api/agent-models/:agentId",
        owner("direct"),
        async (context, { principal }) => {
          const agentId = context.req.param("agentId");
          if (!agentIdPattern.test(agentId))
            return refusal(404, "No such agent");
          const input = agents.decodeModelChoice(await context.req.text());
          if (input === null) return refusal(400, "Invalid model choice");
          const choice = await agents.setModelChoice(agentId, input, principal);
          if ("error" in choice && choice.error === "invalid_model_choice")
            return refusal(400, "Invalid model choice");
          return "error" in choice
            ? refusal(
                choice.error === "not_found"
                  ? 404
                  : choice.error === "not_granted"
                    ? 403
                    : 409,
                choice.error,
              )
            : Response.json(choice);
        },
      )
      .get("/api/agent-policies/:agentId", owner("direct"), async (context) => {
        const agentId = context.req.param("agentId");
        if (!(await knownAgent(agents, agentId)))
          return refusal(404, "No such agent");
        return Response.json({
          expectedRevision: await agents.policyRevision(agentId),
        });
      })
      .put(
        "/api/agent-policies/:agentId",
        owner("direct"),
        async (context, { principal }) =>
          approvePolicy(
            agents,
            principal,
            "owner-direct",
            context.req.param("agentId"),
            await context.req.text(),
          ),
      )
  );
}

const keyIdPattern = /^cred_[A-Za-z0-9_-]{1,64}$/u;
const sealRequestSchema = Schema.Struct({
  provider: Schema.Literals(["anthropic", "openai", "openrouter"]),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  apiKey: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16_384),
  ),
});
const modelKeyRefusalStatus = {
  invalid_key: 400,
  key_rejected: 422,
  provider_unavailable: 502,
  custody_unavailable: 503,
  key_removed: 404,
  target_denied: 400,
  limit: 409,
} satisfies Record<ModelKeyRefusal, number>;

/**
 * Host-owned model-key custody for the owner directly. A key goes in once and
 * never comes back out; listings carry provider, label and times only.
 */
export function modelKeyRoutes(
  agents: OysterAgents,
  computerSetup?: () => Promise<Pick<AppSetup, "terminal" | "terminalReason">>,
): Routes<OysterEnv> {
  return routes<OysterEnv>()
    .get("/api/model-keys", owner("direct"), async () =>
      Response.json({ keys: await agents.modelKeys() }),
    )
    .get("/api/setup", owner("direct"), async () =>
      Response.json({
        ...(await agents.setup()),
        // Git and the terminal are read from the Computer, which reports them.
        git: "unknown",
        terminal: "unknown",
        ...(await computerSetup?.()),
      }),
    )
    .post("/api/model-keys", owner("direct"), async (context) => {
      const length = Number(context.req.header("content-length") ?? "0");
      if (length > 32 * 1024) return refusal(413, "Request too large");
      const input = Schema.decodeUnknownOption(
        Schema.fromJsonString(sealRequestSchema),
        { onExcessProperty: "error" },
      )(await context.req.text());
      if (input._tag === "None")
        return refusal(400, "Choose a provider, name the key and paste it");
      const sealed = await agents.sealModelKey(input.value);
      return "error" in sealed
        ? refusal(modelKeyRefusalStatus[sealed.error], sealed.error)
        : Response.json(sealed, { status: 201 });
    })
    .delete("/api/model-keys/:keyId", owner("direct"), async (context) => {
      const keyId = context.req.param("keyId");
      if (!keyIdPattern.test(keyId)) return refusal(404, "No such key");
      return (await agents.removeModelKey(keyId)) === "deleted"
        ? new Response(null, { status: 204 })
        : refusal(404, "No such key");
    });
}

const connectionIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/u;
const connectionRefusalStatus = {
  not_found: 404,
  duplicate_name: 409,
  limit: 409,
  invalid_endpoint: 400,
};
const accessSchema = Schema.Struct({
  access: Schema.Union([
    Schema.Literal("all"),
    Schema.Literal("read"),
    Schema.Array(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    ).check(Schema.isMaxLength(256)),
  ]),
});

/**
 * Host-owned connection custody for the owner directly; never an App
 * capability. Tokens go in and never come back out.
 */
export function connectionRoutes(agents: OysterAgents): Routes<OysterEnv> {
  return (
    routes<OysterEnv>()
      // One owner read for the settings panel: every connection and every Agent.
      .get("/api/connections", owner("direct"), async () => {
        const [connections, listed] = await Promise.all([
          agents.connections(),
          agents.list(),
        ]);
        return Response.json({
          callbackUrl: agents.mcpCallbackUrl(),
          agents: listed.map(({ agentId, name }) => ({ agentId, name })),
          connections,
        });
      })
      .post("/api/connections", owner("direct"), async (context) => {
        const length = Number(context.req.header("content-length") ?? "0");
        if (length > 16 * 1024) return refusal(413, "Request too large");
        const input = Schema.decodeUnknownOption(
          Schema.fromJsonString(connectionInputSchema),
          { onExcessProperty: "error" },
        )(await context.req.text());
        if (input._tag === "None")
          return refusal(
            400,
            "Name the server (lowercase letters, digits, _) and give its https:// endpoint",
          );
        if (input.value.oauth !== undefined && input.value.bearer !== null)
          return refusal(400, "Choose a token or sign-in, not both");
        const added = await agents.addConnection(input.value);
        return "error" in added
          ? refusal(connectionRefusalStatus[added.error], added.error)
          : Response.json(added, { status: 201 });
      })
      // The authorization server's redirect: the owner's browser, signed in.
      .get("/api/connections/callback", owner("direct"), async (context) => {
        const query = context.req.query();
        if (
          query.error !== undefined ||
          query.state === undefined ||
          query.code === undefined
        )
          return refusal(400, "The sign-in was not completed");
        const settled = await agents.completeMcpConnection({
          state: query.state,
          code: query.code,
          iss: query.iss,
        });
        return "error" in settled
          ? refusal(400, "The sign-in could not be completed")
          : new Response(null, { status: 303, headers: { location: "/" } });
      })
      .get(
        "/api/connections/:connectionId/tools",
        owner("direct"),
        async (context) => {
          const connectionId = context.req.param("connectionId");
          if (!connectionIdPattern.test(connectionId))
            return refusal(404, "No such connection");
          const tools = await agents.connectionTools(connectionId);
          return "error" in tools
            ? refusal(connectionRefusalStatus[tools.error], tools.error)
            : Response.json({ tools });
        },
      )
      .put(
        "/api/connections/:connectionId/agents/:agentId",
        owner("direct"),
        async (context) => {
          const connectionId = context.req.param("connectionId");
          const agentId = context.req.param("agentId");
          if (
            !connectionIdPattern.test(connectionId) ||
            !agentIdPattern.test(agentId)
          )
            return refusal(404, "No such connection");
          const length = Number(context.req.header("content-length") ?? "0");
          if (length > 64 * 1024) return refusal(413, "Request too large");
          const input = Schema.decodeUnknownOption(
            Schema.fromJsonString(accessSchema),
            { onExcessProperty: "error" },
          )(await context.req.text());
          if (input._tag === "None")
            return refusal(400, "Choose all, read, or a list of tools");
          const granted = await agents.grantConnection(
            connectionId,
            agentId,
            input.value.access,
          );
          return "error" in granted
            ? refusal(connectionRefusalStatus[granted.error], granted.error)
            : new Response(null, { status: 204 });
        },
      )
      .delete(
        "/api/connections/:connectionId/agents/:agentId",
        owner("direct"),
        async (context) => {
          const connectionId = context.req.param("connectionId");
          const agentId = context.req.param("agentId");
          if (
            !connectionIdPattern.test(connectionId) ||
            !agentIdPattern.test(agentId)
          )
            return refusal(404, "No such connection");
          return (await agents.ungrantConnection(connectionId, agentId))
            ? new Response(null, { status: 204 })
            : refusal(404, "No such access");
        },
      )
      .delete(
        "/api/connections/:connectionId",
        owner("direct"),
        async (context) => {
          const connectionId = context.req.param("connectionId");
          if (!connectionIdPattern.test(connectionId))
            return refusal(404, "No such connection");
          return (await agents.removeConnection(connectionId))
            ? new Response(null, { status: 204 })
            : refusal(404, "No such connection");
        },
      )
  );
}
