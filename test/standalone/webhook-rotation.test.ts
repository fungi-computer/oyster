import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { encode as encodeBase64 } from "effect/encoding/Base64";
import { encode as encodeBase64Url } from "effect/encoding/Base64Url";
import { afterEach, expect, it, vi } from "vitest";
import { eventDelivery } from "./event-delivery.fixture.js";

const keyring = {
  OYSTER_CREDENTIAL_KEY: encodeBase64Url(new Uint8Array(32).fill(7)),
  OYSTER_CREDENTIAL_KEY_ID: "oyster-1",
};
const HOUR = 60 * 60 * 1000;
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
  const directory = await mkdtemp(join(root, "webhook-rotation-"));
  scratch.push(directory);
  return new DatabaseSync(join(directory, "store.sqlite"));
}

type Sent = Readonly<{ headers: Headers; body: string }>;

/** A receiver that answers `status` and keeps each delivery's headers and body. */
function receiver(status = 204) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push({
      headers: new Headers(init.headers),
      body: await new Response(init.body).text(),
    });
    return new Response(null, { status });
  });
  return sent;
}

/**
 * The Standard Webhooks receiver check, written from the specification
 * (standardwebhooks.com), not from Oyster's signer: HMAC-SHA256 keyed by the
 * base64 bytes after `whsec_`, over `id.timestamp.body`, against any of the
 * space-separated `v1,` signatures.
 */
