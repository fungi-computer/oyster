import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { fauxModel } from "@fungi.computer/mule/testing";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import { FungiMessageMetaSchema } from "@fungi.computer/agar/agents";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import type * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vitest";

import { StandaloneAgentBase } from "../../src/standalone/agents.js";
import { defaultTenant, tenantScope } from "../../src/tenant.js";
import {
  proveRedactionFailsClosed,
  proveSessionRedaction,
  vaultCanary,
  type RedactionLawHost,
} from "../../../shiitake/test/fixtures/session-redaction-laws.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";
import { discordDirectoryFixture } from "./discord-channel.fixture.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type VaultAgentOptions = Pick<
  CloudflareShiitakeOptions,
  "model" | "tools" | "compaction"
>;

/** The production Agent with its production Vault port; tools and model are scripted. */
class VaultAgent extends StandaloneAgentBase {
  options: VaultAgentOptions | undefined;
  protected hostFor(): never {
    return unavailable();
  }
  protected override shiitakeOptions(): Promise<CloudflareShiitakeOptions> {
    const options = this.options;
    if (options === undefined) throw new Error("fixture: no options");
    return Promise.resolve({
      ...options,
      extensions: { roster: [], grants: [] },
      meta: { schema: FungiMessageMetaSchema },
      instructions: {
        load: () => Promise.resolve({ revision: "v1", text: "Help." }),
      },
      redaction: this.vaultRedaction(),
    });
  }
  owner() {
    return this.shiitake();
  }
  close() {
    return this.closeShiitake();
  }
}

/**
 * The real instance directory seals the canary as a Cloudflare model key, a
 * JSON-shaped secret; the Agent's Sessions learn of it only by fingerprint.
 */
const oysterHost: RedactionLawHost = async (input) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({}, { status: 200 }))),
  );
  const base = discordDirectoryFixture();
  const sealed = await base.directory.sealModelKey({
    provider: "cloudflare-workers-ai",
    label: "Canary",
    apiKey: vaultCanary,
    accountId: "0123456789abcdef0123456789abcdef",
  });
  if ("error" in sealed) throw new Error(`fixture: ${sealed.error}`);

  const directory = mkdtempSync(join(tmpdir(), "oyster-vault-"));
  directories.push(directory);
  const path = join(directory, "agent.sqlite");
  const db = new DatabaseSync(path);
  const kv = new Map<string, Schema.Json>([
    [
      "app-policy-directory",
      {
        directoryName: tenantScope(
          defaultTenant,
          "https://oyster.test",
        ).durableName("agents"),
        tenantId: defaultTenant,
      },
    ],
  ]);
  const tasks: Promise<unknown>[] = [];
  const state = agentDurableObjectState(() => 0);
  Object.defineProperty(state, "storage", {
    value: {
      ...state.storage,
      ...cloudflareStorageFixture(fromNodeSqlite(db)),
      get: (key: string) => Promise.resolve(kv.get(key)),
      put: (key: string, value: Schema.Json) => {
        kv.set(key, value);
        return Promise.resolve();
      },
    },
  });
  Object.defineProperty(state, "id", {
    value: { ...state.id, name: base.agent.agentId },
  });
  Object.defineProperty(state, "waitUntil", {
    value: (work: Promise<unknown>) => {
      tasks.push(work);
    },
  });
  const env = agentEnv();
  const down = {
    redactionFingerprints: () =>
      Promise.reject(new Error("The directory is unreachable")),
  };
  Object.defineProperty(env, "AGENT_DIRECTORY", {
    value: {
      getByName: () => (input.portDown() ? down : base.directory),
    },
  });

  const faux = fauxModel([]);
  faux.setResponses([...input.responses]);
  const agent = new VaultAgent(state, env);
  agent.options = {
    model: {
      acquire: () =>
        Promise.resolve({
          model: faux.model,
          retryable: () => false,
          stream: faux.stream,
          release: () => Promise.resolve(),
        }),
    },
    tools: { sandbox: directSandbox(() => Promise.resolve(input.toolOutput)) },
    compaction: input.compaction,
  };
  /** Run the Agent's due work the way its alarm would. */
  const drive = async () => {
    await agent.alarm();
    while (tasks.length > 0) for (const task of tasks.splice(0)) await task;
  };
  const owner = await agent.owner();
  return {
    session: (sessionId) => {
      const session = owner.session(sessionId);
      return {
        send: (text, options) => session.send(text, options),
        compact: (requestId) => session.command({ type: "compact", requestId }),
        read: () => session.read(),
        readSettlement: async (commandId, options) => {
          await drive();
          return session.readSettlement(commandId, options);
        },
        subscribe: (options) => session.subscribe(options),
        watch: () => session.watch(),
      };
    },
    storedBytes: () => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return Promise.resolve(readFileSync(path));
    },
    close: async () => {
      await agent.close();
      db.close();
      base.close();
    },
  };
};

it("scrubs a stored Vault value from an Oyster Agent's model request, store, reads, replay, live frames and compaction", async () => {
  await proveSessionRedaction(oysterHost);
});

it("withholds output and fails the run when the Oyster directory cannot send fingerprints", async () => {
  await proveRedactionFailsClosed(oysterHost);
});

it("passes the production Agent's Vault port to Shiitake", async () => {
  const env = agentEnv();
  class ProbedAgent extends StandaloneAgentBase {
    protected hostFor(): never {
      return unavailable();
    }
    probe() {
      return this.vaultRedaction();
    }
  }
  const db = new DatabaseSync(":memory:");
  const state = agentDurableObjectState(() => 0);
  Object.defineProperty(state, "storage", {
    value: {
      ...state.storage,
      ...cloudflareStorageFixture(fromNodeSqlite(db)),
    },
  });
  try {
    // An Agent no directory has adopted has no Vault to ask: it fails closed.
    await expect(new ProbedAgent(state, env).probe().load()).rejects.toThrow(
      "Agent directory is unavailable",
    );
  } finally {
    db.close();
  }
});
