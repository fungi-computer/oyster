import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { encode as encodeBase64Url } from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vitest";
import { eventDelivery, type KeyringEnv } from "./event-delivery.fixture.js";

const keyring = {
  OYSTER_CREDENTIAL_KEY: encodeBase64Url(new Uint8Array(32).fill(7)),
  OYSTER_CREDENTIAL_KEY_ID: "oyster-1",
};
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const envelope = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    keyId: Schema.String,
    iv: Schema.String,
    ciphertext: Schema.String,
  }),
);
const missingKeyReason =
  "The webhook keyring does not hold the key this subscription's secret was sealed with, so this delivery is held until that key is restored.";
const source = {
  installationId: "notes",
  appId: "app_notes",
  releaseId: "rel_notes",
};
const event = {
  type: "git.push",
  timestamp: new Date(0).toISOString(),
  data: {},
};
/** A keyring whose only key is not the one the subscription was sealed with. */
const rotatedOut = {
  OYSTER_CREDENTIAL_KEY: encodeBase64Url(new Uint8Array(32).fill(9)),
  OYSTER_CREDENTIAL_KEY_ID: "oyster-2",
};
const scratch: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const directory of scratch.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function store() {
  const root = fileURLToPath(
    new URL("../../../../.botanical/", import.meta.url).href,
  );
  const directory = await mkdtemp(join(root, "webhook-hold-"));
  scratch.push(directory);
  return new DatabaseSync(join(directory, "store.sqlite"));
}

function receiver() {
  const sent: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    sent.push(url);
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  return sent;
}

/** Subscribe with a working keyring, then queue one event for it. */
async function subscribed(database: DatabaseSync) {
  const created = await eventDelivery(database, keyring).subscribe({
    installationId: "notes",
    url: "https://receiver.test/hook",
    types: [],
  });
  if ("error" in created) throw new Error("The keyring did not seal");
  return created.subscription.id;
}

/**
 * Queue one event, then run the alarm hourly for `hours`. Three days is far
 * longer than every retry delay adds up to, and shorter than the hold limit.
 */
async function alarmsFor(database: DatabaseSync, env: KeyringEnv, hours = 72) {
  const webhooks = eventDelivery(database, env);
  expect(await webhooks.enqueue(source, event, "event-1", [])).toBe(1);
  for (let hour = 0; hour < hours; hour += 1) {
    vi.setSystemTime(Date.now() + HOUR);
    await webhooks.alarm();
  }
  return webhooks;
}

/** Rewrite the stored signing secret's envelope. */
function editSecret(
  database: DatabaseSync,
  subscription: string,
  edit: (
    sealed: Schema.Schema.Type<typeof envelope>,
  ) => Schema.Schema.Type<typeof envelope>,
) {
  const row = Schema.decodeUnknownSync(
    Schema.Struct({ sealed_secret: Schema.String }),
  )(
    database
      .prepare("SELECT sealed_secret FROM oyster_subscriptions WHERE id = ?")
      .get(subscription),
  );
  database
    .prepare("UPDATE oyster_subscriptions SET sealed_secret = ? WHERE id = ?")
    .run(
      Schema.encodeSync(envelope)(
        edit(Schema.decodeUnknownSync(envelope)(row.sealed_secret)),
      ),
      subscription,
    );
}

