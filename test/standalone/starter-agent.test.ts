import {
  createAgentDirectory,
  type AgentGrant,
} from "@fungi.computer/shiitake/fleet";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStarterLedger,
  ensureStarterAgent,
  seedStarterHome,
  starterAgent,
  starterSeedStatus,
  StarterTimeout,
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

  it("seeds Home once for the created starter, and only then records it", async () => {
    const { host } = team();
    const seeded: string[] = [];
    const seeding: StarterAgentHost = {
      ...host(),
      seedHome: (agentId) => {
        seeded.push(agentId);
        expect(
          createStarterLedger(fromNodeSqlite(database).sql).read(),
        ).toMatchObject({ outcome: "seed-pending", agentId });
        return Promise.resolve();
      },
    };
    expect(await ensureStarterAgent(seeding)).toBe("seeding");
    await vi.waitFor(async () => {
      expect((await starterSeedStatus(seeding.ledger)).state).toBe("ready");
    });
    expect(await ensureStarterAgent(seeding)).toBe("already-offered");
    expect(seeded).toHaveLength(1);
    expect(
      createStarterLedger(fromNodeSqlite(database).sql).read(),
    ).toMatchObject({ outcome: "created", agentId: seeded[0] });
  });

  it("retries a failed Home seed for the same Agent and never makes a second", async () => {
    const { directory, host } = team();
    let broken = true;
    const seeded: string[] = [];
    const seeding: StarterAgentHost = {
      ...host(),
      seedHome: (agentId) => {
        if (broken) return Promise.reject(new Error("Home unavailable"));
        seeded.push(agentId);
        return Promise.resolve();
      },
    };
    expect(await ensureStarterAgent(seeding)).toBe("seeding");
    await vi.waitFor(async () => {
      expect(await starterSeedStatus(seeding.ledger)).toMatchObject({
        state: "failed",
        reason: "Home unavailable",
      });
    });
    expect(reports).toHaveLength(1);
    expect(
      createStarterLedger(fromNodeSqlite(database).sql).read(),
    ).toMatchObject({ outcome: "seed-pending" });
    broken = false;
    expect(await ensureStarterAgent(seeding)).toBe("seeding");
    await vi.waitFor(async () => {
      expect((await starterSeedStatus(seeding.ledger)).state).toBe("ready");
    });
    expect(directory.list(grant)).toHaveLength(1);
    expect(seeded).toEqual([directory.list(grant)[0]?.agentId]);
    expect(await ensureStarterAgent(seeding)).toBe("already-offered");
    expect(seeded).toHaveLength(1);
  });

  it("answers at once while a Home seed hangs, then names the timeout", async () => {
    const { directory, host } = team();
    const seeding: StarterAgentHost = {
      ...host(),
      seedHome: () => new Promise<void>(() => undefined),
      timeoutMs: 1_000,
      describeSeedFailure: (cause) =>
        cause instanceof StarterTimeout ? cause.message : "other",
    };
    expect(await ensureStarterAgent(seeding)).toBe("seeding");
    expect(directory.list(grant)).toHaveLength(1);
    const agentId = directory.list(grant)[0]?.agentId;
    expect(await starterSeedStatus(seeding.ledger)).toEqual({
      state: "seeding",
      agentId,
    });
    // A read during the hung seed answers too, and starts no second seed.
    expect(await ensureStarterAgent(seeding)).toBe("seeding");
    await vi.waitFor(async () => {
      expect(await starterSeedStatus(seeding.ledger)).toMatchObject({
        state: "failed",
        agentId,
        reason: "it did not answer within 1 second",
      });
    }, 3_000);
    expect(reports).toEqual([expect.any(StarterTimeout)]);
  });

  it("names a refused Home seed in the host's words", async () => {
    const { host } = team();
    const seeding: StarterAgentHost = {
      ...host(),
      seedHome: () => Promise.reject(new Error("projection unavailable")),
      describeSeedFailure: () => "it is not reachable right now",
    };
    expect(await ensureStarterAgent(seeding)).toBe("seeding");
    await vi.waitFor(async () => {
      expect(await starterSeedStatus(seeding.ledger)).toMatchObject({
        state: "failed",
        reason: "it is not reachable right now",
      });
    });
    // A status read leaves the failure in place; an ordinary read retries.
    expect(
      await ensureStarterAgent({ ...seeding, retryFailedSeed: false }),
    ).toBe("failed");
    expect((await starterSeedStatus(seeding.ledger)).state).toBe("failed");
    expect(await ensureStarterAgent(seeding)).toBe("seeding");
  });

  it("answers at once while the create hangs, then names the timeout", async () => {
    const { host } = team();
    const hanging: StarterAgentHost = {
      ...host(),
      create: () => new Promise(() => undefined),
      readWaitMs: 20,
      timeoutMs: 1_000,
    };
    expect(await ensureStarterAgent(hanging)).toBe("starting");
    expect(await starterSeedStatus(hanging.ledger)).toEqual({
      state: "starting",
    });
    // A read during the hung create answers too, and starts no second one.
    expect(await ensureStarterAgent(hanging)).toBe("starting");
    await vi.waitFor(async () => {
      expect(await starterSeedStatus(hanging.ledger)).toMatchObject({
        state: "failed",
        agentId: null,
        reason: "it did not answer within 1 second",
      });
    }, 3_000);
    expect(
      await ensureStarterAgent({ ...hanging, retryFailedSeed: false }),
    ).toBe("failed");
  });

  it("records and seeds a create that lands after the read stopped waiting", async () => {
    const { directory, host } = team();
    const base = host();
    let land: () => void = () => undefined;
    const seeded: string[] = [];
    const slow: StarterAgentHost = {
      ...base,
      create: (request) =>
        new Promise((resolve) => {
          land = () => {
            void base.create(request).then(resolve);
          };
        }),
      seedHome: (agentId) => {
        seeded.push(agentId);
        return Promise.resolve();
      },
      readWaitMs: 20,
    };
    expect(await ensureStarterAgent(slow)).toBe("starting");
    land();
    await vi.waitFor(async () => {
      expect((await starterSeedStatus(slow.ledger)).state).toBe("ready");
    });
    expect(seeded).toEqual([directory.list(grant)[0]?.agentId]);
    expect(await ensureStarterAgent(slow)).toBe("already-offered");
  });

  it("resumes a create cut off after it reserved the Agent, never reading the Team as not empty", async () => {
    const { directory, host } = team();
    let now = 1_000;
    const base = host();
    // The first process reserves the Agent, then stops before answering.
    const cut: StarterAgentHost = {
      ...base,
      create: async (request) => {
        await base.create(request);
        return new Promise(() => undefined);
      },
      seedHome: () => Promise.resolve(),
      readWaitMs: 20,
      timeoutMs: 60_000,
      now: () => now,
    };
    expect(await ensureStarterAgent(cut)).toBe("starting");
    expect(directory.list(grant)).toHaveLength(1);
    // A fresh process (new ledger object, nothing in memory) reads the same
    // store: within the bound the attempt may still run, so it waits.
    const fresh = (): StarterAgentHost => ({
      ...host(),
      seedHome: () => Promise.resolve(),
      timeoutMs: 60_000,
      now: () => now,
    });
    expect(await ensureStarterAgent(fresh())).toBe("starting");
    expect(await starterSeedStatus(fresh().ledger)).toEqual({
      state: "starting",
    });
    // Past the bound it replays the create by its request id and seeds.
    now += 60_001;
    expect(await ensureStarterAgent(fresh())).toBe("seeding");
    await vi.waitFor(async () => {
      expect((await starterSeedStatus(fresh().ledger)).state).toBe("ready");
    });
    expect(directory.list(grant)).toHaveLength(1);
  });

  it("resumes a Home seed cut off by a restart", async () => {
    const { directory, host } = team();
    let now = 1_000;
    const cut: StarterAgentHost = {
      ...host(),
      seedHome: () => new Promise<void>(() => undefined),
      timeoutMs: 60_000,
      now: () => now,
    };
    expect(await ensureStarterAgent(cut)).toBe("seeding");
    const seeded: string[] = [];
    const fresh = (): StarterAgentHost => ({
      ...host(),
      seedHome: (agentId) => {
        seeded.push(agentId);
        return Promise.resolve();
      },
      timeoutMs: 60_000,
      now: () => now,
    });
    // The restart lost the running seed; within its bound it still counts.
    expect(await ensureStarterAgent(fresh())).toBe("seeding");
    expect(seeded).toEqual([]);
    now += 60_001;
    // A status read resumes a seed that was cut off, not one that failed.
    expect(
      await ensureStarterAgent({ ...fresh(), retryFailedSeed: false }),
    ).toBe("seeding");
    await vi.waitFor(async () => {
      expect((await starterSeedStatus(fresh().ledger)).state).toBe("ready");
    });
    expect(seeded).toEqual([directory.list(grant)[0]?.agentId]);
  });

  it("keeps the background create and seed alive through the host", async () => {
    const { host } = team();
    const kept: Promise<unknown>[] = [];
    const worker: StarterAgentHost = {
      ...host(),
      seedHome: () => Promise.resolve(),
      keepAlive: (work) => kept.push(work),
    };
    expect(await ensureStarterAgent(worker)).toBe("seeding");
    await Promise.all(kept);
    // Create and seed each handed their work over.
    expect(kept).toHaveLength(2);
    expect((await starterSeedStatus(worker.ledger)).state).toBe("ready");
  });

  it("reads and resumes a ledger stored before attempts were durable", async () => {
    const { directory, host } = team();
    const sqlite = fromNodeSqlite(database);
    sqlite.sql.exec(
      "CREATE TABLE starter_agent (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, outcome TEXT NOT NULL, agent_id TEXT, at INTEGER NOT NULL) STRICT",
    );
    const agent = create(directory, "Shiitake");
    sqlite.sql.exec(
      "INSERT INTO starter_agent(id, version, outcome, agent_id, at) VALUES(1, 1, 'seed-pending', ?, 5)",
      agent.agentId,
    );
    const seeded: string[] = [];
    const resumed: StarterAgentHost = {
      ...host(),
      seedHome: (agentId) => {
        seeded.push(agentId);
        return Promise.resolve();
      },
    };
    expect(await ensureStarterAgent(resumed)).toBe("seeding");
    await vi.waitFor(async () => {
      expect((await starterSeedStatus(resumed.ledger)).state).toBe("ready");
    });
    expect(seeded).toEqual([agent.agentId]);
    expect(createStarterLedger(sqlite.sql).read()).toMatchObject({
      outcome: "created",
      agentId: agent.agentId,
      at: 5,
    });
  });

  it("writes the first-run section only to a missing AGENTS.md", async () => {
    const homes = new Map<string, string>();
    const writeIfMissing = (content: string) => {
      if (!homes.has("AGENTS.md")) homes.set("AGENTS.md", content);
      return Promise.resolve();
    };
    await seedStarterHome(writeIfMissing);
    const seeded = homes.get("AGENTS.md") ?? "";
    expect(seeded).toContain("## First conversation");
    expect(seeded).toContain('skill.load({name: "setup-fungi"})');
    expect(seeded).toContain("delete this section");
    expect(seeded).toContain("AGENTS.md and load");
    expect(seeded).not.toContain("computer://");
    // The Agent keeps its own instructions current, and never saves secrets.
    expect(seeded).toContain("## About my person");
    expect(seeded).toContain("## Keeping this file up to date");
    expect(seeded).toContain("Never save secrets");
    homes.set("AGENTS.md", "mine");
    await seedStarterHome(writeIfMissing);
    expect(homes.get("AGENTS.md")).toBe("mine");
  });
});
