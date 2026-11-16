import { z } from "zod";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { ownerCodec } from "./apps/installation.js";
import { installationRequestIdSchema } from "./installation-operations.js";
import { AppInstanceError, selectionSchema, type Instance } from "./index.js";

/** A test copy is fenced to the same store and owner selection as its source. */
export const appTestCopyAuthoritySchema = z.strictObject({
  selection: ownerCodec(selectionSchema),
  storeGeneration: z.string().min(1).max(256),
});
/** Exact source selection and store incarnation observed by the owner. */
export type AppTestCopyAuthority = z.output<typeof appTestCopyAuthoritySchema>;
/** Resource identity is host-minted, never an idempotency key or an Instance. */
const appTestCopyIds = defineIdFamily({
  family: "app-test-copy",
  version: 1,
  kinds: { copy: { prefix: "appcopy" } },
});
/** Host-owned identity and fixed deadline of one disposable App-data sibling. */
export const appTestCopySchema = appTestCopyAuthoritySchema.extend({
  copyId: z.string().refine((value): boolean => appTestCopyIds.copy.is(value)),
  expiresAt: z.number().int().nonnegative(),
});
/** Observed sibling identity and nonrenewing deadline, never live host grants. */
export type AppTestCopy = z.output<typeof appTestCopySchema>;
const recordSchema = appTestCopySchema.extend({
  requestId: installationRequestIdSchema,
  phase: z.enum(["creating", "active", "closing", "closed"]),
});
type CopyRecord = z.output<typeof recordSchema>;

// Private resource ceiling, not caller-selectable policy or a renewable lease.
const lifetimeMs = 5 * 60 * 1000;

/** Native operations stay with the Instance; only the App facet is cloned. */
export type AppTestCopyPorts = Readonly<{
  owner: WatchdogSqliteOwner;
  now: () => number;
  source: () => Effect.Effect<
    Readonly<{ instance: Instance; storeGeneration: string }> | null,
    Error
  >;
  clone: () => Effect.Effect<void, Error>;
  purge: () => Effect.Effect<void, Error>;
  wake: (at: number) => Effect.Effect<void, Error>;
}>;

function matches(a: AppTestCopyAuthority, b: AppTestCopyAuthority): boolean {
  const left = a.selection;
  const right = b.selection;
  return (
    a.storeGeneration === b.storeGeneration &&
    left.instanceId === right.instanceId &&
    left.owner.kind === right.owner.kind &&
    left.owner.id === right.owner.id &&
    left.appId === right.appId &&
    left.releaseId === right.releaseId &&
    left.authorityVersion === right.authorityVersion
  );
}

function metadata(record: CopyRecord): AppTestCopy {
  return {
    selection: record.selection,
    storeGeneration: record.storeGeneration,
    copyId: record.copyId,
    expiresAt: record.expiresAt,
  };
}

/** One bounded durable lifecycle, independent of App and editable Shell code. */
export function createAppTestCopies(ports: AppTestCopyPorts) {
  const sql = ports.owner.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS app_test_copy (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL) STRICT",
  );
  const lock = Semaphore.makeUnsafe(1);
  const attempt = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (cause) =>
        cause instanceof Error ? cause : new Error("Test copy storage failed"),
    });
  const read = attempt(() => {
    const row = sql
      .exec("SELECT record FROM app_test_copy WHERE id=1")
      .toArray()[0];
    if (row === undefined) return null;
    const stored = z.strictObject({ record: z.string() }).parse(row);
    return recordSchema.parse(JSON.parse(stored.record));
  });
  const write = (record: CopyRecord) =>
    attempt(() => {
      sql.exec(
        "INSERT INTO app_test_copy(id,record) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
        JSON.stringify(record),
      );
    });
  const close = (record: CopyRecord) =>
    Effect.gen(function* () {
      yield* write({ ...record, phase: "closing" });
      // The expiry wake preceded clone. Purging must not depend on another
      // scheduler write; a failed purge remains closing for that wake/replay.
      yield* ports.purge();
      yield* write({ ...record, phase: "closed" });
    });
  const currentSource = (authority: AppTestCopyAuthority) =>
    ports.source().pipe(
      Effect.map(
        (source) =>
          source !== null &&
          source.instance.status === "active" &&
          source.instance.stateSchema !== null &&
          matches(authority, {
            selection: source.instance,
            storeGeneration: source.storeGeneration,
          }),
      ),
    );
  const live = Effect.gen(function* () {
    const record = yield* read;
    if (record === null || record.phase === "closed") return null;
    if (
      record.phase !== "active" ||
      record.expiresAt <= ports.now() ||
      !(yield* currentSource(record))
    ) {
      yield* close(record);
      return null;
    }
    return record;
  });
  const inspect = (authority: AppTestCopyAuthority) =>
    lock.withPermits(1)(
      live.pipe(
        Effect.map((record) =>
          record !== null && matches(record, authority)
            ? metadata(record)
            : null,
        ),
      ),
    );
  // The native adapter bounds work. Keep its allocation and invocation under
  // the same permit as retirement, not merely its initial metadata read.
  const withCopy = <A>(
    authority: AppTestCopyAuthority,
    copyId: string,
    work: (copy: AppTestCopy) => Effect.Effect<A, Error>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* live;
        if (record?.copyId !== copyId || !matches(record, authority))
          return yield* Effect.fail(new AppInstanceError("expired"));
        const result = yield* work(metadata(record));
        const current = yield* live;
        if (current?.copyId !== copyId || !matches(current, authority))
          return yield* Effect.fail(new AppInstanceError("revoked"));
        return result;
      }),
    );
  const open = (authority: AppTestCopyAuthority, requestId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const input = yield* attempt(() =>
          appTestCopyAuthoritySchema.parse(authority),
        );
        const id = yield* attempt(() =>
          installationRequestIdSchema.parse(requestId),
        );
        if (!(yield* currentSource(input)))
          return yield* Effect.fail(new AppInstanceError("instance_inactive"));
        yield* live;
        const current = yield* read;
        if (current?.phase === "closed" && current.requestId === id)
          return yield* Effect.fail(new AppInstanceError("expired"));
        if (current !== null && current.phase !== "closed") {
          if (
            current.phase === "active" &&
            current.requestId === id &&
            matches(current, input)
          )
            return metadata(current);
          return yield* Effect.fail(
            new AppInstanceError("conflicting_owner_state"),
          );
        }
        const record: CopyRecord = {
          ...input,
          copyId: appTestCopyIds.copy.generate(),
          requestId: id,
          expiresAt: ports.now() + lifetimeMs,
          phase: "creating",
        };
        yield* write(record);
        return yield* Effect.gen(function* () {
          // Retain cleanup before clone, including a crash before publication.
          yield* ports.wake(record.expiresAt);
          yield* ports.clone();
          const active = { ...record, phase: "active" as const };
          yield* write(active);
          return metadata(active);
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? close(record) : Effect.void,
          ),
        );
      }),
    );
  const discard = (authority: AppTestCopyAuthority, copyId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* read;
        if (
          record === null ||
          record.phase === "closed" ||
          record.copyId !== copyId ||
          !matches(record, authority)
        )
          return false;
        yield* close(record);
        return true;
      }),
    );
  const expire = () =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* read;
        if (record === null || record.phase === "closed") return;
        if (record.phase !== "active" || record.expiresAt <= ports.now())
          yield* close(record);
        else yield* ports.wake(record.expiresAt);
      }),
    );
  const revoke = () =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* read;
        if (record !== null && record.phase !== "closed") yield* close(record);
      }),
    );
  return { open, inspect, withCopy, discard, expire, revoke };
}
