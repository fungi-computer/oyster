import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { ownerOrKeyAuth } from "../../src/auth.js";
import { serveHost } from "../../src/authorization.js";
import {
  createDiscordBindings,
  DiscordBindingError,
} from "../../src/channels/discord-binding.js";
import { channelIds } from "../../src/channels/ids.js";
import {
  standaloneDiscordRoutes,
  type StandaloneDiscordControl,
} from "../../src/standalone/discord-channels.js";
import {
  applicationId,
  botToken,
  channelId,
  discordDirectoryFixture,
  guildId,
  origin,
  otherBotToken,
  owner,
  stranger,
} from "./discord-channel.fixture.js";

const publicKey = "ab".repeat(32);
const facts = {
  agentId: "agent_1",
  applicationId,
  publicKey,
  guildIds: [guildId],
};

function bindings(agents: readonly string[] = ["agent_1"]) {
  const sql = fromNodeSqlite(new DatabaseSync(":memory:"));
  return createDiscordBindings({
    ...sql,
    agentExists: (agentId) => agents.includes(agentId),
  });
}

describe("discord bindings", () => {
  it("binds one application to an existing Agent and keeps the token out of the record", () => {
    const owned = bindings();
    const created = owned.create(facts, "cred_1", "request-1");
    expect(channelIds.binding.is(created.bindingId)).toBe(true);
    expect(created).toMatchObject({
      lifecycle: "active",
      authorityVersion: 1,
      persona: "",
      selector: {
        provider: "discord",
        applicationId,
        publicKey,
        guildIds: [guildId],
        channelIds: [],
      },
    });
    expect(owned.tokenCredentialId(created.bindingId)).toBe("cred_1");
    expect(JSON.stringify(created)).not.toContain("cred_1");
    expect(() =>
      owned.create({ ...facts, agentId: "agent_2" }, "cred_2", "request-2"),
    ).toThrow(new DiscordBindingError("not_found"));
  });

  it("refuses a malformed application, key or guild and a second binding of one application", () => {
    const owned = bindings();
    for (const bad of [
      { applicationId: "12" },
      { publicKey: "zz" },
      { guildIds: [] },
      { guildIds: ["nope"] },
      { channelIds: ["nope"] },
    ])
      expect(() =>
        owned.create({ ...facts, ...bad }, "cred_1", "request-bad"),
      ).toThrow(new DiscordBindingError("invalid_input"));
    owned.create(facts, "cred_1", "request-1");
    expect(() => owned.create(facts, "cred_2", "request-2")).toThrow(
      new DiscordBindingError("application_taken"),
    );
  });

  it("creates once per request and refuses a changed replay", () => {
    const owned = bindings();
    const first = owned.create(facts, "cred_1", "request-1");
    expect(owned.replay(facts, "request-1")).toEqual(first);
    expect(owned.replay(facts, "request-new")).toBeNull();
    expect(() =>
      owned.replay(
        { ...facts, guildIds: ["9999999999999999999"] },
        "request-1",
      ),
    ).toThrow(new DiscordBindingError("request_conflict"));
    expect(owned.list()).toEqual([first]);
  });

  it("fences edits by version and swaps the token credential atomically", () => {
    const owned = bindings();
    const created = owned.create(facts, "cred_1", "request-1");
    const edited = owned.update(
      created.bindingId,
      {
        expectedVersion: 1,
        channelIds: [channelId],
        persona: "Answer kindly.",
        lifecycle: "suspended",
      },
      "cred_2",
    );
    expect(edited).toMatchObject({
      authorityVersion: 2,
      lifecycle: "suspended",
      persona: "Answer kindly.",
      selector: { channelIds: [channelId], applicationId },
    });
    expect(owned.tokenCredentialId(created.bindingId)).toBe("cred_2");
    expect(() =>
      owned.update(created.bindingId, { expectedVersion: 1 }, null),
    ).toThrow(new DiscordBindingError("version_conflict"));
    expect(() =>
      owned.update("chb_none", { expectedVersion: 1 }, null),
    ).toThrow(new DiscordBindingError("not_found"));
  });
});

const fixtures: (() => void)[] = [];
afterEach(() => {
  for (const close of fixtures.splice(0)) close();
});
function directoryFixture(...args: Parameters<typeof discordDirectoryFixture>) {
  const f = discordDirectoryFixture(...args);
  fixtures.push(f.close);
  return f;
}
const input = (agentId: string) => ({
  agentId,
  applicationId,
  publicKey,
  guildIds: [guildId],
  botToken,
});
const credentials = (kv: ReadonlyMap<string, unknown>) =>
  [...kv.keys()].filter((key) => key.startsWith("credential:"));

