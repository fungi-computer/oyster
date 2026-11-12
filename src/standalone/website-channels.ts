/**
 * The standalone website channel: an owner puts a chat with one of their
 * Agents on a separate website. The directory owns the bindings and the
 * anonymous visitor identities; each website is served by a dedicated Agent
 * instance (never the owner's own Agent), and the public edge authenticates a
 * visitor once before any Agent is selected.
 */
import { Hono, type Context } from "hono";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { z } from "zod";
import type { Avatar } from "@fungi.computer/sprite/avatar";
import { owner, routes, type Routes } from "../authorization.js";
import {
  createWebsiteBindings,
  createWebsiteInputSchema,
  updateWebsiteInputSchema,
  type CreateWebsiteInput,
  type UpdateWebsiteInput,
  WebsiteBindingError,
  type WebsiteBinding,
} from "../channels/web-binding.js";
import { createChannelVisitors } from "../channels/visitors.js";
import type { VisitorSql } from "../channels/visitors.js";
import type { VisitorSiteFacts } from "../channels/visitor-edge.js";
import type { WebsiteTranscript } from "@fungi.computer/nacre/website-channels";
import type { OysterEnv } from "../host.js";
import { readTurnstileConfiguration } from "../turnstile.js";
import { tenantScope, defaultTenant, type TenantPrincipal } from "../tenant.js";
import { agentDirectoryForScope } from "./agent-directory.js";
import type { StandaloneAgentsEnv } from "./agents.js";
import { standaloneVisitorEdge } from "./visitor-edge.js";

/** A public site: its binding and the chrome a visitor sees. */
export type WebsiteSite = Readonly<{
  binding: WebsiteBinding;
  facts: VisitorSiteFacts;
}>;

/** The chosen Agent's public face, or null when it is no longer in the directory. */
export type WebsiteAgentIdentity = Readonly<{ name: string; avatar: Avatar }>;

/**
 * The directory's website owner: bindings and visitor identities on its own
 * store, with the chosen Agent's identity read from the directory itself.
 */
export function createWebsiteChannelOwner(
  options: Readonly<{
    sql: VisitorSql;
    transactionSync: <T>(body: () => T) => T;
    agentExists: (agentId: string) => boolean;
    agentIdentity: (agentId: string) => WebsiteAgentIdentity | null;
  }>,
) {
  const bindings = createWebsiteBindings(options);
  const visitors = createChannelVisitors({
    sql: options.sql,
    transactionSync: options.transactionSync,
    now: () => Date.now(),
  });
  return {
    bindings,
    visitors,
    /** A public site key resolves only to an active site with a live Agent. */
    site: (siteKey: string): WebsiteSite | null => {
      const binding = bindings.readBySiteKey(siteKey);
      if (binding === null) return null;
      const agent = options.agentIdentity(binding.agentId);
      if (agent === null) return null;
      const { origins, accent, turnstile } = binding.selector;
      const facts: VisitorSiteFacts = { ...agent, origins };
      if (accent !== undefined) facts.accent = accent;
      if (turnstile === true) facts.turnstile = true;
      return { binding, facts };
    },
  };
}
/** The directory's website owner. */
export type WebsiteChannelOwner = ReturnType<typeof createWebsiteChannelOwner>;

/** Why an owner's website command was refused. */
export type WebsiteRefusal = Readonly<{
  error:
    | "not_granted"
    | "not_found"
    | "version_conflict"
    | "request_conflict"
    | "invalid_input";
}>;

/** Run one binding command, turning its closed failures into data. */
export function websiteOutcome<T>(command: () => T): T | WebsiteRefusal {
  try {
    return command();
  } catch (error) {
    if (error instanceof WebsiteBindingError) return { error: error.code };
    throw error;
  }
}

/** The host secrets a website needs; absent or short means the edge is closed. */
export type StandaloneWebsiteEnv = Pick<
  StandaloneAgentsEnv,
  "AGENTS" | "AGENT_DIRECTORY" | "OYSTER_ORIGIN" | "OYSTER_WEBSITE_PROOF_KEY"
> &
  Readonly<{
    /** Host secret (at least 32 bytes) salting the visitor address hash. */
    OYSTER_WEBSITE_ADDRESS_KEY?: string;
    TURNSTILE?: string;
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
  }>;

/** The website channel is not configured on this Oyster. */
class WebsiteConfigurationError extends Error {
  constructor() {
    super("Website channel host secrets are unavailable or invalid");
    this.name = "WebsiteConfigurationError";
  }
}

const hostKeySchema = z
  .string()
  .refine((value) => new TextEncoder().encode(value).byteLength >= 32);

