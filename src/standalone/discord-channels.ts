/**
 * The standalone Discord channel: the owner brings their own Discord
 * application and puts one of their Agents behind it. The directory owns the
 * bindings; the bot token is sealed in the instance credential store and never
 * leaves it except inside a request to Discord. Fungi holds no Discord
 * credential.
 */
import { Hono, type Context } from "hono";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { z } from "zod";
import {
  CredentialError,
  type CredentialStore,
} from "@fungi.computer/veil/credential-store";
import { owner, routes, type Routes } from "../authorization.js";
import {
  createDiscordInputSchema,
  DiscordBindingError,
  updateDiscordInputSchema,
  discordPlaceAllowed,
  isDiscordBinding,
  type CreateDiscordInput,
  type DiscordBinding,
  type UpdateDiscordInput,
} from "../channels/discord-binding.js";
import {
  DISCORD_ASK_LIMIT,
  ASK_COMMAND,
  ASK_OPTION,
  REPLY_ID,
  REPLY_TEXT_ID,
  deferredResponse,
  ephemeralResponse,
  interactionSchema,
  pongResponse,
  replyModalResponse,
  verifyDiscordRequest,
  type DiscordAsk,
} from "../channels/discord-interactions.js";
import type { OysterEnv } from "../host.js";
import { defaultTenant, tenantScope, type TenantPrincipal } from "../tenant.js";
import { agentDirectoryForScope } from "./agent-directory.js";
import type { StandaloneAgentsEnv } from "./agents.js";

/** Why an owner's Discord command was refused. */
export type DiscordRefusal = Readonly<{
  error:
    | "not_granted"
    | "not_found"
    | "version_conflict"
    | "request_conflict"
    | "application_taken"
    | "invalid_input"
    | "custody_unavailable"
    | "limit";
}>;

/** Run one binding command, turning its closed failures into data. */
export function discordOutcome<T>(command: () => T): T | DiscordRefusal {
  try {
    return command();
  } catch (error) {
    if (error instanceof DiscordBindingError) return { error: error.code };
    throw error;
  }
}

/** Seal one bot token; the credential id is all that leaves custody. */
export async function sealDiscordToken(
  vault: CredentialStore,
  botToken: string,
): Promise<Readonly<{ credentialId: string }> | DiscordRefusal> {
  try {
    const record = await vault.put({
      kind: "discord-bot-token",
      label: "Discord bot token",
      secret: botToken,
    });
    return { credentialId: record.credentialId };
  } catch (error) {
    if (error instanceof CredentialError)
      return {
        error: error.code === "limit" ? "limit" : "custody_unavailable",
      };
    throw error;
  }
}

/** What the owner's Discord routes need from the directory. */
export type StandaloneDiscordControl = Readonly<{
  read: (principal: TenantPrincipal) => Promise<
    Readonly<{
      interactionsOrigin: string;
      agents: readonly Readonly<{ agentId: string; name: string }>[];
      discords: readonly DiscordBinding[];
    }>
  >;
  create: (
    principal: TenantPrincipal,
    input: CreateDiscordInput,
    requestId: string,
  ) => Promise<DiscordBinding | DiscordRefusal>;
  update: (
    principal: TenantPrincipal,
    bindingId: string,
    input: UpdateDiscordInput,
  ) => Promise<DiscordBinding | DiscordRefusal>;
  registerCommands: (
    principal: TenantPrincipal,
    bindingId: string,
  ) => Promise<
    | Readonly<{ registered: readonly string[]; failed: readonly string[] }>
    | DiscordRefusal
  >;
}>;

/** The owner's Discord controls over the directory. */
export function standaloneDiscordControl(
  env: Pick<StandaloneAgentsEnv, "OYSTER_ORIGIN">,
  directoryOf: () => ReturnType<typeof agentDirectoryForScope>,
): StandaloneDiscordControl {
  return {
    read: async (principal) => {
      const listed = await directoryOf().discordList(principal);
      return {
        interactionsOrigin: env.OYSTER_ORIGIN,
        agents: (await directoryOf().list()).map(({ agentId, name }) => ({
          agentId,
          name,
        })),
        discords: "error" in listed ? [] : listed,
      };
    },
    create: (principal, input, requestId) =>
      directoryOf().discordCreate(principal, input, requestId),
    update: (principal, bindingId, input) =>
      directoryOf().discordUpdate(principal, bindingId, input),
    registerCommands: (principal, bindingId) =>
      directoryOf().discordRegisterCommands(principal, bindingId),
  };
}

const refusalStatus = {
  not_granted: 403,
  not_found: 404,
  version_conflict: 409,
  request_conflict: 409,
  application_taken: 409,
  invalid_input: 400,
  custody_unavailable: 503,
  limit: 409,
} as const;

function refused(
  value: DiscordBinding | DiscordRefusal,
): value is DiscordRefusal {
  return "error" in value;
}

/**
 * The owner's Discord controls. Each route is owner-direct: an App cannot bind
 * a Discord application, or replace its sealed token, on the owner's behalf.
 */
