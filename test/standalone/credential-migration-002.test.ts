import { createHmac, createSecretKey } from "node:crypto";
import { existsSync } from "node:fs";
import { encode as encodeBase64 } from "effect/encoding/Base64";
import { encode as encodeBase64Url } from "effect/encoding/Base64Url";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { armedWorkflowTriggerSchema } from "@fungi.computer/braid/runtime";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDiscordReplies,
  discordReplies002,
} from "../../src/channels/discord-replies.js";
import { credentialMigration002 } from "../../src/credential-migration-002.js";
import { StandaloneEventDelivery } from "../../src/standalone/instance.js";
import {
  instanceSecretCustody,
  instanceSecretSealer,
} from "../../src/standalone/model-key-vault.js";
import {
  workflowWebhookCustody,
  workflowWebhookKeys002,
} from "../../src/webhook-custody.js";
import {
  agentDurableObjectState,
  unavailable,
} from "./agent-do-state.fixture.js";

const DAY = 24 * 60 * 60 * 1000;
const env = {
  OYSTER_CREDENTIAL_KEY: encodeBase64Url(new Uint8Array(32).fill(7)),
  OYSTER_CREDENTIAL_KEY_ID: "oyster-1",
};
const binding = armedWorkflowTriggerSchema.parse({
  installationId: "trellis",
  workflowId: "hook",
  commit: "a".repeat(40),
  digest: `sha256:${"b".repeat(64)}`,
  triggerId: "hook",
  bindings: {},
  armedBy: "creator",
  armedVia: null,
  grantorMembershipVersion: 1,
  computerId: "computer-owner",
  installationAuthority: {
    selection: {
      instanceId: "instance-trellis",
      owner: { kind: "installation", id: "trellis" },
      appId: "app_trellis",
      releaseId: "rel_trellis",
      authorityVersion: 1,
    },
    artifactDigest: `sha256:${"c".repeat(64)}`,
  },
});
const scratch: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of scratch.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** A file-backed store, so the scan reads the bytes SQLite actually wrote. */
async function fileStore() {
  const root = fileURLToPath(
    new URL("../../../../.botanical/", import.meta.url).href,
  );
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "migration-002-"));
  scratch.push(directory);
  const path = join(directory, "store.sqlite");
  return { path, database: new DatabaseSync(path) };
}

/** Every byte SQLite left on disk for this store, one character per byte. */
async function storeBytes(path: string): Promise<string> {
  const parts = await Promise.all(
    ["", "-journal", "-wal"]
      .map((suffix) => `${path}${suffix}`)
      .filter((file) => existsSync(file))
      .map(async (file) =>
        new TextDecoder("latin1").decode(await readFile(file)),
      ),
  );
  return parts.join("");
}

function columns(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
}

const randomSecret = () =>
  encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));

function fungiSigned(secret: string, now: number) {
  const text = '{"action":"opened"}';
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", createSecretKey(secret, "base64url"))
    .update(`${timestamp}.`)
    .update(text)
    .digest("hex");
  return {
    bindingId: "binding",
    headers: new Headers({
      "x-fungi-timestamp": timestamp,
      "x-fungi-signature": `v1=${signature}`,
    }),
    body: new TextEncoder().encode(text),
  };
}

/** The webhook key table exactly as Oyster stored it before migration 002. */
function seedWebhookKeys(database: DatabaseSync, now: number) {
  const current = randomSecret();
  const previous = randomSecret();
  database.exec(`CREATE TABLE oyster_workflow_webhook_keys (
    id TEXT PRIMARY KEY, record TEXT NOT NULL
  ) STRICT`);
  database
    .prepare("INSERT INTO oyster_workflow_webhook_keys(id,record) VALUES(?,?)")
    .run(
      "binding",
      JSON.stringify({
        id: "binding",
        creator: "creator",
        binding,
        verifier: "fungi-v1",
        current: { secret: current, generation: 2 },
        previous: { secret: previous, generation: 1, expiresAt: now + DAY },
      }),
    );
  return { current, previous };
}

function webhookCustody(
  database: DatabaseSync,
  now: () => number,
  sealer: ReturnType<typeof instanceSecretSealer>,
) {
  const storage = fromNodeSqlite(database);
  return workflowWebhookCustody<string>({
    ...storage,
    now,
    owner: (principal) =>
      Promise.resolve(principal === "owner" ? "creator" : null),
    sealer,
    ready: credentialMigration002({
      store: storage,
      sealer,
      tables: [workflowWebhookKeys002],
    }),
  });
}

