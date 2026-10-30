import { z } from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";

const archivedRow = z.strictObject({
  archived: z.union([z.literal(0), z.literal(1)]),
  revision: z.number().int().nonnegative(),
});
const agentRow = z.strictObject({ agent_id: z.string() });
const changesRow = z.strictObject({ count: z.number() });

/** Revisioned, bounded-stale directory view; never the Agent's flag authority. */
export function agentArchiveProjection(sql: WatchdogSqliteOwner["sql"]) {
  sql.exec(`CREATE TABLE IF NOT EXISTS oyster_archive_projection (
    agent_id TEXT PRIMARY KEY,
    archived INTEGER NOT NULL CHECK(archived IN (0, 1)),
    revision INTEGER NOT NULL
  ) STRICT`);
  return {
    /** Only an advanced fact changes the view; replay can still be acked. */
    record(
      agentId: string,
      archived: boolean,
      revision: number,
    ): "advanced" | "replayed" | "stale" {
      sql.exec(
        `INSERT INTO oyster_archive_projection(agent_id,archived,revision)
         VALUES(?,?,?)
         ON CONFLICT(agent_id) DO UPDATE SET
           archived=excluded.archived, revision=excluded.revision
         WHERE oyster_archive_projection.revision < excluded.revision`,
        agentId,
        archived ? 1 : 0,
        revision,
      );
      if (
        changesRow.parse(sql.exec("SELECT changes() AS count").toArray()[0])
          .count > 0
      )
        return "advanced";
      const row = sql
        .exec(
          "SELECT archived, revision FROM oyster_archive_projection WHERE agent_id=?",
          agentId,
        )
        .toArray()[0];
      const current = row === undefined ? null : archivedRow.parse(row);
      return current !== null &&
        current.revision === revision &&
        current.archived === (archived ? 1 : 0)
        ? "replayed"
        : "stale";
    },
    archived(agentId: string): boolean {
      const row = sql
        .exec(
          "SELECT archived, revision FROM oyster_archive_projection WHERE agent_id=?",
          agentId,
        )
        .toArray()[0];
      return row === undefined ? false : archivedRow.parse(row).archived === 1;
    },
    archivedIds(): ReadonlySet<string> {
      return new Set(
        sql
          .exec(
            "SELECT agent_id FROM oyster_archive_projection WHERE archived=1",
          )
          .toArray()
          .map((row) => agentRow.parse(row).agent_id),
      );
    },
  };
}
