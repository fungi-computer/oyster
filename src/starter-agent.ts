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

/** Seed only a missing Home file; the host supplies an atomic create-if-absent. */
export async function seedStarterHome(
  writeIfMissing: (content: string) => Promise<void>,
): Promise<void> {
  await writeIfMissing(starterHomeInstructions);
}

/**
 * The Home AGENTS.md a new Team's Agent starts with. It says nothing about
 * money; the person and the Agent both edit it from here on.
 */
const starterHomeInstructions = `# Shiitake's instructions

These are my standing instructions. They live on my Computer at
computer://home/AGENTS.md and load at the start of every conversation. My
person and I both edit this file.

## First conversation
My person is new to Fungi. In our first conversation, load the \`setup-fungi\`
skill with \`return await skill.load({name: "setup-fungi"});\` inside execute
and follow it. If they ask for something specific first, do that, then set up.
When setup is finished, delete this section.

## About my person
(Empty until setup. Fill in: their name, what they want from Fungi, their
work and where it lives on my Computer, how they like updates.)

## Keeping this file up to date
- When my person states a lasting preference, corrects me, or tells me
  something I would get wrong next time, add one short line here in the right
  section, then tell them in one sentence that I saved it.
- When I learn a fact about one of their codebases, put it in that codebase's
  own AGENTS.md, not here.
- Keep each line short and true. Every line answers "would I get this wrong
  without it?". Remove lines that stop being true.
- Never delete or rewrite a line my person wrote without asking.
- Never save secrets, keys, passwords or payment details here.
- Keep this file under 200 lines; tidy it when it grows.
`;

/** Why the last create or Home seed attempt failed, in plain words. */
export type StarterFailure = Readonly<{ reason: string; at: number }>;

/**
 * What the ledger remembers, durably, so a restart or a fresh Worker request
 * resumes the starter instead of forgetting it. `creating` is recorded before
 * the create starts, so a create cut off after reserving the Agent is replayed
 * by its `requestId`, never read as a Team that already had Agents.
 * `seed-pending` means the starter exists but its Home is not seeded yet.
 * `attemptAt` is when the running attempt started: within the bound it is
 * still running somewhere; past it, with no `failure`, it was cut off.
 */
export type StarterLedgerRow = Readonly<{
  version: number;
  outcome: "creating" | "seed-pending" | "created" | "team-not-empty";
  agentId: string | null;
  at: number;
  attemptAt: number | null;
  failure: StarterFailure | null;
}>;

/** One row per Team in the host's own SQLite. */
export type StarterLedgerStore = Readonly<{
  read(): StarterLedgerRow | undefined;
  /**
   * First write wins. Afterwards only an unsettled starter moves on: a
   * `creating` row to its next attempt, `seed-pending` or `created`; a
   * `seed-pending` row to its next attempt or `created`, for the same Agent.
   */
  record(row: StarterLedgerRow): void;
  /** Drop a `creating` row whose create was refused for funding. */
  forget(): void;
}>;

/** The ledger as the policy reads it; a host across an RPC awaits its store. */
export type StarterLedger = Readonly<{
  read(): StarterLedgerRow | undefined | Promise<StarterLedgerRow | undefined>;
  record(row: StarterLedgerRow): void | Promise<void>;
  forget(): void | Promise<void>;
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
  /**
   * Hosts with a Home seed it atomically. The seed runs in the background,
   * bounded by `timeoutMs`; a failure leaves a retryable ledger row.
   */
  seedHome?(agentId: string): Promise<void>;
  /**
   * Keep background work alive after the read answers: a stateless Worker
   * passes its `waitUntil`. A host whose process outlives the read omits it;
   * work cut off anyway is resumed from the ledger by a later offer.
   */
  keepAlive?: ((work: Promise<unknown>) => void) | undefined;
  /** How long the create or one Home seed may take before it counts as failed; default 60 s. */
  timeoutMs?: number;
  /** How long a read waits for the create before answering `starting`; default 5 s. */
  readWaitMs?: number;
  /**
   * Whether this offer starts a create or seed that last failed again (the
   * default). A status read passes false, so a failure stays visible until a
   * retry. An attempt that was cut off is always resumed.
   */
  retryFailedSeed?: boolean;
  /**
   * Why the create or seed failed, in plain words for the owner, completing
   * "Your Computer didn't start: ...". One that ran out of time arrives as a
   * `StarterTimeout`.
   */
  describeSeedFailure?(cause: unknown): string;
  /** Where a failed attempt is reported; the caller's read never fails. */
  report?(cause: unknown): void;
  now?(): number;
}>;

