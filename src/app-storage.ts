/**
 * `env.APP_STORAGE`: the App's own key/value store, as its backend receives
 * it. One contract for every Oyster host (standalone and the Fungi Hub).
 *
 * - **Same handle everywhere.** Method handlers and lifecycle handlers (such
 *   as `onGitPush`) run in the same facet and receive the same `env`. When the
 *   Release declares the `APP_STORAGE` binding, both get this handle with the
 *   same operations.
 * - **Who writes.** In a method call, a member writes their own `member`
 *   layer; an admitted owner may also write the `team` layer, as from the UI.
 *   A lifecycle handler has no
 *   member, so it writes the installation's shared `team` layer; a `member`
 *   write from a lifecycle handler is rejected with `owner_required`.
 * - **Visible to watchers.** Every accepted write or reset is committed by the
 *   host's storage owner, bumps the key's revision and is published to
 *   `appStorage.watch` subscribers, exactly like a write from the App's UI.
 *   A push that writes a key therefore refreshes every open UI watching it.
 * - **Same limits.** Declared keys, scopes, per-key size and quotas, and
 *   `basedOn` compare-and-set apply unchanged; rejections use Agar's
 *   `AppStorageError` codes.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { appStorageScopes, type AppStorageKey } from "@fungi.computer/puffball";

import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import {
  AppStorageError,
  type AppStorageResult,
  type AppStorageWrite,
  type AppStorageReset,
  type ResolvedAppStorage,
  type AppStorageEvent,
} from "@fungi.computer/agar/storage";

/** The App storage handle in `env.APP_STORAGE`. */
export type AppStorageBinding = Readonly<{
  /** Read one declared key, resolved across the team and member layers. */
  read(key: string): Promise<AppStorageResult<ResolvedAppStorage>>;
  /** Write one layer of a declared key; `basedOn` is the expected revision. */
  write(
    input: AppStorageWrite,
  ): Promise<AppStorageResult<{ revision: number }>>;
  /** Remove one layer of a declared key. */
  reset(
    input: AppStorageReset,
  ): Promise<AppStorageResult<{ revision: number }>>;
}>;

/** Trusted backend writer: owners may also edit the Team layer; lifecycle has no member. */
export type AppStorageWriter =
  | Readonly<{ kind: "member"; memberId: string; isOwner: boolean }>
  | Readonly<{ kind: "lifecycle"; handler: string }>;

/** Whether `writer` may mutate `scope`; anything else is `owner_required`. */
export function appStorageWritable(
  writer: AppStorageWriter,
  scope: AppStorageWrite["scope"],
): boolean {
  return writer.kind === "member"
    ? scope === "member" || writer.isOwner
    : scope === "team";
}

const unavailable = (cause: unknown) =>
  cause instanceof AppStorageError
    ? cause
    : new AppStorageError("unavailable", { cause });
const revision = Schema.Int.check(Schema.isGreaterThan(0));

/** Trusted live App admission, never supplied by the App or an HTTP body. */
export type AppStorageAdmission = Readonly<{
  address: string;
  appId: string;
  memberId: string;
  membershipVersion: number;
  isOwner: boolean;
  keys: readonly AppStorageKey[];
  /** Recheck local membership, installation and Release inside the transaction. */
  assertCurrent: () => void;
}>;

/** Trusted installation lifecycle admission, with no member identity or private layer. */
export type AppStorageInstallationAdmission = Pick<
  AppStorageAdmission,
  "address" | "appId" | "keys" | "assertCurrent"
>;
type MutationAdmission = AppStorageAdmission | AppStorageInstallationAdmission;
// Team layers and installation rate counters use the existing non-member SQL partition.
const writerIdentity = (admission: MutationAdmission) =>
  "memberId" in admission
    ? {
        memberId: admission.memberId,
        membershipVersion: admission.membershipVersion,
      }
    : { memberId: "", membershipVersion: 0 };