function verifies(secret: string, delivery: Sent): boolean {
  const id = delivery.headers.get("webhook-id") ?? "";
  const timestamp = delivery.headers.get("webhook-timestamp") ?? "";
  const key = Uint8Array.from(atob(secret.slice("whsec_".length)), (char) =>
    char.charCodeAt(0),
  );
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${delivery.body}`)
    .digest("base64");
  return (delivery.headers.get("webhook-signature") ?? "")
    .split(" ")
    .includes(`v1,${expected}`);
}

/** The stored rotated-out secret columns of one subscription. */
function previousSecret(database: DatabaseSync, id: string) {
  return database
    .prepare(
      "SELECT previous_sealed_secret, previous_expires_at FROM oyster_subscriptions WHERE id = ?",
    )
    .get(id);
}

async function subscribed(database: DatabaseSync) {
  const created = await eventDelivery(database, keyring).subscribe({
    installationId: "notes",
    url: "https://receiver.test/hook",
    types: [],
  });
  if ("error" in created) throw new Error("The keyring did not seal");
  return created;
}

/** A pre-002 subscription, exactly as the older SQLite owner stored it. */
function plaintextSubscription(database: DatabaseSync): string {
  const old = `whsec_${encodeBase64(new Uint8Array(24).fill(3))}`;
  database.exec(`CREATE TABLE oyster_subscriptions (
    id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, url TEXT NOT NULL,
    secret TEXT NOT NULL, types TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT`);
  database
    .prepare("INSERT INTO oyster_subscriptions VALUES (?, ?, ?, ?, ?, ?)")
    .run("whsub_legacy", "notes", "https://receiver.test/hook", old, "[]", 0);
  return old;
}

it("a rotated secret signs beside the old one for 24 hours, then alone", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const database = await store();
  try {
    const { subscription, secret: old } = await subscribed(database);
    const webhooks = eventDelivery(database, keyring);
    const rotated = await webhooks.rotateSecret(subscription.id);
    if (rotated === null || "error" in rotated)
      throw new Error("The secret did not rotate");
    expect(rotated.secret).toMatch(/^whsec_/u);
    expect(rotated.secret).not.toBe(old);

    const restarted = eventDelivery(database, keyring);
    const sent = receiver();
    await restarted.enqueue(source, event, "event-1", []);
    await restarted.alarm();
    vi.setSystemTime(Date.now() + 24 * HOUR);
    await restarted.enqueue(source, event, "event-2", []);
    await restarted.alarm();

    const [inside, after] = sent;
    if (inside === undefined || after === undefined)
      throw new Error("Both deliveries should have been sent");
    expect(inside.headers.get("webhook-signature")?.split(" ")).toHaveLength(2);
    expect(verifies(rotated.secret, inside)).toBe(true);
    expect(verifies(old, inside)).toBe(true);
    expect(after.headers.get("webhook-signature")?.split(" ")).toHaveLength(1);
    expect(verifies(rotated.secret, after)).toBe(true);
    expect(verifies(old, after)).toBe(false);
    // Signing after the overlap forgot the old secret; no timer did it.
    expect(previousSecret(database, subscription.id)).toEqual({
      previous_sealed_secret: null,
      previous_expires_at: null,
    });
  } finally {
    database.close();
  }
});

it("concurrent rotations return one new secret and one conflict", async () => {
  const database = await store();
  try {
    const { subscription } = await subscribed(database);
    const webhooks = eventDelivery(database, keyring);
    const results = await Promise.all([
      webhooks.rotateSecret(subscription.id),
      webhooks.rotateSecret(subscription.id),
    ]);
    const outcomes = results.map((result) =>
      result === null
        ? "missing"
        : "error" in result
          ? result.error
          : "rotated",
    );
    expect(outcomes.sort()).toEqual(["conflict", "rotated"]);
  } finally {
    database.close();
  }
});

it("a second rotation retires the first secret at once; an unknown subscription rotates nothing", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const database = await store();
  try {
    const { subscription, secret: first } = await subscribed(database);
    const webhooks = eventDelivery(database, keyring);
    const second = await webhooks.rotateSecret(subscription.id);
    const third = await webhooks.rotateSecret(subscription.id);
    if (
      second === null ||
      "error" in second ||
      third === null ||
      "error" in third
    )
      throw new Error("The secret did not rotate");
    const sent = receiver();
    await webhooks.enqueue(source, event, "event-1", []);
    await webhooks.alarm();
    const [delivery] = sent;
    if (delivery === undefined) throw new Error("No delivery was sent");
    expect(verifies(third.secret, delivery)).toBe(true);
    expect(verifies(second.secret, delivery)).toBe(true);
    expect(verifies(first, delivery)).toBe(false);
    expect(await webhooks.rotateSecret("whsub_missing")).toBeNull();
  } finally {
    database.close();
  }
});

it("a rotation after the overlap forgets the expired secret even when refused", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const database = await store();
  try {
    const { subscription } = await subscribed(database);
    await eventDelivery(database, keyring).rotateSecret(subscription.id);
    expect(previousSecret(database, subscription.id)).toMatchObject({
      previous_expires_at: Date.now() + 24 * HOUR,
    });
    vi.setSystemTime(Date.now() + 24 * HOUR);
    expect(
      await eventDelivery(database, {}).rotateSecret(subscription.id),
    ).toEqual({ error: "unavailable" });
    expect(previousSecret(database, subscription.id)).toEqual({
      previous_sealed_secret: null,
      previous_expires_at: null,
    });
  } finally {
    database.close();
  }
});

it("without a keyring a rotation is refused and the old secret keeps signing", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const database = await store();
  try {
    const { subscription, secret } = await subscribed(database);
    expect(
      await eventDelivery(database, {}).rotateSecret(subscription.id),
    ).toEqual({ error: "unavailable" });
    const sent = receiver();
    const webhooks = eventDelivery(database, keyring);
    await webhooks.enqueue(source, event, "event-1", []);
    await webhooks.alarm();
    const [delivery] = sent;
    if (delivery === undefined) throw new Error("No delivery was sent");
    expect(verifies(secret, delivery)).toBe(true);
  } finally {
    database.close();
  }
});

it("a failed delivery is redelivered from its first attempt; others are not", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const database = await store();
  try {
    const { subscription } = await subscribed(database);
    const webhooks = eventDelivery(database, keyring);
    receiver(500);
    await webhooks.enqueue(source, event, "event-1", []);
    for (let hour = 0; hour < 72; hour += 1) {
      vi.setSystemTime(Date.now() + HOUR);
      await webhooks.alarm();
    }
    const [failed] = webhooks.deliveries(subscription.id);
    expect(failed).toMatchObject({ state: "failed", attempts: 6 });
    if (failed === undefined) throw new Error("No delivery was recorded");

    const sent = receiver(204);
    expect(
      await Promise.all([
        webhooks.redeliver(failed.id),
        webhooks.redeliver(failed.id),
      ]),
    ).toEqual([true, false]);
    expect(await webhooks.redeliver(failed.id)).toBe(false);
    expect(webhooks.deliveries(subscription.id)).toMatchObject([
      { state: "pending", attempts: 0, lastStatus: null },
    ]);
    await webhooks.alarm();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get("webhook-id")).toBe(failed.id);
    expect(webhooks.deliveries(subscription.id)).toMatchObject([
      { state: "delivered", attempts: 1, lastStatus: 204 },
    ]);
    expect(await webhooks.redeliver(failed.id)).toBe(false);
    expect(await webhooks.redeliver("whsub_missing.event-1")).toBe(false);
  } finally {
    database.close();
  }
});

it("an older store's subscriptions gain the rotation columns and keep their secret", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const database = await store();
  try {
    const { subscription, secret } = await subscribed(database);
    const original = eventDelivery(database, keyring);
    await original.enqueue(source, event, "before-upgrade", []);
    const retainedDeliveries = original.deliveries(subscription.id);
    // Rebuild the table as an Oyster before rotation stored it.
    database.exec(`
      ALTER TABLE oyster_subscriptions RENAME TO rotation_seed;
      CREATE TABLE oyster_subscriptions (
        id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, url TEXT NOT NULL, sealed_secret TEXT NOT NULL,
        types TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      INSERT INTO oyster_subscriptions
        SELECT id, installation_id, url, sealed_secret, types, created_at FROM rotation_seed;
      DROP TABLE rotation_seed;
    `);
    const webhooks = eventDelivery(database, keyring);
    expect(webhooks.deliveries(subscription.id)).toEqual(retainedDeliveries);
    expect(eventDelivery(database, keyring).subscriptions()).toEqual([
      subscription,
    ]);
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('oyster_subscriptions')")
        .all()
        .map((row) => row.name),
    ).toEqual(
      expect.arrayContaining(["previous_sealed_secret", "previous_expires_at"]),
    );
    expect(webhooks.subscriptions()).toEqual([subscription]);
    const sent = receiver();
    await webhooks.alarm();
    const [delivery] = sent;
    if (delivery === undefined) throw new Error("No delivery was sent");
    expect(delivery.headers.get("webhook-id")).toBe(retainedDeliveries[0]?.id);
    expect(delivery.headers.get("webhook-signature")?.split(" ")).toHaveLength(
      1,
    );
    expect(verifies(secret, delivery)).toBe(true);
  } finally {
    database.close();
  }
});

it("rotation migrates a plaintext subscription before its first alarm", async () => {
  const database = await store();
  try {
    const old = plaintextSubscription(database);
    const webhooks = eventDelivery(database, keyring);
    const rotated = await webhooks.rotateSecret("whsub_legacy");
    if (rotated === null || "error" in rotated)
      throw new Error("Legacy subscription did not rotate");
    const sent = receiver();
    await webhooks.enqueue(source, event, "after-upgrade", []);
    await webhooks.alarm();
    const [delivery] = sent;
    if (delivery === undefined) throw new Error("No delivery was sent");
    expect(verifies(old, delivery)).toBe(true);
    expect(verifies(rotated.secret, delivery)).toBe(true);
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('oyster_subscriptions')")
        .all()
        .map((row) => row.name),
    ).not.toContain("secret");
  } finally {
    database.close();
  }
});

it("removing a subscription while its legacy secret seals cannot restore it", async () => {
  const database = await store();
  try {
    plaintextSubscription(database);
    const webhooks = eventDelivery(database, keyring);
    const rotating = webhooks.rotateSecret("whsub_legacy");
    expect(webhooks.unsubscribe("whsub_legacy")).toBe(true);
    const result = await rotating;
    expect(webhooks.subscriptions()).toEqual([]);
    expect(result !== null && "error" in result ? result.error : null).toBe(
      "unavailable",
    );
    expect(await webhooks.rotateSecret("whsub_legacy")).toBeNull();
  } finally {
    database.close();
  }
});