for (const [fault, env, reason] of [
  [
    "no keyring",
    {},
    "No webhook keyring is configured (OYSTER_CREDENTIAL_KEY), so this delivery is held until one is.",
  ],
  [
    "a malformed keyring",
    {
      OYSTER_CREDENTIAL_KEY: "not-a-key",
      OYSTER_CREDENTIAL_KEY_ID: "oyster-1",
    },
    "The webhook keyring (OYSTER_CREDENTIAL_KEY) is malformed, so this delivery is held until it is fixed.",
  ],
  ["a keyring without the sealing key", rotatedOut, missingKeyReason],
] as const)
  it(`with ${fault} a delivery stays pending without spending a retry, then delivers once the keyring is back`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const database = await store();
    try {
      const subscription = await subscribed(database);
      const sent = receiver();
      const held = await alarmsFor(database, env);
      expect(sent).toEqual([]);
      expect(held.deliveries(subscription)).toMatchObject([
        { state: "pending", attempts: 0, lastStatus: null, heldReason: reason },
      ]);

      const restored = eventDelivery(database, keyring);
      vi.setSystemTime(Date.now() + DAY);
      await restored.alarm();
      expect(sent).toEqual(["https://receiver.test/hook"]);
      expect(restored.deliveries(subscription)).toMatchObject([
        { state: "delivered", attempts: 1, lastStatus: 204, heldReason: null },
      ]);
    } finally {
      database.close();
    }
  });

for (const [tamper, edit] of [
  [
    "a changed ciphertext",
    (sealed: Schema.Schema.Type<typeof envelope>) => ({
      ...sealed,
      ciphertext: `${sealed.ciphertext.startsWith("A") ? "B" : "A"}${sealed.ciphertext.slice(1)}`,
    }),
  ],
  [
    "an edited key id",
    (sealed: Schema.Schema.Type<typeof envelope>) => ({
      ...sealed,
      keyId: "rotated",
    }),
  ],
] as const)
  it(`a signing secret with ${tamper} spends its retries and fails instead of being held`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const database = await store();
    try {
      const subscription = await subscribed(database);
      editSecret(database, subscription, edit);
      const sent = receiver();
      const webhooks = await alarmsFor(database, keyring);
      expect(sent).toEqual([]);
      expect(webhooks.deliveries(subscription)).toMatchObject([
        { state: "failed", attempts: 6, lastStatus: null, heldReason: null },
      ]);
    } finally {
      database.close();
    }
  });

it("a delivery held for 7 days fails and says why", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const database = await store();
  try {
    const subscription = await subscribed(database);
    const sent = receiver();
    const webhooks = await alarmsFor(database, rotatedOut, 8 * 24);
    expect(sent).toEqual([]);
    expect(webhooks.deliveries(subscription)).toMatchObject([
      {
        state: "failed",
        attempts: 0,
        lastStatus: null,
        heldReason: `Held 7 days: ${missingKeyReason}`,
      },
    ]);
  } finally {
    database.close();
  }
});

it("a refusing receiver still spends retries and fails, with no held reason", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const database = await store();
  try {
    const subscription = await subscribed(database);
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(null, { status: 500 })),
    );
    const webhooks = await alarmsFor(database, keyring);
    expect(webhooks.deliveries(subscription)).toMatchObject([
      { state: "failed", attempts: 6, lastStatus: 500, heldReason: null },
    ]);
  } finally {
    database.close();
  }
});

it("an older store's deliveries table gains the held reason and keeps its rows", async () => {
  const database = await store();
  try {
    database.exec(`
      CREATE TABLE oyster_deliveries (
        id TEXT PRIMARY KEY, subscription TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL,
        last_status INTEGER, updated_at INTEGER NOT NULL) STRICT;
      INSERT INTO oyster_deliveries VALUES
        ('whsub_old.event-0', 'whsub_old', 'git.push', '{}', 'failed', 6, 0, 500, 1),
        ('whsub_old.event-1', 'whsub_old', 'git.push', '{}', 'pending', 2, 0, NULL, 2);
    `);
    const webhooks = eventDelivery(database, keyring);
    expect(webhooks.deliveries("whsub_old")).toEqual([
      {
        id: "whsub_old.event-1",
        subscription: "whsub_old",
        type: "git.push",
        state: "pending",
        attempts: 2,
        lastStatus: null,
        heldReason: null,
        updatedAt: 2,
      },
      {
        id: "whsub_old.event-0",
        subscription: "whsub_old",
        type: "git.push",
        state: "failed",
        attempts: 6,
        lastStatus: 500,
        heldReason: null,
        updatedAt: 1,
      },
    ]);
  } finally {
    database.close();
  }
});
