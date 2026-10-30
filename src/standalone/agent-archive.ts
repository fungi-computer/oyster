import { z } from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";

const stateRow = z.strictObject({
  archived: z.union([z.literal(0), z.literal(1)]),
  revision: z.number().int().nonnegative(),
  pending: z.union([z.literal(0), z.literal(1)]),
});
const suspendedRow = z.strictObject({
  kind: z.enum(["almanac", "loop"]),
  id: z.string(),
});

/** The Agent DO's one archive authority and durable repair cursor.
 * Call transitions inside the same SQLite transaction as Shiitake.busySync.
 */
export function agentArchive(sql: WatchdogSqliteOwner["sql"]) {
  sql.exec(`CREATE TABLE IF NOT EXISTS oyster_agent_archive (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    archived INTEGER NOT NULL CHECK(archived IN (0, 1)),
    revision INTEGER NOT NULL,
    pending INTEGER NOT NULL CHECK(pending IN (0, 1))
  ) STRICT`);
  sql.exec(
    "INSERT OR IGNORE INTO oyster_agent_archive(singleton,archived,revision,pending) VALUES(1,0,0,0)",
  );
  sql.exec(`CREATE TABLE IF NOT EXISTS oyster_agent_archive_suspended (
    kind TEXT NOT NULL CHECK(kind IN ('almanac','loop')),
    id TEXT NOT NULL,
    PRIMARY KEY(kind,id)
  ) STRICT`);

  const read = () => {
    const raw = sql
      .exec(
        "SELECT archived,revision,pending FROM oyster_agent_archive WHERE singleton=1",
      )
      .toArray()[0];
    if (raw === undefined)
      throw new Error("Agent archive authority is missing");
    const row = stateRow.parse(raw);
    return {
      archived: row.archived === 1,
      revision: row.revision,
      pending: row.pending === 1,
    };
  };

  return {
    read,
    /** Idempotent intent; a failed directory or schedule write retains pending. */
    transition(archived: boolean) {
      const before = read();
      if (before.archived === archived) return before;
      sql.exec(
        "UPDATE oyster_agent_archive SET archived=?, revision=revision+1, pending=1 WHERE singleton=1",
        archived ? 1 : 0,
      );
      return read();
    },
    ack(revision: number) {
      sql.exec(
        "UPDATE oyster_agent_archive SET pending=0 WHERE singleton=1 AND revision=?",
        revision,
      );
    },
    /** Only schedules this archive paused are eligible for auto-resume. */
    suspend(kind: "almanac" | "loop", id: string) {
      sql.exec(
        "INSERT OR IGNORE INTO oyster_agent_archive_suspended(kind,id) VALUES(?,?)",
        kind,
        id,
      );
    },
    suspended(): readonly z.infer<typeof suspendedRow>[] {
      return sql
        .exec(
          "SELECT kind,id FROM oyster_agent_archive_suspended ORDER BY kind,id LIMIT 64",
        )
        .toArray()
        .map((raw) => suspendedRow.parse(raw));
    },
    resumed(kind: "almanac" | "loop", id: string) {
      sql.exec(
        "DELETE FROM oyster_agent_archive_suspended WHERE kind=? AND id=?",
        kind,
        id,
      );
    },
  };
}
