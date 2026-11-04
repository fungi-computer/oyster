import { z } from "zod";

import { channelIds } from "./ids.js";
import { webOriginSchema } from "@fungi.computer/nacre/website-channels";
import type { VisitorSql } from "./visitors.js";

/**
 * The website channel's neutral binding rules: what a site key, its allowed
 * origins and its accent are, how an owner's edit changes them, and the fixed
 * words every website Agent starts from. Team, billing and member authority
 * stay with the host that stores the binding.
 */

/** Owner-set widget accent: exactly `#rrggbb`, stored lowercase. */
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/iu, "Accent must be #rrggbb")
  .transform((value) => value.toLowerCase());

const siteKeySchema = z
  .string()
  .refine((value): boolean => channelIds.site.is(value), "Invalid site key");
const originsSchema = z.array(webOriginSchema).min(1).max(16);

/** The exact selector of a web binding; the site key is how the embed finds it. */
export const webSelectorSchema = z.strictObject({
  provider: z.literal("web"),
  siteKey: siteKeySchema,
  origins: originsSchema,
  accent: hexColorSchema.optional(),
  /** Visitors must pass a Turnstile check before a mint; absent means off. */
  turnstile: z.boolean().optional(),
});
/** One parsed web selector. */
export type WebSelector = z.infer<typeof webSelectorSchema>;

/** Owner input for a new web selector. The site key is minted, never supplied. */
export const webSelectorRequestSchema = z.strictObject({
  provider: z.literal("web"),
  origins: originsSchema,
  accent: hexColorSchema.optional(),
  turnstile: z.boolean().optional(),
});

/** The edits an owner may make to a web selector. */
export const webSelectorEditSchema = z.strictObject({
  origins: originsSchema.optional(),
  /** `null` clears the accent back to the embed theme default. */
  accent: hexColorSchema.nullable().optional(),
  turnstile: z.boolean().optional(),
  /** Mint a new site key; the old key stops resolving at once. */
  rotateSiteKey: z.literal(true).optional(),
});
/** One owner edit of a web selector, as parsed. */
export type WebSelectorEdit = z.output<typeof webSelectorEditSchema>;

/** Does this edit touch the web selector at all? */
export function editsWebSelector(
  edit: Readonly<z.input<typeof webSelectorEditSchema>>,
): boolean {
  return (
    edit.origins !== undefined ||
    edit.accent !== undefined ||
    edit.turnstile !== undefined ||
    edit.rotateSiteKey !== undefined
  );
}

/** Mint the selector of a new web binding. */
export function mintWebSelector(
  requested: z.output<typeof webSelectorRequestSchema>,
): WebSelector {
  const selector: WebSelector = {
    provider: "web",
    siteKey: channelIds.site.generate(),
    origins: requested.origins,
  };
  if (requested.accent !== undefined) selector.accent = requested.accent;
  if (requested.turnstile === true) selector.turnstile = true;
  return selector;
}

/** Apply one owner edit to a selector; unmentioned facts are unchanged. */
export function editWebSelector(
  selector: WebSelector,
  edit: WebSelectorEdit,
): WebSelector {
  const next: WebSelector = {
    provider: "web",
    siteKey:
      edit.rotateSiteKey === true
        ? channelIds.site.generate()
        : selector.siteKey,
    origins: edit.origins ?? selector.origins,
  };
  const accent = edit.accent === undefined ? selector.accent : edit.accent;
  if (accent !== null && accent !== undefined) next.accent = accent;
  const turnstile = edit.turnstile ?? selector.turnstile;
  if (turnstile === true) next.turnstile = true;
  return next;
}

/** Fixed rules that precede every channel persona. */
const CHANNEL_PREAMBLE = [
  "You are an Agent answering on a channel on behalf of your owner.",
  "Stay on the owner's topic. Never claim an action you did not take; only report work confirmed by returned results.",
  "When you are unsure or the party asks for a person, say that you will pass the conversation to the owner.",
].join(" ");

/** The fixed preamble, then the owner's persona for a person-facing channel. */
export function personChannelInstructions(persona: string): string {
  const trimmed = persona.trim();
  return trimmed.length === 0
    ? CHANNEL_PREAMBLE
    : `${CHANNEL_PREAMBLE}\n\nOwner persona:\n${trimmed}`;
}

/** A standalone website: one owner's Agent behind one site key. */
export const websiteBindingSchema = z.strictObject({
  bindingId: z
    .string()
    .refine(
      (value): boolean => channelIds.binding.is(value),
      "Invalid binding",
    ),
  agentId: z.string().min(1).max(256),
  selector: webSelectorSchema,
  lifecycle: z.enum(["active", "suspended"]),
  /** Increments on every owner edit of this binding. */
  authorityVersion: z.number().int().positive(),
  /** Owner persona text, placed after the fixed channel preamble. */
  persona: z.string().max(4_000),
});
/** One standalone website binding. */
export type WebsiteBinding = z.infer<typeof websiteBindingSchema>;

/** Owner input for a new website. */
export const createWebsiteInputSchema = z.strictObject({
  agentId: z.string().min(1).max(256),
  selector: webSelectorRequestSchema,
  persona: z.string().max(4_000).default(""),
});
/** Owner input for a new website. */
export type CreateWebsiteInput = z.input<typeof createWebsiteInputSchema>;

