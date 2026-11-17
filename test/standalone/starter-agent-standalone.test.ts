import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  AgentDirectory,
  standaloneAgents,
} from "../../src/standalone/agents.js";
import { agentDurableObjectState, agentEnv } from "./agent-do-state.fixture.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";

/** The starter laws on the real standalone Agent directory over SQLite. */
const owner = {
  actor: { kind: "member", memberId: "owner" },
  role: "owner",
} as const;
const stranger = {
  actor: { kind: "member", memberId: "guest" },
  role: "member",
} as const;

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

/** The owner's Home AGENTS.md as the Agent reports it; `null` content is an absent file. */
function standalone(
  home: { attached: boolean; content: string | null } = {
    attached: true,
    content: null,
  },
) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const env = agentEnv();
  Object.defineProperty(env, "OYSTER_ORIGIN", { value: "https://oyster.test" });
  Object.defineProperty(env, "OYSTER_OWNER_NAME", { value: "owner" });
  const state = agentDurableObjectState(() => 0);
  Object.defineProperty(state, "storage", {
    value: {
      ...state.storage,
      ...cloudflareStorageFixture(fromNodeSqlite(database)),
    },
  });
  const directory = new AgentDirectory(state, env);
  const policyDirectories: string[] = [];
  const replacements: (string | null)[] = [];
  Object.defineProperties(env, {
    AGENT_DIRECTORY: { value: { getByName: () => directory } },
    AGENTS: {
      value: {
        getByName: (agentId: string) => ({
          usePolicyDirectory: () => {
            policyDirectories.push(agentId);
            return Promise.resolve();
          },
          // The create-only write the Home instructions file performs.
          replaceInstructions: (
            _actor: string,
            expected: string | null,
            content: string,
          ) => {
            replacements.push(content);
            if (!home.attached)
              return Promise.resolve({ error: "no_home" as const });
            if (home.content !== expected)
              return Promise.resolve({ error: "conflict" as const });
            home.content = content;
            return Promise.resolve({ home: { name: "Home" }, content });
          },
        }),
      },
    },
  });
  return {
    agents: standaloneAgents(env),
    directory,
    policyDirectories,
    replacements,
    home,
  };
}

it("offers the owner one Shiitake on an empty Team, through the ordinary create, once", async () => {
  const { agents, policyDirectories } = standalone();
  expect(await agents.ensureStarter(owner)).toBe("created");
  expect(await agents.ensureStarter(owner)).toBe("already-offered");
  const listed = await agents.list();
  expect(listed.map(({ name }) => name)).toEqual(["Shiitake"]);
  // The same follow-up the ordinary create performs.
  expect(policyDirectories).toEqual([listed[0]?.agentId]);
});

it("never triggers for a non-owner", async () => {
  const { agents } = standalone();
  expect(await agents.ensureStarter(stranger)).toBe("not-owner");
  expect(await agents.list()).toEqual([]);
});

it("leaves a Team with an Agent alone and never re-creates a renamed starter", async () => {
  const { agents } = standalone();
  await agents.create("Mine", "mine", owner, "owner-direct");
  expect(await agents.ensureStarter(owner)).toBe("team-not-empty");
  expect((await agents.list()).map(({ name }) => name)).toEqual(["Mine"]);

  const second = standalone();
  expect(await second.agents.ensureStarter(owner)).toBe("created");
  const [starter] = await second.agents.list();
  await second.agents.rename(starter?.agentId ?? "", "Moss", owner);
  expect(await second.agents.ensureStarter(owner)).toBe("already-offered");
  expect((await second.agents.list()).map(({ name }) => name)).toEqual([
    "Moss",
  ]);
});

const firstRun = "## First conversation";

it("seeds the first-run section into a Home with no AGENTS.md, once, and says nothing about money", async () => {
  const { agents, home, replacements } = standalone();
  expect(await agents.ensureStarter(owner)).toBe("created");
  expect(await agents.ensureStarter(owner)).toBe("already-offered");
  expect(replacements).toHaveLength(1);
  expect(home.content).toContain(firstRun);
  expect(home.content).toContain('skill.load({name: "setup-fungi"})');
  expect(home.content).not.toMatch(/Pro|credit|price|\$|setup\.finish/u);
});

it("leaves an AGENTS.md the owner already has exactly as it is", async () => {
  const { agents, home } = standalone({ attached: true, content: "mine\n" });
  expect(await agents.ensureStarter(owner)).toBe("created");
  expect(home.content).toBe("mine\n");
  expect(await agents.ensureStarter(owner)).toBe("already-offered");
  expect(home.content).toBe("mine\n");
});

it("never seeds a store that settled its starter before the seed existed", async () => {
  const { agents, directory, home, replacements } = standalone({
    attached: true,
    content: "written long ago\n",
  });
  const old = await agents.create(
    "Shiitake",
    "starter-agent:v1",
    owner,
    "owner-direct",
  );
  directory.recordStarter({
    version: 1,
    outcome: "created",
    agentId: old.agentId,
    at: 0,
  });
  expect(await agents.ensureStarter(owner)).toBe("already-offered");
  expect(replacements).toEqual([]);
  expect(home.content).toBe("written long ago\n");
  // The same old store with an empty Home is not seeded after the fact.
  const empty = standalone();
  const early = await empty.agents.create(
    "Shiitake",
    "starter-agent:v1",
    owner,
    "owner-direct",
  );
  empty.directory.recordStarter({
    version: 1,
    outcome: "created",
    agentId: early.agentId,
    at: 0,
  });
  expect(await empty.agents.ensureStarter(owner)).toBe("already-offered");
  expect(empty.home.content).toBeNull();
  expect(empty.replacements).toEqual([]);
});

it("waits quietly for a Home, then seeds the same starter without a second Agent", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { agents, home } = standalone({ attached: false, content: null });
  expect(await agents.ensureStarter(owner)).toBe("failed");
  expect(await agents.ensureStarter(owner)).toBe("failed");
  expect(warn).not.toHaveBeenCalled();
  expect(await agents.list()).toHaveLength(1);
  home.attached = true;
  expect(await agents.ensureStarter(owner)).toBe("created");
  expect(home.content).toContain(firstRun);
  expect(await agents.list()).toHaveLength(1);
});
