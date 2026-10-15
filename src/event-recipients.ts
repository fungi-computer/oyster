/**
 * Host recipients of App events: durable, per-recipient delivery records the
 * host commits when it accepts an emit, and drains after the emitter's write
 * has returned. A recipient that is down, slow or refusing never reaches the
 * emitter; its outcome is recorded on its own row as pending, delivered or
 * failed, and retried on the owner's alarm.
 */
import * as Schema from "effect/Schema";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { failureDiagnostic } from "./cause-class.js";

/** The emitting installation as the host attested it on the emit's frame. */
export type HostEventSource = Readonly<{
  installationId: string;
  appId: string;
  releaseId: string;
}>;

/** One accepted event, as a host recipient receives it. */
export type HostRecipientEvent = Readonly<{
  source: HostEventSource;
  type: string;
  eventId: string;
  payload: Readonly<{ type: string; timestamp: string; data: unknown }>;
}>;

/** One recipient's delivery record for one event. */
export type RecipientDelivery = Readonly<{
  recipient: string;
  eventId: string;
  type: string;
  state: "pending" | "delivered" | "failed";
  attempts: number;
  /** The last failed attempt's host-owned diagnostic, never guest text. */
  lastError: string | null;
  updatedAt: number;
}>;

/**
 * Retained D5 baseline: a ten-second attempt bound, and a terminal failure
 * after six failed attempts (the first plus one per retry delay).
 */
export const RECIPIENT_ATTEMPT_MS = 10_000;
export const RECIPIENT_RETRY_DELAYS_MS = [
  10_000, 60_000, 300_000, 1_800_000, 7_200_000,
] as const;
const DRAIN_PAGE = 16;

const eventCodec = Schema.fromJsonString(
  Schema.Struct({
    source: Schema.Struct({
      installationId: Schema.String,
      appId: Schema.String,
      releaseId: Schema.String,
    }),
    type: Schema.String,
    eventId: Schema.String,
    payload: Schema.Struct({
      type: Schema.String,
      timestamp: Schema.String,
      data: Schema.Unknown,
    }),
  }),
);
const decodeEvent = Schema.decodeUnknownSync(eventCodec);
const encodeEvent = Schema.encodeSync(eventCodec);
const dueRow = Schema.Struct({
  recipient: Schema.String,
  event_id: Schema.String,
  body: Schema.String,
  attempts: Schema.Number,
});
const deliveryRow = Schema.Struct({
  recipient: Schema.String,
  event_id: Schema.String,
  type: Schema.String,
  state: Schema.Literals(["pending", "delivered", "failed"]),
  attempts: Schema.Number,
  last_error: Schema.NullOr(Schema.String),
  updated_at: Schema.Number,
});
const nextRow = Schema.Struct({ at: Schema.NullOr(Schema.Number) });

function diagnostic(cause: unknown): string {
  const { causeClass, platform, message } = failureDiagnostic(cause);
  return [causeClass, ...(platform ?? []), message]
    .filter((part) => part !== undefined)
    .join(": ");
}

async function bounded(attempt: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      attempt,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new DOMException("Recipient delivery timed out", "TimeoutError"),
          );
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The owner's SQLite records, its alarm and the one typed delivery port. */
export function createRecipientDeliveries(options: {
  sql: WatchdogSqliteOwner["sql"];
  now(): number;
  /** Schedule the owner's next drain no later than `at`. */
  wake(at: number): Promise<void>;
  /** Deliver one event to one recipient; a rejection is one failed attempt. */
  deliver(recipient: string, event: HostRecipientEvent): Promise<void>;
  attemptMs?: number;
}) {
  const { sql } = options;
  sql.exec(`CREATE TABLE IF NOT EXISTS oyster_recipient_deliveries (
    recipient TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL,
    last_error TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (recipient, event_id)) STRICT`);
  sql.exec(`CREATE INDEX IF NOT EXISTS oyster_recipient_deliveries_due
    ON oyster_recipient_deliveries(state, next_at)`);
  const attemptMs = options.attemptMs ?? RECIPIENT_ATTEMPT_MS;
  const nextDue = (): number | null =>
    Schema.decodeUnknownSync(nextRow)(
      sql
        .exec(
          "SELECT MIN(next_at) AS at FROM oyster_recipient_deliveries WHERE state = 'pending'",
        )
        .toArray()[0],
    ).at;
  return {
    /**
     * Record one pending row per recipient (idempotent per event id). The
     * caller commits it with its other rows and then wakes for `now`.
     */
    enqueue(event: HostRecipientEvent, recipients: readonly string[]): number {
      const now = options.now();
      const body = encodeEvent(event);
      let queued = 0;
      for (const recipient of new Set(recipients))
        queued += sql
          .exec(
            "INSERT INTO oyster_recipient_deliveries (recipient, event_id, type, body, state, attempts, next_at, last_error, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?) ON CONFLICT DO NOTHING RETURNING event_id",
            recipient,
            event.eventId,
            event.type,
            body,
            now,
            now,
          )
          .toArray().length;
      return queued;
    },
    /** Attempt every due row once, record each outcome, and re-arm for the next retry. */
    async drain(): Promise<void> {
      const now = options.now();
      const due = sql
        .exec(
          "SELECT recipient, event_id, body, attempts FROM oyster_recipient_deliveries WHERE state = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?",
          now,
          DRAIN_PAGE,
        )
        .toArray()
        .map((row) => Schema.decodeUnknownSync(dueRow)(row));
      await Promise.all(
        due.map(async (row) => {
          // The attempt's cause becomes this row's recorded diagnostic.
          const failure = await bounded(
            options.deliver(row.recipient, decodeEvent(row.body)),
            attemptMs,
          ).then(
            () => null,
            (cause: unknown) => diagnostic(cause),
          );
          const attempts = row.attempts + 1;
          sql.exec(
            "UPDATE oyster_recipient_deliveries SET state = ?, attempts = ?, next_at = ?, last_error = ?, updated_at = ? WHERE recipient = ? AND event_id = ?",
            failure === null
              ? "delivered"
              : attempts > RECIPIENT_RETRY_DELAYS_MS.length
                ? "failed"
                : "pending",
            attempts,
            now + (RECIPIENT_RETRY_DELAYS_MS[attempts - 1] ?? 0),
            failure,
            options.now(),
            row.recipient,
            row.event_id,
          );
        }),
      );
      const next = nextDue();
      if (next !== null) await options.wake(next);
    },
    /** The earliest pending retry, if any. */
    nextDue,
    /** Recent deliveries to one recipient, newest first. */
    deliveries(recipient: string): RecipientDelivery[] {
      return sql
        .exec(
          "SELECT recipient, event_id, type, state, attempts, last_error, updated_at FROM oyster_recipient_deliveries WHERE recipient = ? ORDER BY updated_at DESC LIMIT 50",
          recipient,
        )
        .toArray()
        .map((raw) => {
          const row = Schema.decodeUnknownSync(deliveryRow)(raw);
          return {
            recipient: row.recipient,
            eventId: row.event_id,
            type: row.type,
            state: row.state,
            attempts: row.attempts,
            lastError: row.last_error,
            updatedAt: row.updated_at,
          };
        });
    },
  };
}