/** Owner edit of one website, fenced by the version the owner last read. */
export const updateWebsiteInputSchema = webSelectorEditSchema.extend({
  expectedVersion: z.number().int().positive(),
  persona: z.string().max(4_000).optional(),
  lifecycle: z.enum(["active", "suspended"]).optional(),
});
/** Owner edit of one website. */
export type UpdateWebsiteInput = z.input<typeof updateWebsiteInputSchema>;

/** Closed owner failures; routes map each to one status. */
export class WebsiteBindingError extends Error {
  constructor(
    readonly code:
      "not_found" | "version_conflict" | "request_conflict" | "invalid_input",
  ) {
    super(code);
  }
}

const payloadRow = z.strictObject({ payload: z.string() });
const receiptRow = payloadRow.extend({ input_json: z.string().nullable() });
const requestIdSchema = z.string().min(1).max(128);

/**
 * One standalone owner's website bindings, behind a SQL port. The owner
 * authorizes the caller; this module fences versions and mints site keys.
 */
export function createWebsiteBindings(
  options: Readonly<{
    sql: VisitorSql;
    transactionSync: <T>(body: () => T) => T;
    /** Whether the Agent is in this owner's directory. */
    agentExists: (agentId: string) => boolean;
  }>,
) {
  const { sql } = options;
  const ensure = () => {
    sql.exec(`CREATE TABLE IF NOT EXISTS oyster_website_bindings (
      binding_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      site_key TEXT NOT NULL UNIQUE,
      request_id TEXT UNIQUE,
      input_json TEXT,
      payload TEXT NOT NULL
    ) STRICT`);
  };
  const decode = (raw: z.output<typeof payloadRow>): WebsiteBinding =>
    websiteBindingSchema.parse(JSON.parse(raw.payload));
  const read = (bindingId: string): WebsiteBinding | null => {
    ensure();
    const row = sql
      .exec(
        "SELECT payload FROM oyster_website_bindings WHERE binding_id=?",
        bindingId,
      )
      .toArray()[0];
    return row === undefined ? null : decode(payloadRow.parse(row));
  };
  return {
    read,
    /** The only way a public site key resolves; a rotated key does not. */
    readBySiteKey: (siteKey: string): WebsiteBinding | null => {
      ensure();
      const row = sql
        .exec(
          "SELECT payload FROM oyster_website_bindings WHERE site_key=?",
          siteKey,
        )
        .toArray()[0];
      return row === undefined ? null : decode(payloadRow.parse(row));
    },
    list: (): readonly WebsiteBinding[] => {
      ensure();
      return sql
        .exec("SELECT payload FROM oyster_website_bindings ORDER BY binding_id")
        .toArray()
        .map((row) => decode(payloadRow.parse(row)));
    },
    /** Create once per request identity; a replay returns the first result. */
    create: (
      rawInput: CreateWebsiteInput,
      requestId: string,
    ): WebsiteBinding => {
      const parsed = createWebsiteInputSchema.safeParse(rawInput);
      const identity = requestIdSchema.safeParse(requestId);
      if (!parsed.success || !identity.success)
        throw new WebsiteBindingError("invalid_input");
      const input = parsed.data;
      const inputJson = JSON.stringify(input);
      return options.transactionSync(() => {
        ensure();
        const prior = sql
          .exec(
            "SELECT input_json,payload FROM oyster_website_bindings WHERE request_id=?",
            identity.data,
          )
          .toArray()[0];
        if (prior !== undefined) {
          const receipt = receiptRow.parse(prior);
          if (receipt.input_json !== inputJson)
            throw new WebsiteBindingError("request_conflict");
          return decode(receipt);
        }
        if (!options.agentExists(input.agentId))
          throw new WebsiteBindingError("not_found");
        const binding = websiteBindingSchema.parse({
          bindingId: channelIds.binding.generate(),
          agentId: input.agentId,
          selector: mintWebSelector(input.selector),
          lifecycle: "active",
          authorityVersion: 1,
          persona: input.persona,
        });
        sql.exec(
          "INSERT INTO oyster_website_bindings (binding_id,agent_id,site_key,request_id,input_json,payload) VALUES (?,?,?,?,?,?)",
          binding.bindingId,
          binding.agentId,
          binding.selector.siteKey,
          identity.data,
          inputJson,
          JSON.stringify(binding),
        );
        return binding;
      });
    },
    update: (
      bindingId: string,
      rawInput: UpdateWebsiteInput,
    ): WebsiteBinding => {
      const parsed = updateWebsiteInputSchema.safeParse(rawInput);
      if (!parsed.success) throw new WebsiteBindingError("invalid_input");
      const input = parsed.data;
      return options.transactionSync(() => {
        const current = read(bindingId);
        if (current === null) throw new WebsiteBindingError("not_found");
        if (current.authorityVersion !== input.expectedVersion)
          throw new WebsiteBindingError("version_conflict");
        const next = websiteBindingSchema.parse({
          ...current,
          selector: editWebSelector(current.selector, input),
          lifecycle: input.lifecycle ?? current.lifecycle,
          persona: input.persona ?? current.persona,
          authorityVersion: current.authorityVersion + 1,
        });
        sql.exec(
          "UPDATE oyster_website_bindings SET site_key=?, payload=? WHERE binding_id=?",
          next.selector.siteKey,
          JSON.stringify(next),
          bindingId,
        );
        return next;
      });
    },
  };
}
/** The standalone website binding owner. */
export type WebsiteBindings = ReturnType<typeof createWebsiteBindings>;
