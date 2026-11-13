import { z } from "zod";

import type { DiscordAsk } from "./discord-interactions.js";
import type { ConversationSql } from "./conversations.js";

/**
 * The Discord replies an Agent still owes. An interaction token is valid for
 * about 15 minutes: until then the answer fills the original message. A run
 * that needs longer says it is still working before the token lapses, and its
 * answer then arrives as a normal channel message. One row per interaction
 * keeps the debt in the Agent's own store, so an evicted run still answers
 * after the Agent wakes. A row names no secret once it is closed, and a closed
 * row says honestly why: `expired` (no answer within two hours) or `failed`
 * (delivery kept failing).
 */

/** The interaction token window we honour, a little under Discord's 15 minutes. */
const DISCORD_REPLY_WINDOW_MS = 14 * 60_000;
/** When a run still going tells the member so, safely inside the token window. */
const STILL_WORKING_AFTER_MS = 12 * 60_000;
/** How long an answer may take before the reply is given up as expired. */
const CHANNEL_WINDOW_MS = 2 * 3_600_000;
/** How soon a run past the token window is looked at again. */
const SLOW_POLL_MS = 10_000;
/** How long a closed row stays readable before it is pruned. */
const CLOSED_RETENTION_MS = 7 * 86_400_000;
/** Delivery attempts after which a reply is given up as failed. */
const MAX_DELIVERY_ATTEMPTS = 5;
/** Rows one pass works on, so a pass stays bounded. */
const PASS_LIMIT = 4;
/** How soon an unsettled run is looked at again. */
const POLL_MS = 1_000;

/** What one delivery attempt found. */
export type DiscordDelivery =
  /** The answer, or a refusal, reached Discord; the debt is paid. */
  | "delivered"
  /** The run has not settled yet; look again soon. */
  | "waiting"
  /** Discord refuses every way of reaching the member; nothing more can be sent. */
  | "gone"
  /** A transient failure; try again with backoff. */
  | "retry";

/** One reply still owed. */
export type DiscordPendingReply = Readonly<{
  bindingId: string;
  ask: DiscordAsk;
  /** Known once intake accepted the question; recovery skips intake then. */
  accepted: Readonly<{ sessionId: string; commandId: string }> | null;
  attempts: number;
  /** Messages of the answer Discord already has; a retry resumes after them. */
  deliveredParts: number;
  /** Whether the interaction token still works; past it, only the channel does. */
  tokenLive: boolean;
  /** The token is about to lapse and the member has not been told it is still working. */
  stillWorkingDue: boolean;
}>;

/** One reply that never reached Discord, as the owner's list shows it. */
export type DiscordClosedReply = Readonly<{
  interactionId: string;
  /** What the member goes by; never their id. */
  label: string;
  state: "expired" | "failed";
  closedAt: number;
}>;

const pendingRow = z.strictObject({
  interaction_id: z.string(),
  binding_id: z.string(),
  application_id: z.string(),
  token: z.string(),
  guild_id: z.string(),
  channel_id: z.string(),
  user_id: z.string(),
  text: z.string(),
  echo: z.string().nullable(),
  display_name: z.string().nullable(),
  session_id: z.string().nullable(),
  command_id: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  delivered_parts: z.number().int().nonnegative(),
  still_working: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
  expires_at: z.number().int(),
});
const closedRow = z.strictObject({
  interaction_id: z.string(),
  display_name: z.string().nullable(),
  state: z.enum(["expired", "failed"]),
  closed_at: z.number().int(),
});
const dueRow = z.strictObject({ due: z.number().int().nullable() });