it("migration 002 seals a seeded plaintext webhook key store; current and previous keys still verify, its bytes hold no key, and the old shape refuses after", async () => {
  const { path, database } = await fileStore();
  let now = 1_800_000_000_000;
  const keys = seedWebhookKeys(database, now);
  const sealer = instanceSecretSealer({
    owner: fromNodeSqlite(database),
    ownerId: "library",
    env,
  });
  const custody = webhookCustody(database, () => now, sealer);
  for (const secret of [keys.current, keys.previous])
    expect(
      (await custody.verification.verify(fungiSigned(secret, now))).status,
    ).toBe("ok");
  expect(columns(database, "oyster_workflow_webhook_keys")).toEqual([
    "id",
    "record",
    "sealed",
  ]);
  expect(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE '%plaintext_002%'",
      )
      .all(),
  ).toEqual([]);
  expect(await custody.list("owner")).toEqual({
    bindings: [
      {
        bindingId: "binding",
        verifier: "fungi-v1",
        creator: "creator",
        generation: 2,
        previousExpiresAt: now + DAY,
      },
    ],
    next: null,
  });
  database.close();
  const bytes = await storeBytes(path);
  for (const secret of [keys.current, keys.previous])
    expect(bytes.includes(secret)).toBe(false);

  const reopened = new DatabaseSync(path);
  try {
    // A store restart sees the sealed rows; the previous slot still lapses on time.
    const restarted = webhookCustody(
      reopened,
      () => now,
      instanceSecretSealer({
        owner: fromNodeSqlite(reopened),
        ownerId: "library",
        env,
      }),
    );
    now += DAY;
    expect(
      (await restarted.verification.verify(fungiSigned(keys.previous, now)))
        .status,
    ).toBe("refused");
    expect(
      (await restarted.verification.verify(fungiSigned(keys.current, now)))
        .status,
    ).toBe("ok");
    // The plaintext record shape is never read again, even beside a sealed column.
    reopened
      .prepare(
        "UPDATE oyster_workflow_webhook_keys SET record=?, sealed=? WHERE id='binding'",
      )
      .run(
        JSON.stringify({
          id: "binding",
          creator: "creator",
          binding,
          verifier: "fungi-v1",
          current: { secret: keys.current, generation: 2 },
          previous: null,
        }),
        JSON.stringify({ current: keys.current, previous: null }),
      );
    expect(
      (await restarted.verification.verify(fungiSigned(keys.current, now)))
        .status,
    ).toBe("refused");
  } finally {
    reopened.close();
  }
});

it("without a keyring migration 002 leaves a plaintext webhook store closed and refuses as unavailable", async () => {
  const { database } = await fileStore();
  try {
    const now = 1_800_000_000_000;
    const keys = seedWebhookKeys(database, now);
    const custody = webhookCustody(database, () => now, undefined);
    await expect(
      custody.verification.verify(fungiSigned(keys.current, now)),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      custody.create("owner", "other", "fungi-v1", binding),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(columns(database, "oyster_workflow_webhook_keys")).toEqual([
      "id",
      "record",
    ]);
  } finally {
    database.close();
  }
});

/** Durable Object SQL over Node SQLite, with the cursor fields the owner reads. */
function durableSql(database: DatabaseSync) {
  return {
    exec(statement: string, ...bindings: SQLInputValue[]) {
      const prepared = database.prepare(statement);
      if (prepared.columns().length > 0) {
        const rows = prepared.all(...bindings);
        return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 };
      }
      if (bindings.length === 0) {
        database.exec(statement);
        return { toArray: () => [], one: unavailable, rowsWritten: 0 };
      }
      const { changes } = prepared.run(...bindings);
      return {
        toArray: () => [],
        one: unavailable,
        rowsWritten: Number(changes),
      };
    },
  };
}

function eventDelivery(
  database: DatabaseSync,
  configured: Partial<typeof env>,
) {
  const state = agentDurableObjectState(() => 0);
  let alarm: number | null = null;
  Object.defineProperty(state, "storage", {
    value: {
      sql: durableSql(database),
      transactionSync: fromNodeSqlite(database).transactionSync,
      getAlarm: () => Promise.resolve(alarm),
      setAlarm: (at: number) => {
        alarm = at;
        return Promise.resolve();
      },
    },
  });
  Object.defineProperty(state, "blockConcurrencyWhile", {
    value: (body: () => Promise<void>) => body(),
  });
  return new StandaloneEventDelivery(state, {
    ...configured,
    WORKFLOW_RUNS: { getByName: unavailable },
  });
}