/** SQLite tables, indexes and initial revision state used by the App storage owner. */
export const appStorageSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS hub_app_storage (
    address TEXT NOT NULL, app_id TEXT NOT NULL, key TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('team','member')), member_id TEXT NOT NULL, membership_version INTEGER NOT NULL,
    value TEXT NOT NULL, revision INTEGER NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY(address,app_id,key,scope,member_id,membership_version),
    CHECK((scope='team' AND member_id='' AND membership_version=0) OR (scope='member' AND member_id<>'' AND membership_version>0))) STRICT`,
  `CREATE INDEX IF NOT EXISTS hub_app_storage_member ON hub_app_storage(member_id) WHERE scope='member'`,
  `CREATE TABLE IF NOT EXISTS hub_app_storage_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL) STRICT`,
  `INSERT OR IGNORE INTO hub_app_storage_clock VALUES(1,0)`,
  `CREATE TABLE IF NOT EXISTS hub_app_storage_writes (address TEXT NOT NULL, member_id TEXT NOT NULL, membership_version INTEGER NOT NULL, started_at INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(address,member_id,membership_version)) STRICT`,
] as const;

/** Called only inside the installation owner's delete transaction. */
export function purgeAppStorageInCommit(
  sql: WatchdogSqliteOwner["sql"],
  address: string,
): void {
  sql.exec("DELETE FROM hub_app_storage WHERE address=?", address);
  sql.exec("DELETE FROM hub_app_storage_writes WHERE address=?", address);
}
/** Called only inside the membership owner's removal transaction. */
export function purgeAppMemberStorageInCommit(
  sql: WatchdogSqliteOwner["sql"],
  memberId: string,
  throughVersion: number,
): void {
  sql.exec(
    "DELETE FROM hub_app_storage WHERE scope='member' AND member_id=? AND membership_version<=?",
    memberId,
    throughVersion,
  );
  sql.exec(
    "DELETE FROM hub_app_storage_writes WHERE member_id=? AND membership_version<=?",
    memberId,
    throughVersion,
  );
}

const storedLayer = Schema.Struct({
  scope: Schema.Literals(appStorageScopes),
  value: Schema.fromJsonString(Schema.Json),
  revision,
  bytes: Schema.Int,
});
const usageSchema = Schema.Struct({ bytes: Schema.Int, app_bytes: Schema.Int });
const clockSchema = Schema.Struct({ revision });
const appQuotaBytes = 1024 * 1024;
const teamQuotaBytes = 16 * appQuotaBytes;

const isJsonPrimitive = Schema.is(
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
);
function withinDepth(value: Schema.Json, depth = 0): boolean {
  if (isJsonPrimitive(value)) return true;
  if (depth >= 32) return false;
  return Object.values(value).every((child) => withinDepth(child, depth + 1));
}

/** One SQLite owner for scoped App values; its views bind the admitted member. */
export function createAppStorage(options: {
  /** The SQLite connection shared with installation and membership changes. */
  sql: WatchdogSqliteOwner["sql"];
  /** Millisecond clock used for the existing per-principal write-rate limit. */
  now?: () => number;
  /** Commit the supplied mutation atomically before publishing its invalidation. */
  commit: <A>(body: () => A) => Effect.Effect<A, Error>;
}) {
  const { sql } = options;
  type Notice = AppStorageEvent &
    Readonly<{ address: string; memberId: string }>;
  const listeners = new Set<(notice: Notice) => void>();
  const publish = (
    admission: MutationAdmission,
    input: AppStorageReset,
    result: { revision: number },
  ) => {
    const notice = {
      address: admission.address,
      appId: admission.appId,
      memberId: writerIdentity(admission).memberId,
      key: input.key,
      scope: input.scope,
      revision: result.revision,
    };
    for (const listener of listeners) listener(notice);
  };
  for (const statement of appStorageSchemaStatements) sql.exec(statement);
  const layers = (admission: MutationAdmission, key: string) =>
    sql
      .exec(
        "SELECT scope,value,revision,bytes FROM hub_app_storage WHERE address=? AND app_id=? AND key=? AND (scope='team' OR (member_id=? AND membership_version=?))",
        admission.address,
        admission.appId,
        key,
        writerIdentity(admission).memberId,
        writerIdentity(admission).membershipVersion,
      )
      .toArray()
      .map((row) => Schema.decodeUnknownSync(storedLayer)(row));
  const declare = (admission: MutationAdmission, key: string) => {
    const declared = admission.keys.find((entry) => entry.key === key);
    if (declared === undefined) throw new AppStorageError("undeclared_key");
    admission.assertCurrent();
    return declared;
  };
  const nextRevision = () => {
    sql.exec("UPDATE hub_app_storage_clock SET revision=revision+1 WHERE id=1");
    const row = sql
      .exec("SELECT revision FROM hub_app_storage_clock WHERE id=1")
      .toArray()[0];
    return Schema.decodeUnknownSync(clockSchema)(row).revision;
  };
  const consumeWrite = (admission: MutationAdmission) => {
    const now = (options.now ?? Date.now)();
    const row = sql
      .exec(
        "SELECT started_at,count FROM hub_app_storage_writes WHERE address=? AND member_id=? AND membership_version=?",
        admission.address,
        writerIdentity(admission).memberId,
        writerIdentity(admission).membershipVersion,
      )
      .toArray()[0];
    const saved =
      row === undefined
        ? null
        : Schema.decodeUnknownSync(
            Schema.Struct({ started_at: Schema.Int, count: Schema.Int }),
          )(row);
    const current = saved !== null && now < saved.started_at + 60000;
    if (current && saved.count >= 60)
      throw new AppStorageError("quota_exceeded");
    sql.exec(
      "INSERT INTO hub_app_storage_writes(address,member_id,membership_version,started_at,count) VALUES(?,?,?,?,?) ON CONFLICT(address,member_id,membership_version) DO UPDATE SET started_at=excluded.started_at,count=excluded.count",
      admission.address,
      writerIdentity(admission).memberId,
      writerIdentity(admission).membershipVersion,
      current ? saved.started_at : now,
      current ? saved.count + 1 : 1,
    );
  };
  const mutate = (
    admission: MutationAdmission,
    input: AppStorageReset,
    value: Schema.Json | undefined,
  ) => {
    const writer: AppStorageWriter =
      "memberId" in admission
        ? {
            kind: "member",
            memberId: admission.memberId,
            isOwner: admission.isOwner,
          }
        : { kind: "lifecycle", handler: "installation" };
    if (!appStorageWritable(writer, input.scope))
      throw new AppStorageError("owner_required");
    const declared = declare(admission, input.key);
    if (!declared.scopes.includes(input.scope))
      throw new AppStorageError("scope_not_declared");
    const current = layers(admission, input.key).find(
      (row) => row.scope === input.scope,
    );
    if ((current?.revision ?? null) !== input.basedOn)
      throw new AppStorageError("conflict");
    const memberId =
      input.scope === "member" ? writerIdentity(admission).memberId : "";
    const membershipVersion =
      input.scope === "member"
        ? writerIdentity(admission).membershipVersion
        : 0;
    if (value === undefined) {
      consumeWrite(admission);
      sql.exec(
        "DELETE FROM hub_app_storage WHERE address=? AND app_id=? AND key=? AND scope=? AND member_id=? AND membership_version=?",
        admission.address,
        admission.appId,
        input.key,
        input.scope,
        memberId,
        membershipVersion,
      );
      return { revision: nextRevision() };
    }
    if (!withinDepth(value)) throw new AppStorageError("invalid");
    const encoded = JSON.stringify(value);
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (bytes > declared.maxBytes) throw new AppStorageError("too_large");
    const usage = Schema.decodeUnknownSync(usageSchema)(
      sql
        .exec(
          "SELECT COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(CASE WHEN address=? THEN bytes ELSE 0 END),0) AS app_bytes FROM hub_app_storage",
          admission.address,
        )
        .toArray()[0],
    );
    const delta = bytes - (current?.bytes ?? 0);
    if (
      usage.bytes + delta > teamQuotaBytes ||
      usage.app_bytes + delta > appQuotaBytes
    )
      throw new AppStorageError("quota_exceeded");
    consumeWrite(admission);
    const revision = nextRevision();
    sql.exec(
      "INSERT INTO hub_app_storage(address,app_id,key,scope,member_id,membership_version,value,revision,bytes) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(address,app_id,key,scope,member_id,membership_version) DO UPDATE SET value=excluded.value,revision=excluded.revision,bytes=excluded.bytes",
      admission.address,
      admission.appId,
      input.key,
      input.scope,
      memberId,
      membershipVersion,
      encoded,
      revision,
      bytes,
    );
    return { revision };
  };
  const resolveStorage = (
    admission: MutationAdmission,
    key: string,
  ): ResolvedAppStorage => {
    const declared = declare(admission, key);
    const rows = layers(admission, key);
    const team = declared.scopes.includes("team")
      ? rows.find((row) => row.scope === "team")
      : undefined;
    if (!("memberId" in admission) && !declared.scopes.includes("team"))
      throw new AppStorageError("owner_required");
    const member =
      "memberId" in admission && declared.scopes.includes("member")
        ? rows.find((row) => row.scope === "member")
        : undefined;
    const project = (row: typeof team) =>
      row === undefined ? null : { value: row.value, revision: row.revision };
    return {
      value:
        member !== undefined
          ? member.value
          : team !== undefined
            ? team.value
            : null,
      source:
        member !== undefined ? "member" : team !== undefined ? "team" : "none",
      team: project(team),
      member: project(member),
      canWriteTeam: "isOwner" in admission ? admission.isOwner : true,
    };
  };
  const commitMutation = (
    admission: MutationAdmission,
    input: AppStorageReset,
    value: Schema.Json | undefined,
  ) =>
    Effect.uninterruptible(
      options
        .commit(() => mutate(admission, input, value))
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              publish(admission, input, result);
            }),
          ),
        ),
    );
  return {
    /** Remove an installation's values and write counters inside its delete transaction. */
    purgeInstallation: (address: string) => {
      purgeAppStorageInCommit(sql, address);
    },
    /** Remove a member's private values and counters through the revoked membership version. */
    purgeMember: (memberId: string, throughVersion: number) => {
      purgeAppMemberStorageInCommit(sql, memberId, throughVersion);
    },
    /** Bind a lifecycle view to fresh installation admission; only declared team layers are accessible. */
    openInstallation(
      authorize: () => Effect.Effect<AppStorageInstallationAdmission, Error>,
    ) {
      const mutation = (
        input: AppStorageReset,
        value: Schema.Json | undefined,
      ) =>
        authorize().pipe(
          Effect.flatMap((admission) =>
            commitMutation(admission, input, value),
          ),
          Effect.mapError(unavailable),
        );
      return {
        /** Read the declared team layer without exposing any member's private value. */
        read: (key: string) =>
          authorize().pipe(
            Effect.flatMap((admission) =>
              Effect.try({
                try: () => resolveStorage(admission, key),
                catch: unavailable,
              }),
            ),
            Effect.mapError(unavailable),
          ),
        /** Commit a declared team-layer write and publish its new revision to watchers. */
        write: (input: AppStorageWrite) => mutation(input, input.value),
        /** Reset a declared team layer; member scope is rejected with owner_required. */
        reset: (input: AppStorageReset) => mutation(input, undefined),
      };
    },
    /** Bind a member view to live admission, declared keys and the current membership version. */
    open(authorize: () => Effect.Effect<AppStorageAdmission, Error>) {
      const admitted = () => authorize().pipe(Effect.mapError(unavailable));
      return {
        /** Resolve declared member and team layers under current live admission. */
        read: (key: string) =>
          admitted().pipe(
            Effect.flatMap((admission) =>
              Effect.try({
                try: (): ResolvedAppStorage => {
                  return resolveStorage(admission, key);
                },
                catch: unavailable,
              }),
            ),
          ),
        /** Commit an admitted layer write with revision and quota checks, then notify watchers. */
        write: (input: AppStorageWrite) =>
          admitted().pipe(
            Effect.flatMap((admission) =>
              commitMutation(admission, input, input.value),
            ),
            Effect.mapError(unavailable),
          ),
        /** Remove an admitted layer at its expected revision and notify watchers. */
        reset: (input: AppStorageReset) =>
          admitted().pipe(
            Effect.flatMap((admission) =>
              commitMutation(admission, input, undefined),
            ),
            Effect.mapError(unavailable),
          ),
        /** One bounded invalidation stream. Null marks an armed subscription. */
        events: (key: string) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const admission = yield* admitted();
              const declared = yield* Effect.try({
                try: () => declare(admission, key),
                catch: unavailable,
              });
              const queue = yield* Queue.sliding<AppStorageEvent>(1);
              const listener = (notice: Notice) => {
                if (
                  notice.address !== admission.address ||
                  notice.appId !== admission.appId ||
                  notice.key !== key ||
                  !declared.scopes.includes(notice.scope) ||
                  (notice.scope === "member" &&
                    notice.memberId !== admission.memberId)
                )
                  return;
                Queue.offerUnsafe(queue, {
                  appId: notice.appId,
                  key: notice.key,
                  scope: notice.scope,
                  revision: notice.revision,
                });
              };
              yield* Effect.acquireRelease(
                Effect.sync(() => listeners.add(listener)),
                () =>
                  Effect.sync(() => {
                    listeners.delete(listener);
                    Queue.shutdownUnsafe(queue);
                  }),
              );
              return Stream.concat(
                Stream.succeed(null),
                Stream.fromQueue(queue),
              ).pipe(
                Stream.tap(() =>
                  admitted().pipe(
                    Effect.flatMap((current) =>
                      Effect.try({
                        try: () => declare(current, key),
                        catch: unavailable,
                      }),
                    ),
                  ),
                ),
              );
            }),
          ),
      };
    },
  };
}