function hostKey(value: string | undefined): string {
  const parsed = hostKeySchema.safeParse(value);
  if (!parsed.success) throw new WebsiteConfigurationError();
  return parsed.data;
}

/** Rate-limit key: the client address hashed under a daily-rotating salt. */
async function addressHash(
  env: StandaloneWebsiteEnv,
  address: string | undefined,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(hostKey(env.OYSTER_WEBSITE_ADDRESS_KEY)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const day = new Date().toISOString().slice(0, 10);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${day}:${address ?? "unknown"}`),
  );
  return Array.from(new Uint8Array(signature).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const defaultDirectory = (env: StandaloneWebsiteEnv) =>
  agentDirectoryForScope(env, tenantScope(defaultTenant, env.OYSTER_ORIGIN));

const embedAssets = async () => import("#embed-scripts");
const scriptHeaders = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
} as const;

/**
 * The public website surface, on the same paths as Hub's: the launcher, the
 * visitor document and the visitor API. Every visitor request authenticates
 * once here; Agents receive only a signed, short-lived assertion.
 */
export function standaloneWebsiteApp() {
  type E = { Bindings: StandaloneWebsiteEnv };
  const resolve = (context: Context<E>) => context.env;
  const edge = standaloneVisitorEdge<E>({
    site: (context, siteKey) =>
      defaultDirectory(resolve(context)).websiteSite(siteKey),
    visitors: (context) => {
      const directory = defaultDirectory(resolve(context));
      return {
        mint: (site, siteKey, address) =>
          directory.websiteMint(site?.bindingId ?? "", siteKey, address),
        refresh: (site, secret) =>
          directory.websiteRefresh(site?.bindingId ?? "", secret),
        rotate: (site, siteKey, token, address) =>
          directory.websiteRotate(
            site?.bindingId ?? "",
            siteKey,
            token,
            address,
          ),
        authenticate: (bindingId, token) =>
          directory.websiteAuthenticate(bindingId, token),
      };
    },
    // Visitors reach the chosen Agent itself, with its own tools.
    agent: (context, binding) =>
      resolve(context).AGENTS.getByName(binding.agentId),
    proofKey: (context) => hostKey(resolve(context).OYSTER_WEBSITE_PROOF_KEY),
    addressHash: (context) =>
      addressHash(resolve(context), context.req.header("cf-connecting-ip")),
    turnstile: (context) => {
      const env = resolve(context);
      return {
        configuration: readTurnstileConfiguration(env, env.OYSTER_ORIGIN),
        timeoutMs: 5_000,
        onError: (cause) => {
          console.error("website turnstile verification failed", cause);
        },
      };
    },
    assetPath: (kind) =>
      kind === "widget" ? "/embed/widget.js" : "/styles.css",
    onError: (error, context) => {
      if (error instanceof WebsiteConfigurationError)
        return context.json({ error: "website_unavailable" }, 503);
      console.error(error);
      return context.json({ error: "internal" }, 500);
    },
  });
  return new Hono<E>()
    .get("/embed/v1.js", async () => {
      const { embedLoaderScript } = await embedAssets();
      return new Response(embedLoaderScript, { headers: scriptHeaders });
    })
    .get("/embed/widget.js", async () => {
      const { embedWidgetScript } = await embedAssets();
      return new Response(embedWidgetScript, { headers: scriptHeaders });
    })
    .get("/styles.css", async () => {
      const { embedStyles } = await embedAssets();
      return new Response(embedStyles, {
        headers: {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    })
    .route("/", edge);
}

/** What the owner's website routes need from the directory and the Agents. */
export type StandaloneWebsiteControl = Readonly<{
  read: (principal: TenantPrincipal) => Promise<
    Readonly<{
      embedOrigin: string;
      agents: readonly Readonly<{ agentId: string; name: string }>[];
      websites: readonly WebsiteBinding[];
    }>
  >;
  create: (
    principal: TenantPrincipal,
    input: CreateWebsiteInput,
    requestId: string,
  ) => Promise<WebsiteBinding | WebsiteRefusal>;
  update: (
    principal: TenantPrincipal,
    bindingId: string,
    input: UpdateWebsiteInput,
  ) => Promise<WebsiteBinding | WebsiteRefusal>;
  conversations: (
    principal: TenantPrincipal,
    bindingId: string,
  ) => Promise<
    readonly Readonly<{
      sessionId: string;
      label: string;
      lastEventAt: number;
    }>[]
  >;
  transcript: (
    principal: TenantPrincipal,
    bindingId: string,
    sessionId: string,
  ) => Promise<WebsiteTranscript | null>;
}>;

/** What the owner's website controls need from their host. */
export type StandaloneWebsiteControlEnv = Pick<
  StandaloneAgentsEnv,
  "AGENTS" | "OYSTER_ORIGIN"
>;

/** The owner's website controls over the directory and each website's Agent. */
export function standaloneWebsiteControl(
  env: StandaloneWebsiteControlEnv,
  directoryOf: () => ReturnType<typeof agentDirectoryForScope>,
): StandaloneWebsiteControl {
  // Only a binding the directory knows names an Agent whose conversations are read.
  const agentOf = async (principal: TenantPrincipal, bindingId: string) => {
    const listed = await directoryOf().websiteList(principal);
    const binding =
      "error" in listed
        ? undefined
        : listed.find((item) => item.bindingId === bindingId);
    return binding === undefined ? null : env.AGENTS.getByName(binding.agentId);
  };
  return {
    read: async (principal) => {
      const listed = await directoryOf().websiteList(principal);
      return {
        embedOrigin: env.OYSTER_ORIGIN,
        agents: (await directoryOf().list()).map(({ agentId, name }) => ({
          agentId,
          name,
        })),
        websites: "error" in listed ? [] : listed,
      };
    },
    create: (principal, input, requestId) =>
      directoryOf().websiteCreate(principal, input, requestId),
    update: (principal, bindingId, input) =>
      directoryOf().websiteUpdate(principal, bindingId, input),
    conversations: async (principal, bindingId) => {
      const agent = await agentOf(principal, bindingId);
      return agent === null
        ? []
        : (await agent.bindingConversations(bindingId)).map(
            ({ sessionId, label, lastEventAt }) => ({
              sessionId,
              label,
              lastEventAt,
            }),
          );
    },
    transcript: async (principal, bindingId, sessionId) => {
      const agent = await agentOf(principal, bindingId);
      return agent === null
        ? null
        : agent.bindingTranscript(bindingId, sessionId);
    },
  };
}

const refusalStatus = {
  not_granted: 403,
  not_found: 404,
  version_conflict: 409,
  request_conflict: 409,
  invalid_input: 400,
} as const;

function refused(
  value: WebsiteBinding | WebsiteRefusal,
): value is WebsiteRefusal {
  return "error" in value;
}

/**
 * The owner's website controls. Each route is owner-direct: an App cannot
 * create a public surface, or read what its visitors said, on the owner's behalf.
 */
export function standaloneWebsiteRoutes(
  control: StandaloneWebsiteControl,
): Routes<OysterEnv> {
  const table = routes<OysterEnv>();
  // A body that is not JSON is a malformed request, not a thrown failure.
  const parseBody = async (context: Context<OysterEnv>) => {
    const decoded = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Json),
    )(await context.req.text());
    return Option.isSome(decoded)
      ? { ok: true as const, value: decoded.value }
      : { ok: false as const };
  };
  table.get(
    "/api/websites",
    owner("direct"),
    async (context, { principal }) => {
      context.header("Cache-Control", "no-store");
      return context.json(await control.read(principal));
    },
  );
  table.post(
    "/api/websites",
    owner("direct"),
    async (context, { principal }) => {
      context.header("Cache-Control", "no-store");
      const body = await parseBody(context);
      if (!body.ok) return context.json({ error: "invalid_input" }, 400);
      const parsed = createWebsiteInputSchema.safeParse(body.value);
      if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
      const result = await control.create(
        principal,
        parsed.data,
        context.req.header("x-request-id") ?? "",
      );
      return refused(result)
        ? context.json(result, refusalStatus[result.error])
        : context.json({ binding: result }, 201);
    },
  );
  table.put(
    "/api/websites/:bindingId",
    owner("direct"),
    async (context, { principal }) => {
      context.header("Cache-Control", "no-store");
      const body = await parseBody(context);
      if (!body.ok) return context.json({ error: "invalid_input" }, 400);
      const parsed = updateWebsiteInputSchema.safeParse(body.value);
      if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
      const result = await control.update(
        principal,
        context.req.param("bindingId"),
        parsed.data,
      );
      return refused(result)
        ? context.json(result, refusalStatus[result.error])
        : context.json({ binding: result });
    },
  );
  table.get(
    "/api/websites/:bindingId/conversations",
    owner("direct"),
    async (context, { principal }) => {
      context.header("Cache-Control", "no-store");
      return context.json({
        conversations: await control.conversations(
          principal,
          context.req.param("bindingId"),
        ),
      });
    },
  );
  table.get(
    "/api/websites/:bindingId/conversations/:sessionId",
    owner("direct"),
    async (context, { principal }) => {
      context.header("Cache-Control", "no-store");
      const transcript = await control.transcript(
        principal,
        context.req.param("bindingId"),
        context.req.param("sessionId"),
      );
      return transcript === null
        ? context.json({ error: "not_found" }, 404)
        : context.json(transcript);
    },
  );
  return table;
}
