import { Hex } from "effect/encoding";
import * as Result from "effect/Result";
import { z } from "zod";

import { discordSnowflakeSchema } from "./binding.js";

/**
 * Discord's HTTP interactions, as one Agent channel needs them: verify the
 * Ed25519 signature of a request, decode only the fields we use, and build
 * the few responses and follow-ups we send. No Gateway and no Message Content
 * intent: members reach the Agent through the `/ask` command and a Reply
 * button that opens a modal.
 */

/** The one command; an owner registers it in each bound guild. */
export const ASK_COMMAND = "ask";
/** The one option of `/ask`. */
export const ASK_OPTION = "question";
/** The Reply button and its modal share one custom id. */
export const REPLY_ID = "reply";
/** The modal's single text input. */
export const REPLY_TEXT_ID = "text";
/** Discord rejects a message over 2,000 characters. */
const DISCORD_MESSAGE_LIMIT = 2_000;
/** The longest question or reply Discord lets a member type here. */
export const DISCORD_ASK_LIMIT = 1_000;
/** Discord API version the follow-up and registration calls pin. */
const DISCORD_API = "https://discord.com/api/v10";

/** One settlement read waits at most this long (Shiitake allows 30 s). */
export const DISCORD_SETTLEMENT_WAIT_MS = 8_000;

/** One verified question, as the public edge hands it to the Agent. */
export type DiscordAsk = Readonly<{
  interactionId: string;
  applicationId: string;
  /** Credential for the follow-up webhook; never stored. */
  interactionToken: string;
  guildId: string;
  channelId: string;
  userId: string;
  text: string;
  /** What the member goes by, if Discord said; never their id. */
  displayName?: string | undefined;
  /** The member's own words, quoted above the answer of a modal reply. */
  echo?: string | undefined;
}>;

/**
 * What a member goes by: their nickname in the server, else their display
 * name, else `@username`. Absent when Discord sent none of them.
 */
export function discordDisplayName(
  who: Readonly<{
    member?: z.infer<typeof memberSchema> | undefined;
    user?: z.infer<typeof userSchema> | undefined;
  }>,
): string | undefined {
  const user = who.member?.user ?? who.user;
  const name =
    [who.member?.nick, user?.global_name]
      .map((candidate) => candidate?.trim())
      .find((candidate) => candidate !== undefined && candidate !== "") ??
    (user?.username?.trim() ? `@${user.username.trim()}` : undefined);
  return name?.slice(0, 80);
}

/** What a member is told when intake says no. */
export const discordDenial = {
  unmapped: "This Agent is not available right now.",
  suspended: "This Agent is paused.",
  banned: "You cannot ask this Agent anything.",
  too_long: "That message is too long.",
  party_daily_limit: "You have reached today's limit. Try again tomorrow.",
  new_party_limit: "This Agent is busy right now. Try again soon.",
  rate_limited: "This Agent is busy right now. Try again soon.",
  event_conflict: "That message could not be accepted.",
} as const;

/** How far a request's signed timestamp may sit from now, in seconds. */
const SIGNATURE_MAX_SKEW_SECONDS = 300;

const optionSchema = z.object({
  name: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
const userSchema = z.object({
  id: discordSnowflakeSchema,
  username: z.string().nullish(),
  global_name: z.string().nullish(),
});
const memberSchema = z.object({
  user: userSchema,
  /** The member's nickname in this server. */
  nick: z.string().nullish(),
});
const placeFields = {
  id: discordSnowflakeSchema,
  application_id: discordSnowflakeSchema,
  token: z.string().min(1).max(512),
  guild_id: discordSnowflakeSchema.optional(),
  channel_id: discordSnowflakeSchema.optional(),
  member: memberSchema.optional(),
  user: userSchema.optional(),
};

/** The interaction types we answer; any other type fails to decode. */
export const interactionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(1),
    id: discordSnowflakeSchema,
    application_id: discordSnowflakeSchema,
  }),
  z.object({
    ...placeFields,
    type: z.literal(2),
    data: z.object({
      name: z.string(),
      options: z.array(optionSchema).optional(),
    }),
  }),
  z.object({
    ...placeFields,
    type: z.literal(3),
    data: z.object({ custom_id: z.string() }),
  }),
  z.object({
    ...placeFields,
    type: z.literal(5),
    data: z.object({
      custom_id: z.string(),
      components: z.array(
        z.object({
          components: z.array(
            z.object({ custom_id: z.string(), value: z.string() }),
          ),
        }),
      ),
    }),
  }),
]);

/** Why a request's signature was refused. */
export type SignatureRefusal = "missing" | "malformed" | "stale" | "invalid";

