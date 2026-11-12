import { z } from "zod";

import { discordSnowflakeSchema } from "./binding.js";
import { channelIds } from "./ids.js";
import type { VisitorSql } from "./visitors.js";

/**
 * The Discord channel's neutral binding rules. The owner brings their own
 * Discord application: its id and public key are facts of the binding, and its
 * bot token is sealed elsewhere and only named here by an owner-only column.
 * Fungi holds no Discord credential of its own.
 */

/** Ed25519 public key of a Discord application: 32 bytes, as 64 hex digits. */
const publicKeySchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/iu, "Public key must be 64 hex digits")
  .transform((value) => value.toLowerCase());
const guildIdsSchema = z.array(discordSnowflakeSchema).min(1).max(16);
/** Empty means every channel of the bound guilds. */
const channelIdsSchema = z.array(discordSnowflakeSchema).max(64);

/** The bot token as Discord issues it: dot-separated base64url segments. */
const discordBotTokenSchema = z
  .string()
  .regex(/^[\w-]{10,64}\.[\w-]{4,16}\.[\w-]{20,128}$/u, "Invalid bot token");

/** The exact selector of a Discord binding; secrets are never part of it. */
const discordSelectorSchema = z.strictObject({
  provider: z.literal("discord"),
  applicationId: discordSnowflakeSchema,
  publicKey: publicKeySchema,
  guildIds: guildIdsSchema,
  channelIds: channelIdsSchema,
});
/** One parsed Discord selector. */
export type DiscordSelector = z.infer<typeof discordSelectorSchema>;

/** A Discord application's Agent: one owner Agent behind one application. */
const discordBindingSchema = z.strictObject({
  bindingId: z
    .string()
    .refine(
      (value): boolean => channelIds.binding.is(value),
      "Invalid binding",
    ),
  agentId: z.string().min(1).max(256),
  selector: discordSelectorSchema,
  lifecycle: z.enum(["active", "suspended"]),
  /** Increments on every owner edit of this binding. */
  authorityVersion: z.number().int().positive(),
  /** Owner persona text, placed after the fixed channel preamble. */
  persona: z.string().max(4_000),
});
/** One Discord binding. */
export type DiscordBinding = z.infer<typeof discordBindingSchema>;

/** Owner input for a new Discord binding, the bot token included. */
export const createDiscordInputSchema = z.strictObject({
  agentId: z.string().min(1).max(256),
  applicationId: discordSnowflakeSchema,
  publicKey: publicKeySchema,
  guildIds: guildIdsSchema,
  channelIds: channelIdsSchema.default([]),
  persona: z.string().max(4_000).default(""),
  botToken: discordBotTokenSchema,
});
/** Owner input for a new Discord binding. */
export type CreateDiscordInput = z.input<typeof createDiscordInputSchema>;

const discordFactsSchema = createDiscordInputSchema.omit({ botToken: true });
/** The same input without the secret, which is sealed before the binding exists. */
type DiscordBindingFacts = z.input<typeof discordFactsSchema>;

/** Owner edit of one Discord binding, fenced by the version the owner last read. */
export const updateDiscordInputSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  publicKey: publicKeySchema.optional(),
  guildIds: guildIdsSchema.optional(),
  channelIds: channelIdsSchema.optional(),
  persona: z.string().max(4_000).optional(),
  lifecycle: z.enum(["active", "suspended"]).optional(),
  /** Replace the sealed bot token. */
  botToken: discordBotTokenSchema.optional(),
});
/** Owner edit of one Discord binding. */
export type UpdateDiscordInput = z.input<typeof updateDiscordInputSchema>;
const discordEditSchema = updateDiscordInputSchema.omit({ botToken: true });
type DiscordEdit = z.input<typeof discordEditSchema>;

/** Closed owner failures; routes map each to one status. */
export class DiscordBindingError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "version_conflict"
      | "request_conflict"
      | "application_taken"
      | "invalid_input",
  ) {
    super(code);
  }
}

/** Is this standalone channel binding a Discord application's? */
export function isDiscordBinding(
  binding: Readonly<{ selector: Readonly<{ provider: string }> }>,
): binding is DiscordBinding {
  return binding.selector.provider === "discord";
}

/**
 * Does this guild and channel belong to the binding? An interaction outside
 * the owner's allowlist is not this Agent's to answer.
 */
export function discordPlaceAllowed(
  selector: DiscordSelector,
  place: Readonly<{ guildId: string; channelId: string }>,
): boolean {
  return (
    selector.guildIds.includes(place.guildId) &&
    (selector.channelIds.length === 0 ||
      selector.channelIds.includes(place.channelId))
  );
}

const payloadRow = z.strictObject({ payload: z.string() });
const receiptRow = payloadRow.extend({ input_json: z.string().nullable() });
const tokenRow = z.strictObject({ token_credential_id: z.string() });
const requestIdSchema = z.string().min(1).max(128);

/**
 * One standalone owner's Discord bindings, behind a SQL port. The owner
 * authorizes the caller; this module fences versions and keeps one binding
 * per Discord application.
 */
