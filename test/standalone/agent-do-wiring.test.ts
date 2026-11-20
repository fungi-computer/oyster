import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

import {
  StandaloneAgentBase,
  type StandaloneAgentEnv,
  type StandaloneModelSource,
} from "../../src/standalone/agents.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";
import type { AgentEngine } from "../../src/standalone/agent-engine.js";

/** The production Agent class, with only its root host and model door filled in. */
class ProbedAgent extends StandaloneAgentBase {
  protected hostFor(): never {
    return unavailable();
  }
  protected override modelSource(): StandaloneModelSource {
    return {
      acquire: () => Promise.reject(new Error("No model in this test")),
    };
  }
  /** The options the Agent hands Shiitake's Cloudflare host. */
  probe(): Promise<CloudflareShiitakeOptions> {
    return this.shiitakeOptions();
  }
}

async function withProbe(
  databaseSize: () => number,
  check: (options: CloudflareShiitakeOptions) => void | Promise<void>,
) {
  const database = new DatabaseSync(":memory:");
  const state = agentDurableObjectState(databaseSize);
  Object.assign(state.storage.sql, { exec: fromNodeSqlite(database).sql.exec });
  const env: StandaloneAgentEnv = agentEnv();
  try {
    await check(await new ProbedAgent(state, env).probe());
  } finally {
    database.close();
  }
}

/** The production Agent class over a recording engine instead of Shiitake. */
class EngineProbedAgent extends ProbedAgent {
  readonly calls: string[] = [];
  protected override engine(): AgentEngine {
    const calls = this.calls;
    return {
      kind: "shiitake",
      fetch: (request) => {
        calls.push(`fetch ${new URL(request.url).pathname}`);
        return Promise.resolve(new Response("from the engine"));
      },
      alarm: () => {
        calls.push("alarm");
        return Promise.resolve();
      },
      wake: () => {
        calls.push("wake");
        return Promise.resolve();
      },
      agent: () => {
        calls.push("agent");
        return Promise.reject(new Error("engine agent"));
      },
      inboxChanges: (after, limit) => {
        calls.push(`inbox ${String(after)} ${String(limit)}`);
        return Promise.resolve({
          rows: [{ sessionId: "gone", deleted: true }],
          through: 7,
          latest: 7,
        });
      },
      inboxRevision: () => {
        calls.push("revision");
        return Promise.resolve(7);
      },
      hasStoredSession: () => Promise.resolve(false),
      coldSessions: () => Promise.reject(new Error("not read here")),
      close: () => Promise.resolve(),
    };
  }
}

it("routes the Agent's Session wire, alarm, inbox and App sends through its engine", async () => {
  const database = new DatabaseSync(":memory:");
  const state = agentDurableObjectState(() => 100_000_000);
  Object.assign(state.storage.sql, { exec: fromNodeSqlite(database).sql.exec });
  try {
    const agent = new EngineProbedAgent(state, agentEnv());
    const response = await agent.fetch(
      new Request("https://agent.test/sessions"),
    );
    expect(await response.text()).toBe("from the engine");
    await agent.alarm();
    expect(await agent.revision()).toBe(7);
    expect(await agent.inboxRows()).toEqual({ rows: [], revision: 7 });
    await expect(
      agent.sendFromApp("installation-1", "session-1", {
        requestId: "request-1",
        text: "hello",
      }),
    ).rejects.toThrow("engine agent");
    expect(agent.calls).toEqual([
      "fetch /sessions",
      "alarm",
      "revision",
      "inbox 0 1000",
      "agent",
    ]);
  } finally {
    database.close();
  }
});

it("hands Shiitake a storage-pressure check over the Agent's own measured store", async () => {
  let databaseSize = 100_000_000;
  await withProbe(
    () => databaseSize,
    ({ storagePressure }) => {
      if (storagePressure === undefined)
        throw new Error("The Agent passes no storage-pressure check");
      expect(storagePressure.underPressure()).toBe(false);
      databaseSize = 9_000_000_000;
      expect(storagePressure.underPressure()).toBe(true);
    },
  );
});

it("offers the self-identity capability in the standalone runtime", async () => {
  await withProbe(
    () => 0,
    async ({ tools }) => {
      const sources =
        tools !== undefined && "sandbox" in tools ? (tools.sources ?? []) : [];
      const source = sources.find(
        (source) => source.id === "oyster-agent-self",
      );
      expect(source).toBeDefined();
      if (source === undefined) throw new Error("self source missing");
      const lease = await source.acquire({
        signal: new AbortController().signal,
        session: { sessionId: "owner-session" },
        invalidate: () => undefined,
      });
      expect(lease.snapshot.modules).toHaveLength(1);
      await lease.release();
    },
  );
});

it("hands Shiitake the Zookeeper patrol, which wakes only over the waterline", async () => {
  let databaseSize = 100_000_000;
  await withProbe(
    () => databaseSize,
    ({ hostWork }) => {
      // Delivery belongs to hostJobs; hostWork keeps the patrol, the archive
      // and the Discord replies an evicted run still owes.
      expect(hostWork).toHaveLength(3);
      const [patrol] = hostWork ?? [];
      if (patrol === undefined) throw new Error("The Agent passes no patrol");
      expect(patrol.pending().nextWakeAt).toBeNull();
      databaseSize = 6_000_000_000;
      expect(patrol.pending().nextWakeAt).not.toBeNull();
    },
  );
});

it("passes the Agent's durable archive flag into the common Shiitake door", async () => {
  const database = new DatabaseSync(":memory:");
  const sql = fromNodeSqlite(database).sql;
  const state = agentDurableObjectState(() => 100_000_000);
  Object.assign(state.storage.sql, { exec: sql.exec });
  try {
    const agent = new ProbedAgent(state, agentEnv());
    const { admission } = await agent.probe();
    if (admission === undefined) throw new Error("No archive admission");
    expect(() => {
      admission.assertOpen();
    }).not.toThrow();
    state.storage.sql.exec(
      "UPDATE oyster_agent_archive SET archived=1 WHERE singleton=1",
    );
    expect(() => {
      admission.assertOpen();
    }).toThrow("Agent is archived");
  } finally {
    database.close();
  }
});

it("gives an Oyster Agent skills but no setup.finish, so the setup skill never reaches the money line", async () => {
  await withProbe(
    () => 100_000_000,
    ({ extensions }) => {
      const ids = extensions.roster.map(({ manifest }) => manifest.id);
      // The skills extension serves the built-in setup-fungi skill; the Hub
      // alone adds a tool that ends an invite allowance.
      expect(ids).toContain("botanical-skills");
      expect(
        ids.filter((id) => /setup|finish|billing|credit/u.test(id)),
      ).toEqual([]);
    },
  );
});
