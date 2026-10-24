import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";

/** The closed error code a refused request carries. */
export const olderOysterStoreCode = "store_from_older_oyster";

/** Where the reset steps live. */
const olderOysterStoreGuide =
  "https://github.com/fungi-computer/oyster#upgrading-from-oyster-02-or-earlier";

/** The one message every refusal shows. */
export const olderOysterStoreMessage = `This Oyster's data was created by Oyster 0.2 or earlier, which this version cannot read. Reset it (${olderOysterStoreGuide}) or redeploy 0.2.x. Old data is left untouched.`;

/** Raised by a store owner that finds data written by Oyster 0.2 or earlier. */
export class OlderOysterStoreError extends Error {
  constructor() {
    super(olderOysterStoreMessage);
    this.name = "OlderOysterStoreError";
  }
}

/**
 * Whether the registry holds an installation row written before 0.3, which
 * kept its authority fields at the top level. Reads only.
 */
export function installationsFromOlderOyster(
  sql: WatchdogSqliteOwner["sql"],
): boolean {
  const table = sql
    .exec("SELECT 1 AS found FROM sqlite_master WHERE name='installations'")
    .toArray();
  if (table.length === 0) return false;
  return (
    sql
      .exec(
        "SELECT 1 AS found FROM installations WHERE json_valid(record) AND json_type(record, '$.authority') IS NULL LIMIT 1",
      )
      .toArray().length > 0
  );
}

/**
 * Whether `oyster_build_jobs` was created before 0.3 added `request_id`. Reads
 * the table's own definition, never a schema probe.
 */
export function buildJobsFromOlderOyster(
  sql: WatchdogSqliteOwner["sql"],
): boolean {
  return (
    sql
      .exec(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='oyster_build_jobs' AND sql NOT LIKE '%request_id%'",
      )
      .toArray().length > 0
  );
}

/** The refusal as the browser or API caller asked to see it. */
export function olderOysterStoreResponse(request: Request): Response {
  const status = 409;
  if (request.headers.get("accept")?.includes("text/html") === true)
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Oyster data needs a reset</title><body style="font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>Oyster data needs a reset</h1><p>This Oyster's data was created by Oyster 0.2 or earlier, which this version cannot read. Old data is left untouched.</p><p><a href="${olderOysterStoreGuide}">Reset it</a> or redeploy 0.2.x.</p></body>`,
      { status, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  return Response.json(
    { error: olderOysterStoreCode, message: olderOysterStoreMessage },
    { status },
  );
}
