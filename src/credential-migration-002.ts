import {
  CredentialError,
  type OwnerCredentialSealer,
} from "@fungi.computer/veil/credential-store";
import type { SqlStore } from "@fungi.computer/veil/connections";
import * as Schema from "effect/Schema";

/** S1's per-owner envelope sealer; `undefined` is a host with no keyring. */
export type SecretSealer = Pick<OwnerCredentialSealer, "seal" | "open">;

const rowSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Null]),
);
/** One legacy row as SQLite returned it; its owner decodes its own columns. */
export type SqlRow002 = typeof rowSchema.Type;

/**
 * One owner's table whose secret column moves from plaintext to an S1
 * envelope. The owner keeps its current DDL and sealing context; this
 * migration only moves rows.
 */
export type SealedTable002 = Readonly<{
  table: string;
  /** True when the table still has its plaintext shape. */
  plaintext(columns: readonly string[]): boolean;
  /** The legacy columns that hold secret bytes. */
  secretColumns: readonly string[];
  /** The owner's current `CREATE TABLE IF NOT EXISTS` for `table`. */
  ensure(sql: SqlStore["sql"]): void;
  /** One legacy row to its current column values, with the secret sealed. */
  seal(sealer: SecretSealer, row: SqlRow002): Promise<SqlRow002>;
}>;

const columnsSchema = Schema.Array(Schema.Struct({ name: Schema.String }));
const identifier = /^[a-z_]+$/u;

function columnsOf(store: SqlStore, table: string): readonly string[] {
  return Schema.decodeUnknownSync(columnsSchema)(
    store.sql.exec(`PRAGMA table_info(${table})`).toArray(),
  ).map(({ name }) => name);
}

async function migrateTable(
  store: SqlStore,
  sealer: SecretSealer | undefined,
  step: SealedTable002,
): Promise<void> {
  if (!identifier.test(step.table)) throw new Error("Invalid table name");
  if (!step.plaintext(columnsOf(store, step.table))) return;
  const rows = Schema.decodeUnknownSync(Schema.Array(rowSchema))(
    store.sql.exec(`SELECT * FROM ${step.table} ORDER BY rowid`).toArray(),
  );
  // No keyring: plaintext rows stay closed to every reader until one exists.
  if (rows.length !== 0 && sealer === undefined)
    throw new CredentialError("unavailable");
  const sealed: SqlRow002[] = [];
  for (const row of rows) {
    if (sealer === undefined) throw new CredentialError("unavailable");
    sealed.push(await step.seal(sealer, row));
  }
  const legacy = `${step.table}_plaintext_002`;
  store.transactionSync(() => {
    // A concurrent attempt already finished; its rows are the current ones.
    if (!step.plaintext(columnsOf(store, step.table))) return;
    // Sealing yields to other owner requests. Never copy a stale snapshot over
    // a removal or update; leave the current table intact for the next retry.
    const current = Schema.decodeUnknownSync(Schema.Array(rowSchema))(
      store.sql.exec(`SELECT * FROM ${step.table} ORDER BY rowid`).toArray(),
    );
    if (JSON.stringify(current) !== JSON.stringify(rows))
      throw new CredentialError("unavailable");
    store.sql.exec(`ALTER TABLE ${step.table} RENAME TO ${legacy}`);
    step.ensure(store.sql);
    for (const values of sealed) {
      const names = Object.keys(values);
      if (!names.every((name) => identifier.test(name)))
        throw new Error("Invalid column name");
      store.sql.exec(
        `INSERT INTO ${step.table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
        ...names.map((name) => values[name] ?? null),
      );
    }
    // Overwrite the secret bytes in place before the pages are freed.
    for (const column of step.secretColumns) {
      if (!identifier.test(column)) throw new Error("Invalid column name");
      store.sql.exec(
        `UPDATE ${legacy} SET ${column} = substr(hex(zeroblob(length(CAST(${column} AS BLOB)))), 1, length(CAST(${column} AS BLOB))) WHERE ${column} IS NOT NULL`,
      );
    }
    store.sql.exec(`DROP TABLE ${legacy}`);
  });
}

/**
 * Oyster credential migration 002: webhook signing secrets, subscription
 * secrets and open Discord interaction tokens move from plaintext columns to
 * the owner's S1 envelope, and the plaintext columns are dropped with them.
 * Runs before an owner reads or writes its table. A failed attempt is
 * retried by the next use instead of being cached. Without a keyring a
 * plaintext row refuses as `unavailable`; it is never read in the clear.
 */
export function credentialMigration002(options: {
  store: SqlStore;
  sealer: SecretSealer | undefined;
  tables: readonly SealedTable002[];
}): () => Promise<void> {
  let migration: Promise<void> | undefined;
  let done = false;
  return async () => {
    if (done) return;
    const running = (migration ??= (async () => {
      for (const table of options.tables)
        await migrateTable(options.store, options.sealer, table);
    })());
    try {
      await running;
      done = true;
    } catch (cause) {
      if (migration === running) migration = undefined;
      throw cause;
    }
  };
}
