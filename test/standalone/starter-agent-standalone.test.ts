import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { afterEach, expect, it } from "vitest";
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
  for (const database of databases.splice(0)) database.close();
});

function standalone() {
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
  Object.defineProperties(env, {
    AGENT_DIRECTORY: { value: { getByName: () => directory } },
    AGENTS: {
      value: {
        getByName: (agentId: string) => ({
          usePolicyDirectory: () => {
            policyDirectories.push(agentId);
            return Promise.resolve();
          },
        }),
      },
    },
  });
  return {
    agents: standaloneAgents(env),
    directory,
    policyDirectories,
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
