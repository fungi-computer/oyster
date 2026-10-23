import * as Schema from "effect/Schema";
import type { CloudflareShiitakeState } from "@fungi.computer/shiitake/cloudflare";
import type { SqliteOwner } from "@fungi.computer/shiitake";

/** Oyster's adapter-call fixture; native restart proofs use the Worker. */
const decodePages = Schema.decodeUnknownSync(
  Schema.Struct({ bytes: Schema.Number }),
);

export function cloudflareStorageFixture(
  owner: SqliteOwner,
): CloudflareShiitakeState["storage"] & {
  get: (key: string) => Promise<undefined>;
  sql: SqliteOwner["sql"] & { readonly databaseSize: number };
} {
  let alarm: number | null = null;
  let transaction: Promise<unknown> = Promise.resolve();
  return {
    ...owner,
    sql: {
      exec: (statement, ...bindings) => owner.sql.exec(statement, ...bindings),
      get databaseSize() {
        return decodePages(
          owner.sql
            .exec(
              "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()",
            )
            .one(),
        ).bytes;
      },
    },
    get: () => Promise.resolve(undefined),
    getAlarm: () => Promise.resolve(alarm),
    setAlarm: (at) => {
      alarm = at instanceof Date ? at.getTime() : at;
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarm = null;
      return Promise.resolve();
    },
    transaction: (operation) => {
      const current = transaction.then(operation, operation);
      transaction = current;
      return current;
    },
  };
}
