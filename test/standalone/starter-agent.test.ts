import {
  createAgentDirectory,
  type AgentGrant,
} from "@fungi.computer/shiitake/fleet";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createStarterLedger,
  ensureStarterAgent,
  starterAgent,
  type StarterAgentHost,
} from "../../src/starter-agent.js";

/** The laws, over the real Agent directory and ledger on in-memory SQLite. */
const grant: AgentGrant = {
  agents: "all",
  actions: ["create", "read", "manage"],
  expiresAt: Date.now() + 3_600_000,
  provenance: { actor: "owner" },
};

let database: DatabaseSync;
let funded: boolean;
let owner: boolean;
let failure: Error | null;
let reports: unknown[];

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  funded = true;
  owner = true;
  failure = null;
  reports = [];
});
afterEach(() => {
  database.close();
});

function team() {
  const sqlite = fromNodeSqlite(database);
  const directory = createAgentDirectory(sqlite.sql);
  const host = (): StarterAgentHost => ({
    ledger: createStarterLedger(sqlite.sql),
    isOwner: () => owner,
    agentCount: () => directory.list(grant).length,
    create: (request) => {
      if (failure !== null) return Promise.reject(failure);
      if (!funded) return Promise.resolve({ status: "unfunded" });
      const { agent } = sqlite.transactionSync(() =>
        directory.create(grant, { ...request, configuration: "none" }),
      );
      return Promise.resolve({ status: "created", agentId: agent.agentId });
    },
    report: (cause) => reports.push(cause),
  });
  return { directory, host, sqlite };
}

const create = (
  directory: ReturnType<typeof team>["directory"],
  name: string,
) =>
  directory.create(grant, {
    requestId: `own-${name}`,
    name,
    configuration: "none",
  }).agent;

describe("starter Agent laws", () => {
  it("gives an empty Team exactly one Shiitake, once", async () => {
    const { directory, host } = team();
    expect(await ensureStarterAgent(host())).toBe("created");
    expect(await ensureStarterAgent(host())).toBe("already-offered");
    expect(directory.list(grant).map(({ name }) => name)).toEqual([
      starterAgent.name,
    ]);
  });

  it("makes concurrent ensures on one host one Agent", async () => {
    const { directory, host } = team();
    const shared = host();
    const outcomes = await Promise.all([
      ensureStarterAgent(shared),
      ensureStarterAgent(shared),
      ensureStarterAgent(shared),
    ]);
    expect(outcomes).toEqual(["created", "created", "created"]);
    expect(directory.list(grant)).toHaveLength(1);
    expect(
      createStarterLedger(fromNodeSqlite(database).sql).read(),
    ).toMatchObject({ outcome: "created" });
  });

  it("replays one Agent when two host instances race", async () => {
    const { directory, host } = team();
    await Promise.all([ensureStarterAgent(host()), ensureStarterAgent(host())]);
    expect(directory.list(grant)).toHaveLength(1);
  });

  it("never resurrects a deleted starter", async () => {
    const { directory, host } = team();
    await ensureStarterAgent(host());
    const starter = directory.list(grant)[0];
    if (starter === undefined) throw new Error("No starter");
    directory.remove(grant, starter.agentId);
    expect(await ensureStarterAgent(host())).toBe("already-offered");
    expect(directory.list(grant)).toHaveLength(0);
  });

  it("keeps a renamed starter as the owner's", async () => {
    const { directory, host } = team();
    await ensureStarterAgent(host());
    const starter = directory.list(grant)[0];
    if (starter === undefined) throw new Error("No starter");
    directory.rename(grant, starter.agentId, { name: "Moss" });
    expect(await ensureStarterAgent(host())).toBe("already-offered");
    expect(directory.list(grant).map(({ name }) => name)).toEqual(["Moss"]);
  });

  it("leaves a non-empty Team alone, even one that already owns the name", async () => {
    const { directory, host } = team();
    create(directory, "Shiitake");
    expect(await ensureStarterAgent(host())).toBe("team-not-empty");
    expect(directory.list(grant)).toHaveLength(1);
    expect(await ensureStarterAgent(host())).toBe("already-offered");
  });

  it("records nothing while unfunded and offers once funded", async () => {
    const { directory, host } = team();
    funded = false;
    expect(await ensureStarterAgent(host())).toBe("unfunded");
    expect(
      createStarterLedger(fromNodeSqlite(database).sql).read(),
    ).toBeUndefined();
    expect(directory.list(grant)).toHaveLength(0);
    funded = true;
    expect(await ensureStarterAgent(host())).toBe("created");
    expect(directory.list(grant)).toHaveLength(1);
  });

  it("never triggers for a non-owner", async () => {
    const { directory, host } = team();
    owner = false;
    expect(await ensureStarterAgent(host())).toBe("not-owner");
    expect(directory.list(grant)).toHaveLength(0);
    expect(
      createStarterLedger(fromNodeSqlite(database).sql).read(),
    ).toBeUndefined();
  });

  it("reports a failed attempt without failing the caller, then retries", async () => {
    const { directory, host } = team();
    failure = new Error("Computer provisioning failed");
    expect(await ensureStarterAgent(host())).toBe("failed");
    expect(reports).toEqual([failure]);
    expect(directory.list(grant)).toHaveLength(0);
    failure = null;
    expect(await ensureStarterAgent(host())).toBe("created");
  });
});
