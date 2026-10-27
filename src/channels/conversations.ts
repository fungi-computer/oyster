import { z } from "zod";
import {
  authorMeta,
  FungiMessageMetaSchema,
  type FungiAuthor,
  type AuthorMeta,
  type MessageMetaValue,
} from "@fungi.computer/agar/agents";
import { handoffSchema, type Handoff } from "@fungi.computer/agar/channels";
import {
  EVENT_REPLAY_WINDOW_SECONDS,
  channelPartySchema,
  limitsOf,
  partyLabel,
  type ConversationBinding,
  type ChannelParty,
} from "./binding.js";

export type HandoffEvent = Readonly<{ expectedVersion: number }> &
  (
    | Readonly<{ kind: "request"; reason: string; at: number }>
    | Readonly<{
        kind: "take_over";
        member: FungiAuthor;
        confirm: boolean;
        at: number;
      }>
    | Readonly<{ kind: "hand_back"; memberId: string; confirm: boolean }>
    | Readonly<{ kind: "dismiss" }>
  );
export type HandoffTransition =
  | Readonly<{ kind: "ok"; handoff: Handoff }>
  | Readonly<{
      kind: "conflict" | "confirmation_required" | "not_holder" | "not_found";
    }>;

/** Decide one handoff; persistence, notifications and cancellation stay with the owner. */
export function transitionHandoff(
  current: Handoff | null,
  event: HandoffEvent,
): HandoffTransition {
  if (current === null) return { kind: "not_found" };
  if (current.version !== event.expectedVersion) return { kind: "conflict" };
  switch (event.kind) {
    case "request":
      if (current.state === "requested")
        return { kind: "ok", handoff: current };
      if (current.state !== "agent") return { kind: "not_holder" };
      return {
        kind: "ok",
        handoff: {
          state: "requested",
          version: current.version + 1,
          reason: event.reason,
          at: event.at,
        },
      };
    case "take_over":
      if (current.state === "person") {
        if (current.memberId === event.member.id)
          return { kind: "ok", handoff: current };
        if (!event.confirm) return { kind: "confirmation_required" };
      }
      return {
        kind: "ok",
        handoff: {
          state: "person",
          version: current.version + 1,
          memberId: event.member.id,
          memberName: event.member.name,
          since: event.at,
        },
      };
    case "hand_back":
      if (
        current.state !== "person" ||
        (current.memberId !== event.memberId && !event.confirm)
      )
        return { kind: "not_holder" };
      return {
        kind: "ok",
        handoff: { state: "agent", version: current.version + 1 },
      };
    case "dismiss":
      return current.state === "requested"
        ? {
            kind: "ok",
            handoff: { state: "agent", version: current.version + 1 },
          }
        : { kind: "not_holder" };
  }
}

export type ConversationSql = Readonly<{
  exec: (
    statement: string,
    ...bindings: (ArrayBuffer | string | number | null)[]
  ) => Readonly<{ toArray: () => readonly unknown[] }>;
}>;

const boundedKey = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\x21-\x7e]+$/u, "Printable ASCII only");

