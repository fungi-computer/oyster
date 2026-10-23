import * as Schema from "effect/Schema";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";

const installationStoreIds = defineIdFamily({
  family: "installation-store",
  version: 1,
  kinds: { generation: { prefix: "store" } },
});
const generationRow = Schema.decodeUnknownSync(
  Schema.Struct({ generation: Schema.NonEmptyString }),
);

/** Own one persisted store incarnation, independent of installation row revisions. */
export function createInstallationStoreGeneration(
  sql: WatchdogSqliteOwner["sql"],
): () => string {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS installation_store (id INTEGER PRIMARY KEY CHECK (id=1), generation TEXT NOT NULL) STRICT",
  );
  sql.exec(
    "INSERT OR IGNORE INTO installation_store (id,generation) VALUES(1,?)",
    installationStoreIds.generation.generate(),
  );
  return () =>
    generationRow(
      sql
        .exec("SELECT generation FROM installation_store WHERE id=1")
        .toArray()[0],
    ).generation;
}