/** The default bound on the starter's create and on one Home seed. */
export const starterTimeoutMs = 60_000;
/** The default time a read waits for the starter's create. */
export const starterReadWaitMs = 5_000;

/** A create or Home seed that did not finish within its bound. */
export class StarterTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    super(
      `it did not answer within ${String(seconds)} second${seconds === 1 ? "" : "s"}`,
    );
    this.name = "StarterTimeout";
  }
}

/**
 * Where the starter stands, for the owner's first run: `starting` while its
 * create runs (or is owed), `seeding` while its Home seed runs (or is owed),
 * `failed` with the plain reason of the last attempt (`agentId` null when the
 * create itself failed), `ready` once seeded, `none` when there is no starter.
 */
export type StarterSeedStatus =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "starting" }>
  | Readonly<{ state: "seeding"; agentId: string }>
  | Readonly<{ state: "ready"; agentId: string }>
  | Readonly<{
      state: "failed";
      agentId: string | null;
      reason: string;
      at: number;
    }>;

/**
 * How one offer of the starter Agent settled. `created` and `seeding` both
 * mean the Agent exists; `seeding` means its Home seed is still running;
 * `starting` means its create is still running.
 */
export type StarterOutcome =
  | "created"
  | "seeding"
  | "starting"
  | "already-offered"
  | "team-not-empty"
  | "unfunded"
  | "not-owner"
  | "failed";

const ledgerRowSchema = z.strictObject({
  version: z.number().int(),
  outcome: z.enum(["creating", "seed-pending", "created", "team-not-empty"]),
  agent_id: z.string().nullable(),
  at: z.number(),
  attempt_at: z.number().nullable(),
  failure_reason: z.string().nullable(),
  failure_at: z.number().nullable(),
});

const ledgerColumnsSchema = z.array(z.object({ name: z.string() }));

/** Open the one-row ledger in the host's own SQLite. */
export function createStarterLedger(
  sql: WatchdogSqliteOwner["sql"],
): StarterLedgerStore {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS starter_agent (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, outcome TEXT NOT NULL, agent_id TEXT, at INTEGER NOT NULL, attempt_at INTEGER, failure_reason TEXT, failure_at INTEGER) STRICT",
  );
  // A ledger stored before attempts were durable has none of their columns.
  const columns = new Set(
    ledgerColumnsSchema
      .parse(sql.exec("PRAGMA table_info(starter_agent)").toArray())
      .map(({ name }) => name),
  );
  for (const [column, type] of [
    ["attempt_at", "INTEGER"],
    ["failure_reason", "TEXT"],
    ["failure_at", "INTEGER"],
  ] as const)
    if (!columns.has(column))
      sql.exec(`ALTER TABLE starter_agent ADD COLUMN ${column} ${type}`);
  return {
    read() {
      const row = sql
        .exec(
          "SELECT version, outcome, agent_id, at, attempt_at, failure_reason, failure_at FROM starter_agent WHERE id = 1",
        )
        .toArray()[0];
      if (row === undefined) return undefined;
      const stored = ledgerRowSchema.parse(row);
      return {
        version: stored.version,
        outcome: stored.outcome,
        agentId: stored.agent_id,
        at: stored.at,
        attemptAt: stored.attempt_at,
        failure:
          stored.failure_reason === null || stored.failure_at === null
            ? null
            : { reason: stored.failure_reason, at: stored.failure_at },
      };
    },
    record(row) {
      sql.exec(
        "INSERT INTO starter_agent(id, version, outcome, agent_id, at, attempt_at, failure_reason, failure_at) VALUES(1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET outcome = excluded.outcome, agent_id = excluded.agent_id, attempt_at = excluded.attempt_at, failure_reason = excluded.failure_reason, failure_at = excluded.failure_at WHERE (starter_agent.outcome = 'creating' AND excluded.outcome IN ('creating', 'seed-pending', 'created')) OR (starter_agent.outcome = 'seed-pending' AND excluded.outcome IN ('seed-pending', 'created') AND starter_agent.agent_id = excluded.agent_id)",
        row.version,
        row.outcome,
        row.agentId,
        row.at,
        row.attemptAt,
        row.failure?.reason ?? null,
        row.failure?.at ?? null,
      );
    },
    forget() {
      sql.exec("DELETE FROM starter_agent WHERE outcome = 'creating'");
    },
  };
}

