import * as Schema from "effect/Schema";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  appGitPushFactSchema,
  type AppGitPushFact,
} from "@fungi.computer/agar/git";
import {
  backgroundWakeSchema,
  type BackgroundWake,
} from "@fungi.computer/puffball/background-replay";
import { createGitPushJournal } from "../src/git.js";

afterEach(() => vi.useRealTimers());
const fixtureDigest = Schema.decodeUnknownSync(sha256DigestSchema)(
  `sha256:${"a".repeat(64)}`,
);

const fact: AppGitPushFact = {
  repository: "notes",
  writer: { kind: "actor", actor: { kind: "member", memberId: "member_a" } },
  eventId: "push_one",
  updates: [
    {
      ref: "refs/heads/main",
      before: "0".repeat(40),
      after: "a".repeat(40),
    },
  ],
};

it("delivers an accepted push after reopening the producer with the same event ID", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const delivered: AppGitPushFact[] = [];
    const ports = {
      owner: fromNodeSqlite(database),
      deliverSync: () =>
        Promise.reject(new Error("Unexpected background delivery")),
      deliver: (installationId: string, incoming: AppGitPushFact) => {
        expect(installationId).toBe("installation_a");
        delivered.push(incoming);
        return Promise.resolve();
      },
      scheduleWake: () => Promise.resolve(),
    };
    const producer = await createGitPushJournal(ports);
    expect(await producer.accept("installation_a", fact)).toBe("recorded");
    expect(delivered).toEqual([]);
    const reopened = await createGitPushJournal(ports);
    await reopened.alarm();
    expect(delivered).toEqual([fact]);
    expect(await reopened.accept("installation_a", fact)).toBe("duplicate");
    await reopened.alarm();
    expect(delivered).toEqual([fact]);
  } finally {
    database.close();
  }
});

it("rolls back the accepted fact when Carrier cannot enqueue it", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const delivered: AppGitPushFact[] = [];
    const producer = await createGitPushJournal({
      owner: fromNodeSqlite(database),
      deliverSync: () =>
        Promise.reject(new Error("Unexpected background delivery")),
      deliver: (_installationId, incoming) => {
        delivered.push(incoming);
        return Promise.resolve();
      },
      scheduleWake: () => Promise.resolve(),
    });
    database.exec(
      "CREATE TRIGGER refuse_post BEFORE INSERT ON carrier_post_rows BEGIN SELECT RAISE(ABORT,'post unavailable'); END",
    );
    await expect(producer.accept("installation_a", fact)).rejects.toThrow(
      "post unavailable",
    );
    database.exec("DROP TRIGGER refuse_post");
    expect(await producer.accept("installation_a", fact)).toBe("recorded");
    await producer.alarm();
    expect(delivered).toEqual([fact]);
  } finally {
    database.close();
  }
});

it("redelivers a lost acknowledgement after backoff with one logical receiver effect", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(100_000);
  const database = new DatabaseSync(":memory:");
  const receiver = new DatabaseSync(":memory:");
  try {
    receiver.exec(
      "CREATE TABLE applied_events (event_id TEXT PRIMARY KEY, fact TEXT NOT NULL)",
    );
    const delivered: AppGitPushFact[] = [];
    const ports = {
      owner: fromNodeSqlite(database),
      deliverSync: () =>
        Promise.reject(new Error("Unexpected background delivery")),
      deliver: (_installationId: string, incoming: AppGitPushFact) => {
        delivered.push(incoming);
        receiver
          .prepare("INSERT OR IGNORE INTO applied_events VALUES (?,?)")
          .run(incoming.eventId, JSON.stringify(incoming));
        return delivered.length === 1
          ? Promise.reject(new Error("acknowledgement lost"))
          : Promise.resolve();
      },
      scheduleWake: () => Promise.resolve(),
    };
    const producer = await createGitPushJournal(ports);
    await producer.accept("installation_a", fact);
    await producer.alarm();
    expect(delivered).toEqual([fact]);
    expect(producer.nextWake()).toBe(102_000);
    const reopened = await createGitPushJournal(ports);
    vi.setSystemTime(101_999);
    await reopened.alarm();
    expect(delivered).toEqual([fact]);
    vi.setSystemTime(102_000);
    await reopened.alarm();
    expect(delivered).toEqual([fact, fact]);
    expect(receiver.prepare("SELECT fact FROM applied_events").all()).toEqual([
      { fact: JSON.stringify(appGitPushFactSchema.parse(fact)) },
    ]);
    expect(reopened.nextWake()).toBeNull();
    await expect(
      reopened.accept("installation_a", {
        ...fact,
        repository: "different_repository",
      }),
    ).rejects.toThrow("conflicts");
    expect(delivered).toEqual([fact, fact]);
  } finally {
    receiver.close();
    database.close();
  }
});

it("recovers retries beyond a page of completed Post records", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(100_000);
  const database = new DatabaseSync(":memory:");
  try {
    const attempts = new Map<string, number>();
    const producer = await createGitPushJournal({
      owner: fromNodeSqlite(database),
      deliverSync: () =>
        Promise.reject(new Error("Unexpected background delivery")),
      deliver: (_installationId, incoming) => {
        const count = (attempts.get(incoming.eventId) ?? 0) + 1;
        attempts.set(incoming.eventId, count);
        return count === 1
          ? Promise.reject(new Error("receiver unavailable"))
          : Promise.resolve();
      },
      scheduleWake: () => Promise.resolve(),
    });
    for (let index = 0; index < 65; index += 1)
      await producer.accept(`installation_${index.toString()}`, {
        ...fact,
        eventId: `push_${index.toString()}`,
      });
    await producer.alarm();
    await producer.alarm();
    expect([...attempts.values()]).toEqual(Array(65).fill(1));
    vi.setSystemTime(102_000);
    await producer.alarm();
    await producer.alarm();
    expect([...attempts.values()]).toEqual(Array(65).fill(2));
    expect(producer.nextWake()).toBeNull();
  } finally {
    database.close();
  }
});