describe("the directory's Discord owner", () => {
  it("seals the bot token and never stores, lists or returns it", async () => {
    const f = directoryFixture();
    const created = await f.directory.discordCreate(
      owner,
      input(f.agent.agentId),
      "request-1",
    );
    if ("error" in created) throw new Error(created.error);
    expect(credentials(f.kv)).toHaveLength(1);
    expect(f.everything()).not.toContain(botToken);
    expect(JSON.stringify(created)).not.toContain(botToken);
    expect(JSON.stringify(f.directory.discordList(owner))).not.toContain(
      botToken,
    );
    expect(f.directory.discordList(owner)).toEqual([created]);
  });

  it("does not seal again on a replay and cleans up a refused create", async () => {
    const f = directoryFixture();
    const first = await f.directory.discordCreate(
      owner,
      input(f.agent.agentId),
      "request-1",
    );
    const again = await f.directory.discordCreate(
      owner,
      input(f.agent.agentId),
      "request-1",
    );
    expect(again).toEqual(first);
    expect(credentials(f.kv)).toHaveLength(1);
    expect(
      await f.directory.discordCreate(
        owner,
        { ...input(f.agent.agentId), applicationId: "9876543210987654321" },
        "request-1",
      ),
    ).toEqual({ error: "request_conflict" });
    expect(
      await f.directory.discordCreate(
        owner,
        input(f.agent.agentId),
        "request-2",
      ),
    ).toEqual({ error: "application_taken" });
    expect(
      await f.directory.discordCreate(owner, input("nobody"), "request-3"),
    ).toEqual({ error: "not_found" });
    expect(credentials(f.kv)).toHaveLength(1);
  });

  it("replaces a sealed token and leaves exactly one credential", async () => {
    const f = directoryFixture();
    const created = await f.directory.discordCreate(
      owner,
      input(f.agent.agentId),
      "request-1",
    );
    if ("error" in created) throw new Error(created.error);
    const [before] = credentials(f.kv);
    const updated = await f.directory.discordUpdate(owner, created.bindingId, {
      expectedVersion: created.authorityVersion,
      botToken: otherBotToken,
    });
    if ("error" in updated) throw new Error(updated.error);
    expect(updated.authorityVersion).toBe(2);
    expect(credentials(f.kv)).toHaveLength(1);
    expect(credentials(f.kv)).not.toContain(before);
    expect(f.everything()).not.toContain(otherBotToken);
    // A stale edit seals nothing that survives it.
    expect(
      await f.directory.discordUpdate(owner, created.bindingId, {
        expectedVersion: 1,
        botToken,
      }),
    ).toEqual({ error: "version_conflict" });
    expect(credentials(f.kv)).toHaveLength(1);
  });

  it("refuses without instance custody and refuses anyone but the owner", async () => {
    const closed = directoryFixture({});
    expect(
      await closed.directory.discordCreate(
        owner,
        input(closed.agent.agentId),
        "request-1",
      ),
    ).toEqual({ error: "custody_unavailable" });
    expect(closed.directory.discordList(owner)).toEqual([]);
    const f = directoryFixture();
    expect(
      await f.directory.discordCreate(
        stranger,
        input(f.agent.agentId),
        "request-1",
      ),
    ).toEqual({ error: "not_granted" });
    expect(f.directory.discordList(stranger)).toEqual({
      error: "not_granted",
    });
    expect(credentials(f.kv)).toHaveLength(0);
  });
});

describe("the owner's Discord controls", () => {
  const control = (calls: string[]): StandaloneDiscordControl => ({
    read: () => {
      calls.push("read");
      return Promise.resolve({
        interactionsOrigin: origin,
        agents: [],
        discords: [],
      });
    },
    create: () => {
      calls.push("create");
      return Promise.resolve({ error: "invalid_input" });
    },
    update: () => {
      calls.push("update");
      return Promise.resolve({ error: "not_found" });
    },
    registerCommands: () => {
      calls.push("register");
      return Promise.resolve({ registered: [], failed: [] });
    },
  });
  const ownerKey = ["fixture", "owner", "word"].join("-").padEnd(30, "o");
  const served = (calls: string[]) =>
    serveHost(
      standaloneDiscordRoutes(control(calls)),
      ownerOrKeyAuth(ownerKey, "owner", () => ({
        verify: () =>
          Promise.resolve({ kind: "error", error: { code: "denied" } }),
      })).authenticate,
      { liveKey: () => Promise.resolve(null), appToolPolicy: () => null },
    );

  it("admits the owner directly, never an App or a stranger", async () => {
    const calls: string[] = [];
    const app = served(calls);
    const bindingId = channelIds.binding.generate();
    const every = [
      ["GET", "/api/discord"],
      ["POST", "/api/discord"],
      ["PUT", `/api/discord/${bindingId}`],
      ["POST", `/api/discord/${bindingId}/commands`],
    ] as const;
    for (const [method, path] of every) {
      const stranger = await app.request(`${origin}${path}`, {
        method,
        headers: { authorization: "Bearer not-the-owner" },
        body: method === "GET" ? null : "{}",
      });
      expect(stranger.status, `${method} ${path}`).toBe(401);
      const mediated = await app.request(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${ownerKey}`,
          "X-Oyster-Installation": "notes",
        },
        body: method === "GET" ? null : "{}",
      });
      expect(mediated.status, `${method} ${path}`).toBe(403);
    }
    expect(calls).toEqual([]);
    const asOwner = await app.request(`${origin}/api/discord`, {
      headers: { authorization: `Bearer ${ownerKey}` },
    });
    expect(asOwner.status).toBe(200);
    expect(calls).toEqual(["read"]);
  });

  it("answers a malformed body with a 400 and a refusal with its status", async () => {
    const calls: string[] = [];
    const app = served(calls);
    const headers = { authorization: `Bearer ${ownerKey}` };
    expect(
      (
        await app.request(`${origin}/api/discord`, {
          method: "POST",
          headers,
          body: "{nope",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(`${origin}/api/discord`, {
          method: "POST",
          headers,
          body: JSON.stringify({ botToken: "short" }),
        })
      ).status,
    ).toBe(400);
    expect(calls).toEqual([]);
    const refused = await app.request(`${origin}/api/discord`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...input("agent_1") }),
    });
    expect(refused.status).toBe(400);
    expect(calls).toEqual(["create"]);
  });
});
