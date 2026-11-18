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

/**
 * What the host offers as the starter's Home. `home` is its configured
 * Computer, which the fleet admits; `refused` is one the fleet will not
 * resolve; `none` is a host with no configured Computer at all; `throws` is
 * a fleet that fails the attach outright.
 */
type Runtime = "home" | "refused" | "none" | "throws";

/** The owner's Home AGENTS.md as the Agent reports it; `null` content is an absent file. */
function standalone(
  options: { runtime?: Runtime; content?: string | null } = {},
) {
  const runtime = options.runtime ?? "home";
  const home = { content: options.content ?? null };
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const env = agentEnv();
  Object.defineProperty(env, "OYSTER_ORIGIN", { value: "https://oyster.test" });
  Object.defineProperty(env, "OYSTER_OWNER_NAME", { value: "owner" });
  Object.defineProperty(env, "OYSTER_COMPUTER_ID", {
    value: runtime === "none" ? "" : "agent-fixture",
  });
  Object.defineProperty(env, "TENANCY", {
    value: { memberById: () => Promise.resolve(owner) },
  });
  Object.defineProperty(env, "REGISTRY", {
    value: {
      getByName: () => ({
        computerFleet: (
          _memberId: string,
          request: { operation: string; computerId: string },
        ) =>
          runtime === "throws"
            ? Promise.reject(new Error("fleet unavailable"))
            : Promise.resolve(
                request.operation === "resolve" && runtime !== "home"
                  ? null
                  : { computerId: request.computerId, name: "Home" },
              ),
      }),
    },
  });
  const state = agentDurableObjectState(() => 0);
  Object.defineProperties(state, {
    // The directory only answers to the name the Team's directory has.
    id: { value: { ...state.id, name: "agents" } },
    waitUntil: { value: () => undefined },
    storage: {
      value: {
        ...state.storage,
        ...cloudflareStorageFixture(fromNodeSqlite(database)),
      },
    },
  });
  const directory = new AgentDirectory(state, env);
  const policyDirectories: string[] = [];
  const replacements: (string | null)[] = [];
  const kept: string[] = [];
  Object.defineProperties(env, {
    AGENT_DIRECTORY: { value: { getByName: () => directory } },
    AGENTS: {
      value: {
        getByName: (agentId: string) => ({
          usePolicyDirectory: () => {
            policyDirectories.push(agentId);
            return Promise.resolve();
          },
          invalidateComputerConnections: () => Promise.resolve(),
          // The setup prompt an Agent with no Home keeps on its own record.
          seedFirstConversation: (content: string, actor: string) => {
            expect(JSON.parse(actor)).toEqual(owner);
            kept.push(content);
            return Promise.resolve();
          },
          // The create-only write the Home instructions file performs.
          replaceInstructions: async (
            _actor: string,
            expected: string | null,
            content: string,
          ) => {
            replacements.push(content);
            const attached = await directory.readAgentComputers(agentId, owner);
            if (
              attached.kind !== "ok" ||
              attached.projection.attachments.length === 0
            )
              return { error: "no_home" as const };
            if (home.content !== expected)
              return { error: "conflict" as const };
            home.content = content;
            return { home: { name: "Home" }, content };
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
    kept,
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
  const { agents, home } = standalone({ content: "mine\n" });
  expect(await agents.ensureStarter(owner)).toBe("created");
  expect(home.content).toBe("mine\n");
  expect(await agents.ensureStarter(owner)).toBe("already-offered");
  expect(home.content).toBe("mine\n");
});

it("never seeds a store that settled its starter before the seed existed", async () => {
  const { agents, directory, home, replacements } = standalone({
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
  // Nor is its Computer-less starter given a Home, or a kept prompt, later.
  const unattached = await empty.directory.readAgentComputers(
    early.agentId,
    owner,
  );
  expect(unattached).toMatchObject({
    kind: "ok",
    projection: { attachments: [] },
  });
  expect(empty.kept).toEqual([]);
});

it("gives the starter the host's configured Computer as its Home when it is created", async () => {
  const { agents, directory, home, kept } = standalone();
  expect(await agents.ensureStarter(owner)).toBe("created");
  const [starter] = await agents.list();
  const attached = await directory.readAgentComputers(
    starter?.agentId ?? "",
    owner,
  );
  expect(attached).toMatchObject({
    kind: "ok",
    projection: {
      attachments: [
        { computerId: "agent-fixture", attachmentId: "starter-home:v1" },
      ],
    },
  });
  expect(home.content).toContain(firstRun);
  expect(kept).toEqual([]);
  // A second read neither attaches again nor makes a second Agent.
  expect(await agents.ensureStarter(owner)).toBe("already-offered");
  expect(await agents.list()).toHaveLength(1);
});

it.each(["none", "refused"] as const)(
  "keeps the setup prompt on the Agent when the host has no Computer to attach (%s)",
  async (runtime) => {
    const { agents, directory, home, kept } = standalone({ runtime });
    expect(await agents.ensureStarter(owner)).toBe("created");
    const [starter] = await agents.list();
    expect(
      await directory.readAgentComputers(starter?.agentId ?? "", owner),
    ).toMatchObject({ kind: "ok", projection: { attachments: [] } });
    expect(home.content).toBeNull();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain(firstRun);
    expect(kept[0]).toContain('skill.load({name: "setup-fungi"})');
    expect(kept[0]).not.toMatch(/Pro|credit|price|\$|setup\.finish/u);
    expect(await agents.ensureStarter(owner)).toBe("already-offered");
    expect(kept).toHaveLength(1);
    expect(await agents.list()).toHaveLength(1);
  },
);

it("still records and seeds the starter when the Home attach fails outright, and reports why", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { agents, directory, kept } = standalone({ runtime: "throws" });
  expect(await agents.ensureStarter(owner)).toBe("created");
  const [starter] = await agents.list();
  expect(
    await directory.readAgentComputers(starter?.agentId ?? "", owner),
  ).toMatchObject({ kind: "ok", projection: { attachments: [] } });
  expect(kept).toHaveLength(1);
  expect(kept[0]).toContain(firstRun);
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("starter_agent_failed"),
    );
  });
  expect(String(warn.mock.calls[0]?.[0])).toContain("fleet unavailable");
  // The ledger was written: the next read neither re-creates nor re-seeds.
  expect(await agents.ensureStarter(owner)).toBe("already-offered");
  expect(kept).toHaveLength(1);
  expect(await agents.list()).toHaveLength(1);
});