export function standaloneDiscordRoutes(
  control: StandaloneDiscordControl,
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
  table.get("/api/discord", owner("direct"), async (context, { principal }) => {
    context.header("Cache-Control", "no-store");
    return context.json(await control.read(principal));
  });
  table.post(
    "/api/discord",
    owner("direct"),
    async (context, { principal }) => {
      context.header("Cache-Control", "no-store");
      const body = await parseBody(context);
      if (!body.ok) return context.json({ error: "invalid_input" }, 400);
      const parsed = createDiscordInputSchema.safeParse(body.value);
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
    "/api/discord/:bindingId",
    owner("direct"),
    async (context, { principal }) => {
      context.header("Cache-Control", "no-store");
      const body = await parseBody(context);
      if (!body.ok) return context.json({ error: "invalid_input" }, 400);
      const parsed = updateDiscordInputSchema.safeParse(body.value);
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
  table.post(
    "/api/discord/:bindingId/commands",
    owner("direct"),
    async (context, { principal }) => {
      context.header("Cache-Control", "no-store");
      const result = await control.registerCommands(
        principal,
        context.req.param("bindingId"),
      );
      return "error" in result
        ? context.json(result, refusalStatus[result.error])
        : context.json(result);
    },
  );
  return table;
}

/** The host values the public interactions door needs. */
type StandaloneDiscordEnv = Pick<
  StandaloneAgentsEnv,
  "AGENTS" | "AGENT_DIRECTORY" | "OYSTER_ORIGIN"
>;

/** A request body larger than this is not a Discord interaction. */
const INTERACTION_BODY_LIMIT = 100_000;

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Json),
);

/**
 * The public Discord door: one URL per bound application, which the owner
 * pastes into the Discord developer portal as its Interactions Endpoint URL.
 * Every request proves itself with the application's Ed25519 signature before
 * anything is decoded; the Agent is reached only after the guild and channel
 * pass the owner's allowlist.
 */
export function standaloneDiscordApp() {
  return new Hono<{ Bindings: StandaloneDiscordEnv }>().post(
    "/api/discord/interactions/:bindingId",
    async (context) => {
      const { env } = context;
      const found = await agentDirectoryForScope(
        env,
        tenantScope(defaultTenant, env.OYSTER_ORIGIN),
      ).channelBinding(context.req.param("bindingId"));
      if (found === null || !isDiscordBinding(found))
        return context.json({ error: "not_found" }, 404);
      const binding = found;
      const body = await context.req.text();
      if (body.length > INTERACTION_BODY_LIMIT)
        return context.json({ error: "too_large" }, 413);
      const verdict = await verifyDiscordRequest({
        publicKey: binding.selector.publicKey,
        signature: context.req.header("x-signature-ed25519"),
        timestamp: context.req.header("x-signature-timestamp"),
        body,
        nowSeconds: Date.now() / 1_000,
      });
      if (verdict !== "verified")
        return context.text("invalid request signature", 401);
      const json = decodeJson(body);
      const decoded = interactionSchema.safeParse(Option.getOrUndefined(json));
      if (!decoded.success)
        return context.json({ error: "invalid_interaction" }, 400);
      const interaction = decoded.data;
      if (interaction.type === 1) return context.json(pongResponse);
      if (interaction.application_id !== binding.selector.applicationId)
        return context.json({ error: "wrong_application" }, 400);
      if (binding.lifecycle !== "active")
        return context.json(ephemeralResponse("This Agent is paused."));
      const userId = interaction.member?.user.id ?? interaction.user?.id;
      const { guild_id: guildId, channel_id: channelId } = interaction;
      if (
        guildId === undefined ||
        channelId === undefined ||
        userId === undefined
      )
        return context.json(
          ephemeralResponse(
            "Ask in a server channel, not in a direct message.",
          ),
        );
      if (!discordPlaceAllowed(binding.selector, { guildId, channelId }))
        return context.json(
          ephemeralResponse("This channel is not set up for this Agent."),
        );
      const ask = (text: string, echo?: string): Response => {
        const trimmed = text.trim();
        if (trimmed.length === 0 || trimmed.length > DISCORD_ASK_LIMIT)
          return context.json(
            ephemeralResponse("Keep it between 1 and 1,000 characters."),
          );
        const question: DiscordAsk = {
          interactionId: interaction.id,
          applicationId: binding.selector.applicationId,
          interactionToken: interaction.token,
          guildId,
          channelId,
          userId,
          text: trimmed,
          echo,
        };
        // The answer outlives Discord's three seconds; it follows by webhook.
        context.executionCtx.waitUntil(
          Promise.resolve(
            env.AGENTS.getByName(binding.agentId).askDiscord(
              binding.bindingId,
              question,
            ),
          ),
        );
        return context.json(deferredResponse);
      };
      if (interaction.type === 2) {
        if (interaction.data.name !== ASK_COMMAND)
          return context.json(ephemeralResponse("Unknown command."));
        const option = interaction.data.options?.find(
          ({ name }) => name === ASK_OPTION,
        );
        return ask(z.string().catch("").parse(option?.value));
      }
      if (interaction.data.custom_id !== REPLY_ID)
        return context.json(ephemeralResponse("Unknown action."));
      if (interaction.type === 3) return context.json(replyModalResponse);
      const reply = interaction.data.components
        .flatMap((row) => row.components)
        .find(({ custom_id: id }) => id === REPLY_TEXT_ID);
      return ask(reply?.value ?? "", reply?.value.trim());
    },
  );
}