/** One verified inbound event from a provider edge. */
const inboundEventSchema = z.strictObject({
  bindingId: z.string().min(1).max(64),
  /** Adapter-chosen conversation key: visitor id, thread id, Message-ID… */
  conversation: boundedKey,
  /** Provider event identity; a retry carries the same one. */
  eventId: boundedKey,
  party: channelPartySchema,
  text: z.string().min(1).max(16_000),
  /** Present for a host-translated caller; provider events use their own identity. */
  sourceRequestId: FungiMessageMetaSchema.shape.sourceRequestId,
  /**
   * SHA-256 (hex) of the verified request body. GitHub does not sign its
   * delivery id, so intake dedupes GitHub events on this too.
   */
  bodyDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
/** One verified inbound event. */
export type InboundEvent = z.infer<typeof inboundEventSchema>;

/** Channel events and composer requests do not share the Session owner's key space. */
export function channelRequestId(bindingId: string, eventId: string): string {
  return `ch:${bindingId}:${eventId}`;
}

/** Closed intake result; "said no" is distinct from "couldn't answer". */
export type IntakeResult =
  | Readonly<{
      kind: "accepted";
      sessionId: string;
      commandId: string;
      delivery: "new" | "replay";
    }>
  | Readonly<{
      /** Held for a person: recorded as a party line, no run started. */
      kind: "held";
      sessionId: string;
      delivery: "new" | "replay";
    }>
  | Readonly<{
      kind: "denied";
      reason:
        | "unmapped"
        | "suspended"
        | "banned"
        | "too_long"
        | "party_daily_limit"
        | "new_party_limit"
        | "rate_limited"
        | "event_conflict";
    }>;

/** One channel conversation row, as owner surfaces label it. */
export type ChannelConversation = Readonly<{
  bindingId: string;
  conversation: string;
  sessionId: string;
  party: ChannelParty;
  label: string;
  createdAt: number;
  lastEventAt: number;
  handoff: Handoff;
}>;

export type ChannelHandoffResult =
  | Readonly<{ kind: "ok"; conversation: ChannelConversation }>
  | Exclude<HandoffTransition, { kind: "ok" }>;
type ChannelTakeoverReceipt = Readonly<{
  version: number;
  memberId: string;
  memberName: string;
  previousMemberId: string | null;
  at: number;
}>;

const takeoverRow = z.strictObject({
  session_id: z.string(),
  version: z.number().int().positive(),
  member_id: z.string().min(1).max(256),
  member_name: z.string().min(1).max(128),
  previous_member_id: z.string().nullable(),
  taken_at: z.number().int(),
});

/** Payload-free event metadata for a Team member's channel log. */
export type ChannelEventReceipt = Readonly<{
  eventId: string;
  receivedAt: number;
  status: "pending" | "accepted" | "held";
  size: number;
  sessionId: string;
}>;

/** Only the withdrawal outcomes a channel visitor can observe. */
export type ChannelWithdrawResult =
  | Readonly<{ status: "unknown" }>
  | Readonly<{
      status: "accepted";
      commandId: string;
      sessionId?: string;
    }>;

/** Only the pending fields a channel visitor can read. */
export type ChannelPendingPrompt = Readonly<{
  requestId: string;
  commandId: string;
  text: string;
  meta?: MessageMetaValue | undefined;
  delivery: "steer" | "followUp";
  images?:
    | readonly Readonly<{
        type: "image";
        data: string;
        mimeType: string;
      }>[]
    | undefined;
}>;

/** The channel's narrow Session port; hosts translate to their durable client. */
export type SessionDoor = Readonly<{
  withdraw: (
    sessionId: string,
    requestId: string,
  ) => Promise<ChannelWithdrawResult>;
  latestPending: (
    sessionId: string,
    visitor: FungiAuthor,
  ) => Promise<ChannelPendingPrompt | null>;
  createSession: (requestId: string) => Promise<string>;
  /** Deliver this conversation Session's tool grants to the runtime. */
  deliverGrants: (sessionId: string) => void;
  prompt: (
    sessionId: string,
    input: Readonly<{
      requestId: string;
      text: string;
      meta: AuthorMeta & Readonly<{ sourceRequestId?: string }>;
    }>,
  ) => Promise<Readonly<{ commandId: string }>>;
  /** Record one run-free operator or party line (Shiitake `operator`). */
  line: (
    sessionId: string,
    input: Readonly<{
      requestId: string;
      text: string;
    }> &
      (
        | Readonly<{ author: "operator"; identity: FungiAuthor }>
        | Readonly<{
            author: "party";
            meta: AuthorMeta & Readonly<{ sourceRequestId?: string }>;
          }>
      ),
  ) => Promise<void>;
  /** Only a matching, contract-closed request clears a visitor reservation. */
  errorKind: (error: Error, requestId: string) => "closed_request" | null;
}>;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** The one conversation every event of a `named` events binding joins. */
const NAMED_EVENT_CONVERSATION = "events";

const conversationRow = z.strictObject({
  binding_id: z.string(),
  conversation: z.string(),
  session_id: z.string(),
  party_json: z.string(),
  created_at: z.number().int(),
  last_event_at: z.number().int(),
  handoff_json: z.string(),
  notify_due_at: z.number().int().nullable(),
});
const intakeRow = z.strictObject({
  conversation: z.string(),
  session_id: z.string(),
  text: z.string(),
  state: z.enum(["pending", "accepted", "held"]),
  command_id: z.string().nullable(),
});
const countRow = z.strictObject({ count: z.number().int() });
const eventReceiptRow = z.strictObject({
  event_id: z.string(),
  received_at: z.number().int(),
  state: z.enum(["pending", "accepted", "held"]),
  size: z.number().int().nonnegative(),
  session_id: z.string(),
});

/**
 * Oyster's channel conversation owner. It maps (binding, conversation) to one
 * server-minted Session, records each inbound event as pending with one atomic
 * insert-or-ignore, submits it through the Session door under a derived
 * requestId, and marks it accepted only after the door committed. A retry of
 * the same event replays the same command; changed text conflicts.
 */
const sessionIdRow = z.object({ session_id: z.string() });

export function createChannelConversations(
  options: Readonly<{
    sql: ConversationSql;
    transactionSync: <T>(body: () => T) => T;
    binding: (bindingId: string) => ConversationBinding | null;
    door: Pick<
      SessionDoor,
      "createSession" | "deliverGrants" | "prompt" | "line" | "errorKind"
    >;
    now: () => number;
    /** Commit hook for accepted work, in the acceptance transaction. */
    onAccepted?: (
      accepted: Readonly<{
        binding: ConversationBinding;
        event: InboundEvent;
        sessionId: string;
        commandId: string;
      }>,
    ) => void;
  }>,
) {
  const { sql } = options;
  const ensure = () => {
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_channel_conversations (
      binding_id TEXT NOT NULL,
      conversation TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      party_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_event_at INTEGER NOT NULL,
      handoff_json TEXT NOT NULL DEFAULT '{"state":"agent","version":0}' CHECK (json_valid(handoff_json)),
      notify_due_at INTEGER,
      PRIMARY KEY (binding_id, conversation)
    ) STRICT`);
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_channel_intake (
      binding_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      conversation TEXT NOT NULL,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','accepted','held')),
      command_id TEXT,
      received_at INTEGER NOT NULL,
      body_digest TEXT,
      PRIMARY KEY (binding_id, event_id)
    ) STRICT`);
    sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS hub_channel_intake_body_digest ON hub_channel_intake(binding_id, body_digest) WHERE body_digest IS NOT NULL",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS hub_channel_intake_binding ON hub_channel_intake(binding_id, received_at)",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS hub_channel_intake_party ON hub_channel_intake(binding_id, conversation, received_at)",
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_channel_bans (
      binding_id TEXT NOT NULL,
      conversation TEXT NOT NULL,
      banned_at INTEGER NOT NULL,
      PRIMARY KEY (binding_id, conversation)
    ) STRICT`);
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_channel_takeovers (
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      member_name TEXT NOT NULL,
      previous_member_id TEXT,
      taken_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, version)
    ) STRICT`);
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_channel_turns (
      session_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      handoff_version INTEGER NOT NULL,
      PRIMARY KEY (session_id, command_id)
    ) STRICT`);
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_channel_reply_delivery (
      session_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('message','settlement')),
      reply_id TEXT NOT NULL,
      delivered INTEGER NOT NULL CHECK(delivered IN (0,1)),
      PRIMARY KEY (session_id, command_id, kind, reply_id)
    ) STRICT`);
  };

  const decodeConversation = (
    row: z.infer<typeof conversationRow>,
  ): ChannelConversation => {
    const party = channelPartySchema.parse(JSON.parse(row.party_json));
    return {
      bindingId: row.binding_id,
      conversation: row.conversation,
      sessionId: row.session_id,
      party,
      label: partyLabel(party),
      createdAt: row.created_at,
      lastEventAt: row.last_event_at,
      handoff: handoffSchema.parse(JSON.parse(row.handoff_json)),
    };
  };

  const findConversation = (bindingId: string, conversation: string) => {
    ensure();
    const raw = sql
      .exec(
        "SELECT * FROM hub_channel_conversations WHERE binding_id=? AND conversation=?",
        bindingId,
        conversation,
      )
      .toArray()[0];
    return raw === undefined
      ? null
      : decodeConversation(conversationRow.parse(raw));
  };

  const count = (statement: string, ...bindings: (string | number)[]) =>
    countRow.parse(sql.exec(statement, ...bindings).toArray()[0]).count;

  /** Which binding, if any, a Session belongs to. Unbound means owner. */
  const sessionConversation = (
    sessionId: string,
  ): ChannelConversation | null => {
    ensure();
    const raw = sql
      .exec(
        "SELECT * FROM hub_channel_conversations WHERE session_id=?",
        sessionId,
      )
      .toArray()[0];
    return raw === undefined
      ? null
      : decodeConversation(conversationRow.parse(raw));
  };

  /** Every channel conversation's Session; owner Sessions are not listed. */
  const sessionIds = (): readonly string[] => {
    ensure();
    return sql
      .exec("SELECT session_id FROM hub_channel_conversations")
      .toArray()
      .map((raw) => sessionIdRow.parse(raw).session_id);
  };

  /** Open (or find) the conversation Session without submitting work. */
  const open = async (
    binding: ConversationBinding,
    conversation: string,
    party: ChannelParty,
  ): Promise<
    | Readonly<{ kind: "open"; conversation: ChannelConversation }>
    | Readonly<{ kind: "denied"; reason: "new_party_limit" | "banned" }>
  > => {
    if (isBanned(binding.bindingId, conversation))
      return { kind: "denied", reason: "banned" };
    const existing = findConversation(binding.bindingId, conversation);
    if (existing !== null) return { kind: "open", conversation: existing };
    const limits = limitsOf(binding);
    const now = options.now();
    if (
      count(
        "SELECT COUNT(*) AS count FROM hub_channel_conversations WHERE binding_id=? AND created_at>?",
        binding.bindingId,
        now - HOUR_MS,
      ) >= limits.newPartiesPerHour
    )
      return { kind: "denied", reason: "new_party_limit" };
    // Session creation is idempotent per request id, so a crash between the
    // door and this row leaves nothing to reconcile: the retry finds the same
    // Session.
    const sessionId = await options.door.createSession(
      `ch:${binding.bindingId}:${conversation}`,
    );
    options.transactionSync(() => {
      sql.exec(
        "INSERT OR IGNORE INTO hub_channel_conversations (binding_id,conversation,session_id,party_json,created_at,last_event_at) VALUES (?,?,?,?,?,?)",
        binding.bindingId,
        conversation,
        sessionId,
        JSON.stringify(party),
        now,
        now,
      );
    });
    const opened = findConversation(binding.bindingId, conversation);
    if (opened === null) throw new Error("Channel conversation was not stored");
    // The row now names the binding, so run admission is known: deliver tools
    // before any run of this Session can call a tool.
    options.door.deliverGrants(sessionId);
    return { kind: "open", conversation: opened };
  };

  const isBanned = (bindingId: string, conversation: string) => {
    ensure();
    return (
      sql
        .exec(
          "SELECT 1 FROM hub_channel_bans WHERE binding_id=? AND conversation=?",
          bindingId,
          conversation,
        )
        .toArray().length > 0
    );
  };

  /**
   * The conversation an event lands in. An incoming-events binding owns the
   * choice: `named` joins every event to one Session, `new` gives each event
   * the key its edge derived from the event id.
   */
  const conversationOf = (
    binding: ConversationBinding,
    event: InboundEvent,
  ): string =>
    binding.selector.provider === "event" && binding.selector.target === "named"
      ? NAMED_EVENT_CONVERSATION
      : event.conversation;

  /**
   * The digest an event is deduped on: only GitHub's, whose delivery id the
   * sender does not sign. Every other verifier either signs its event id
   * (fungi-v1) or has none to dedupe on (secret-url: each request is new).
   */
  const replayDigest = (
    binding: ConversationBinding,
    event: InboundEvent,
  ): string | null => {
    if (
      binding.selector.provider !== "event" ||
      binding.selector.verifier !== "github"
    )
      return null;
    // The edge always computes it; a GitHub event without one is a bug there.
    if (event.bodyDigest === undefined)
      throw new Error("A GitHub event needs the digest of its verified body");
    return event.bodyDigest;
  };

  /** The event id that already admitted this body inside the replay window. */
  const digestHit = (
    bindingId: string,
    digest: string,
    now: number,
  ): string | null => {
    const row = sql
      .exec(
        "SELECT event_id FROM hub_channel_intake WHERE binding_id=? AND body_digest=? AND received_at>?",
        bindingId,
        digest,
        now - EVENT_REPLAY_WINDOW_SECONDS * 1_000,
      )
      .toArray()[0];
    return row === undefined
      ? null
      : z.strictObject({ event_id: z.string() }).parse(row).event_id;
  };

  /** Has this events binding admitted its per-minute allowance already? */
  const rateLimited = (binding: ConversationBinding, now: number): boolean =>
    binding.selector.provider === "event" &&
    count(
      "SELECT COUNT(*) AS count FROM hub_channel_intake WHERE binding_id=? AND received_at>?",
      binding.bindingId,
      now - MINUTE_MS,
    ) >= binding.selector.eventsPerMinute;

  /** Accept one inbound event as ordinary Agent work, exactly once. */
  const admit = async (
    rawEvent: InboundEvent,
    retried: boolean,
  ): Promise<IntakeResult> => {
    const parsed = inboundEventSchema.parse(rawEvent);
    ensure();
    const binding = options.binding(parsed.bindingId);
    if (binding === null) return { kind: "denied", reason: "unmapped" };
    if (binding.lifecycle !== "active")
      return { kind: "denied", reason: "suspended" };
    const conversation = conversationOf(binding, parsed);
    if (isBanned(binding.bindingId, conversation))
      return { kind: "denied", reason: "banned" };
    const limits = limitsOf(binding);
    if (parsed.text.length > limits.charsPerMessage)
      return { kind: "denied", reason: "too_long" };

    // A body that already admitted an event inside the replay window is that
    // event again, whatever delivery id the replay carries.
    const digest = replayDigest(binding, parsed);
    const replayOf =
      digest === null
        ? null
        : digestHit(binding.bindingId, digest, options.now());
    const event: InboundEvent = {
      ...parsed,
      conversation,
      eventId: replayOf ?? parsed.eventId,
    };

    const prior = sql
      .exec(
        "SELECT conversation,session_id,text,state,command_id FROM hub_channel_intake WHERE binding_id=? AND event_id=?",
        binding.bindingId,
        event.eventId,
      )
      .toArray()[0];
    const priorIntake = prior === undefined ? null : intakeRow.parse(prior);
    // Visitor bearers own separate conversations. A verified provider-body
    // replay, in contrast, intentionally resolves to its original conversation.
    if (
      priorIntake !== null &&
      ((event.party.kind === "visitor" &&
        priorIntake.conversation !== event.conversation) ||
        priorIntake.text !== event.text)
    )
      return { kind: "denied", reason: "event_conflict" };
    if (priorIntake?.state === "accepted" && priorIntake.command_id !== null)
      return {
        kind: "accepted",
        sessionId: priorIntake.session_id,
        commandId: priorIntake.command_id,
        delivery: "replay",
      };
    if (priorIntake?.state === "held")
      return {
        kind: "held",
        sessionId: priorIntake.session_id,
        delivery: "replay",
      };

    let sessionId: string;
    if (priorIntake === null) {
      // Refuse a flood before it opens a Session per rejected event.
      if (rateLimited(binding, options.now()))
        return { kind: "denied", reason: "rate_limited" };
      const opened = await open(binding, event.conversation, event.party);
      if (opened.kind === "denied") return opened;
      if (opened.conversation.party.kind !== event.party.kind)
        return { kind: "denied", reason: "event_conflict" };
      sessionId = opened.conversation.sessionId;
      const now = options.now();
      const admitted = options.transactionSync(
        (): "inserted" | "replay" | "party_daily_limit" | "rate_limited" => {
          // Digests past the window stop blocking, so the same body may be
          // admitted again later.
          sql.exec(
            "UPDATE hub_channel_intake SET body_digest=NULL WHERE binding_id=? AND body_digest IS NOT NULL AND received_at<=?",
            binding.bindingId,
            now - EVENT_REPLAY_WINDOW_SECONDS * 1_000,
          );
          // Session creation yielded. Resolve a competing reservation through
          // the same conversation/text checks before replaying its receipt.
          if (
            sql
              .exec(
                "SELECT 1 FROM hub_channel_intake WHERE binding_id=? AND event_id=?",
                binding.bindingId,
                event.eventId,
              )
              .toArray().length > 0
          )
            return "replay";
          // Another delivery of this body may also have landed.
          if (
            digest !== null &&
            digestHit(binding.bindingId, digest, now) !== null
          )
            return "replay";
          if (
            count(
              "SELECT COUNT(*) AS count FROM hub_channel_intake WHERE binding_id=? AND conversation=? AND received_at>?",
              binding.bindingId,
              event.conversation,
              now - DAY_MS,
            ) >= limits.messagesPerPartyPerDay
          )
            return "party_daily_limit";
          if (rateLimited(binding, now)) return "rate_limited";
          sql.exec(
            "INSERT OR IGNORE INTO hub_channel_intake (binding_id,event_id,conversation,session_id,text,state,command_id,received_at,body_digest) VALUES (?,?,?,?,?,'pending',NULL,?,?)",
            binding.bindingId,
            event.eventId,
            event.conversation,
            sessionId,
            event.text,
            now,
            digest,
          );
          return "inserted";
        },
      );
      if (admitted === "replay") {
        // Intake lost a race while opening the Session. Re-read the winner,
        // including its conversation, rather than treating insert-ignore as ours.
        if (retried) throw new Error("A replayed event body was not found");
        return await admit(rawEvent, true);
      }
      if (admitted !== "inserted") return { kind: "denied", reason: admitted };
    } else sessionId = priorIntake.session_id;
    const requestId = channelRequestId(binding.bindingId, event.eventId);
    const delivery = priorIntake === null ? "new" : "replay";
    const party = event.party;
    const author: FungiAuthor = {
      id:
        party.kind === "visitor"
          ? party.visitorId
          : party.kind === "discord-user"
            ? party.userId
            : party.kind === "email-sender"
              ? party.address
              : party.kind === "player"
                ? party.playerId
                : party.source,
      name: partyLabel(party).slice(0, 128),
    };
    const meta =
      event.sourceRequestId === undefined
        ? authorMeta(author)
        : { ...authorMeta(author), sourceRequestId: event.sourceRequestId };
    try {
      // A held conversation is a person's: the event is a run-free party line.
      if (sessionConversation(sessionId)?.handoff.state === "person") {
        await options.door.line(sessionId, {
          requestId,
          author: "party",
          text: event.text,
          meta,
        });
        options.transactionSync(() => {
          sql.exec(
            "UPDATE hub_channel_intake SET state='held' WHERE binding_id=? AND event_id=? AND state='pending'",
            binding.bindingId,
            event.eventId,
          );
          sql.exec(
            "UPDATE hub_channel_conversations SET last_event_at=? WHERE session_id=?",
            options.now(),
            sessionId,
          );
        });
        return { kind: "held", sessionId, delivery };
      }
      const { commandId } = await options.door.prompt(sessionId, {
        requestId,
        text: event.text,
        meta,
      });
      options.transactionSync(() => {
        sql.exec(
          "UPDATE hub_channel_intake SET state='accepted', command_id=? WHERE binding_id=? AND event_id=? AND state='pending'",
          commandId,
          binding.bindingId,
          event.eventId,
        );
        sql.exec(
          "UPDATE hub_channel_conversations SET last_event_at=? WHERE session_id=?",
          options.now(),
          sessionId,
        );
        options.onAccepted?.({ binding, event, sessionId, commandId });
      });
      return { kind: "accepted", sessionId, commandId, delivery };
    } catch (error) {
      if (
        event.party.kind !== "visitor" ||
        !(error instanceof Error) ||
        options.door.errorKind(error, requestId) !== "closed_request"
      )
        throw error;
      // The owner's durable withdrawal fence is authoritative. This reservation
      // never became a line or command; do not present it as pending intake.
      sql.exec(
        "DELETE FROM hub_channel_intake WHERE binding_id=? AND event_id=? AND session_id=? AND state='pending'",
        binding.bindingId,
        event.eventId,
        sessionId,
      );
      return { kind: "denied", reason: "event_conflict" };
    }
  };

  const receive = (rawEvent: InboundEvent): Promise<IntakeResult> =>
    admit(rawEvent, false);

  const changeHandoff = (
    sessionId: string,
    event: HandoffEvent,
  ): ChannelHandoffResult =>
    options.transactionSync(() => {
      const current = sessionConversation(sessionId);
      if (current === null) return { kind: "not_found" };
      const result = transitionHandoff(current.handoff, event);
      if (result.kind !== "ok") return result;
      const next = handoffSchema.parse(result.handoff);
      if (next.version === current.handoff.version)
        return { kind: "ok", conversation: current };
      const changed = sql
        .exec(
          "UPDATE hub_channel_conversations SET handoff_json=?, notify_due_at=? WHERE session_id=? AND json_extract(handoff_json,'$.version')=? RETURNING session_id",
          JSON.stringify(next),
          next.state === "requested" ? next.at : null,
          sessionId,
          event.expectedVersion,
        )
        .toArray();
      if (changed.length !== 1) return { kind: "conflict" };
      if (event.kind === "take_over" && next.state === "person") {
        sql.exec(
          "INSERT INTO hub_channel_takeovers VALUES (?,?,?,?,?,?)",
          sessionId,
          next.version,
          next.memberId,
          next.memberName,
          current.handoff.state === "person" ? current.handoff.memberId : null,
          next.since,
        );
        sql.exec(
          "DELETE FROM hub_channel_takeovers WHERE session_id=? AND version NOT IN (SELECT version FROM hub_channel_takeovers WHERE session_id=? ORDER BY version DESC LIMIT 100)",
          sessionId,
          sessionId,
        );
      }
      return { kind: "ok", conversation: { ...current, handoff: next } };
    });

  /** Capture only the immutable command supplied by the real turn-start producer. */
  const captureTurn = (sessionId: string, commandId: string): void => {
    options.transactionSync(() => {
      const conversation = sessionConversation(sessionId);
      if (conversation === null) return;
      sql.exec(
        "INSERT OR IGNORE INTO hub_channel_turns VALUES (?,?,?)",
        sessionId,
        commandId,
        conversation.handoff.version,
      );
    });
  };

  const turnIsCurrent = (sessionId: string, commandId: string): boolean => {
    const conversation = sessionConversation(sessionId);
    if (conversation === null || conversation.handoff.state === "person")
      return false;
    const row = sql
      .exec(
        "SELECT handoff_version FROM hub_channel_turns WHERE session_id=? AND command_id=?",
        sessionId,
        commandId,
      )
      .toArray()[0];
    if (row === undefined) return false;
    const capturedVersion = z
      .strictObject({ handoff_version: z.number().int().nonnegative() })
      .parse(row).handoff_version;
    const handoff = conversation.handoff;
    // Requesting a person leaves the Agent in control: its current turn must
    // still be able to tell the participant someone will follow up. Only the
    // immediately following request is safe; any takeover/hand-back moves
    // beyond it. Never recapture the command at a newer version.
    return (
      capturedVersion === handoff.version ||
      (handoff.state === "requested" && handoff.version === capturedVersion + 1)
    );
  };

  /** Keep the first delivery decision: later handoffs cannot erase delivered history. */
  const deliverAgentReply = (
    sessionId: string,
    commandId: string,
    reply:
      | Readonly<{ kind: "message"; messageId: string }>
      | Readonly<{ kind: "settlement" }>,
  ): boolean =>
    options.transactionSync(() => {
      if (sessionConversation(sessionId) === null) return false;
      const replyId = reply.kind === "message" ? reply.messageId : "";
      const existing = sql
        .exec(
          "SELECT delivered FROM hub_channel_reply_delivery WHERE session_id=? AND command_id=? AND kind=? AND reply_id=?",
          sessionId,
          commandId,
          reply.kind,
          replyId,
        )
        .toArray()[0];
      if (existing !== undefined)
        return (
          z
            .strictObject({ delivered: z.union([z.literal(0), z.literal(1)]) })
            .parse(existing).delivered === 1
        );
      // Missing turn capture is not proof of a delivery or a permanent draft.
      const captured = sql
        .exec(
          "SELECT command_id FROM hub_channel_turns WHERE session_id=? AND command_id=?",
          sessionId,
          commandId,
        )
        .toArray();
      if (captured.length === 0) return false;
      const delivered = turnIsCurrent(sessionId, commandId);
      sql.exec(
        "INSERT INTO hub_channel_reply_delivery VALUES (?,?,?,?,?)",
        sessionId,
        commandId,
        reply.kind,
        replyId,
        delivered ? 1 : 0,
      );
      return delivered;
    });

  /**
   * The Agent asks for a person; the first reason stands until dismissal or takeover. A
   * new request owes the owner one notification, due now.
   */
  const requestHandoff = (sessionId: string, reason: string) => {
    const current = sessionConversation(sessionId);
    if (current === null) return { kind: "not_found" } as const;
    return changeHandoff(sessionId, {
      kind: "request",
      expectedVersion: current.handoff.version,
      reason,
      at: options.now(),
    });
  };

  /** Handoffs whose owner notification is due, oldest first. */
  const dueNotifications = (now: number): readonly ChannelConversation[] => {
    ensure();
    return sql
      .exec(
        "SELECT * FROM hub_channel_conversations WHERE notify_due_at IS NOT NULL AND notify_due_at<=? AND json_extract(handoff_json,'$.state')='requested' ORDER BY notify_due_at LIMIT 16",
        now,
      )
      .toArray()
      .map((raw) => decodeConversation(conversationRow.parse(raw)));
  };

  /** The earliest owed notification, or null. */
  const nextNotification = (): number | null => {
    ensure();
    return z
      .object({ due: z.number().int().nullable() })
      .parse(
        sql
          .exec(
            "SELECT MIN(notify_due_at) AS due FROM hub_channel_conversations WHERE json_extract(handoff_json,'$.state')='requested'",
          )
          .toArray()[0],
      ).due;
  };

  /** Settle (null) or reschedule one conversation's owed notification. */
  const scheduleNotification = (sessionId: string, dueAt: number | null) => {
    ensure();
    sql.exec(
      "UPDATE hub_channel_conversations SET notify_due_at=? WHERE session_id=? AND json_extract(handoff_json,'$.state')='requested'",
      dueAt,
      sessionId,
    );
  };

  /** Whether this exact handoff (by its start time) is still open. */
  const handoffOpen = (sessionId: string, version: number): boolean => {
    const handoff = sessionConversation(sessionId)?.handoff;
    return handoff?.state === "requested" && handoff.version === version;
  };

  /**
   * Conversations past their binding's retention, oldest first. A held
   * conversation is a person's and is never swept from under them.
   */
  const expired = (
    now: number,
    retentionMs: (bindingId: string) => number,
  ): readonly ChannelConversation[] => {
    ensure();
    return sql
      .exec(
        "SELECT * FROM hub_channel_conversations WHERE json_extract(handoff_json,'$.state')!='person' ORDER BY last_event_at LIMIT 256",
      )
      .toArray()
      .map((raw) => decodeConversation(conversationRow.parse(raw)))
      .filter(
        (conversation) =>
          conversation.lastEventAt + retentionMs(conversation.bindingId) <= now,
      )
      .slice(0, 32);
  };

  /** The earliest time any unheld conversation passes its retention. */
  const nextExpiry = (
    retentionMs: (bindingId: string) => number,
  ): number | null => {
    ensure();
    const rows = sql
      .exec(
        "SELECT binding_id, MIN(last_event_at) AS oldest FROM hub_channel_conversations WHERE json_extract(handoff_json,'$.state')!='person' GROUP BY binding_id",
      )
      .toArray()
      .map((raw) =>
        z
          .strictObject({ binding_id: z.string(), oldest: z.number().int() })
          .parse(raw),
      );
    const due = rows.map((row) => row.oldest + retentionMs(row.binding_id));
    return due.length === 0 ? null : Math.min(...due);
  };

  /** Forget a swept conversation: its map row and its intake log. */
  const forget = (conversation: ChannelConversation) => {
    ensure();
    options.transactionSync(() => {
      sql.exec(
        "DELETE FROM hub_channel_intake WHERE binding_id=? AND conversation=?",
        conversation.bindingId,
        conversation.conversation,
      );
      sql.exec(
        "DELETE FROM hub_channel_conversations WHERE session_id=?",
        conversation.sessionId,
      );
      sql.exec(
        "DELETE FROM hub_channel_turns WHERE session_id=?",
        conversation.sessionId,
      );
      sql.exec(
        "DELETE FROM hub_channel_reply_delivery WHERE session_id=?",
        conversation.sessionId,
      );
      sql.exec(
        "DELETE FROM hub_channel_takeovers WHERE session_id=?",
        conversation.sessionId,
      );
    });
  };

  /** The same transition function owns requests, takeovers, hand back and dismissal. */
  const takeOver = (
    sessionId: string,
    member: FungiAuthor,
    expectedVersion: number,
    confirm: boolean,
  ) =>
    changeHandoff(sessionId, {
      kind: "take_over",
      member,
      expectedVersion,
      confirm,
      at: options.now(),
    });
  const handBack = (
    sessionId: string,
    memberId: string,
    expectedVersion: number,
    confirm: boolean,
  ) =>
    changeHandoff(sessionId, {
      kind: "hand_back",
      memberId,
      expectedVersion,
      confirm,
    });
  const dismiss = (sessionId: string, expectedVersion: number) =>
    changeHandoff(sessionId, { kind: "dismiss", expectedVersion });

  const takeovers = (sessionId: string): readonly ChannelTakeoverReceipt[] => {
    ensure();
    return sql
      .exec(
        "SELECT * FROM hub_channel_takeovers WHERE session_id=? ORDER BY version DESC LIMIT 100",
        sessionId,
      )
      .toArray()
      .map((raw) => {
        const row = takeoverRow.parse(raw);
        return {
          version: row.version,
          memberId: row.member_id,
          memberName: row.member_name,
          previousMemberId: row.previous_member_id,
          at: row.taken_at,
        };
      });
  };

  /** Owner action: refuse further events from one conversation. */
  const ban = (bindingId: string, conversation: string) => {
    ensure();
    sql.exec(
      "INSERT OR IGNORE INTO hub_channel_bans VALUES (?,?,?)",
      bindingId,
      conversation,
      options.now(),
    );
  };

  /** Every conversation, newest activity first, for owner surfaces. */
  const list = (bindingId?: string): readonly ChannelConversation[] => {
    ensure();
    const rows =
      bindingId === undefined
        ? sql
            .exec(
              "SELECT * FROM hub_channel_conversations ORDER BY last_event_at DESC",
            )
            .toArray()
        : sql
            .exec(
              "SELECT * FROM hub_channel_conversations WHERE binding_id=? ORDER BY last_event_at DESC",
              bindingId,
            )
            .toArray();
    return rows.map((raw) => decodeConversation(conversationRow.parse(raw)));
  };

  /** Last 100 events on a projected event binding, with no payload or digest. */
  const recentEvents = (bindingId: string): readonly ChannelEventReceipt[] => {
    ensure();
    if (options.binding(bindingId)?.selector.provider !== "event") return [];
    return sql
      .exec(
        "SELECT event_id,received_at,state,length(CAST(text AS BLOB)) AS size,session_id FROM hub_channel_intake WHERE binding_id=? ORDER BY received_at DESC,event_id DESC LIMIT 100",
        bindingId,
      )
      .toArray()
      .map((raw) => {
        const row = eventReceiptRow.parse(raw);
        return {
          eventId: row.event_id,
          receivedAt: row.received_at,
          status: row.state,
          size: row.size,
          sessionId: row.session_id,
        };
      });
  };

  return {
    ensure,
    open,
    receive,
    /** A visitor bearer may never resolve another conversation's intake key. */
    visitorEventConflict: (
      bindingId: string,
      visitorId: string,
      eventId: string,
    ): boolean => {
      const row = sql
        .exec(
          "SELECT conversation FROM hub_channel_intake WHERE binding_id=? AND event_id=?",
          bindingId,
          eventId,
        )
        .toArray()[0];
      return (
        row !== undefined &&
        z.strictObject({ conversation: z.string() }).parse(row).conversation !==
          visitorId
      );
    },
    ban,
    list,
    recentEvents,
    requestHandoff,
    captureTurn,
    turnIsCurrent,
    deliverAgentReply,
    dueNotifications,
    nextNotification,
    scheduleNotification,
    handoffOpen,
    takeOver,
    handBack,
    dismiss,
    takeovers,
    expired,
    nextExpiry,
    forget,
    find: findConversation,
    sessionConversation,
    sessionIds,
  };
}
/** AgentDO's channel conversation owner. */
export type ChannelConversations = ReturnType<
  typeof createChannelConversations
>;
