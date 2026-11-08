/**
 * The starter Agent policy: an owner with an empty Team gets one Agent named
 * "Shiitake", once, ever. This module owns only that rule and its one-row
 * ledger. It never creates anything itself: the host supplies its ordinary,
 * idempotent Agent create, so the starter has exactly the identity, Computer,
 * App tools and funding checks of any other Agent. It stores no model, prompt,
 * session or tool grant.
 */
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";

/** The declaration. Changing it affects only Teams with no ledger row. */
export const starterAgent = {
  version: 1,
  name: "Shiitake",
  requestId: "starter-agent:v1",
} as const;

/** What the ledger remembers: that the starter was settled, never to be offered again. */
export type StarterLedgerRow = Readonly<{
  version: number;
  outcome: "created" | "team-not-empty";
  agentId: string | null;
  at: number;
}>;

/** One row per Team in the host's own SQLite. */
export type StarterLedgerStore = Readonly<{
  read(): StarterLedgerRow | undefined;
  /** First write wins; a later one is ignored. */
  record(row: StarterLedgerRow): void;
}>;

/** The ledger as the policy reads it; a host across an RPC awaits its store. */
export type StarterLedger = Readonly<{
  read(): StarterLedgerRow | undefined | Promise<StarterLedgerRow | undefined>;
  record(row: StarterLedgerRow): void | Promise<void>;
}>;

/** The host's ordinary create, as the starter sees it. */
export type StarterCreateResult =
  | Readonly<{ status: "created"; agentId: string }>
  | Readonly<{ status: "unfunded" }>;

export type StarterAgentHost = Readonly<{
  ledger: StarterLedger;
  /** Only the Team owner's read may trigger the starter. */
  isOwner(): boolean;
  /** Agents in the Team, archived ones included. */
  agentCount(): number | Promise<number>;
  /** The host's normal create, replayed by `requestId`; funding refusal is `unfunded`. */
  create(request: {
    name: string;
    requestId: string;
  }): Promise<StarterCreateResult>;
  /** Where a failed attempt is reported; the caller's read never fails. */
  report?(cause: unknown): void;
  now?(): number;
}>;

/** How one offer of the starter Agent settled; only `created` made an Agent. */
export type StarterOutcome =
  | "created"
  | "already-offered"
  | "team-not-empty"
  | "unfunded"
  | "not-owner"
  | "failed";

const ledgerRowSchema = z.strictObject({
  version: z.number().int(),
  outcome: z.enum(["created", "team-not-empty"]),
  agent_id: z.string().nullable(),
  at: z.number(),
});

/** Open the one-row ledger in the host's own SQLite. */
export function createStarterLedger(
  sql: WatchdogSqliteOwner["sql"],
): StarterLedgerStore {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS starter_agent (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, outcome TEXT NOT NULL, agent_id TEXT, at INTEGER NOT NULL) STRICT",
  );
  return {
    read() {
      const row = sql
        .exec(
          "SELECT version, outcome, agent_id, at FROM starter_agent WHERE id = 1",
        )
        .toArray()[0];
      if (row === undefined) return undefined;
      const stored = ledgerRowSchema.parse(row);
      return {
        version: stored.version,
        outcome: stored.outcome,
        agentId: stored.agent_id,
        at: stored.at,
      };
    },
    record(row) {
      sql.exec(
        "INSERT INTO starter_agent(id, version, outcome, agent_id, at) VALUES(1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        row.version,
        row.outcome,
        row.agentId,
        row.at,
      );
    },
  };
}

const inFlight = new WeakMap<StarterLedger, Promise<StarterOutcome>>();

/**
 * Offer the starter Agent if this Team never had its chance. Safe to call on
 * every owner directory read: concurrent calls share one attempt, and the
 * host's `requestId` replay makes a second attempt return the same Agent.
 */
export function ensureStarterAgent(
  host: StarterAgentHost,
): Promise<StarterOutcome> {
  const running = inFlight.get(host.ledger);
  if (running !== undefined) return running;
  const attempt = settle(host).finally(() => inFlight.delete(host.ledger));
  inFlight.set(host.ledger, attempt);
  return attempt;
}

async function settle(host: StarterAgentHost): Promise<StarterOutcome> {
  try {
    if (!host.isOwner()) return "not-owner";
    if ((await host.ledger.read()) !== undefined) return "already-offered";
    const at = (host.now ?? Date.now)();
    if ((await host.agentCount()) > 0) {
      await host.ledger.record({
        version: starterAgent.version,
        outcome: "team-not-empty",
        agentId: null,
        at,
      });
      return "team-not-empty";
    }
    const result = await host.create({
      name: starterAgent.name,
      requestId: starterAgent.requestId,
    });
    if (result.status === "unfunded") return "unfunded";
    await host.ledger.record({
      version: starterAgent.version,
      outcome: "created",
      agentId: result.agentId,
      at,
    });
    return "created";
  } catch (cause) {
    host.report?.(cause);
    return "failed";
  }
}