function bytesOf(hex: string): Uint8Array<ArrayBuffer> | null {
  const decoded = Hex.decode(hex);
  return Result.isSuccess(decoded) ? new Uint8Array(decoded.success) : null;
}

/**
 * Verify Discord's Ed25519 signature over `timestamp + body` with WebCrypto.
 * The timestamp is also bounded, so a captured request cannot be replayed
 * later.
 */
export async function verifyDiscordRequest(
  input: Readonly<{
    publicKey: string;
    signature: string | undefined;
    timestamp: string | undefined;
    body: string;
    nowSeconds: number;
  }>,
): Promise<"verified" | SignatureRefusal> {
  if (input.signature === undefined || input.timestamp === undefined)
    return "missing";
  const signature = bytesOf(input.signature);
  const publicKey = bytesOf(input.publicKey);
  const signedAt = Number(input.timestamp);
  if (signature === null || publicKey === null || !Number.isFinite(signedAt))
    return "malformed";
  if (Math.abs(input.nowSeconds - signedAt) > SIGNATURE_MAX_SKEW_SECONDS)
    return "stale";
  const key = await crypto.subtle.importKey(
    "raw",
    publicKey,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    signature,
    new TextEncoder().encode(input.timestamp + input.body),
  );
  return valid ? "verified" : "invalid";
}

/** Interaction callback types we send. */
const CALLBACK = { pong: 1, message: 4, deferred: 5, modal: 9 } as const;
/** Message flag: only the member who triggered the interaction sees it. */
const EPHEMERAL = 64;

/** The answer to Discord's endpoint check. */
export const pongResponse = { type: CALLBACK.pong } as const;
/** Tell the member the Agent is working; the answer follows by webhook. */
export const deferredResponse = { type: CALLBACK.deferred } as const;

/** A one-off notice only the member sees, such as a refusal. */
export function ephemeralResponse(content: string) {
  return {
    type: CALLBACK.message,
    data: {
      content: content.slice(0, DISCORD_MESSAGE_LIMIT),
      flags: EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  } as const;
}

/** The modal a Reply button opens: one paragraph input. */
export const replyModalResponse = {
  type: CALLBACK.modal,
  data: {
    custom_id: REPLY_ID,
    title: "Reply",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: REPLY_TEXT_ID,
            label: "Your reply",
            style: 2,
            min_length: 1,
            max_length: DISCORD_ASK_LIMIT,
            required: true,
          },
        ],
      },
    ],
  },
} as const;

/** The Reply button attached to every Agent answer. */
const replyRow = [
  {
    type: 1,
    components: [{ type: 2, style: 2, label: "Reply", custom_id: REPLY_ID }],
  },
] as const;

/** Most messages one answer may fill; past it the last one says the rest is cut. */
const DISCORD_MAX_PARTS = 10;
const CONTINUES = "\n\n… (the rest of this answer is too long for Discord)";

/**
 * Split an answer into messages Discord accepts, in order, losing nothing but
 * the whitespace at each cut. A cut prefers a blank line, then a line, then a
 * space, and only then falls inside a word. An answer past ten messages ends
 * with a notice that the rest is cut.
 */
export function splitDiscordMessage(
  text: string,
  limit: number = DISCORD_MESSAGE_LIMIT,
): readonly string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const room =
      parts.length === DISCORD_MAX_PARTS - 1 ? limit - CONTINUES.length : limit;
    const window = rest.slice(0, room);
    const floor = Math.floor(room * 0.5);
    const cut = [
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    ].find((at) => at >= floor);
    if (parts.length === DISCORD_MAX_PARTS - 1) {
      parts.push(`${window.trimEnd()}${CONTINUES}`);
      return parts;
    }
    const end = cut ?? room;
    parts.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  parts.push(rest);
  return parts;
}

/** The body of a follow-up message; its content is already within Discord's bound. */
function followUpBody(content: string, withReply: boolean) {
  return {
    content,
    // Model text never pings anyone.
    allowed_mentions: { parse: [] },
    components: withReply ? replyRow : [],
  } as const;
}

