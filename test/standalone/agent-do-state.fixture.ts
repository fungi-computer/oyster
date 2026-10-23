import type { StandaloneAgentEnv } from "../../src/standalone/agents.js";

/** A platform door this test never opens; reaching it is a failure of the test. */
export function unavailable(): never {
  throw new Error("Not part of the Agent store fixture");
}

/**
 * The typed Durable Object state of an Oyster Agent over a controllable
 * `databaseSize`: the platform's own `DurableObjectState`, so the production
 * class is constructed without a cast. Only the size is real.
 */
export function agentDurableObjectState(
  databaseSize: () => number,
): DurableObjectState {
  const sql: SqlStorage = {
    exec: unavailable,
    get databaseSize() {
      return databaseSize();
    },
    get Cursor(): SqlStorage["Cursor"] {
      return unavailable();
    },
    get Statement(): SqlStorage["Statement"] {
      return unavailable();
    },
  };
  const storage: DurableObjectStorage = {
    get: unavailable,
    list: unavailable,
    put: unavailable,
    delete: unavailable,
    deleteAll: unavailable,
    transaction: unavailable,
    getAlarm: unavailable,
    setAlarm: unavailable,
    deleteAlarm: unavailable,
    sync: unavailable,
    sql,
    kv: {
      get: unavailable,
      put: unavailable,
      delete: unavailable,
      list: unavailable,
    },
    transactionSync: unavailable,
    getCurrentBookmark: unavailable,
    getBookmarkForTime: unavailable,
    onNextSessionRestoreBookmark: unavailable,
  };
  return {
    waitUntil: unavailable,
    get exports(): Cloudflare.Exports {
      return unavailable();
    },
    props: undefined,
    id: {
      name: "agent_fixture",
      toString: () => "agent_fixture",
      equals: unavailable,
    },
    storage,
    facets: {
      get: unavailable,
      abort: unavailable,
      delete: unavailable,
      clone: unavailable,
    },
    blockConcurrencyWhile: unavailable,
    acceptWebSocket: unavailable,
    getWebSockets: unavailable,
    setWebSocketAutoResponse: unavailable,
    getWebSocketAutoResponse: unavailable,
    getWebSocketAutoResponseTimestamp: unavailable,
    setHibernatableWebSocketEventTimeout: unavailable,
    getHibernatableWebSocketEventTimeout: unavailable,
    getTags: unavailable,
    abort: unavailable,
  };
}

/** The Agent's whole env with every binding a door this test never opens. */
export function agentEnv(): StandaloneAgentEnv {
  return {
    OYSTER_ORIGIN: "https://oyster.test",
    OYSTER_OWNER_KEY: "fixture-owner-key-not-a-secret",
    get MACHINE_LINK(): StandaloneAgentEnv["MACHINE_LINK"] {
      return unavailable();
    },
    get AGENTS(): StandaloneAgentEnv["AGENTS"] {
      return unavailable();
    },
    get MCP(): StandaloneAgentEnv["MCP"] {
      return unavailable();
    },
    get RELEASES(): StandaloneAgentEnv["RELEASES"] {
      return unavailable();
    },
    get REGISTRY(): StandaloneAgentEnv["REGISTRY"] {
      return unavailable();
    },
    get INSTANCES(): StandaloneAgentEnv["INSTANCES"] {
      return unavailable();
    },
    LOADER: { get: unavailable, load: unavailable },
    OYSTER_COMPUTER_ID: "agent-fixture",
    get COMPUTER(): StandaloneAgentEnv["COMPUTER"] {
      return unavailable();
    },
    get KEYS(): StandaloneAgentEnv["KEYS"] {
      return unavailable();
    },
    get AGENT_DIRECTORY(): StandaloneAgentEnv["AGENT_DIRECTORY"] {
      return unavailable();
    },
  };
}
