import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  RECIPIENT_RETRY_DELAYS_MS,
  createRecipientDeliveries,
  type HostRecipientEvent,
} from "../src/event-recipients.js";

const event: HostRecipientEvent = {
  source: { installationId: "bonsai", appId: "app_bonsai", releaseId: "rel" },
  type: "repo.created",
  eventId: "evt_1",
  payload: {
    type: "repo.created",
    timestamp: "2026-10-15T05:19:00.000Z",
    data: { repo: "reed-pond" },
  },
};

function fixture(deliver: (recipient: string) => Promise<void>) {
  const database = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(database);
  let clock = 1_000;
  const wakes: number[] = [];
  const received: [string, HostRecipientEvent][] = [];
  const deliveries = createRecipientDeliveries({
    sql: owner.sql,
    now: () => clock,
    wake: (at) => {
      wakes.push(at);
      return Promise.resolve();
    },
    deliver: (recipient, delivered) => {
      received.push([recipient, delivered]);
      return deliver(recipient);
    },
    attemptMs: 50,
  });
  return {
    deliveries,
    wakes,
    received,
    advance: (ms: number) => {
      clock += ms;
    },
    close: () => {
      database.close();
    },
  };
}

it("accepts an event without contacting any recipient", () => {
  const f = fixture(() => Promise.reject(new Error("must not run")));
  try {
    expect(f.deliveries.enqueue(event, ["library", "library"])).toBe(1);
    expect(f.deliveries.enqueue(event, ["library"])).toBe(0);
    expect(f.received).toEqual([]);
    expect(f.deliveries.deliveries("library")).toMatchObject([
      { eventId: "evt_1", state: "pending", attempts: 0, lastError: null },
    ]);
  } finally {
    f.close();
  }
});

it("records a failing recipient per row, retries it, and keeps the healthy one delivered", async () => {
  let down = true;
  const f = fixture((recipient) =>
    recipient === "broken" && down
      ? Promise.reject(new Error("Workflows instance unavailable"))
      : Promise.resolve(),
  );
  try {
    f.deliveries.enqueue(event, ["broken", "healthy"]);
    await f.deliveries.drain();
    expect(f.deliveries.deliveries("healthy")).toMatchObject([
      { state: "delivered", attempts: 1, lastError: null },
    ]);
    expect(f.deliveries.deliveries("broken")).toMatchObject([
      {
        state: "pending",
        attempts: 1,
        lastError: "Error: Workflows instance unavailable",
      },
    ]);
    expect(f.wakes).toEqual([1_000 + RECIPIENT_RETRY_DELAYS_MS[0]]);
    // Not yet due: nothing is attempted.
    await f.deliveries.drain();
    expect(f.received).toHaveLength(2);
    down = false;
    f.advance(RECIPIENT_RETRY_DELAYS_MS[0]);
    await f.deliveries.drain();
    expect(f.deliveries.deliveries("broken")).toMatchObject([
      { state: "delivered", attempts: 2, lastError: null },
    ]);
    expect(f.received.map(([recipient]) => recipient)).toEqual([
      "broken",
      "healthy",
      "broken",
    ]);
    expect(f.received[2]?.[1]).toEqual(event);
    expect(f.deliveries.nextDue()).toBeNull();
  } finally {
    f.close();
  }
});

it("bounds a hung recipient and fails it after the last retry", async () => {
  const f = fixture(() => new Promise<void>(() => undefined));
  try {
    f.deliveries.enqueue(event, ["hung"]);
    for (const delay of [...RECIPIENT_RETRY_DELAYS_MS, 0]) {
      await f.deliveries.drain();
      f.advance(delay);
    }
    expect(f.deliveries.deliveries("hung")).toMatchObject([
      {
        state: "failed",
        attempts: RECIPIENT_RETRY_DELAYS_MS.length + 1,
        lastError: "TimeoutError: Recipient delivery timed out",
      },
    ]);
    expect(f.deliveries.nextDue()).toBeNull();
  } finally {
    f.close();
  }
});
