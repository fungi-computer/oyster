import * as Schema from "effect/Schema";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { installationsFromOlderOyster } from "./older-oyster-store.js";

const installationStoreIds = defineIdFamily({
  family: "installation-store",
  version: 1,
  kinds: { generation: { prefix: "store" } },
});
const generationRow = Schema.decodeUnknownSync(
  Schema.Struct({ generation: Schema.NonEmptyString }),
);
const resetRow = Schema.decodeUnknownSync(
  Schema.Struct({ reset_at: Schema.NullOr(Schema.Int) }),
);
const columnRow = Schema.decodeUnknownSync(
  Schema.Struct({ name: Schema.String }),
);
const countRow = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }));

/** Recognize only the retired producer's keys, never general decode failures. */
function preOwnerOnlyInstallations(sql: WatchdogSqliteOwner["sql"]): boolean {
  if (
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='installations'",
      )
      .toArray().length === 0
  )
    return false;
  // Missing authority belongs to the existing pre-0.3 refusal, not this reset.
  if (installationsFromOlderOyster(sql)) return false;
  return (
    sql
      .exec(
        `SELECT 1 FROM installations WHERE json_valid(record) AND (
      json_type(record, '$.visibility') IS NOT NULL OR
      json_type(record, '$.approvedAnonymousMethods') IS NOT NULL OR
      json_type(record, '$.anonymousApproval') IS NOT NULL
    ) LIMIT 1`,
      )
      .toArray().length > 0
  );
}

/** Own one persisted store incarnation, independent of installation row revisions. */
export function createInstallationStoreGeneration(owner: WatchdogSqliteOwner) {
  const { sql } = owner;
  const needsReset = preOwnerOnlyInstallations(sql);
  const resetAt = () =>
    resetRow(
      sql
        .exec("SELECT reset_at FROM installation_store WHERE id=1")
        .toArray()[0],
    ).reset_at;
  owner.transactionSync(() => {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS installation_store (id INTEGER PRIMARY KEY CHECK (id=1), generation TEXT NOT NULL, reset_at INTEGER, reset_rows INTEGER) STRICT",
    );
    // Enroll the existing incarnation singleton in its current audit shape.
    const columns = sql
      .exec("PRAGMA table_info(installation_store)")
      .toArray()
      .map((row) => columnRow(row));
    if (!columns.some(({ name }) => name === "reset_at"))
      sql.exec("ALTER TABLE installation_store ADD COLUMN reset_at INTEGER");
    if (!columns.some(({ name }) => name === "reset_rows"))
      sql.exec("ALTER TABLE installation_store ADD COLUMN reset_rows INTEGER");
    sql.exec(
      "INSERT OR IGNORE INTO installation_store (id,generation) VALUES(1,?)",
      installationStoreIds.generation.generate(),
    );
    if (!needsReset || resetAt() !== null || !preOwnerOnlyInstallations(sql))
      return;
    const rows = countRow(
      sql.exec("SELECT COUNT(*) AS count FROM installations").toArray()[0],
    ).count;
    // any row keyed by an installationId that is read as authority must be
    // cleared in the same transaction. Other owners and Watchdog job identities
    // remain intact; their existing missing-command handling settles orphan work.
    sql.exec("DELETE FROM installations");
    if (
      sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='installation_commands'",
        )
        .toArray().length > 0
    )
      sql.exec("DELETE FROM installation_commands");
    sql.exec(
      "UPDATE installation_store SET generation=? WHERE id=1",
      installationStoreIds.generation.generate(),
    );
    sql.exec(
      "UPDATE installation_store SET reset_at=?, reset_rows=? WHERE id=1",
      Date.now(),
      rows,
    );
  });
  return {
    generation: () =>
      generationRow(
        sql
          .exec("SELECT generation FROM installation_store WHERE id=1")
          .toArray()[0],
      ).generation,
    resetAt,
  };
}
