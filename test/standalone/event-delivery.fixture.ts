import { type DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { StandaloneEventDelivery } from "../../src/standalone/instance.js";
import {
  agentDurableObjectState,
  unavailable,
} from "./agent-do-state.fixture.js";

/** The instance keyring a standalone host reads from its environment. */
export type KeyringEnv = Partial<
  Record<
    | "OYSTER_CREDENTIAL_KEY"
    | "OYSTER_CREDENTIAL_KEY_ID"
    | "OYSTER_CREDENTIAL_PREVIOUS_KEYS",
    string
  >
>;

/** Durable Object SQL over Node SQLite, with the cursor fields the owner reads. */
function durableSql(database: DatabaseSync) {
  return {
    exec(statement: string, ...bindings: SQLInputValue[]) {
      const prepared = database.prepare(statement);
      if (prepared.columns().length > 0) {
        const rows = prepared.all(...bindings);
        return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 };
      }
      if (bindings.length === 0) {
        database.exec(statement);
        return { toArray: () => [], one: unavailable, rowsWritten: 0 };
      }
      const { changes } = prepared.run(...bindings);
      return {
        toArray: () => [],
        one: unavailable,
        rowsWritten: Number(changes),
      };
    },
  };
}

/** A standalone event delivery owner over a Node SQLite store and a keyring. */
export function eventDelivery(database: DatabaseSync, configured: KeyringEnv) {
  const state = agentDurableObjectState(() => 0);
  let alarm: number | null = null;
  Object.defineProperty(state, "storage", {
    value: {
      sql: durableSql(database),
      transactionSync: fromNodeSqlite(database).transactionSync,
      getAlarm: () => Promise.resolve(alarm),
      setAlarm: (at: number) => {
        alarm = at;
        return Promise.resolve();
      },
    },
  });
  Object.defineProperty(state, "blockConcurrencyWhile", {
    value: (body: () => Promise<void>) => body(),
  });
  return new StandaloneEventDelivery(state, {
    ...configured,
    WORKFLOW_RUNS: { getByName: unavailable },
  });
}