const inFlight = new WeakMap<StarterLedger, Promise<StarterOutcome>>();

/**
 * Offer the starter Agent if this Team never had its chance. Safe to call on
 * every owner directory read: concurrent calls share one attempt, and the
 * host's `requestId` replay makes a second attempt return the same Agent.
 * It waits at most `readWaitMs` for the create and never for the Home seed:
 * both run on in the background, bounded, and `starterSeedStatus` says how
 * they went. Everything it knows is in the ledger, so an attempt cut off by
 * a restart is resumed by the next offer once its bound has passed.
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

/** Where the starter stands, read from the ledger alone. */
export async function starterSeedStatus(
  ledger: StarterLedger,
): Promise<StarterSeedStatus> {
  const row = await ledger.read();
  if (row === undefined || row.outcome === "team-not-empty")
    return { state: "none" };
  const { agentId, failure } = row;
  if (row.outcome === "creating")
    return failure === null
      ? { state: "starting" }
      : { state: "failed", agentId: null, ...failure };
  if (agentId === null) return { state: "none" };
  if (row.outcome === "created") return { state: "ready", agentId };
  return failure === null
    ? { state: "seeding", agentId }
    : { state: "failed", agentId, ...failure };
}

/**
 * Settle `work` within `timeoutMs`: `bounded` rejects with a `StarterTimeout`
 * when it runs out, while `work` itself carries on.
 */
type Deadlined<T> = Readonly<{ bounded: Promise<T>; timedOut: () => boolean }>;

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Deadlined<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new StarterTimeout(timeoutMs));
    }, timeoutMs);
  });
  const bounded = Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
  });
  return { bounded, timedOut: () => expired };
}

function describe(host: StarterAgentHost, cause: unknown): string {
  if (host.describeSeedFailure !== undefined)
    return host.describeSeedFailure(cause);
  return cause instanceof Error
    ? cause.message
    : "the Computer did not say why";
}

/** Record why `attempt` failed; a row that has moved on since keeps its state. */
async function fail(
  host: StarterAgentHost,
  attempt: StarterLedgerRow,
  cause: unknown,
): Promise<void> {
  host.report?.(cause);
  await host.ledger.record({
    ...attempt,
    failure: { reason: describe(host, cause), at: (host.now ?? Date.now)() },
  });
}

/** Whether `row`'s attempt may still be running somewhere. */
function attemptLive(host: StarterAgentHost, row: StarterLedgerRow): boolean {
  return (
    row.failure === null &&
    row.attemptAt !== null &&
    (host.now ?? Date.now)() <
      row.attemptAt + (host.timeoutMs ?? starterTimeoutMs)
  );
}

/**
 * Run `work` within the bound: on success `done` records the result; on
 * failure the attempt's row records why. The read never awaits it.
 */
function runBounded<T>(
  host: StarterAgentHost,
  attempt: StarterLedgerRow,
  work: Promise<T>,
): Promise<T | "failed"> {
  const { bounded, timedOut } = withDeadline(
    work,
    host.timeoutMs ?? starterTimeoutMs,
  );
  const settled = bounded.then(
    (value) => value,
    async (cause: unknown) => {
      try {
        await fail(host, attempt, cause);
      } catch (recordCause) {
        // Reported; the attempt's row stays live until its bound passes.
        host.report?.(recordCause);
      }
      return "failed" as const;
    },
  );
  // Work that outlives its bound may still finish and record its result; one
  // that fails after its timeout was recorded is reported too.
  const late = work.catch((cause: unknown) => {
    if (timedOut()) host.report?.(cause);
  });
  host.keepAlive?.(Promise.all([settled, late]));
  return settled;
}

