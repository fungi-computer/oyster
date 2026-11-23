import * as Schema from "effect/Schema";

/** How long one browser sign-in lasts, absolutely: no sliding renewal. */
export const ownerSessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

/**
 * The server side of owner browser sessions. The cookie carries a random
 * session id; the store keeps only its digest, the owner it signs in, and an
 * expiry. Logging out revokes the row, so a copied cookie stops working.
 */
export type OwnerSessions = Readonly<{
  /** Record a new session for `owner` opened at `now`; it ends `ownerSessionLifetimeMs` later. */
  open(owner: string, digest: string, now: number): Promise<void>;
  /** The owner a live session signs in, or null for an unknown, expired or revoked one. */
  owner(digest: string, now: number): Promise<string | null>;
  /** Revoke one session; revoking an unknown session does nothing. */
  revoke(digest: string): Promise<void>;
  /** Revoke every browser session belonging to this owner. */
  revokeOwner(owner: string): Promise<void>;
}>;

/** The synchronous SQL a Durable Object or SQLite host gives the store. */
export type OwnerSessionSql = Readonly<{
  /** Run one statement with positional bindings. */
  exec(
    query: string,
    ...bindings: (string | number | null)[]
  ): {
    /** The statement's rows, decoded by the store. */
    toArray(): readonly object[];
  };
}>;

const sessionRows = Schema.Array(
  Schema.Struct({ owner: Schema.String, expires_at: Schema.Number }),
);

/**
 * The session table, created on first use. Older stores have no sessions,
 * so the browser cookies they issued (a digest of the owner key) match no
 * row here and fail closed to the sign-in page.
 */
function ensureOwnerSessions(sql: OwnerSessionSql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS oyster_owner_sessions (
    session_digest TEXT PRIMARY KEY, owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL) STRICT`);
}

/** Owner sessions over one store's SQL. */
export function ownerSessionStore(sql: OwnerSessionSql): OwnerSessions {
  let ready = false;
  const table = () => {
    if (!ready) ensureOwnerSessions(sql);
    ready = true;
    return sql;
  };
  return {
    open(owner, digest, now) {
      const store = table();
      // Expired rows go when a new session opens, so the table stays small.
      store.exec(
        "DELETE FROM oyster_owner_sessions WHERE expires_at <= ?",
        now,
      );
      store.exec(
        "INSERT INTO oyster_owner_sessions (session_digest, owner, expires_at) VALUES (?, ?, ?)",
        digest,
        owner,
        now + ownerSessionLifetimeMs,
      );
      return Promise.resolve();
    },
    owner(digest, now) {
      const store = table();
      const [row] = Schema.decodeUnknownSync(sessionRows)(
        store
          .exec(
            "SELECT owner, expires_at FROM oyster_owner_sessions WHERE session_digest = ?",
            digest,
          )
          .toArray(),
      );
      if (row === undefined) return Promise.resolve(null);
      if (row.expires_at <= now) {
        store.exec(
          "DELETE FROM oyster_owner_sessions WHERE session_digest = ?",
          digest,
        );
        return Promise.resolve(null);
      }
      return Promise.resolve(row.owner);
    },
    revoke(digest) {
      table().exec(
        "DELETE FROM oyster_owner_sessions WHERE session_digest = ?",
        digest,
      );
      return Promise.resolve();
    },
    revokeOwner(owner) {
      table().exec("DELETE FROM oyster_owner_sessions WHERE owner = ?", owner);
      return Promise.resolve();
    },
  };
}
