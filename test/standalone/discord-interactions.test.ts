import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  discordPlaceAllowed,
  type DiscordSelector,
} from "../../src/channels/discord-binding.js";
import { agentDurableObjectState } from "./agent-do-state.fixture.js";
import {
  discordFailureText,
  splitDiscordMessage,
} from "../../src/channels/discord-interactions.js";
import { standaloneDiscordControl } from "../../src/standalone/discord-channels.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";
import {
  applicationId,
  botToken,
  channelId,
  discordWorld,
  failedRun,
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
async function world(replies?: readonly string[]) {
  const w = await discordWorld({ replies });
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
      await w.agentFor().bindingConversations(w.binding.bindingId),
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
    const [conversation] = await agent.bindingConversations(
      w.binding.bindingId,
    );
    expect(conversation?.party).toEqual({
      kind: "discord-user",
      guildId,
      userId: "4567890123456789012",
      displayName: "Ava",
    });
    const transcript = await agent.bindingTranscript(
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
    const conversations = await agent.bindingConversations(w.binding.bindingId);
    expect(conversations).toHaveLength(1);
    const transcript = await agent.bindingTranscript(
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
      await w.agentFor().bindingConversations(w.binding.bindingId),
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
      await w.agentFor().bindingConversations(w.binding.bindingId),
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

describe("a reply an Agent still owes", () => {
  const later = (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  };
  afterEach(() => {
    vi.useRealTimers();
  });
  const afterOutage = async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = await world();
    w.answerNext(503);
    await w.interact(ask("5234567890123456781", "Is my fern fine?"));
    await w.settle();
    return w;
  };

  it("is paid off and forgotten, token and all, once Discord has the answer", async () => {
    const w = await world();
    await w.interact(ask("5234567890123456780", "Is my fern fine?"));
    await w.settle();
    expect(w.discordCalls).toHaveLength(1);
    expect(w.owed()).toEqual([]);
  });

  it("is kept through an outage and delivered by a restarted Agent", async () => {
    const w = await afterOutage();
    expect(w.discordCalls).toHaveLength(1);
    expect(w.owed()).toMatchObject([
      { state: "waiting", attempts: 1, text: "Is my fern fine?" },
    ]);
    // The Agent is evicted; nothing it knew in memory survives.
    const reopened = await w.restartAgent();
    later(10_000);
    await reopened.alarm();
    await w.settle();
    expect(w.discordCalls).toHaveLength(2);
    expect(w.discordCalls[1]?.body).toMatchObject({
      content: "The fern is fine",
    });
    expect(w.discordCalls[1]?.url).toBe(w.discordCalls[0]?.url);
    expect(w.owed()).toEqual([]);
    // One question was one run: the conversation holds it once.
    const [conversation] = await reopened.bindingConversations(
      w.binding.bindingId,
    );
    const transcript = await reopened.bindingTranscript(
      w.binding.bindingId,
      conversation?.sessionId ?? "",
    );
    expect(transcript?.lines.map(({ text }) => text)).toEqual([
      "Is my fern fine?",
      "The fern is fine",
    ]);
    // The recovered reply still knows what the member goes by.
    expect(conversation?.label).toBe("Ava");
  });

  it("is closed as expired, with its token and question wiped, once Discord's token has lapsed", async () => {
    const w = await afterOutage();
    const reopened = await w.restartAgent();
    later(15 * 60_000);
    await reopened.alarm();
    await w.settle();
    expect(w.discordCalls).toHaveLength(1);
    expect(w.owed()).toEqual([
      expect.objectContaining({ state: "expired", token: "", text: "" }),
    ]);
    expect(w.owed()).toMatchObject([
      { interaction_id: "5234567890123456781", state: "expired" },
    ]);
  });

  it("is closed as expired at once when Discord no longer knows the token", async () => {
    const w = await world();
    w.answerNext(404);
    await w.interact(ask("5234567890123456782", "hi"));
    await w.settle();
    expect(w.discordCalls).toHaveLength(1);
    expect(w.owed()).toEqual([
      expect.objectContaining({ state: "expired", token: "" }),
    ]);
  });

  it("is given up as failed after repeated delivery failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = await world();
    w.answerNext(500, 500, 500, 500, 500);
    await w.interact(ask("5234567890123456783", "hi"));
    await w.settle();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      later(60_000);
      await w.agentFor().alarm();
      await w.settle();
    }
    expect(w.discordCalls).toHaveLength(5);
    expect(w.owed()).toEqual([
      expect.objectContaining({ state: "failed", token: "", text: "" }),
    ]);
  });
});

describe("the owner's Discord conversations", () => {
  it("lists what members asked and reads the transcript back, for the owner only", async () => {
    const w = await world();
    await w.interact(ask("6234567890123456781", "Is my fern fine?"));
    await w.settle();
    const control = standaloneDiscordControl(w.env, w.door);
    const [conversation] = await control.conversations(
      owner,
      w.binding.bindingId,
    );
    expect(conversation).toMatchObject({
      label: "Ava",
    });
    const transcript = await control.transcript(
      owner,
      w.binding.bindingId,
      conversation?.sessionId ?? "",
    );
    expect(transcript?.lines).toEqual([
      { role: "visitor", text: "Is my fern fine?" },
      { role: "agent", text: "The fern is fine" },
    ]);
    // Anyone else, an unknown binding and another binding's Session read nothing.
    expect(await control.conversations(stranger, w.binding.bindingId)).toEqual(
      [],
    );
    expect(await control.conversations(owner, "chb_none")).toEqual([]);
    expect(
      await control.transcript(
        stranger,
        w.binding.bindingId,
        conversation?.sessionId ?? "",
      ),
    ).toBeNull();
    expect(
      await control.transcript(owner, w.binding.bindingId, "unrelated"),
    ).toBeNull();
  });
});

describe("what a member is called", () => {
  const nameOf = async (
    names: Parameters<typeof interaction>[0]["names"],
    id: string,
  ) => {
    const w = await world();
    await w.interact(
      interaction({
        id,
        type: 2,
        names,
        data: { name: "ask", options: [{ name: "question", value: "hi" }] },
      }),
    );
    await w.settle();
    const [conversation] = await w
      .agentFor()
      .bindingConversations(w.binding.bindingId);
    return conversation?.label;
  };

  it("prefers the server nickname, then the display name, then @username, never the id", async () => {
    expect(
      await nameOf(
        { nick: "Ava B", global: "Ava", username: "ava" },
        "7234567890123456781",
      ),
    ).toBe("Ava B");
    expect(
      await nameOf({ global: "Ava", username: "ava" }, "7234567890123456782"),
    ).toBe("Ava");
    expect(
      await nameOf({ global: null, username: "ava" }, "7234567890123456783"),
    ).toBe("@ava");
    expect(
      await nameOf({ global: null, username: "" }, "7234567890123456784"),
    ).toBe("Discord member");
  });

  it("follows a member who renames themselves, in the same conversation", async () => {
    const w = await world();
    const send = (id: string, global: string) =>
      w.interact(
        interaction({
          id,
          type: 2,
          names: { global },
          data: { name: "ask", options: [{ name: "question", value: "hi" }] },
        }),
      );
    await send("7234567890123456791", "Ava");
    await w.settle();
    await send("7234567890123456792", "Ava the Gardener");
    await w.settle();
    const conversations = await w
      .agentFor()
      .bindingConversations(w.binding.bindingId);
    expect(conversations.map(({ label }) => label)).toEqual([
      "Ava the Gardener",
    ]);
  });
});

const longAnswer = Array.from({ length: 60 }, (_, line) =>
  `Line ${String(line + 1)} of a long answer about ferns. `.repeat(2),
).join("\n\n");
const flat = (text: string) => text.replace(/\s+/gu, " ").trim();
const sentBody = z.object({
  content: z.string(),
  components: z.array(z.unknown()).optional(),
});
const bodyText = (call: { body: unknown } | undefined) =>
  sentBody.parse(call?.body).content;
const buttonCount = (call: { body: unknown } | undefined) =>
  sentBody.parse(call?.body).components?.length ?? 0;

describe("splitting a long answer", () => {
  it("keeps every message within Discord's bound and loses nothing", () => {
    const parts = splitDiscordMessage(longAnswer);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(2_000);
    expect(flat(parts.join(" "))).toBe(flat(longAnswer));
    // Cuts fall between paragraphs here, never inside a line of the answer.
    for (const part of parts.slice(0, -1))
      expect(part.endsWith("ferns.")).toBe(true);
  });

  it("returns a short answer whole and cuts a wall of text inside a word only as a last resort", () => {
    expect(splitDiscordMessage("Short.")).toEqual(["Short."]);
    const wall = "x".repeat(4_500);
    const parts = splitDiscordMessage(wall);
    expect(parts.map((part) => part.length)).toEqual([2_000, 2_000, 500]);
  });

  it("stops at ten messages and says the rest is cut", () => {
    const parts = splitDiscordMessage("word ".repeat(10_000));
    expect(parts).toHaveLength(10);
    expect(parts.at(-1)).toContain("too long for Discord");
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(2_000);
  });
});

describe("a long answer in Discord", () => {
  it("arrives in full: the first message fills the original, the rest follow, and only the last offers Reply", async () => {
    const w = await world([longAnswer]);
    await w.interact(ask("8234567890123456781", "Tell me everything"));
    await w.settle();
    const [first, ...rest] = w.discordCalls;
    expect(first?.method).toBe("PATCH");
    expect(first?.url).toContain("/messages/@original");
    expect(rest.length).toBeGreaterThan(0);
    for (const call of rest) {
      expect(call.method).toBe("POST");
      expect(call.url).toBe(
        `https://discord.com/api/v10/webhooks/${applicationId}/token-8234567890123456781`,
      );
    }
    const messages = [first, ...rest].map(bodyText);
    for (const text of messages) expect(text.length).toBeLessThanOrEqual(2_000);
    expect(flat(messages.join(" "))).toBe(flat(longAnswer));
    const buttons = [first, ...rest].map(buttonCount);
    expect(buttons.slice(0, -1).every((count) => count === 0)).toBe(true);
    expect(buttons.at(-1)).toBe(1);
    expect(w.owed()).toEqual([]);
  });

  it("opens with the member's quoted reply in the first message", async () => {
    const w = await world(["Short first.", longAnswer]);
    await w.interact(ask("8234567890123456782", "Is my fern fine?"));
    await w.settle();
    w.discordCalls.length = 0;
    await w.interact(
      interaction({
        id: "8234567890123456783",
        type: 5,
        data: {
          custom_id: "reply",
          components: [
            {
              type: 1,
              components: [
                { type: 4, custom_id: "text", value: "Tell me more" },
              ],
            },
          ],
        },
      }),
    );
    await w.settle();
    expect(bodyText(w.discordCalls[0]).startsWith("> Tell me more\n\n")).toBe(
      true,
    );
    expect(w.discordCalls.length).toBeGreaterThan(1);
  });

  it("resumes after the messages Discord already has, never repeating one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const w = await world([longAnswer]);
      // The original is accepted; the first follow-up is refused, then all succeed.
      w.answerNext(200, 503);
      await w.interact(ask("8234567890123456784", "Tell me everything"));
      await w.settle();
      expect(w.discordCalls).toHaveLength(2);
      expect(w.owed()).toMatchObject([{ state: "waiting", attempts: 1 }]);
      vi.setSystemTime(Date.now() + 10_000);
      await w.agentFor().alarm();
      await w.settle();
      const messages = w.discordCalls.map(bodyText);
      // The first message went out once; the retry picked up at the second.
      expect(messages.filter((text) => text === messages[0])).toHaveLength(1);
      expect(w.discordCalls[0]?.method).toBe("PATCH");
      expect(
        w.discordCalls.slice(1).every((call) => call.method === "POST"),
      ).toBe(true);
      expect(flat([messages[0], ...messages.slice(2)].join(" "))).toBe(
        flat(longAnswer),
      );
      expect(w.owed()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a failed answer in Discord", () => {
  it("says why and what to do, in words a member can act on", () => {
    const text = (
      outcome: "failed" | "cancelled" | "interrupted" | "completed",
      code?: string,
    ) =>
      discordFailureText({
        outcome,
        diagnostic:
          code === undefined
            ? null
            : `Model request failed (${code}). Retry the request.`,
      });
    expect(text("failed", "setup_required")).toContain("No model is connected");
    expect(text("failed", "usage-limit-reached")).toContain("credit");
    for (const code of ["rate-limit", "overloaded", "provider_unavailable"])
      expect(text("failed", code)).toContain("Try again in a minute");
    expect(text("failed", "provider_rejected")).toContain("refused");
    expect(text("failed", "tools_unsupported")).toContain("another model");
    expect(text("failed", "something-new")).toContain("went wrong");
    expect(text("failed")).toContain("went wrong");
    expect(text("cancelled")).toContain("cancelled");
    expect(text("interrupted")).toContain("interrupted");
    expect(text("completed")).toContain("without a reply");
  });

  it("is what the member reads when the run fails, with no Reply button", async () => {
    const w = await world([failedRun("setup_required")]);
    await w.interact(ask("9234567890123456781", "Is my fern fine?"));
    await w.settle();
    expect(w.discordCalls).toHaveLength(1);
    expect(bodyText(w.discordCalls[0])).toContain("No model is connected");
    expect(w.discordCalls[0]?.body).toMatchObject({ components: [] });
    expect(JSON.stringify(w.discordCalls)).not.toContain("Retry the request");
  });

  it("lists replies that never reached Discord for the owner, by name", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const w = await world();
      w.answerNext(500, 500, 500, 500, 500);
      await w.interact(ask("9234567890123456782", "hi"));
      await w.settle();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        vi.setSystemTime(Date.now() + 60_000);
        await w.agentFor().alarm();
        await w.settle();
      }
      const control = standaloneDiscordControl(w.env, w.door);
      expect(
        await control.undelivered(owner, w.binding.bindingId),
      ).toMatchObject([{ label: "Ava", state: "failed" }]);
      expect(w.everything()).not.toContain("4567890123456789012");
      expect(await control.undelivered(stranger, w.binding.bindingId)).toEqual(
        [],
      );
      expect(await control.undelivered(owner, "chb_none")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
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
