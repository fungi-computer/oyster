import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discordPlaceAllowed,
  type DiscordSelector,
} from "../../src/channels/discord-binding.js";
import { agentDurableObjectState } from "./agent-do-state.fixture.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";
import {
  applicationId,
  botToken,
  channelId,
  discordWorld,
  DiscordOptionsAgent,
  guildId,
  interaction,
  owner,
  stranger,
} from "./discord-channel.fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function world() {
  const w = await discordWorld();
  cleanups.push(w.close);
  return w;
}
const ask = (id: string, question: string, userId?: string) =>
  interaction({
    id,
    type: 2,
    userId,
    data: { name: "ask", options: [{ name: "question", value: question }] },
  });

describe("the Discord interactions door", () => {
  it("answers Discord's endpoint check with a PONG", async () => {
    const w = await world();
    const response = await w.interact({
      id: "1234567890123456780",
      application_id: applicationId,
      type: 1,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("refuses an unsigned, wrongly signed, stale or malformed request with 401 and runs nothing", async () => {
    const w = await world();
    const question = ask("1234567890123456781", "hello?");
    const stranger = await w.otherKey();
    const old = String(Math.floor(Date.now() / 1_000) - 3_600);
    const refusals = await Promise.all([
      w.interact(question, { signWith: stranger }),
      w.interact(question, { headers: {} }),
      w.interact(question, { timestamp: old }),
      w.interact(question, {
        headers: {
          "x-signature-ed25519": "not-hex",
          "x-signature-timestamp": "1",
        },
      }),
    ]);
    expect(refusals.map((response) => response.status)).toEqual([
      401, 401, 401, 401,
    ]);
    await w.settle();
    expect(w.discordCalls).toEqual([]);
    expect(
      await w.agentFor().websiteConversations(w.binding.bindingId),
    ).toEqual([]);
  });

  it("refuses an unknown binding, a wrong application and an undecodable body", async () => {
    const w = await world();
    expect(
      (
        await w.interact(ask("1234567890123456782", "hi"), {
          bindingPath: "/api/discord/interactions/chb_nothing",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await w.interact(
          interaction({
            id: "1234567890123456783",
            type: 2,
            application: "9999999999999999999",
            data: { name: "ask" },
          }),
        )
      ).status,
    ).toBe(400);
    expect((await w.interact({ type: 4 })).status).toBe(400);
  });

  it("defers /ask, runs the bound Agent and fills the original message", async () => {
    const w = await world();
    const response = await w.interact(
      ask("1234567890123456784", "Is my fern fine?"),
    );
    expect(await response.json()).toEqual({ type: 5 });
    await w.settle();
    expect(w.discordCalls).toHaveLength(1);
    const [call] = w.discordCalls;
    expect(call?.method).toBe("PATCH");
    expect(call?.url).toBe(
      `https://discord.com/api/v10/webhooks/${applicationId}/token-1234567890123456784/messages/@original`,
    );
    expect(call?.body).toMatchObject({
      content: "The fern is fine",
      allowed_mentions: { parse: [] },
      components: [
        { components: [{ label: "Reply", custom_id: "reply", type: 2 }] },
      ],
    });
    const agent = w.agentFor();
    const [conversation] = await agent.websiteConversations(
      w.binding.bindingId,
    );
    expect(conversation?.party).toEqual({
      kind: "discord-user",
      guildId,
      userId: "4567890123456789012",
    });
    const transcript = await agent.websiteTranscript(
      w.binding.bindingId,
      conversation?.sessionId ?? "",
    );
    expect(transcript?.lines.map(({ text }) => text)).toEqual([
      "Is my fern fine?",
      "The fern is fine",
    ]);
    // No Discord credential reached Discord on the follow-up: the interaction
    // token is the credential.
    expect(JSON.stringify(w.discordCalls)).not.toContain("Bot ");
  });

  it("opens a modal from the Reply button and continues the same conversation", async () => {
    const w = await world();
    await w.interact(ask("1234567890123456785", "Is my fern fine?"));
    await w.settle();
    const button = await w.interact(
      interaction({
        id: "1234567890123456786",
        type: 3,
        data: { custom_id: "reply" },
      }),
    );
    expect(await button.json()).toMatchObject({
      type: 9,
      data: { custom_id: "reply" },
    });
    const submitted = await w.interact(
      interaction({
        id: "1234567890123456787",
        type: 5,
        data: {
          custom_id: "reply",
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "text", value: "How often?" }],
            },
          ],
        },
      }),
    );
    expect(await submitted.json()).toEqual({ type: 5 });
    await w.settle();
    expect(w.discordCalls).toHaveLength(2);
    expect(w.discordCalls[1]?.body).toMatchObject({
      content: "> How often?\n\nWater it weekly",
    });
    const agent = w.agentFor();
    const conversations = await agent.websiteConversations(w.binding.bindingId);
    expect(conversations).toHaveLength(1);
    const transcript = await agent.websiteTranscript(
      w.binding.bindingId,
      conversations[0]?.sessionId ?? "",
    );
    expect(transcript?.lines.map(({ text }) => text)).toEqual([
      "Is my fern fine?",
      "The fern is fine",
      "How often?",
      "Water it weekly",
    ]);
  });

  it("keeps two members' conversations apart", async () => {
    const w = await world();
    await w.interact(
      ask("1234567890123456788", "first?", "4567890123456789012"),
    );
    await w.interact(
      ask("1234567890123456789", "second?", "5678901234567890123"),
    );
    await w.settle();
    expect(
      await w.agentFor().websiteConversations(w.binding.bindingId),
    ).toHaveLength(2);
  });

  it("answers outside the owner's guild or channel, in a direct message and while paused with a private notice", async () => {
    const w = await world();
    const notices = [
      await w.interact({
        ...ask("2234567890123456781", "hi"),
        guild_id: "9999999999999999999",
      }),
      await w.interact({
        ...ask("2234567890123456782", "hi"),
        channel_id: "9999999999999999999",
      }),
      await w.interact(
        interaction({
          id: "2234567890123456783",
          type: 2,
          guild: null,
          data: { name: "ask", options: [{ name: "question", value: "hi" }] },
        }),
      ),
    ];
    for (const notice of notices)
      expect(await notice.json()).toMatchObject({
        type: 4,
        data: { flags: 64, allowed_mentions: { parse: [] } },
      });
    const paused = await w.directory.discordUpdate(owner, w.binding.bindingId, {
      expectedVersion: w.binding.authorityVersion,
      lifecycle: "suspended",
    });
    if ("error" in paused) throw new Error(paused.error);
    const refused = await w.interact(ask("2234567890123456784", "hi"));
    expect(await refused.json()).toMatchObject({
      type: 4,
      data: { content: "This Agent is paused.", flags: 64 },
    });
    await w.settle();
    expect(w.discordCalls).toEqual([]);
    expect(
      await w.agentFor().websiteConversations(w.binding.bindingId),
    ).toEqual([]);
  });

  it("refuses a question that is empty or too long without bothering the Agent", async () => {
    const w = await world();
    for (const text of ["   ", "x".repeat(1_001)])
      expect(
        await (await w.interact(ask("3234567890123456781", text))).json(),
      ).toMatchObject({ type: 4, data: { flags: 64 } });
    await w.settle();
    expect(w.discordCalls).toEqual([]);
  });

  it("tells the member when intake refuses and when the run cannot answer", async () => {
    const w = await world();
    await w.interact(ask("4234567890123456781", "one"));
    await w.settle();
    // A replayed interaction with different text is a conflict, not a new run.
    await w.interact(ask("4234567890123456781", "other words"));
    await w.settle();
    expect(w.discordCalls.at(-1)?.body).toMatchObject({
      content: "That message could not be accepted.",
      components: [],
    });
  });
});

describe("registering /ask", () => {
  it("creates /ask in each bound guild with the sealed bot token and reports who took it", async () => {
    const w = await world();
    const done = await w.directory.discordRegisterCommands(
      owner,
      w.binding.bindingId,
    );
    expect(done).toEqual({ registered: [guildId], failed: [] });
    const [call] = w.discordCalls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(
      `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
    );
    expect(call?.body).toMatchObject({
      name: "ask",
      dm_permission: false,
      options: [{ name: "question", required: true }],
    });
    expect(w.bots).toEqual([`Bot ${botToken}`]);
    expect(JSON.stringify(done)).not.toContain(botToken);
    expect(
      await w.directory.discordRegisterCommands(stranger, w.binding.bindingId),
    ).toEqual({ error: "not_granted" });
    expect(
      await w.directory.discordRegisterCommands(owner, "chb_none"),
    ).toEqual({
      error: "not_found",
    });
  });

  it("names a guild Discord refused", async () => {
    const w = await world();
    w.refuseDiscord();
    expect(
      await w.directory.discordRegisterCommands(owner, w.binding.bindingId),
    ).toEqual({ registered: [], failed: [guildId] });
  });
});

describe("the owner's allowlist", () => {
  it("admits a guild and, when channels are listed, only those channels", () => {
    const selector: DiscordSelector = {
      provider: "discord",
      applicationId,
      publicKey: "ab".repeat(32),
      guildIds: [guildId],
      channelIds: [channelId],
    };
    expect(discordPlaceAllowed(selector, { guildId, channelId })).toBe(true);
    expect(
      discordPlaceAllowed(selector, {
        guildId,
        channelId: "9999999999999999999",
      }),
    ).toBe(false);
    expect(
      discordPlaceAllowed(
        { ...selector, channelIds: [] },
        { guildId, channelId: "9999999999999999999" },
      ),
    ).toBe(true);
    expect(
      discordPlaceAllowed(selector, {
        guildId: "9999999999999999999",
        channelId,
      }),
    ).toBe(false);
  });
});

describe("the Agent a Discord channel runs on", () => {
  it("runs a Discord Session on the bound Agent's own tools while active and blanks them once paused", async () => {
    const w = await world();
    const db = new DatabaseSync(":memory:");
    const sql = fromNodeSqlite(db);
    const state = agentDurableObjectState(() => 0);
    Object.defineProperty(state, "storage", {
      value: { ...state.storage, ...cloudflareStorageFixture(sql) },
    });
    Object.defineProperty(state, "id", {
      value: { ...state.id, name: w.binding.agentId },
    });
    const agent = new DiscordOptionsAgent(state, w.env);
    cleanups.push(async () => {
      await agent.close();
      db.close();
    });
    const options = await agent.options();
    if (options.tools === undefined || !("sources" in options.tools))
      throw new Error("The Agent has no capability sources");
    // The channel admits or refuses a run; it never changes the Agent's grants.
    expect(options.tools.access).toBeUndefined();
    agent.ensureConversations();
    sql.sql.exec(
      "INSERT INTO hub_channel_conversations (binding_id,conversation,session_id,party_json,created_at,last_event_at) VALUES (?,?,?,?,?,?)",
      w.binding.bindingId,
      "key",
      "discord-session",
      JSON.stringify({
        kind: "discord-user",
        guildId,
        userId: "4567890123456789012",
      }),
      Date.now(),
      Date.now(),
    );
    const sources = options.tools.sources ?? [];
    expect(sources.map(({ id }) => id)).toContain("agent-computers");
    const blanked = async (sessionId: string) => {
      const verdicts: boolean[] = [];
      for (const source of sources) {
        const lease = await source.acquire({
          session: { sessionId },
          signal: new AbortController().signal,
          invalidate: () => undefined,
        });
        verdicts.push(lease.snapshot.version === "channel-denied");
        await lease.release();
      }
      return verdicts;
    };
    expect(await blanked("discord-session")).not.toContain(true);
    const paused = await w.directory.discordUpdate(owner, w.binding.bindingId, {
      expectedVersion: w.binding.authorityVersion,
      lifecycle: "suspended",
    });
    if ("error" in paused) throw new Error(paused.error);
    expect(await blanked("discord-session")).not.toContain(false);
    expect(await blanked("owner-session")).not.toContain(true);
  });
});