export function createDiscordBindings(
  options: Readonly<{
    sql: VisitorSql;
    transactionSync: <T>(body: () => T) => T;
    /** Whether the Agent is in this owner's directory. */
    agentExists: (agentId: string) => boolean;
  }>,
) {
  const { sql } = options;
  const ensure = () => {
    sql.exec(`CREATE TABLE IF NOT EXISTS oyster_discord_bindings (
      binding_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      application_id TEXT NOT NULL UNIQUE,
      token_credential_id TEXT NOT NULL,
      request_id TEXT UNIQUE,
      input_json TEXT,
      payload TEXT NOT NULL
    ) STRICT`);
  };
  const decode = (raw: z.output<typeof payloadRow>): DiscordBinding =>
    discordBindingSchema.parse(JSON.parse(raw.payload));
  const read = (bindingId: string): DiscordBinding | null => {
    ensure();
    const row = sql
      .exec(
        "SELECT payload FROM oyster_discord_bindings WHERE binding_id=?",
        bindingId,
      )
      .toArray()[0];
    return row === undefined ? null : decode(payloadRow.parse(row));
  };
  const receipt = (requestId: string) => {
    ensure();
    const row = sql
      .exec(
        "SELECT input_json,payload FROM oyster_discord_bindings WHERE request_id=?",
        requestId,
      )
      .toArray()[0];
    return row === undefined ? null : receiptRow.parse(row);
  };
  return {
    read,
    list: (): readonly DiscordBinding[] => {
      ensure();
      return sql
        .exec("SELECT payload FROM oyster_discord_bindings ORDER BY binding_id")
        .toArray()
        .map((row) => decode(payloadRow.parse(row)));
    },
    /** Host-only: the sealed credential that holds this binding's bot token. */
    tokenCredentialId: (bindingId: string): string | null => {
      ensure();
      const row = sql
        .exec(
          "SELECT token_credential_id FROM oyster_discord_bindings WHERE binding_id=?",
          bindingId,
        )
        .toArray()[0];
      return row === undefined ? null : tokenRow.parse(row).token_credential_id;
    },
    /**
     * The binding this request already created, or null for a new request. A
     * replay must not seal the token again; changed facts conflict.
     */
    replay: (
      rawFacts: DiscordBindingFacts,
      requestId: string,
    ): DiscordBinding | null => {
      const parsed = discordFactsSchema.safeParse(rawFacts);
      const identity = requestIdSchema.safeParse(requestId);
      if (!parsed.success || !identity.success)
        throw new DiscordBindingError("invalid_input");
      const prior = receipt(identity.data);
      if (prior === null) return null;
      if (prior.input_json !== JSON.stringify(parsed.data))
        throw new DiscordBindingError("request_conflict");
      return decode(prior);
    },
    /**
     * Create once per request identity; a replay returns the first result. The
     * secret is already sealed: `facts` carry none and `tokenCredentialId`
     * names it.
     */
    create: (
      rawFacts: DiscordBindingFacts,
      tokenCredentialId: string,
      requestId: string,
    ): DiscordBinding => {
      const parsed = discordFactsSchema.safeParse(rawFacts);
      const identity = requestIdSchema.safeParse(requestId);
      if (!parsed.success || !identity.success)
        throw new DiscordBindingError("invalid_input");
      const input = parsed.data;
      const inputJson = JSON.stringify(input);
      return options.transactionSync(() => {
        ensure();
        const prior = receipt(identity.data);
        if (prior !== null) {
          if (prior.input_json !== inputJson)
            throw new DiscordBindingError("request_conflict");
          return decode(prior);
        }
        if (!options.agentExists(input.agentId))
          throw new DiscordBindingError("not_found");
        const taken = sql
          .exec(
            "SELECT 1 FROM oyster_discord_bindings WHERE application_id=?",
            input.applicationId,
          )
          .toArray();
        if (taken.length > 0)
          throw new DiscordBindingError("application_taken");
        const binding = discordBindingSchema.parse({
          bindingId: channelIds.binding.generate(),
          agentId: input.agentId,
          selector: {
            provider: "discord",
            applicationId: input.applicationId,
            publicKey: input.publicKey,
            guildIds: input.guildIds,
            channelIds: input.channelIds,
          },
          lifecycle: "active",
          authorityVersion: 1,
          persona: input.persona,
        });
        sql.exec(
          "INSERT INTO oyster_discord_bindings (binding_id,agent_id,application_id,token_credential_id,request_id,input_json,payload) VALUES (?,?,?,?,?,?,?)",
          binding.bindingId,
          binding.agentId,
          input.applicationId,
          tokenCredentialId,
          identity.data,
          inputJson,
          JSON.stringify(binding),
        );
        return binding;
      });
    },
    /** Apply one edit; a replaced token's new credential id is already sealed. */
    update: (
      bindingId: string,
      rawEdit: DiscordEdit,
      replacementCredentialId: string | null,
    ): DiscordBinding => {
      const parsed = discordEditSchema.safeParse(rawEdit);
      if (!parsed.success) throw new DiscordBindingError("invalid_input");
      const edit = parsed.data;
      return options.transactionSync(() => {
        const current = read(bindingId);
        if (current === null) throw new DiscordBindingError("not_found");
        if (current.authorityVersion !== edit.expectedVersion)
          throw new DiscordBindingError("version_conflict");
        const next = discordBindingSchema.parse({
          ...current,
          selector: {
            ...current.selector,
            publicKey: edit.publicKey ?? current.selector.publicKey,
            guildIds: edit.guildIds ?? current.selector.guildIds,
            channelIds: edit.channelIds ?? current.selector.channelIds,
          },
          lifecycle: edit.lifecycle ?? current.lifecycle,
          persona: edit.persona ?? current.persona,
          authorityVersion: current.authorityVersion + 1,
        });
        if (replacementCredentialId === null)
          sql.exec(
            "UPDATE oyster_discord_bindings SET payload=? WHERE binding_id=?",
            JSON.stringify(next),
            bindingId,
          );
        else
          sql.exec(
            "UPDATE oyster_discord_bindings SET payload=?, token_credential_id=? WHERE binding_id=?",
            JSON.stringify(next),
            replacementCredentialId,
            bindingId,
          );
        return next;
      });
    },
  };
}
/** The standalone Discord binding owner. */
export type DiscordBindings = ReturnType<typeof createDiscordBindings>;
