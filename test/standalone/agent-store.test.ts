import { fauxModel } from "@fungi.computer/mule/testing";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { parseAccepted } from "@fungi.computer/shiitake/client";
import {
  createFleetDelegation,
  type AgentGrant,
} from "@fungi.computer/shiitake/fleet";
import {
  AttentionItemSchema,
  defineExtension,
  ExtensionId,
} from "@fungi.computer/shiitake/extensions";
import {
  type CloudflareShiitakeState,
  type CloudflareShiitakeOptions,
} from "@fungi.computer/shiitake/cloudflare";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { botanicalAgentExtensions } from "@fungi.computer/shiitake-extensions/roster";
import {
  almanacContract,
  Schedule,
} from "@fungi.computer/shiitake-extensions/almanac";
import {
  loopContract,
  LoopProjection,
} from "@fungi.computer/shiitake-extensions/loop";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { agentStoreKeeping } from "../../src/standalone/agent-store.js";
import { agentArchive } from "../../src/standalone/agent-archive.js";
import { reconcileArchiveSchedules } from "../../src/standalone/agent-archive-schedules.js";
import { StandaloneAgentBase } from "../../src/standalone/agents.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";
import { defaultTenant } from "../../src/tenant.js";

/** The typed state of an Agent owner: Cloudflare's storage plus its measured size. */
type AgentState = CloudflareShiitakeState &
  Readonly<{
    storage: CloudflareShiitakeState["storage"] &
      Readonly<{ sql: Readonly<{ databaseSize: number }> }>;
  }>;

function agentState(
  database: DatabaseSync,
  tasks: Promise<unknown>[],
  databaseSize: () => number,
): AgentState {
  const owner = fromNodeSqlite(database);
  let alarm: number | null = null;
  let transaction: Promise<unknown> = Promise.resolve();
  return {
    storage: {
      ...owner,
      sql: {
        exec: (statement, ...bindings) =>
          owner.sql.exec(statement, ...bindings),
        get databaseSize() {
          return databaseSize();
        },
      },
      getAlarm: () => Promise.resolve(alarm),
      setAlarm: (at) => {
        alarm = at instanceof Date ? at.getTime() : at;
        return Promise.resolve();
      },
      deleteAlarm: () => {
        alarm = null;
        return Promise.resolve();
      },
      transaction: (operation) => {
        const current = transaction.then(operation, operation);
        transaction = current;
        return current;
      },
    },
    waitUntil: (task) => {
      tasks.push(task);
    },
  };
}

/** A real Oyster Agent, with only its remote tools and model replaced. */
class KeptAgent extends StandaloneAgentBase {
  constructor(
    state: DurableObjectState,
    private readonly base: CloudflareShiitakeOptions,
  ) {
    super(state, archiveEnv());
  }
  protected hostFor(): never {
    return unavailable();
  }
  override policyDirectory() {
    return Promise.resolve({
      directoryName: "test-agent-directory",
      tenantId: defaultTenant,
    });
  }
  protected override shiitakeOptions(): Promise<CloudflareShiitakeOptions> {
    return Promise.resolve({
      ...this.base,
      ...agentStoreKeeping(this.ctx.storage, (request) =>
        this.readColdSessions(request),
      ),
    });
  }
  client() {
    return this.shiitake();
  }
  close() {
    return this.closeShiitake();
  }
}

function archiveEnv() {
  const env = agentEnv();
  Object.defineProperty(env, "AGENT_DIRECTORY", {
    value: {
      getByName: () => ({ recordArchive: () => Promise.resolve(true) }),
    },
  });
  return env;
}

