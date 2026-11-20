import * as Schema from "effect/Schema";

/**
 * Each use of a stored model key, for the Vault page: which Agent, when, and
 * how the provider answered. Never the value, the prompt or the response.
 * Identical uses within a minute share a row, as Veil's connection audit does;
 * rows older than 90 days, and the oldest beyond the cap, are dropped.
 */
const retentionMs = 90 * 24 * 60 * 60 * 1_000;
const coalesceMs = 60_000;
const rowLimit = 50_000;
const listLimit = 1_000;

type ModelKeyUse = Readonly<{
  keyId: string;
  agentId: string | null;
  /** The provider's status, or null when nothing came back. */
  status: number | null;
}>;

const usageRow = Schema.Struct({
  key_id: Schema.String,
  agent_id: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Number),
  first_at: Schema.Number,
  last_at: Schema.Number,
  uses: Schema.Number,
});
const decodeRows = Schema.decodeUnknownSync(Schema.Array(usageRow));

/** One recorded use, as the Vault lists it. */
export type ModelKeyUsage = Readonly<{
  keyId: string;
  subject: Readonly<{ kind: "agent"; id: string }> | null;
  outcome: "upstream_status" | "failed";
  status: number | null;
  firstAt: number;
  lastAt: number;
  count: number;
}>;

/**
 * The Durable Object SQL this store needs, as a structural type, so the
 * published declarations never name the Workers-only `SqlStorage` global.
 */
export type ModelKeyUsageSql = Readonly<{
  exec: (
    statement: string,
    ...bindings: (string | number | null)[]
  ) => Readonly<{ toArray: () => readonly unknown[] }>;
}>;

export function createModelKeyUsage(options: {
  sql: ModelKeyUsageSql;
  now?: () => number;
}) {
  const { sql } = options;
  const now = options.now ?? Date.now;
  sql.exec(`CREATE TABLE IF NOT EXISTS oyster_model_key_usage (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT NOT NULL,
      agent_id TEXT,
      status INTEGER,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      uses INTEGER NOT NULL
    )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS oyster_model_key_usage_key ON oyster_model_key_usage (key_id, sequence)",
  );
  const expire = (at: number) => {
    sql.exec(
      "DELETE FROM oyster_model_key_usage WHERE last_at <= ?",
      at - retentionMs,
    );
  };
  return {
    record(use: ModelKeyUse): void {
      const at = now();
      expire(at);
      const coalesced = sql
        .exec(
          `UPDATE oyster_model_key_usage SET last_at = ?, uses = uses + 1
           WHERE sequence = (
             SELECT sequence FROM oyster_model_key_usage
             WHERE key_id = ? AND agent_id IS ? AND status IS ? AND first_at > ?
             ORDER BY sequence DESC LIMIT 1
           ) RETURNING sequence`,
          at,
          use.keyId,
          use.agentId,
          use.status,
          at - coalesceMs,
        )
        .toArray();
      if (coalesced.length > 0) return;
      sql.exec(
        "DELETE FROM oyster_model_key_usage WHERE sequence IN (SELECT sequence FROM oyster_model_key_usage ORDER BY sequence LIMIT MAX(0, (SELECT COUNT(*) FROM oyster_model_key_usage) - ? + 1))",
        rowLimit,
      );
      sql.exec(
        "INSERT INTO oyster_model_key_usage (key_id, agent_id, status, first_at, last_at, uses) VALUES (?, ?, ?, ?, ?, 1)",
        use.keyId,
        use.agentId,
        use.status,
        at,
        at,
      );
    },
    /** The newest uses of one key, oldest first. */
    list(keyId: string): readonly ModelKeyUsage[] {
      expire(now());
      return decodeRows(
        sql
          .exec(
            "SELECT key_id, agent_id, status, first_at, last_at, uses FROM (SELECT * FROM oyster_model_key_usage WHERE key_id = ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence",
            keyId,
            listLimit,
          )
          .toArray(),
      ).map((row) => ({
        keyId: row.key_id,
        subject:
          row.agent_id === null ? null : { kind: "agent", id: row.agent_id },
        outcome: row.status === null ? "failed" : "upstream_status",
        status: row.status,
        firstAt: row.first_at,
        lastAt: row.last_at,
        count: row.uses,
      }));
    },
  };
}
