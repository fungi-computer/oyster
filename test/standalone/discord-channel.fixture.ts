import { DatabaseSync } from "node:sqlite";
import type { StoredCredential } from "@fungi.computer/veil/credential-store";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";

import { Hex } from "effect/encoding";
import * as Schema from "effect/Schema";
import { fauxModelSource } from "@fungi.computer/shiitake/testing";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import { FungiMessageMetaSchema } from "@fungi.computer/agar/agents";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { vi } from "vitest";

import {
  standaloneDiscordApp,
  type DiscordDirectoryDoor,
} from "../../src/standalone/discord-channels.js";
import {
  AgentDirectory,
  StandaloneAgentBase,
} from "../../src/standalone/agents.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";

export const origin = "https://oyster.test";
export const owner = {
  actor: { kind: "member", memberId: "owner" },
  role: "owner",
} as const;
export const stranger = {
  actor: { kind: "member", memberId: "guest" },
  role: "member",
} as const;

/** A well-formed, fake bot token: three base64url segments, no real secret. */
export const botToken = [
  "fixtureAppBotIdentity",
  "AbCdEf",
  "fixtureBotTokenSecretPartNotReal0123456789",
].join(".");
export const otherBotToken = [
  "fixtureSecondBotIdentity",
  "GhIjKl",
  "fixtureReplacementTokenSecretNotReal0123456789",
].join(".");
export const applicationId = "1234567890123456789";
export const guildId = "2345678901234567890";
export const channelId = "3456789012345678901";
export const credentialKey = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

/** The production directory over a real SQL store and an in-memory KV. */
export function discordDirectoryFixture(
  options: Readonly<{ credentialKey?: string }> = { credentialKey },
) {
  const db = new DatabaseSync(":memory:");
  const kv = new Map<string, StoredCredential>();
  const env = agentEnv();
  Object.defineProperty(env, "OYSTER_ORIGIN", { value: origin });
  Object.defineProperty(env, "OYSTER_OWNER_NAME", { value: "owner" });
  if (options.credentialKey !== undefined)
    Object.defineProperty(env, "OYSTER_CREDENTIAL_KEY", {
      value: options.credentialKey,
    });
  const state = agentDurableObjectState(() => 0);
  Object.defineProperty(state, "storage", {
    value: {
      ...state.storage,
      ...cloudflareStorageFixture(fromNodeSqlite(db)),
      get: (key: string) => Promise.resolve(kv.get(key)),
      put: (key: string, value: StoredCredential) => {
        kv.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => Promise.resolve(kv.delete(key)),
      list: ({ prefix }: { prefix: string }) =>
        Promise.resolve(
          new Map([...kv].filter(([key]) => key.startsWith(prefix))),
        ),
    },
  });
  const directory = new AgentDirectory(state, env);
  const agent = directory.create("Fern", "request-fern", owner, "owner-direct");
  return {
    directory,
    agent,
    kv,
    env,
    /** Every byte the directory persisted, for secret-leak checks. */
    everything: () =>
      JSON.stringify([
        ...kv,
        db.prepare("SELECT * FROM oyster_discord_bindings").all(),
      ]),
    close: () => {
      db.close();
    },
  };
}

const defaultReplies: readonly string[] = [
  "The fern is fine",
  "Water it weekly",
];
let discordReplies: readonly string[] = defaultReplies;
let release: () => void = () => undefined;
let held: Promise<void> = Promise.resolve();
/** A scripted reply that keeps the run going until the test lets it finish. */
export const heldRun = "HOLD";
/** The same, finishing with an answer too long for one Discord message. */
export const heldLongRun = "HOLD_LONG";
/** A scripted reply that makes the run fail the way the host words it. */
export const failedRun = (code: string) => `FAIL:${code}`;

/** The production Agent over a real store; only the model is a fixture. */
export class DiscordFixtureAgent extends StandaloneAgentBase {
  /** The reply follows how many times the member has spoken. */
  private readonly scripted = fauxModelSource([
    (context) => {
      const reply =
        discordReplies[
          Math.max(
            0,
            context.messages.filter(({ role }) => role === "user").length - 1,
          )
        ] ?? "Done";
      if (reply === "HOLD")
        return held.then(() => fauxAssistantMessage("Done at last"));
      if (reply === "HOLD_LONG")
        return held.then(() =>
          fauxAssistantMessage(
            Array.from(
              { length: 80 },
              (_, line) => `Late line ${String(line + 1)} about ferns.`,
            ).join("\n\n"),
          ),
        );
      return reply.startsWith("FAIL:")
        ? {
            ...fauxAssistantMessage(""),
            stopReason: "error",
            errorMessage: `Model request failed (${reply.slice(5)}). Retry the request.`,
          }
        : fauxAssistantMessage(reply);
    },
  ]);
  protected hostFor(): never {
    return unavailable();
  }
  /** A pass waits briefly on a run, so a test holding one open is not slowed. */
  protected override discordSettlementWaitMs(): number {
    return 300;
  }
  protected override shiitakeOptions(): Promise<CloudflareShiitakeOptions> {
    return Promise.resolve({
      extensions: { roster: [], grants: [] },
      model: this.scripted,
      meta: { schema: FungiMessageMetaSchema },
      instructions: this.channelInstructions({
        load: () =>
          Promise.resolve({ revision: "owner", text: "OWNER SECRET BRIEF" }),
      }),
      tools: [],
      hostWork: [this.discordReplyWork()],
    });
  }
  close() {
    return this.closeShiitake();
  }
}

/** The production Agent's real option composition, unchanged. */
export class DiscordOptionsAgent extends StandaloneAgentBase {
  protected hostFor(): never {
    return unavailable();
  }
  options() {
    return super.shiitakeOptions();
  }
  ensureConversations() {
    this.channelConversations().ensure();
  }
  close() {
    return this.closeShiitake();
  }
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const encode = (text: string) => new TextEncoder().encode(text);

/** A test Ed25519 key, the way a Discord application holds one. */
async function applicationKey() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("fixture: no Ed25519 key pair");
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(exported instanceof ArrayBuffer))
    throw new Error("fixture: no raw Ed25519 public key");
  const raw = new Uint8Array(exported);
  return {
    publicKey: Hex.encode(raw),
    sign: async (timestamp: string, body: string) =>
      Hex.encode(
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            pair.privateKey,
            encode(timestamp + body),
          ),
        ),
      ),
  };
}

