import { fauxModel } from "@fungi.computer/mule/testing";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { parseAccepted } from "@fungi.computer/shiitake/client";
import {
  ShiitakeOwner,
  type CloudflareShiitakeOptions,
  type CloudflareShiitakeState,
} from "@fungi.computer/shiitake/cloudflare";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

import { agentStoreKeeping } from "../../src/standalone/agent-store.js";

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

/** A Shiitake owner given the store keeping the Oyster Agent passes (the Agent class itself is proven in agent-do-wiring.test.ts). */
class KeptAgent extends ShiitakeOwner<
  Readonly<Record<string, never>>,
  AgentState
> {
  constructor(
    state: AgentState,
    private readonly base: CloudflareShiitakeOptions,
  ) {
    super(state, {});
  }
  protected override shiitakeOptions(): CloudflareShiitakeOptions {
    return {
      ...this.base,
      ...agentStoreKeeping(this.ctx.storage, (request) =>
        this.readColdSessions(request),
      ),
    };
  }
}

function open(databaseSize: () => number) {
  const database = new DatabaseSync(":memory:");
  const tasks: Promise<unknown>[] = [];
  const state = agentState(database, tasks, databaseSize);
  const faux = fauxModel([]);
  faux.setResponses([
    fauxAssistantMessage("Admitted before pressure"),
    fauxAssistantMessage("Admitted after pressure cleared"),
  ]);
  const agent = new KeptAgent(state, {
    extensions: { roster: [], grants: [] },
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
      kept.close();
    }
  },
);