it("coalesces member wakes durably and re-arms after a terminal receipt with a new epoch", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const delivered: BackgroundWake[] = [];
    const scheduled: number[] = [];
    const ports = {
      owner: fromNodeSqlite(database),
      deliver: () => Promise.resolve(),
      deliverSync: (wake: BackgroundWake) => {
        delivered.push(wake);
        return Promise.resolve("accepted" as const);
      },
      scheduleWake: (at: number) => {
        scheduled.push(at);
        return Promise.resolve();
      },
    };
    const intent = {
      installationId: "installation_a",
      actor: { kind: "member" as const, memberId: "member_a" },
      lane: "member:member_a",
      originMethod: "save",
      observed: {
        authorityVersion: 1,
        artifactDigest: fixtureDigest,
      },
    };
    const producer = await createGitPushJournal(ports);
    for (let click = 0; click < 5; click += 1) await producer.armSync(intent);
    expect(delivered).toEqual([]);
    expect(scheduled.length).toBeGreaterThan(0);
    const reopened = await createGitPushJournal(ports);
    await reopened.alarm();
    expect(delivered).toEqual([
      backgroundWakeSchema.parse({ ...intent, epoch: 1 }),
    ]);
    await reopened.alarm();
    expect(delivered).toHaveLength(1);
    await reopened.armSync(intent);
    await reopened.alarm();
    expect(delivered).toEqual([
      backgroundWakeSchema.parse({ ...intent, epoch: 1 }),
      backgroundWakeSchema.parse({ ...intent, epoch: 2 }),
    ]);
  } finally {
    database.close();
  }
});

it("keeps member lanes independent and rolls back wake generations when enqueue fails", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const delivered: BackgroundWake[] = [];
    const journal = await createGitPushJournal({
      owner: fromNodeSqlite(database),
      deliver: () => Promise.reject(new Error("Unexpected Git delivery")),
      deliverSync: (wake) => {
        delivered.push(wake);
        return Promise.resolve("accepted");
      },
      scheduleWake: () => Promise.resolve(),
    });
    const intent = {
      installationId: "installation_a",
      actor: { kind: "member" as const, memberId: "member_a" },
      lane: "member:member_a",
      originMethod: "save",
      observed: {
        authorityVersion: 1,
        artifactDigest: fixtureDigest,
      },
    };
    database.exec(
      "CREATE TRIGGER refuse_sync BEFORE INSERT ON carrier_post_rows BEGIN SELECT RAISE(ABORT,'post unavailable'); END",
    );
    await expect(journal.armSync(intent)).rejects.toThrow("post unavailable");
    database.exec("DROP TRIGGER refuse_sync");
    expect(await journal.armSync(intent)).toBe(1);
    expect(
      await journal.armSync({
        ...intent,
        actor: { kind: "member", memberId: "member_b" },
        lane: "member:member_b",
      }),
    ).toBe(1);
    await journal.alarm();
    await journal.alarm();
    expect(delivered.map(({ lane, epoch }) => ({ lane, epoch }))).toEqual([
      { lane: "member:member_a", epoch: 1 },
      { lane: "member:member_b", epoch: 1 },
    ]);
  } finally {
    database.close();
  }
});

it("retains a click arriving during replay for the next bounded alarm turn", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const epochs: number[] = [];
    const armed: number[] = [];
    const intent = {
      installationId: "installation_a",
      actor: { kind: "member" as const, memberId: "member_a" },
      lane: "member:member_a",
      originMethod: "save",
      observed: {
        authorityVersion: 1,
        artifactDigest: fixtureDigest,
      },
    };
    const journal = await createGitPushJournal({
      owner: fromNodeSqlite(database),
      deliver: () => Promise.reject(new Error("Unexpected Git delivery")),
      deliverSync: async (wake) => {
        epochs.push(wake.epoch);
        if (wake.epoch === 1) armed.push(await journal.armSync(intent));
        return "accepted";
      },
      scheduleWake: () => Promise.resolve(),
    });
    await journal.armSync(intent);
    await journal.alarm();
    expect(armed).toEqual([2]);
    expect(epochs).toEqual([1]);
    expect(journal.nextWake()).not.toBeNull();
    await journal.alarm();
    expect(epochs).toEqual([1, 2]);
    expect(journal.nextWake()).toBeNull();
  } finally {
    database.close();
  }
});

it("queues a valid long installation and member lane within Watchdog's queue bounds", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const delivered: BackgroundWake[] = [];
    const journal = await createGitPushJournal({
      owner: fromNodeSqlite(database),
      deliver: () => Promise.reject(new Error("Unexpected Git delivery")),
      deliverSync: (wake) => {
        delivered.push(wake);
        return Promise.resolve("accepted");
      },
      scheduleWake: () => Promise.resolve(),
    });
    const memberId = "m".repeat(180);
    await journal.armSync({
      installationId: "a".repeat(63),
      actor: { kind: "member", memberId },
      lane: `member:${memberId}`,
      originMethod: "save",
      observed: { authorityVersion: 1, artifactDigest: fixtureDigest },
    });
    await journal.alarm();
    expect(delivered).toHaveLength(1);
  } finally {
    database.close();
  }
});