export type DiscordJson =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly DiscordJson[]
  | { readonly [key: string]: DiscordJson };
/** A JSON body as a test writes it before signing. */
export type DiscordPayload = Readonly<Record<string, DiscordJson>>;

/** One Discord request the fixture's fetch stub saw. */
export type DiscordCall = Readonly<{
  url: string;
  method: string;
  body: unknown;
}>;

/**
 * A bound Discord application over the production directory, edge and Agent.
 * Only Discord itself is stubbed: the global `fetch` records every call.
 */
export async function discordWorld(
  options: Readonly<{ replies?: readonly string[] }> = {},
) {
  discordReplies = options.replies ?? defaultReplies;
  held = new Promise((resolve) => {
    release = resolve;
  });
  const base = discordDirectoryFixture();
  const key = await applicationKey();
  const agents = new Map<string, DiscordFixtureAgent>();
  const stores = new Map<
    string,
    Readonly<{ db: DatabaseSync; state: DurableObjectState }>
  >();
  const databases: DatabaseSync[] = [];
  const tasks: Promise<unknown>[] = [];
  const env = agentEnv();
  for (const [property, value] of Object.entries({
    OYSTER_ORIGIN: origin,
    OYSTER_OWNER_NAME: "owner",
    AGENT_DIRECTORY: { getByName: () => base.directory },
    AGENTS: {
      getByName: (name: string) => {
        const existing = agents.get(name);
        if (existing !== undefined) return existing;
        let store = stores.get(name);
        if (store === undefined) {
          const db = new DatabaseSync(":memory:");
          databases.push(db);
          const state = agentDurableObjectState(() => 0);
          Object.defineProperty(state, "storage", {
            value: {
              ...state.storage,
              ...cloudflareStorageFixture(fromNodeSqlite(db)),
            },
          });
          Object.defineProperty(state, "id", {
            value: { ...state.id, name },
          });
          Object.defineProperty(state, "waitUntil", {
            value: (work: Promise<unknown>) => {
              tasks.push(work);
            },
          });
          store = { db, state };
          stores.set(name, store);
        }
        const agent = new DiscordFixtureAgent(store.state, env);
        agents.set(name, agent);
        return agent;
      },
    },
  }))
    Object.defineProperty(env, property, { value, configurable: true });
  const created = await base.directory.discordCreate(
    owner,
    {
      agentId: base.agent.agentId,
      applicationId,
      publicKey: key.publicKey,
      guildIds: [guildId],
      channelIds: [channelId],
      persona: "Talk about ferns.",
      botToken,
    },
    "request-discord",
  );
  if ("error" in created) throw new Error(`fixture: ${created.error}`);

  const discordCalls: DiscordCall[] = [];
  const bots: string[] = [];
  let status = 200;
  const statuses: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = await request.text();
      discordCalls.push({
        url: request.url,
        method: request.method,
        body: text === "" ? null : decodeJson(text),
      });
      const authorization = request.headers.get("authorization");
      if (authorization !== null) bots.push(authorization);
      return Response.json({}, { status: statuses.shift() ?? status });
    }),
  );
  const edgeTasks: Promise<unknown>[] = [];
  const executionCtx: ExecutionContext = {
    waitUntil: (work: Promise<unknown>) => {
      edgeTasks.push(work);
    },
    passThroughOnException: () => undefined,
    props: undefined,
    get exports(): Cloudflare.Exports {
      return unavailable();
    },
    get tracing(): Tracing {
      return unavailable();
    },
    abort: unavailable,
  };
  const app = standaloneDiscordApp();
  // A run the test holds open keeps its runtime pass pending; the reply lane
  // runs beside it, so waiting on that pass would wait for the test itself.
  const holding =
    options.replies?.some((reply) => reply.startsWith("HOLD")) === true;
  const done = (task: Promise<unknown>) =>
    holding
      ? Promise.race([
          task,
          new Promise<void>((resolve) => setTimeout(resolve, 400)),
        ])
      : task;
  const settle = async () => {
    while (edgeTasks.length + tasks.length > 0) {
      for (const task of edgeTasks.splice(0)) await done(task);
      for (const task of tasks.splice(0)) await done(task);
    }
  };
  const path = `/api/discord/interactions/${created.bindingId}`;
  /** POST one interaction, signed unless a signature is supplied. */
  const interact = async (
    payload: DiscordPayload,
    options: Readonly<{
      signWith?: Awaited<ReturnType<typeof applicationKey>>;
      timestamp?: string;
      headers?: Readonly<Record<string, string>>;
      bindingPath?: string;
    }> = {},
  ) => {
    const body = JSON.stringify(payload);
    const timestamp =
      options.timestamp ?? String(Math.floor(Date.now() / 1_000));
    const signer = options.signWith ?? key;
    const headers = new Headers(
      options.headers ?? {
        "x-signature-ed25519": await signer.sign(timestamp, body),
        "x-signature-timestamp": timestamp,
      },
    );
    return app.request(
      `${origin}${options.bindingPath ?? path}`,
      { method: "POST", headers, body },
      env,
      executionCtx,
    );
  };
  return {
    ...base,
    binding: created,
    key,
    otherKey: applicationKey,
    env,
    interact,
    settle,
    discordCalls,
    /** The Authorization headers Discord saw. */
    bots,
    /** From now on Discord rejects every call. */
    /** The held run finishes now. */
    finishRun: () => {
      release();
    },
    refuseDiscord: () => {
      status = 403;
    },
    /** Discord answers the next calls with these statuses, then as before. */
    answerNext: (...next: number[]) => {
      statuses.push(...next);
    },
    /** What the Agent still owes, straight from its store. */
    owed: () =>
      [...stores.values()].flatMap(({ db }) =>
        db
          .prepare(
            "SELECT interaction_id, state, attempts, token, text FROM oyster_discord_replies",
          )
          .all(),
      ),
    /** The Agent is evicted: a fresh instance wakes over the same store. */
    restartAgent: async (): Promise<DiscordFixtureAgent> => {
      const name = created.agentId;
      await agents.get(name)?.close();
      agents.delete(name);
      env.AGENTS.getByName(name);
      const reopened = agents.get(name);
      if (reopened === undefined) throw new Error("The Agent never reopened");
      return reopened;
    },
    agentFor: (): DiscordFixtureAgent => {
      env.AGENTS.getByName(created.agentId);
      const agent = agents.get(created.agentId);
      if (agent === undefined) throw new Error("The Agent never opened");
      return agent;
    },
    /** The directory as the owner's controls reach it: every call is a promise. */
    door: (): DiscordDirectoryDoor => ({
      list: () => Promise.resolve(base.directory.list()),
      discordList: (
        principal: Parameters<typeof base.directory.discordList>[0],
      ) => Promise.resolve(base.directory.discordList(principal)),
      discordCreate: base.directory.discordCreate.bind(base.directory),
      discordUpdate: base.directory.discordUpdate.bind(base.directory),
      discordRegisterCommands: base.directory.discordRegisterCommands.bind(
        base.directory,
      ),
    }),
    close: async () => {
      for (const agent of agents.values()) await agent.close();
      for (const db of databases) db.close();
      base.close();
    },
  };
}

/** A Discord interaction as Discord sends it, with only the fields we read. */
export function interaction(
  fields: Readonly<{
    id: string;
    type: 1 | 2 | 3 | 5;
    data?: DiscordJson;
    userId?: string;
    /** What Discord says the member goes by; Ava's display name by default. */
    names?: Readonly<{
      nick?: string;
      global?: string | null;
      username?: string;
    }>;
    guild?: string | null;
    channel?: string;
    application?: string;
  }>,
) {
  const user = {
    id: fields.userId ?? "4567890123456789012",
    global_name:
      fields.names === undefined ? "Ava" : (fields.names.global ?? null),
    username: fields.names?.username ?? "ava",
  };
  const nick = fields.names?.nick;
  const base = {
    id: fields.id,
    application_id: fields.application ?? applicationId,
    type: fields.type,
    token: `token-${fields.id}`,
    version: 1,
    channel_id: fields.channel ?? channelId,
    member: nick === undefined ? { user } : { nick, user },
    data: fields.data,
  };
  return fields.guild === null
    ? base
    : { ...base, guild_id: fields.guild ?? guildId };
}
