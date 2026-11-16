import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { instanceIds, type Instance } from "../src/index.js";
import {
  createAppTestCopies,
  type AppTestCopyAuthority,
} from "../src/app-test-copies.js";
import { release } from "./apps-fixture.js";

// Lifecycle/SQLite-owner proof, not a native facets.clone qualification.
function fixture(path = ":memory:") {
  let database = new DatabaseSync(path);
  let closeStoreAfterClone = false;
  let purgeAvailable = true;
  let now = 10_000;
  let sourceReads = 0;
  let schedulerAvailable = true;
  let source: Instance | null = {
    instanceId: instanceIds.instance.generate(),
    owner: { kind: "installation", id: "notes" },
    appId: release.appId,
    releaseId: release.releaseId,
    authorityVersion: 1,
    desiredStatus: "enabled",
    status: "active",
    stateSchema: 1,
  };
  const authority: AppTestCopyAuthority = {
    selection: {
      instanceId: source.instanceId,
      owner: source.owner,
      appId: source.appId,
      releaseId: source.releaseId,
      authorityVersion: source.authorityVersion,
    },
    storeGeneration: "store-one",
  };
  const wakes: number[] = [];
  const effects = { clones: 0, purges: 0, wakes };
  const copies = () =>
    createAppTestCopies({
      owner: fromNodeSqlite(database),
      now: () => now,
      source: () =>
        Effect.sync(() => {
          sourceReads++;
          return source === null
            ? null
            : { instance: source, storeGeneration: "store-one" };
        }),
      clone: () =>
        Effect.sync(() => {
          effects.clones++;
          if (closeStoreAfterClone) database.close();
        }),
      purge: () =>
        Effect.try({
          try: () => {
            if (!purgeAvailable) throw new Error("Native purge unavailable");
            effects.purges++;
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Purge failed"),
        }),
      wake: (at) =>
        Effect.try({
          try: () => {
            if (!schedulerAvailable) throw new Error("Wake unavailable");
            effects.wakes.push(at);
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Wake failed"),
        }),
    });
  return {
    authority,
    effects,
    copies,
    sourceReads: () => sourceReads,
    scheduler: (available: boolean) => {
      schedulerAvailable = available;
    },
    close: () => {
      if (database.isOpen) database.close();
    },
    loseStoreAfterClone: () => {
      closeStoreAfterClone = true;
    },
    reopen: () => {
      if (database.isOpen) database.close();
      database = new DatabaseSync(path);
    },
    purge: (available: boolean) => {
      purgeAvailable = available;
    },
    advance: (ms: number) => {
      now += ms;
    },
    source: (value: Instance | null) => {
      source = value;
    },
  };
}

it("opens one bounded copy, answers an exact retry and retains its identity after owner reopen", async () => {
  const f = fixture();
  try {
    const copies = f.copies();
    const first = await Effect.runPromise(
      copies.open(f.authority, "request-one"),
    );
    expect(first).toMatchObject({
      ...f.authority,
      expiresAt: 310_000,
    });
    expect(first.copyId).not.toBe("request-one");
    expect(
      await Effect.runPromise(copies.open(f.authority, "request-one")),
    ).toEqual(first);
    expect(await Effect.runPromise(f.copies().inspect(f.authority))).toEqual(
      first,
    );
    expect(f.effects).toEqual({ clones: 1, purges: 0, wakes: [310_000] });
  } finally {
    f.close();
  }
});

it.each(["expiry", "revocation"] as const)(
  "keeps %s outside delayed execution and retires the copy before returning a late result",
  async (retirement) => {
    const f = fixture();
    const entered = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    try {
      const copies = f.copies();
      const copy = await Effect.runPromise(
        copies.open(f.authority, "request-one"),
      );
      const execution = Effect.runPromise(
        Effect.flip(
          copies.withCopy(f.authority, copy.copyId, () =>
            Effect.promise(async () => {
              entered.resolve(undefined);
              await resume.promise;
              // A native get here can create a facet: retirement must not
              // publish closed state before this work has stopped allocating.
              expect(f.effects.purges).toBe(0);
              return "late result";
            }),
          ),
        ),
      );
      await entered.promise;
      if (retirement === "expiry") f.advance(300_000);
      else f.source(null);
      const retired = Effect.runPromise(
        retirement === "expiry" ? copies.expire() : copies.revoke(),
      );
      await setImmediate();
      expect(f.effects.purges).toBe(0);
      resume.resolve(undefined);
      expect(await execution).toMatchObject({ code: "revoked" });
      await retired;
      expect(f.effects.purges).toBe(1);
      expect(await Effect.runPromise(copies.inspect(f.authority))).toBeNull();
    } finally {
      resume.resolve(undefined);
      f.close();
    }
  },
);

it("expires the copy after owner reopen without renewing it on an exact open retry", async () => {
  const f = fixture();
  try {
    await Effect.runPromise(f.copies().open(f.authority, "request-one"));
    f.advance(300_000);
    const reopened = f.copies();
    expect(await Effect.runPromise(reopened.inspect(f.authority))).toBeNull();
    expect(
      await Effect.runPromise(
        Effect.flip(reopened.open(f.authority, "request-one")),
      ),
    ).toMatchObject({ code: "expired" });
    expect(f.effects.clones).toBe(1);
    expect(f.effects.purges).toBe(1);
  } finally {
    f.close();
  }
});

it("retires an existing copy when its source Instance is no longer available", async () => {
  const f = fixture();
  try {
    await Effect.runPromise(f.copies().open(f.authority, "request-one"));
    f.source(null);
    expect(await Effect.runPromise(f.copies().inspect(f.authority))).toBeNull();
    expect(f.effects.purges).toBe(1);
    expect(
      await Effect.runPromise(
        Effect.flip(f.copies().open(f.authority, "request-two")),
      ),
    ).toMatchObject({ code: "instance_inactive" });
    expect(f.effects.clones).toBe(1);
  } finally {
    f.close();
  }
});

it("discards only the named copy, never a later copy reached by a delayed close", async () => {
  const f = fixture();
  try {
    const copies = f.copies();
    const first = await Effect.runPromise(
      copies.open(f.authority, "request-one"),
    );
    expect(
      await Effect.runPromise(copies.discard(f.authority, first.copyId)),
    ).toBe(true);
    expect(await Effect.runPromise(copies.inspect(f.authority))).toBeNull();
    const next = await Effect.runPromise(
      copies.open(f.authority, "request-two"),
    );
    expect(
      await Effect.runPromise(copies.discard(f.authority, first.copyId)),
    ).toBe(false);
    expect(await Effect.runPromise(copies.inspect(f.authority))).toEqual(next);
    expect(f.effects.clones).toBe(2);
    expect(f.effects.purges).toBe(1);
  } finally {
    f.close();
  }
});

it("rearms a shared early alarm and cleans the expired copy after owner reopen without source I/O", async () => {
  const f = fixture();
  try {
    const copies = f.copies();
    await Effect.runPromise(copies.open(f.authority, "request-one"));
    const reads = f.sourceReads();
    await Effect.runPromise(copies.expire());
    expect(f.effects.wakes).toEqual([310_000, 310_000]);
    expect(f.effects.purges).toBe(0);
    f.advance(300_000);
    await Effect.runPromise(f.copies().expire());
    expect(f.effects.purges).toBe(1);
    expect(f.sourceReads()).toBe(reads);
    expect(await Effect.runPromise(copies.inspect(f.authority))).toBeNull();
  } finally {
    f.close();
  }
});

it("discards without depending on another scheduler write after the expiry wake was retained", async () => {
  const f = fixture();
  try {
    const copies = f.copies();
    const first = await Effect.runPromise(
      copies.open(f.authority, "request-one"),
    );
    f.scheduler(false);
    expect(
      await Effect.runPromise(copies.discard(f.authority, first.copyId)),
    ).toBe(true);
    expect(f.effects.purges).toBe(1);
    expect(await Effect.runPromise(copies.inspect(f.authority))).toBeNull();
  } finally {
    f.close();
  }
});

it("keeps delayed discard harmless when an old open request outlives its retained receipt", async () => {
  const f = fixture();
  try {
    const copies = f.copies();
    const first = await Effect.runPromise(
      copies.open(f.authority, "request-one"),
    );
    await Effect.runPromise(copies.discard(f.authority, first.copyId));
    const second = await Effect.runPromise(
      copies.open(f.authority, "request-two"),
    );
    await Effect.runPromise(copies.discard(f.authority, second.copyId));
    const replay = await Effect.runPromise(
      copies.open(f.authority, "request-one"),
    );
    expect(replay.copyId).not.toBe(first.copyId);
    expect(
      await Effect.runPromise(copies.discard(f.authority, first.copyId)),
    ).toBe(false);
    expect(await Effect.runPromise(copies.inspect(f.authority))).toEqual(
      replay,
    );
    expect(f.effects.purges).toBe(2);
  } finally {
    f.close();
  }
});

it("cleans an unpublished copy after its SQLite owner reopens from a write failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oyster-copy-"));
  const f = fixture(join(directory, "supervisor.sqlite"));
  try {
    f.loseStoreAfterClone();
    await expect(
      Effect.runPromise(f.copies().open(f.authority, "request-one")),
    ).rejects.toThrow();
    expect(f.effects.clones).toBe(1);
    expect(f.effects.purges).toBe(0);
    expect(f.effects.wakes).toEqual([310_000]);
    const reads = f.sourceReads();
    f.reopen();
    f.source(null);
    const reopened = f.copies();
    await Effect.runPromise(reopened.expire());
    expect(f.effects.purges).toBe(1);
    expect(f.sourceReads()).toBe(reads);
    expect(await Effect.runPromise(reopened.inspect(f.authority))).toBeNull();
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("finishes interrupted discard after its SQLite owner reopens without source I/O", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oyster-copy-"));
  const f = fixture(join(directory, "supervisor.sqlite"));
  try {
    const copies = f.copies();
    const opened = await Effect.runPromise(
      copies.open(f.authority, "request-one"),
    );
    f.purge(false);
    await expect(
      Effect.runPromise(copies.discard(f.authority, opened.copyId)),
    ).rejects.toThrow("Native purge unavailable");
    expect(f.effects.purges).toBe(0);
    const reads = f.sourceReads();
    f.reopen();
    f.purge(true);
    f.source(null);
    const reopened = f.copies();
    await Effect.runPromise(reopened.expire());
    expect(f.effects.purges).toBe(1);
    expect(f.sourceReads()).toBe(reads);
    expect(await Effect.runPromise(reopened.inspect(f.authority))).toBeNull();
    expect(
      await Effect.runPromise(reopened.discard(f.authority, opened.copyId)),
    ).toBe(false);
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