/** The pending-reply store and the host work that pays it off. */
export function createDiscordReplies(
  options: Readonly<{
    sql: ConversationSql;
    now: () => number;
    /** One delivery attempt; it may itself call `attach`. */
    deliver: (
      reply: DiscordPendingReply & Readonly<{ interactionId: string }>,
    ) => Promise<DiscordDelivery>;
    onExpired: (interactionId: string) => void;
  }>,
) {
  const { sql } = options;
  const ensure = () => {
    sql.exec(`CREATE TABLE IF NOT EXISTS oyster_discord_replies (
      interaction_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      application_id TEXT NOT NULL,
      token TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      echo TEXT,
      display_name TEXT,
      delivered_parts INTEGER NOT NULL DEFAULT 0,
      still_working INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      command_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('waiting','expired','failed')),
      attempts INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      next_at INTEGER NOT NULL,
      closed_at INTEGER
    ) STRICT`);
  };
  const close = (interactionId: string, state: "expired" | "failed") => {
    sql.exec(
      "UPDATE oyster_discord_replies SET state=?, token='', text='', echo=NULL, closed_at=? WHERE interaction_id=?",
      state,
      options.now(),
      interactionId,
    );
  };
  const reschedule = (interactionId: string, at: number, attempts: number) => {
    sql.exec(
      "UPDATE oyster_discord_replies SET next_at=?, attempts=? WHERE interaction_id=?",
      at,
      attempts,
      interactionId,
    );
  };
  let active: Promise<void> | undefined;
  const pass = async (): Promise<void> => {
    ensure();
    const now = options.now();
    sql.exec(
      "DELETE FROM oyster_discord_replies WHERE state!='waiting' AND closed_at<?",
      now - CLOSED_RETENTION_MS,
    );
    const rows = sql
      .exec(
        "SELECT interaction_id,binding_id,application_id,token,guild_id,channel_id,user_id,text,echo,display_name,session_id,command_id,attempts,delivered_parts,still_working,created_at,expires_at FROM oyster_discord_replies WHERE state='waiting' AND next_at<=? ORDER BY next_at LIMIT ?",
        now,
        PASS_LIMIT,
      )
      .toArray()
      .map((raw) => pendingRow.parse(raw));
    for (const row of rows) {
      const at = options.now();
      if (at >= row.created_at + CHANNEL_WINDOW_MS) {
        close(row.interaction_id, "expired");
        options.onExpired(row.interaction_id);
        continue;
      }
      const tokenLive = at < row.expires_at;
      const delivery = await options.deliver({
        interactionId: row.interaction_id,
        bindingId: row.binding_id,
        ask: {
          interactionId: row.interaction_id,
          applicationId: row.application_id,
          interactionToken: row.token,
          guildId: row.guild_id,
          channelId: row.channel_id,
          userId: row.user_id,
          text: row.text,
          echo: row.echo ?? undefined,
          displayName: row.display_name ?? undefined,
        },
        accepted:
          row.session_id !== null && row.command_id !== null
            ? { sessionId: row.session_id, commandId: row.command_id }
            : null,
        attempts: row.attempts,
        deliveredParts: row.delivered_parts,
        tokenLive,
        stillWorkingDue:
          tokenLive &&
          row.still_working === 0 &&
          at >= row.created_at + STILL_WORKING_AFTER_MS,
      });
      switch (delivery) {
        case "delivered":
          sql.exec(
            "DELETE FROM oyster_discord_replies WHERE interaction_id=?",
            row.interaction_id,
          );
          break;
        case "waiting":
          reschedule(
            row.interaction_id,
            options.now() + (tokenLive ? POLL_MS : SLOW_POLL_MS),
            row.attempts,
          );
          break;
        case "gone":
          close(row.interaction_id, "expired");
          options.onExpired(row.interaction_id);
          break;
        case "retry":
          if (row.attempts + 1 >= MAX_DELIVERY_ATTEMPTS)
            close(row.interaction_id, "failed");
          else
            reschedule(
              row.interaction_id,
              options.now() + 1_000 * 2 ** (row.attempts + 1),
              row.attempts + 1,
            );
          break;
      }
    }
  };
  return {
    /** Owe one reply. A second record of the same interaction is the first. */
    record: (bindingId: string, ask: DiscordAsk): void => {
      ensure();
      const now = options.now();
      sql.exec(
        "INSERT OR IGNORE INTO oyster_discord_replies (interaction_id,binding_id,application_id,token,guild_id,channel_id,user_id,text,echo,display_name,state,attempts,created_at,expires_at,next_at) VALUES (?,?,?,?,?,?,?,?,?,?,'waiting',0,?,?,?)",
        ask.interactionId,
        bindingId,
        ask.applicationId,
        ask.interactionToken,
        ask.guildId,
        ask.channelId,
        ask.userId,
        ask.text,
        ask.echo ?? null,
        ask.displayName ?? null,
        now,
        now + DISCORD_REPLY_WINDOW_MS,
        now,
      );
    },
    /** The member has been told the run is still going. */
    markStillWorking: (interactionId: string): void => {
      sql.exec(
        "UPDATE oyster_discord_replies SET still_working=1 WHERE interaction_id=?",
        interactionId,
      );
    },
    /** Discord no longer knows the token: only the channel reaches the member now. */
    tokenGone: (interactionId: string): void => {
      sql.exec(
        "UPDATE oyster_discord_replies SET expires_at=? WHERE interaction_id=?",
        options.now(),
        interactionId,
      );
    },
    /** Remember how many messages of the answer Discord has. */
    progress: (interactionId: string, parts: number): void => {
      sql.exec(
        "UPDATE oyster_discord_replies SET delivered_parts=? WHERE interaction_id=?",
        parts,
        interactionId,
      );
    },
    /** Replies of one binding that never reached Discord, newest first. */
    closed: (bindingId: string): readonly DiscordClosedReply[] => {
      ensure();
      return sql
        .exec(
          "SELECT interaction_id,display_name,state,closed_at FROM oyster_discord_replies WHERE binding_id=? AND state!='waiting' ORDER BY closed_at DESC LIMIT 50",
          bindingId,
        )
        .toArray()
        .map((raw) => {
          const row = closedRow.parse(raw);
          return {
            interactionId: row.interaction_id,
            label: row.display_name ?? "Discord member",
            state: row.state,
            closedAt: row.closed_at,
          };
        });
    },
    /** Remember which command answers this interaction. */
    attach: (
      interactionId: string,
      accepted: Readonly<{ sessionId: string; commandId: string }>,
    ): void => {
      sql.exec(
        "UPDATE oyster_discord_replies SET session_id=?, command_id=? WHERE interaction_id=?",
        accepted.sessionId,
        accepted.commandId,
        interactionId,
      );
    },
    /** Host work on the Agent's one durable wake. */
    work: {
      pending: () => {
        ensure();
        const row = dueRow.parse(
          sql
            .exec(
              "SELECT MIN(next_at) AS due FROM oyster_discord_replies WHERE state='waiting'",
            )
            .toArray()[0],
        );
        return {
          due: row.due !== null && row.due <= options.now(),
          nextWakeAt: row.due,
        };
      },
      run: (): Promise<void> => {
        // Passes never overlap, so one reply is never delivered twice at once.
        const next = (active ?? Promise.resolve()).then(pass, pass);
        active = next;
        return next;
      },
    },
  };
}
/** The Discord reply store. */
export type DiscordReplies = ReturnType<typeof createDiscordReplies>;
