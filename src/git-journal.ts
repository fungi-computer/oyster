import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { z } from "zod";
import {
  appGitPushFactSchema,
  type AppGitPushFact,
} from "@fungi.computer/agar/git";
import {
  backgroundWakeSchema,
  type BackgroundWake,
} from "@fungi.computer/puffball/background-replay";
import {
  createPost,
  definePostRoute,
  type PostDeliveryResult,
} from "@fungi.computer/carrier/post";
import {
  Watchdog,
  type WatchdogRuntime,
  type WatchdogSqliteOwner,
} from "@fungi.computer/watchdog";

/** The standalone composition supplies selected-Instance admission and its alarm. */
export type GitPushJournalPorts = Readonly<{
  owner: WatchdogSqliteOwner;
  /** Deliver a retained fact through the selected installation's lifecycle admission. */
  deliver(installationId: string, fact: AppGitPushFact): Promise<void>;
  /** Re-admit a retained member through the host gate before an ordinary continuation call. */
  deliverSync(wake: BackgroundWake): Promise<PostDeliveryResult>;
  /** Arm no later than an already scheduled alarm. */
  scheduleWake(at: number): Promise<void>;
  /** Host clock for delivery scheduling; defaults to Date.now. */
  now?: () => number;
}>;

const storedFact = z.lazy(() => z.strictObject({ fact: z.string() }));
const storedEpoch = z.lazy(() =>
  z.strictObject({
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
);
const syncKey = (installationId: string, lane: string, epoch: number) =>
  `appsync:${createHash("sha256")
    .update(JSON.stringify([installationId, lane, epoch]))
    .digest("hex")}`;
/** The immutable Carrier key also fits the SDK's bounded call idempotency key. */
export function backgroundWakeKey(
  wake: Pick<BackgroundWake, "installationId" | "lane" | "epoch">,
): string {
  return syncKey(wake.installationId, wake.lane, wake.epoch);
}
const installationIdSchema = z.lazy(() => z.string().min(1).max(256));
const postKey = (installationId: string, eventId: string) =>
  `gitpush:${createHash("sha256")
    .update(JSON.stringify([installationId, eventId]))
    .digest("hex")}`;

/** Carrier owns delivery state; this journal owns accepted fact identity. */
export async function createGitPushJournal(ports: GitPushJournalPorts) {
  const { owner } = ports;
  const now = ports.now ?? Date.now;
  owner.sql.exec(
    "CREATE TABLE IF NOT EXISTS oyster_git_push_facts (installation_id TEXT NOT NULL, event_id TEXT NOT NULL, fact TEXT NOT NULL, PRIMARY KEY (installation_id,event_id)) STRICT",
  );
  owner.sql.exec(
    "CREATE TABLE IF NOT EXISTS oyster_git_tips (installation_id TEXT NOT NULL, repository TEXT NOT NULL, ref TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(installation_id,repository,ref)) STRICT",
  );
  owner.sql.exec(
    "CREATE TABLE IF NOT EXISTS oyster_app_sync_epochs (installation_id TEXT NOT NULL, lane TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(installation_id,lane)) STRICT",
  );
  const deliveringSync = new Set<string>();
  const routes = {
    appSync: definePostRoute({
      addressKind: "appSync",
      address: Schema.String,
      event: Schema.String,
      name: (address) => address,
      namespace: {
        getByName: () => ({
          deliver: (envelope): Promise<PostDeliveryResult> => {
            const encoded = Schema.decodeUnknownSync(Schema.String)(
              envelope.event,
            );
            const wake = backgroundWakeSchema.parse(JSON.parse(encoded));
            const key = syncKey(wake.installationId, wake.lane, wake.epoch);
            deliveringSync.add(key);
            return ports.deliverSync(wake);
          },
        }),
      },
    }),
    installation: definePostRoute({
      addressKind: "installation",
      address: Schema.String,
      // The canonical Agar decoder owns the fact grammar, including stored JSON.
      event: Schema.String,
      name: (address) => address,
      namespace: {
        getByName: (installationId) => ({
          deliver: async (envelope): Promise<PostDeliveryResult> => {
            const raw = Schema.decodeUnknownSync(Schema.String)(envelope.event);
            const fact = appGitPushFactSchema.parse(JSON.parse(raw));
            await ports.deliver(installationId, fact);
            return { status: "accepted", receipt: { eventId: fact.eventId } };
          },
        }),
      },
    }),
  };
  const scheduleNext = async () => {
    const at = post.nextWake();
    if (at !== null) await ports.scheduleWake(at);
  };
  const watchdog: WatchdogRuntime = await Watchdog.make({
    owner,
    isAlive: () => Promise.resolve(false),
    execute: (job) => post.execute(job),
    wake: { recompute: scheduleNext },
  });
  const post = createPost({
    owner,
    routes,
    transactional: watchdog.transactional,
    readJob: watchdog.read,
    now,
    scheduleWake: ports.scheduleWake,
  });
  let settling: Promise<void> | undefined;
  const drain = async () => {
    let cursor: string | undefined;
    do {
      cursor = await post.enqueueDue(64, cursor);
    } while (cursor !== undefined);
    try {
      for (let count = 0; count < 64; count += 1) {
        if (
          (await watchdog.tick()).status !== "settled" ||
          deliveringSync.size > 0
        )
          break;
      }
    } finally {
      // Keep delivery marked until Carrier's receipt transaction has finished.
      deliveringSync.clear();
    }
    await scheduleNext();
  };
  await scheduleNext();
  return {
    /** Coalesce a pending member lane; terminal receipts receive a new immutable epoch. */
    async armSync(intent: Omit<BackgroundWake, "epoch">) {
      const identity = backgroundWakeSchema.parse({ ...intent, epoch: 1 });
      const wake = owner.transactionSync(() => {
        const row = owner.sql
          .exec(
            "SELECT epoch FROM oyster_app_sync_epochs WHERE installation_id=? AND lane=?",
            identity.installationId,
            identity.lane,
          )
          .toArray()[0];
        const previous = row === undefined ? 0 : storedEpoch.parse(row).epoch;
        if (
          previous > 0 &&
          !deliveringSync.has(
            syncKey(identity.installationId, identity.lane, previous),
          ) &&
          post.read(syncKey(identity.installationId, identity.lane, previous))
            ?.state === "pending"
        )
          return previous;
        const epoch = previous + 1;
        const next = backgroundWakeSchema.parse({ ...identity, epoch });
        owner.sql.exec(
          "INSERT INTO oyster_app_sync_epochs VALUES(?,?,?) ON CONFLICT(installation_id,lane) DO UPDATE SET epoch=excluded.epoch",
          next.installationId,
          next.lane,
          next.epoch,
        );
        post.send({
          key: syncKey(next.installationId, next.lane, next.epoch),
          kind: "appSync",
          address: createHash("sha256")
            .update(JSON.stringify([next.installationId, next.lane]))
            .digest("hex"),
          event: JSON.stringify(next),
        });
        return epoch;
      });
      await scheduleNext();
      return wake;
    },
    /** Last journaled ref head; null includes a journaled deletion. */
    tip(installation: string, repository: string, ref: string): string | null {
      const row = owner.sql
        .exec(
          "SELECT hash FROM oyster_git_tips WHERE installation_id=? AND repository=? AND ref=?",
          installationIdSchema.parse(installation),
          repository,
          ref,
        )
        .toArray()[0];
      return row === undefined
        ? null
        : z
            .strictObject({ hash: z.string().regex(/^[0-9a-f]{40}$/u) })
            .parse(row).hash;
    },
    /** Record a host-accepted push; provider acceptance precedes this local transaction. */
    async accept(installation: string, raw: AppGitPushFact) {
      const installationId = installationIdSchema.parse(installation);
      const fact = appGitPushFactSchema.parse(raw);
      const encoded = JSON.stringify(fact);
      const result = owner.transactionSync(() => {
        const previous = owner.sql
          .exec(
            "SELECT fact FROM oyster_git_push_facts WHERE installation_id=? AND event_id=?",
            installationId,
            fact.eventId,
          )
          .toArray()[0];
        if (previous !== undefined) {
          if (storedFact.parse(previous).fact !== encoded)
            throw new Error("Git push event conflicts with its accepted fact");
          return "duplicate";
        }
        owner.sql.exec(
          "INSERT INTO oyster_git_push_facts VALUES (?,?,?)",
          installationId,
          fact.eventId,
          encoded,
        );
        for (const update of fact.updates) {
          if (update.after === "0".repeat(40))
            owner.sql.exec(
              "DELETE FROM oyster_git_tips WHERE installation_id=? AND repository=? AND ref=?",
              installationId,
              fact.repository,
              update.ref,
            );
          else
            owner.sql.exec(
              "INSERT INTO oyster_git_tips VALUES(?,?,?,?) ON CONFLICT(installation_id,repository,ref) DO UPDATE SET hash=excluded.hash",
              installationId,
              fact.repository,
              update.ref,
              update.after,
            );
        }
        post.send({
          key: postKey(installationId, fact.eventId),
          kind: "installation",
          address: installationId,
          event: encoded,
        });
        return "recorded";
      });
      await scheduleNext();
      return result;
    },
    /** One bounded alarm turn; Carrier retains unfinished work and retry backoff. */
    alarm() {
      return (settling ??= drain().finally(() => {
        settling = undefined;
      }));
    },
    /** The next retained delivery deadline, or null when no wake is needed. */
    nextWake: () => post.nextWake(),
  };
}