/** Quote a member's modal reply so the thread reads in order. */
export function quoted(text: string): string {
  return text
    .slice(0, 300)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Fill the deferred message with the Agent's answer. The interaction token is
 * the credential: no bot token is involved.
 */
export async function patchOriginal(
  send: typeof fetch,
  input: Readonly<{
    applicationId: string;
    interactionToken: string;
    content: string;
    withReply: boolean;
  }>,
): Promise<"delivered" | "gone" | "retry"> {
  const response = await send(
    `${DISCORD_API}/webhooks/${input.applicationId}/${input.interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(followUpBody(input.content, input.withReply)),
      signal: AbortSignal.timeout(15_000),
    },
  );
  await response.body?.cancel();
  // Discord answers 401, 403 or 404 for a token that lapsed or never was.
  if (response.ok) return "delivered";
  return [401, 403, 404].includes(response.status) ? "gone" : "retry";
}

/**
 * Send one more message under the same interaction, after the original. The
 * interaction token is the credential here too.
 */
export async function postFollowUp(
  send: typeof fetch,
  input: Readonly<{
    applicationId: string;
    interactionToken: string;
    content: string;
    withReply: boolean;
  }>,
): Promise<"delivered" | "gone" | "retry"> {
  const response = await send(
    `${DISCORD_API}/webhooks/${input.applicationId}/${input.interactionToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(followUpBody(input.content, input.withReply)),
      signal: AbortSignal.timeout(15_000),
    },
  );
  await response.body?.cancel();
  if (response.ok) return "delivered";
  return [401, 403, 404].includes(response.status) ? "gone" : "retry";
}

/** What a member is told on the original message when an answer will take longer. */
export const STILL_WORKING_TEXT =
  "Still working on this. I will post the answer in this channel when it is ready.";

/**
 * Post a normal channel message as the owner's bot, for an answer that
 * outlived its interaction token. The bot token is the credential and never
 * leaves the host call; the member is mentioned so they are told it arrived.
 */
export async function postChannelMessage(
  send: typeof fetch,
  input: Readonly<{
    channelId: string;
    botToken: string;
    content: string;
    withReply: boolean;
    /** Mention this member, and only them. */
    mentionUserId: string | null;
  }>,
): Promise<"delivered" | "gone" | "retry"> {
  const response = await send(
    `${DISCORD_API}/channels/${input.channelId}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bot ${input.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...followUpBody(input.content, input.withReply),
        allowed_mentions: {
          parse: [],
          users: input.mentionUserId === null ? [] : [input.mentionUserId],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  await response.body?.cancel();
  // 401, 403 and 404: the bot is not allowed in that channel, or it is gone.
  if (response.ok) return "delivered";
  return [401, 403, 404].includes(response.status) ? "gone" : "retry";
}

const failureCode = /^Model request failed \(([\w-]+)\)/u;

/**
 * Tell the member why an answer did not come, in plain words and with what to
 * do next. The host's own failure diagnostic names the cause; provider prose
 * never reaches a member.
 */
export function discordFailureText(
  terminal: Readonly<{
    outcome: "completed" | "cancelled" | "failed" | "interrupted";
    diagnostic: string | null;
  }>,
): string {
  if (terminal.outcome === "cancelled") return "That run was cancelled.";
  if (terminal.outcome === "interrupted")
    return "The run was interrupted before it finished. Ask again.";
  if (terminal.outcome === "completed")
    return "The Agent finished without a reply. Try asking again.";
  switch (failureCode.exec(terminal.diagnostic ?? "")?.[1]) {
    case "setup_required":
      return "No model is connected to this Agent yet. Ask its owner to connect one, then ask again.";
    case "usage-limit-reached":
      return "The model provider says its usage limit or credit is used up. Ask the owner to check the provider account, then try again.";
    case "rate-limit":
    case "overloaded":
    case "provider_unavailable":
      return "The model provider is busy or unavailable right now. Try again in a minute.";
    case "provider_rejected":
      return "The model provider refused the request. Ask the owner to check the model connection.";
    case "tools_unsupported":
      return "This Agent's model cannot use tools. Ask the owner to pick another model.";
    default:
      return "Something went wrong while answering. Try again; if it keeps happening, tell the owner.";
  }
}

/** The `/ask` application command, as Discord registers it. */
const askCommand = {
  name: ASK_COMMAND,
  type: 1,
  description: "Ask this Agent a question",
  dm_permission: false,
  options: [
    {
      type: 3,
      name: ASK_OPTION,
      description: "What do you want to ask?",
      required: true,
      min_length: 1,
      max_length: DISCORD_ASK_LIMIT,
    },
  ],
} as const;

/**
 * Register `/ask` in one guild with the owner's bot token. Creating by name
 * updates an existing `/ask` and leaves the owner's other commands alone.
 */
export async function registerAskCommand(
  send: typeof fetch,
  input: Readonly<{
    applicationId: string;
    guildId: string;
    botToken: string;
  }>,
): Promise<boolean> {
  const response = await send(
    `${DISCORD_API}/applications/${input.applicationId}/guilds/${input.guildId}/commands`,
    {
      method: "POST",
      headers: {
        authorization: `Bot ${input.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(askCommand),
      signal: AbortSignal.timeout(15_000),
    },
  );
  await response.body?.cancel();
  return response.ok;
}