function open(
  databaseSize: () => number,
  extensions: CloudflareShiitakeOptions["extensions"] = {
    roster: [],
    grants: [],
  },
) {
  const database = new DatabaseSync(":memory:");
  const tasks: Promise<unknown>[] = [];
  const state = agentState(database, tasks, databaseSize);
  const platform = agentDurableObjectState(databaseSize);
  Object.assign(platform.storage, {
    ...state.storage,
    sql: Object.assign(platform.storage.sql, { exec: state.storage.sql.exec }),
  });
  Object.assign(platform, { waitUntil: state.waitUntil });
  const faux = fauxModel([]);
  faux.setResponses([
    fauxAssistantMessage("Admitted before pressure"),
    fauxAssistantMessage("Admitted after pressure cleared"),
  ]);
  const agent = new KeptAgent(platform, {
    extensions,
    model: {
      acquire: ({ signal }) => {
        signal.throwIfAborted();
        return Promise.resolve({
          retryable: () => false,
          model: faux.model,
          stream: faux.stream,
          release: () => Promise.resolve(),
        });
      },
    },
    instructions: {
      load: () => Promise.resolve({ revision: "store-v1", text: "Tend." }),
    },
    tools: [],
  });
  const prompt = (sessionId: string, requestId: string) =>
    agent.fetch(
      new Request(`https://oyster.test/sessions/${sessionId}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: {
            requestId,
            type: "prompt",
            text: "Tend the garden.",
            delivery: "followUp",
          },
        }),
      }),
    );
  const settle = async () => {
    for (const task of tasks) await task;
  };
  return {
    agent,
    state,
    prompt,
    settle,
    close: () => {
      database.close();
    },
  };
}

it("refuses settlement disclosure to a caller outside the Agent's directory", async () => {
  const kept = open(() => 100_000_000);
  try {
    expect(
      await kept.agent.settlement(
        {
          teamId: "other-agent-directory",
          actor: { kind: "agent", id: "caller" },
        },
        "private-session",
        "private-command",
      ),
    ).toBeUndefined();
  } finally {
    await kept.agent.close();
    kept.close();
  }
});

it("refuses a new prompt with storage_pressure near the Agent's budget, and still admits a replay", async () => {
  let databaseSize = 0;
  const kept = open(() => databaseSize);
  try {
    const admitted = await kept.prompt("pressure-session", "pressure-admitted");
    await kept.settle();
    expect(admitted.status).toBe(200);
    const receipt = parseAccepted(await admitted.text());

    databaseSize = 9_000_000_000;
    const refused = await kept.prompt("pressure-session", "pressure-refused");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await refused.json()).toMatchObject({
      boundary: "store",
      cause: "storage_pressure",
    });
    const replay = await kept.prompt("pressure-session", "pressure-admitted");
    expect(replay.status).toBe(200);
    expect(parseAccepted(await replay.text())).toEqual(receipt);

    databaseSize = 7_000_000_000;
    const resumed = await kept.prompt("pressure-session", "pressure-resumed");
    await kept.settle();
    expect(resumed.status).toBe(200);
  } finally {
    await kept.agent.close();
    kept.close();
  }
});

it("refuses archive while a real Session has queued work, without changing the flag", async () => {
  const kept = open(() => 100_000_000);
  try {
    const sessionId = "busy-session";
    const response = await kept.prompt(sessionId, "busy-request");
    expect(response.status).toBe(200);
    const { commandId } = parseAccepted(await response.text());
    const refused = await kept.agent.setArchived(true);
    expect(refused).toMatchObject({ error: "running" });
    if (!("message" in refused))
      throw new Error("Missing archive refusal message");
    expect(refused.message).toContain(sessionId);
    expect(refused.message).toContain(commandId);
    expect(agentArchive(kept.state.storage.sql).read().archived).toBe(false);
    await kept.settle();
  } finally {
    await kept.agent.close();
    kept.close();
  }
});

it("refuses malformed host mail through a real standalone Agent", async () => {
  const kept = open(() => 100_000_000);
  try {
    expect(
      await kept.agent.deliver({
        key: "invalid-mail",
        kind: "agentMail",
        address: { scopeId: "test-agent-directory", agentId: "kept-agent" },
        event: null,
      }),
    ).toBe("refused");
  } finally {
    await kept.agent.close();
    kept.close();
  }
});

it("refuses archive while an accepted delegation remains unsettled", async () => {
  const kept = open(() => 100_000_000);
  const grant: AgentGrant = {
    agents: ["parent", "child"],
    actions: ["delegate"],
    expiresAt: Date.now() + 60_000,
    provenance: {
      actor: "parent",
      session: { agentId: "parent", sessionId: "parent-session" },
    },
  };
  try {
    const fleet = createFleetDelegation({
      storage: kept.state.storage,
      open: () => Promise.reject(new Error("No target client is needed")),
      deliver: () =>
        Promise.resolve({ status: "accepted", commandId: "remote-work" }),
      readSettlement: () => Promise.resolve(undefined),
    });
    await fleet.start(grant, {
      requestId: "delegated-work",
      agentId: "child",
      sessionId: "child-session",
      text: "Complete once",
    });
    expect(await kept.agent.setArchived(true)).toMatchObject({
      error: "pending",
    });
    expect(agentArchive(kept.state.storage.sql).read().archived).toBe(false);
  } finally {
    await kept.agent.close();
    kept.close();
  }
});

it("admits archive after a settled Session is idle", async () => {
  const attention = defineExtension({
    id: ExtensionId.make("archive-attention"),
    version: "1.0.0",
  }).define({
    attention: true,
    commands: {
      specs: {
        set: {
          scope: "session",
          input: AttentionItemSchema,
          output: Schema.Null,
        },
      },
      handlers: (ctx) => ({
        set: ({ sessionId, input }) =>
          ctx.attention.set(sessionId, input).pipe(Effect.as(null)),
      }),
    },
  });
  const kept = open(() => 100_000_000, {
    roster: [...botanicalAgentExtensions.roster, attention],
    grants: [
      ...botanicalAgentExtensions.grants,
      { id: attention.manifest.id, capabilities: attention.manifest.requests },
    ],
  });
  try {
    expect((await kept.prompt("idle-session", "idle-work")).status).toBe(200);
    await kept.settle();
    const agent = await kept.agent.client();
    await agent
      .session("idle-session")
      .extension(attention.manifest.id)
      .call("set", {
        id: "needs-you",
        kind: "question",
        summary: "Choose a destination",
        since: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
    expect((await agent.listSessions()).sessions[0]).toMatchObject({
      state: "needs_you",
    });
    expect(agent.busySync()).toBeUndefined();
    expect(await kept.agent.setArchived(true)).toMatchObject({
      archived: true,
    });
    expect(agentArchive(kept.state.storage.sql).read().archived).toBe(true);
  } finally {
    await kept.agent.close();
    kept.close();
  }
});

it("fails closed when a real Agent's busy read is unreadable", async () => {
  const kept = open(() => 100_000_000);
  try {
    expect(
      (await kept.prompt("unreadable-session", "read-before-corruption"))
        .status,
    ).toBe(200);
    await kept.settle();
    // The real inbox decoder fails closed on a corrupt persisted Session row.
    kept.state.storage.sql.exec(
      "UPDATE session_inbox SET title = X'FF' WHERE session_id = ?",
      "unreadable-session",
    );
    const agent = await kept.agent.client();
    expect(() =>
      kept.state.storage.transactionSync(() => agent.busySync()),
    ).toThrow();
    expect(await kept.agent.setArchived(true)).toMatchObject({
      error: "unreadable",
    });
    expect(agentArchive(kept.state.storage.sql).read().archived).toBe(false);
  } finally {
    kept.state.storage.sql.exec(
      "UPDATE session_inbox SET title = NULL WHERE session_id = ?",
      "unreadable-session",
    );
    await kept.agent.close();
    kept.close();
  }
});

it.each([
  { store: "quiet", databaseSize: 100_000_000, armed: false },
  {
    store: "over the Zookeeper waterline",
    databaseSize: 6_000_000_000,
    armed: true,
  },
])(
  "arms the patrol alarm only for real store work: $store store, armed=$armed",
  async ({ databaseSize, armed }) => {
    const kept = open(() => databaseSize);
    try {
      const before = Date.now();
      const accepted = await kept.prompt("alarm-session", "alarm-prompt");
      await kept.settle();
      expect(accepted.status).toBe(200);
      const wake = await kept.state.storage.getAlarm();
      if (armed) {
        // The patrol's own five-minute cadence, not the 5 s recovery alarm.
        expect(wake ?? 0).toBeGreaterThanOrEqual(before + 300_000 - 5_000);
      } else {
        expect(wake).toBeNull();
      }
    } finally {
      await kept.agent.close();
      kept.close();
    }
  },
);

it("pauses only active Almanac and Loop timers and restores only archive-paused ones", async () => {
  const kept = open(() => 100_000_000, botanicalAgentExtensions);
  try {
    const agent = await kept.agent.client();
    const sessionId = await agent.createSession("archive-schedules-session");
    const dueAt = Date.now() + 3_600_000;
    for (const requestId of ["active-schedule", "human-paused"]) {
      await agent.extensions.call(almanacContract.id, "createOneShot", {
        requestId,
        sessionId,
        prompt: "Tend the beds",
        dueAt,
      });
    }
    await agent.extensions.call(almanacContract.id, "pause", {
      scheduleId: "human-paused",
    });
    await agent
      .session(sessionId)
      .extension(loopContract.id)
      .call("startFixedInterval", {
        prompt: "Tend the beds",
        requestId: "archive-loop",
        expression: "0 * * * *",
        timeZone: "UTC",
      });
    await kept.settle();
    const archive = agentArchive(kept.state.storage.sql);
    archive.transition(true);
    await reconcileArchiveSchedules(agent, archive, true);
    expect(archive.suspended()).toEqual([
      { kind: "almanac", id: "active-schedule" },
      { kind: "loop", id: sessionId },
    ]);
    const readSchedule = async (id: string) =>
      Schema.decodeUnknownSync(Schema.NullOr(Schedule))(
        await agent.extensions.call(almanacContract.id, "read", {
          scheduleId: id,
        }),
      );
    expect((await readSchedule("active-schedule"))?.state).toBe("paused");
    expect((await readSchedule("human-paused"))?.state).toBe("paused");
    const readLoop = async () => {
      const slot = (await agent.session(sessionId).read({ limit: 1 }))
        .extensions[loopContract.id];
      if (slot?.status !== "running") throw new Error("No loop projection");
      return Schema.decodeUnknownSync(LoopProjection)(slot.value).loop;
    };
    expect((await readLoop()).state).toBe("paused");
    archive.transition(false);
    await reconcileArchiveSchedules(agent, archive, false);
    expect(archive.suspended()).toEqual([]);
    expect((await readSchedule("active-schedule"))?.state).toBe("active");
    expect((await readSchedule("human-paused"))?.state).toBe("paused");
    expect((await readLoop()).state).toBe("active");
  } finally {
    await kept.agent.close();
    kept.close();
  }
});