/** Start the Home seed for an existing starter, recording the attempt first. */
async function startSeed(
  host: StarterAgentHost,
  seedHome: (agentId: string) => Promise<void>,
  row: StarterLedgerRow,
  agentId: string,
): Promise<void> {
  const attempt: StarterLedgerRow = {
    ...row,
    outcome: "seed-pending",
    agentId,
    attemptAt: (host.now ?? Date.now)(),
    failure: null,
  };
  await host.ledger.record(attempt);
  const seeded = Promise.resolve()
    .then(() => seedHome(agentId))
    .then(() => host.ledger.record({ ...attempt, outcome: "created" }));
  void runBounded(host, attempt, seeded);
}

/**
 * Record the `creating` attempt, then run the host's create with its
 * continuation attached, so a create that lands after a read stopped waiting
 * still records the starter and seeds it.
 */
async function startCreate(
  host: StarterAgentHost,
  row: StarterLedgerRow,
): Promise<StarterOutcome> {
  const attempt: StarterLedgerRow = {
    ...row,
    outcome: "creating",
    agentId: null,
    attemptAt: (host.now ?? Date.now)(),
    failure: null,
  };
  await host.ledger.record(attempt);
  const landed = Promise.resolve()
    .then(() =>
      host.create({
        name: starterAgent.name,
        requestId: starterAgent.requestId,
      }),
    )
    .then(async (result): Promise<StarterOutcome> => {
      if (result.status === "unfunded") {
        await host.ledger.forget();
        return "unfunded";
      }
      if (host.seedHome === undefined) {
        await host.ledger.record({
          ...attempt,
          outcome: "created",
          agentId: result.agentId,
          attemptAt: null,
        });
        return "created";
      }
      await startSeed(host, host.seedHome, attempt, result.agentId);
      return "seeding";
    });
  return runBounded(host, attempt, landed);
}

async function settle(host: StarterAgentHost): Promise<StarterOutcome> {
  try {
    if (!host.isOwner()) return "not-owner";
    const row = await host.ledger.read();
    const retry = host.retryFailedSeed !== false;
    if (row === undefined) {
      const at = (host.now ?? Date.now)();
      if ((await host.agentCount()) > 0) {
        await host.ledger.record({
          version: starterAgent.version,
          outcome: "team-not-empty",
          agentId: null,
          at,
          attemptAt: null,
          failure: null,
        });
        return "team-not-empty";
      }
      return await waitForCreate(
        host,
        startCreate(host, {
          version: starterAgent.version,
          outcome: "creating",
          agentId: null,
          at,
          attemptAt: null,
          failure: null,
        }),
      );
    }
    if (row.outcome === "created" || row.outcome === "team-not-empty")
      return "already-offered";
    const live = attemptLive(host, row);
    if (row.outcome === "creating") {
      if (live) return "starting";
      if (row.failure !== null && !retry) return "failed";
      return await waitForCreate(host, startCreate(host, row));
    }
    const { agentId } = row;
    if (agentId === null || host.seedHome === undefined)
      throw new Error("Pending starter has no Home seed owner");
    if (live) return "seeding";
    if (row.failure !== null && !retry) return "failed";
    await startSeed(host, host.seedHome, row, agentId);
    return "seeding";
  } catch (cause) {
    host.report?.(cause);
    return "failed";
  }
}

/** Wait at most `readWaitMs` for the create; past that the read answers `starting`. */
async function waitForCreate(
  host: StarterAgentHost,
  outcome: Promise<StarterOutcome>,
): Promise<StarterOutcome> {
  let waited: ReturnType<typeof setTimeout> | undefined;
  const readWait = new Promise<"starting">((resolve) => {
    waited = setTimeout(() => {
      resolve("starting");
    }, host.readWaitMs ?? starterReadWaitMs);
  });
  try {
    return await Promise.race([outcome, readWait]);
  } finally {
    clearTimeout(waited);
  }
}
