import { encode } from "@msgpack/msgpack";
import { z } from "zod";

const maxTables = 128;
const maxRows = 100_000;
const rowsPerPart = 128;
const maxPartBytes = 8 * 1024 * 1024;

const schemaRow = z.object({
  type: z.string(),
  name: z.string(),
  tbl_name: z.string(),
  sql: z.string().nullable(),
});

function packet(name: string, bytes: Uint8Array) {
  if (bytes.byteLength > maxPartBytes)
    throw new Error("Old Worker SQL snapshot part exceeds the safety ceiling");
  return { name, bytes };
}

/** A SQLite identifier from sqlite_master, quoted by the SQLite dialect. */
function tableIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Read SQLite through the old Durable Object's own storage API. Call inside
 * that object's blockConcurrencyWhile and keep the old Worker quiescent:
 * neither SQLite nor a multi-DO/R2 archive is an atomic global snapshot.
 * A safety ceiling throws instead of turning an incomplete scan into a part.
 */
export function* snapshotOldSql(sql: SqlStorage) {
  const schema = z
    .array(schemaRow)
    .parse(
      sql
        .exec(
          "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
        )
        .toArray(),
    );
  if (schema.length > maxTables)
    throw new Error("Old Worker SQL schema exceeds the safety ceiling");
  yield packet("sql/schema", encode({ schema }));

  let totalRows = 0;
  for (const entry of schema) {
    if (entry.type !== "table") continue;
    const table = tableIdentifier(entry.name);
    const count = sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)
      .one().n;
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      totalRows + count > maxRows
    )
      throw new Error("Old Worker SQL row count exceeds the safety ceiling");
    for (let offset = 0; offset < count; offset += rowsPerPart) {
      const rows = sql
        .exec(`SELECT * FROM ${table} LIMIT ? OFFSET ?`, rowsPerPart, offset)
        .toArray()
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([column, value]) => [
              column,
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ]),
          ),
        );
      if (rows.length !== Math.min(rowsPerPart, count - offset))
        throw new Error("Old Worker SQL table changed during snapshot");
      yield packet(
        `sql/${entry.name}/${String(offset)}`,
        encode({ table: entry.name, rows }),
      );
    }
    const after = sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)
      .one().n;
    if (after !== count)
      throw new Error("Old Worker SQL table changed during snapshot");
    totalRows += count;
  }
}
