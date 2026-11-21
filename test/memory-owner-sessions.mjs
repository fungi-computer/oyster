/** An in-memory OwnerSessions port for tests that sign in by key or by a short-lived browser. */
export function memoryOwnerSessions() {
  const rows = new Map();
  return {
    open: async (owner, digest, now) => {
      rows.set(digest, { owner, expiresAt: now + 30 * 24 * 60 * 60 * 1000 });
    },
    owner: async (digest, now) => {
      const row = rows.get(digest);
      return row === undefined || row.expiresAt <= now ? null : row.owner;
    },
    revoke: async (digest) => {
      rows.delete(digest);
    },
  };
}

/** A registry stub exposing only the owner-session RPC, over memory. */
export function memoryRegistrySessions() {
  const sessions = memoryOwnerSessions();
  return {
    openOwnerSession: (owner, digest, now) => sessions.open(owner, digest, now),
    ownerSessionOwner: (digest, now) => sessions.owner(digest, now),
    revokeOwnerSession: (digest) => sessions.revoke(digest),
  };
}
