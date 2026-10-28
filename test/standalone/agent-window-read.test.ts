import { fauxModel } from "@fungi.computer/mule/testing";
import {
  ShiitakeOwner,
  type CloudflareShiitakeOptions,
  type CloudflareShiitakeState,
} from "@fungi.computer/shiitake/cloudflare";
import { seededAvatar } from "@fungi.computer/sprite/avatar";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import * as Schema from "effect/Schema";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

import { agentCapabilities, type OysterAgents } from "../../src/agents.js";
import { computerTargetUrl } from "../../src/computer-target.js";
import { capabilityFixture } from "../../src/testing/capabilities.js";

/** One fresh Agent's real Shiitake owner over in-memory SQLite. */
class FreshAgent extends ShiitakeOwner<Readonly<Record<string, never>>> {
  constructor(
    state: CloudflareShiitakeState,
    private readonly options: CloudflareShiitakeOptions,
  ) {
    super(state, {});
  }
  protected override shiitakeOptions(): CloudflareShiitakeOptions {
    return this.options;
  }
}

function freshAgent(database: DatabaseSync): FreshAgent {
  const owner = fromNodeSqlite(database);
  let transaction: Promise<unknown> = Promise.resolve();
  const faux = fauxModel([]);
  return new FreshAgent(
    {
      storage: {
        ...owner,
        getAlarm: () => Promise.resolve(null),
        setAlarm: () => Promise.resolve(),
        deleteAlarm: () => Promise.resolve(),
        transaction: (operation) => {
          const current = transaction.then(operation, operation);
          transaction = current;
          return current;
        },
      },
      waitUntil: () => undefined,
    },
    {
      extensions: { roster: [], grants: [] },
      model: {
        acquire: () =>
          Promise.resolve({
            retryable: () => false,
            model: faux.model,
            stream: faux.stream,
            release: () => Promise.resolve(),
          }),
      },
      instructions: {
        load: () => Promise.resolve({ revision: "fresh-v1", text: "Tend." }),
      },
      tools: [],
    },
  );
}

const notInTest = () =>
  Promise.reject(new Error("This test only opens one fresh Agent's Session"));
const notInTestSync = (): never => {
  throw new Error("This test only opens one fresh Agent's Session");
};

it("opens a fresh Agent's new Session from a desk window that carries its Computer hint", async () => {
  const database = new DatabaseSync(":memory:");
  const agent = freshAgent(database);
  const owner = {
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  } as const;
  const fresh = {
    agentId: "agent_fresh",
    name: "Fresh",
    avatar: seededAvatar("agent_fresh"),
    sessionOperations: ["agent.read", "agent.send", "agent.manage"],
  } as const;
  const agents: OysterAgents = {
    list: () => Promise.resolve([fresh]),
    fetch: (agentId, request) =>
      agentId === fresh.agentId ? agent.fetch(request) : Promise.resolve(null),
    policyRevision: () => Promise.resolve(null),
    policyStatus: () => Promise.resolve(null),
    appToolPolicy: () => Promise.resolve(null),
    create: notInTest,
    rename: notInTest,
    setAvatar: notInTest,
    readModelChoice: notInTest,
    decodeModelChoice: notInTestSync,
    setModelChoice: notInTest,
    approveAppToolPolicy: notInTest,
    mcpServers: notInTest,
    addMcpServer: notInTest,
    removeMcpServer: notInTest,
    inbox: notInTest,
    revision: notInTest,
    visit: notInTest,
  };
  const liveKey = () => Promise.resolve(null);
  const host = await capabilityFixture({
    capabilities: ["agent.list", "agent.manage", "agent.read", "agent.send"],
    adapters: agentCapabilities(agents, liveKey),
    agents,
    liveKey,
    authenticate: () => Promise.resolve({ kind: "admitted", principal: owner }),
  });
  // Tourtois mounts Grove in a window bound to the Workspace Computer, so
  // every capability request carries that window's routing hint.
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-Oyster-Installation", "capability-fixture");
    return host.app.request(
      `https://oyster.test${computerTargetUrl(path, "workspace")}`,
      { ...init, headers },
    );
  };
  try {
    const created = await call(`/agents/${fresh.agentId}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request_fresh" }),
    });
    expect(created.status).toBe(201);
    const { sessionId } = Schema.decodeUnknownSync(
      Schema.Struct({ sessionId: Schema.String }),
    )(await created.json());

    const read = await call(
      `/agents/${fresh.agentId}/sessions/${sessionId}?limit=200`,
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      sessionId,
      cursor: null,
      hasMore: false,
      messages: [],
    });
  } finally {
    database.close();
  }
});