it("migration 002 seals a seeded plaintext subscription; deliveries still sign with its secret and the store's bytes hold none", async () => {
  const { path, database } = await fileStore();
  const secret = `whsec_${encodeBase64(crypto.getRandomValues(new Uint8Array(24)))}`;
  database.exec(`
    CREATE TABLE oyster_subscriptions (
      id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
      types TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
    CREATE TABLE oyster_deliveries (
      id TEXT PRIMARY KEY, subscription TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL,
      last_status INTEGER, updated_at INTEGER NOT NULL) STRICT;
  `);
  database
    .prepare(
      "INSERT INTO oyster_subscriptions (id, installation_id, url, secret, types, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "whsub_seeded",
      "notes",
      "https://receiver.test/hook",
      secret,
      "[]",
      1,
    );
  const sent: { url: string; headers: Record<string, string>; body: string }[] =
    [];
  vi.stubGlobal(
    "fetch",
    (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  );
  const webhooks = eventDelivery(database, env);
  expect(
    await webhooks.enqueue(
      { installationId: "notes", appId: "app_notes", releaseId: "rel_notes" },
      { type: "git.push", timestamp: new Date(0).toISOString(), data: {} },
      "event-1",
      [],
    ),
  ).toBe(1);
  await webhooks.alarm();
  expect(sent).toHaveLength(1);
  const [delivery] = sent;
  if (delivery === undefined) throw new Error("No delivery was sent");
  expect(delivery.headers["x-hub-signature-256"]).toBe(
    `sha256=${createHmac("sha256", secret).update(delivery.body).digest("hex")}`,
  );
  expect(webhooks.deliveries("whsub_seeded")[0]?.state).toBe("delivered");
  expect(columns(database, "oyster_subscriptions")).toEqual([
    "id",
    "installation_id",
    "url",
    "sealed_secret",
    "types",
    "created_at",
  ]);
  const created = await webhooks.subscribe({
    installationId: "notes",
    url: "https://receiver.test/second",
    types: [],
  });
  if ("error" in created) throw new Error("Subscription was refused");
  database.close();
  const bytes = await storeBytes(path);
  for (const value of [secret, created.secret])
    expect(bytes.includes(value)).toBe(false);
});

it("without a keyring a new subscription refuses as unavailable", async () => {
  const { database } = await fileStore();
  try {
    const webhooks = eventDelivery(database, {});
    expect(
      await webhooks.subscribe({
        installationId: "notes",
        url: "https://receiver.test/hook",
        types: [],
      }),
    ).toEqual({ error: "unavailable" });
    expect(webhooks.subscriptions()).toEqual([]);
  } finally {
    database.close();
  }
});

it("migration 002 seals a seeded open Discord interaction token; the reply still answers with it and the store's bytes hold none", async () => {
  const { path, database } = await fileStore();
  const token = `aW50ZXJhY3Rpb246${randomSecret()}`;
  database.exec(`CREATE TABLE oyster_discord_replies (
      interaction_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      application_id TEXT NOT NULL,
      token TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      echo TEXT,
      display_name TEXT,
      delivered_parts INTEGER NOT NULL DEFAULT 0,
      still_working INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      command_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('waiting','expired','failed')),
      attempts INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      next_at INTEGER NOT NULL,
      closed_at INTEGER
    ) STRICT`);
  const now = 1_800_000_000_000;
  const insert = database.prepare(
    "INSERT INTO oyster_discord_replies (interaction_id,binding_id,application_id,token,guild_id,channel_id,user_id,text,state,attempts,created_at,expires_at,next_at,closed_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?)",
  );
  insert.run(
    "open",
    "binding",
    "app",
    token,
    "guild",
    "channel",
    "user",
    "How is the fern?",
    "waiting",
    now,
    now + 60_000,
    now,
    null,
  );
  insert.run(
    "closed",
    "binding",
    "app",
    "",
    "guild",
    "channel",
    "user",
    "",
    "expired",
    now,
    now,
    now,
    now,
  );
  const storage = fromNodeSqlite(database);
  const tokens: string[] = [];
  const replies = createDiscordReplies({
    sql: storage.sql,
    now: () => now,
    ...instanceSecretCustody({
      owner: storage,
      ownerId: "agent",
      env,
      tables: [discordReplies002],
    }),
    deliver: (reply) => {
      tokens.push(reply.ask.interactionToken);
      return Promise.resolve("waiting");
    },
    onExpired: unavailable,
  });
  await replies.work.run();
  expect(tokens).toEqual([token]);
  expect(columns(database, "oyster_discord_replies")).toContain("sealed_token");
  expect(columns(database, "oyster_discord_replies")).not.toContain("token");
  expect(replies.closed("binding")).toEqual([
    {
      interactionId: "closed",
      label: "Discord member",
      state: "expired",
      closedAt: now,
    },
  ]);
  const recorded = `aW50ZXJhY3Rpb246${randomSecret()}`;
  await replies.record("binding", {
    interactionId: "second",
    applicationId: "app",
    interactionToken: recorded,
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    text: "And the moss?",
  });
  database.close();
  const bytes = await storeBytes(path);
  for (const value of [token, recorded])
    expect(bytes.includes(value)).toBe(false);
});
