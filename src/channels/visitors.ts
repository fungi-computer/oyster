import { z } from "zod";

import { DEFAULT_BINDING_LIMITS, type ConversationBinding } from "./binding.js";
import { channelIds } from "./ids.js";

export type VisitorSql = Readonly<{
  exec: (
    statement: string,
    ...bindings: (ArrayBuffer | string | number | null)[]
  ) => Readonly<{ toArray: () => readonly unknown[] }>;
}>;

/** Access tokens live one hour; refresh secrets seven days, rotated on use. */
const VISITOR_ACCESS_MS = 3_600_000;
const VISITOR_REFRESH_MS = 7 * 86_400_000;
/**
 * A visitor identity (one conversation) ends thirty days after it was
 * minted however often it refreshes: no token outlives it.
 */
const VISITOR_LIFETIME_MS = 30 * 86_400_000;
/** New visitors one network address may mint per hour on one binding. */
const VISITORS_PER_ADDRESS_PER_HOUR = 10;

const HOUR_MS = 3_600_000;

/** Credentials handed to one anonymous visitor's iframe. */
export type VisitorCredentials = Readonly<{
  visitorId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshSecret: string;
}>;

/** Closed mint/refresh result. */
export type VisitorGrant =
  | Readonly<{ kind: "granted"; credentials: VisitorCredentials }>
  | Readonly<{
      kind: "denied";
      reason:
        | "unmapped"
        | "suspended"
        | "new_party_limit"
        | "address_limit"
        | "refresh_invalid"
        | "refresh_reused";
    }>;

/** Bearer grammar: `vt_` or `vr_` plus 43 base64url characters. */
export const visitorBearerSchema = z
  .string()
  .regex(/^v[tr]_[A-Za-z0-9_-]{43}$/u);

const tokenRow = z.strictObject({
  visitor_id: z.string(),
  family: z.string(),
  kind: z.enum(["access", "refresh"]),
  expires_at: z.number().int(),
  used: z.number().int(),
});
const countRow = z.strictObject({ count: z.number().int() });

function randomBearer(prefix: "vt_" | "vr_"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (
    prefix +
    btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
  );
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Anonymous visitor identity for web bindings. A visitor principal
 * names exactly one binding and one visitor, so it can reach exactly that
 * visitor's one conversation Session and nothing else. Only token hashes are
 * stored. Reusing a spent refresh secret revokes the whole family.
 */
export function createChannelVisitors(
  options: Readonly<{
    sql: VisitorSql;
    transactionSync: <T>(body: () => T) => T;
    now: () => number;
  }>,
) {
  const { sql } = options;
  const ensure = () => {
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_channel_visitors (
      visitor_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      address_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
    sql.exec(
      "CREATE INDEX IF NOT EXISTS hub_channel_visitors_binding ON hub_channel_visitors(binding_id, created_at)",
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_channel_visitor_tokens (
      token_hash TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      family TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
  };

  const count = (statement: string, ...bindings: (string | number)[]) =>
    countRow.parse(sql.exec(statement, ...bindings).toArray()[0]).count;

  const issue = async (
    bindingId: string,
    visitorId: string,
    family: string,
    endsAt: number,
  ): Promise<VisitorCredentials> => {
    const accessToken = randomBearer("vt_");
    const refreshSecret = randomBearer("vr_");
    const now = options.now();
    const accessExpiresAt = Math.min(now + VISITOR_ACCESS_MS, endsAt);
    const [accessHash, refreshHash] = await Promise.all([
      digest(accessToken),
      digest(refreshSecret),
    ]);
    options.transactionSync(() => {
      sql.exec(
        "INSERT INTO hub_channel_visitor_tokens VALUES (?,?,?,?,'access',?,0)",
        accessHash,
        visitorId,
        bindingId,
        family,
        accessExpiresAt,
      );
      sql.exec(
        "INSERT INTO hub_channel_visitor_tokens VALUES (?,?,?,?,'refresh',?,0)",
        refreshHash,
        visitorId,
        bindingId,
        family,
        Math.min(now + VISITOR_REFRESH_MS, endsAt),
      );
    });
    return { visitorId, accessToken, accessExpiresAt, refreshSecret };
  };

  /** Mint a new anonymous visitor on one active web binding. */
  const mint = async (
    binding: ConversationBinding | null,
    siteKey: string,
    addressHash: string,
  ): Promise<VisitorGrant> => {
    ensure();
    if (
      binding?.selector.provider !== "web" ||
      binding.selector.siteKey !== siteKey
    )
      return { kind: "denied", reason: "unmapped" };
    if (binding.lifecycle !== "active")
      return { kind: "denied", reason: "suspended" };
    const limits = binding.limits ?? DEFAULT_BINDING_LIMITS;
    const now = options.now();
    const visitorId = channelIds.visitor.generate();
    const admitted = options.transactionSync(() => {
      if (
        count(
          "SELECT COUNT(*) AS count FROM hub_channel_visitors WHERE binding_id=? AND created_at>?",
          binding.bindingId,
          now - HOUR_MS,
        ) >= limits.newPartiesPerHour
      )
        return "new_party_limit" as const;
      if (
        count(
          "SELECT COUNT(*) AS count FROM hub_channel_visitors WHERE binding_id=? AND address_hash=? AND created_at>?",
          binding.bindingId,
          addressHash,
          now - HOUR_MS,
        ) >= VISITORS_PER_ADDRESS_PER_HOUR
      )
        return "address_limit" as const;
      sql.exec(
        "INSERT INTO hub_channel_visitors (visitor_id,binding_id,address_hash,created_at) VALUES (?,?,?,?)",
        visitorId,
        binding.bindingId,
        addressHash,
        now,
      );
      return null;
    });
    if (admitted !== null) return { kind: "denied", reason: admitted };
    return {
      kind: "granted",
      credentials: await issue(
        binding.bindingId,
        visitorId,
        visitorId,
        now + VISITOR_LIFETIME_MS,
      ),
    };
  };

  const lookup = async (bearer: string) => {
    ensure();
    const raw = sql
      .exec(
        "SELECT t.visitor_id,t.family,t.kind,t.expires_at,t.used FROM hub_channel_visitor_tokens t JOIN hub_channel_visitors v ON v.visitor_id=t.visitor_id WHERE t.token_hash=? AND v.revoked=0",
        await digest(bearer),
      )
      .toArray()[0];
    return raw === undefined ? null : tokenRow.parse(raw);
  };

  /** Rotate a refresh secret; a reused one revokes the visitor's family. */
  const refresh = async (
    binding: ConversationBinding | null,
    refreshSecret: string,
  ): Promise<VisitorGrant> => {
    if (binding?.selector.provider !== "web")
      return { kind: "denied", reason: "unmapped" };
    if (binding.lifecycle !== "active")
      return { kind: "denied", reason: "suspended" };
    const hash = await digest(refreshSecret);
    const row = await lookup(refreshSecret);
    if (
      row?.kind !== "refresh" ||
      row.expires_at <= options.now() ||
      !sql
        .exec(
          "SELECT 1 FROM hub_channel_visitor_tokens WHERE token_hash=? AND binding_id=?",
          hash,
          binding.bindingId,
        )
        .toArray().length
    )
      return { kind: "denied", reason: "refresh_invalid" };
    const claimed = options.transactionSync(() => {
      if (row.used !== 0) {
        sql.exec(
          "UPDATE hub_channel_visitors SET revoked=1 WHERE visitor_id=?",
          row.visitor_id,
        );
        return false;
      }
      sql.exec(
        "UPDATE hub_channel_visitor_tokens SET used=1 WHERE token_hash=?",
        hash,
      );
      return true;
    });
    if (!claimed) return { kind: "denied", reason: "refresh_reused" };
    const created = z
      .strictObject({ created_at: z.number().int() })
      .parse(
        sql
          .exec(
            "SELECT created_at FROM hub_channel_visitors WHERE visitor_id=?",
            row.visitor_id,
          )
          .toArray()[0],
      ).created_at;
    const endsAt = created + VISITOR_LIFETIME_MS;
    if (endsAt <= options.now())
      return { kind: "denied", reason: "refresh_invalid" };
    return {
      kind: "granted",
      credentials: await issue(
        binding.bindingId,
        row.visitor_id,
        row.family,
        endsAt,
      ),
    };
  };

  /** The one visitor an access token names on this binding, or null. */
  const authenticate = async (
    bindingId: string,
    accessToken: string,
  ): Promise<Readonly<{
    visitorId: string;
    expiresAt: number;
    addressHash: string;
  }> | null> => {
    const hash = await digest(accessToken);
    const row = await lookup(accessToken);
    if (row?.kind !== "access" || row.expires_at <= options.now()) return null;
    const scoped = sql
      .exec(
        "SELECT v.address_hash FROM hub_channel_visitor_tokens t JOIN hub_channel_visitors v ON v.visitor_id=t.visitor_id WHERE t.token_hash=? AND t.binding_id=? AND v.revoked=0",
        hash,
        bindingId,
      )
      .toArray()[0];
    if (scoped === undefined) return null;
    const address = z.strictObject({ address_hash: z.string() }).parse(scoped);
    return {
      visitorId: row.visitor_id,
      expiresAt: row.expires_at,
      addressHash: address.address_hash,
    };
  };

  /** Revoke a swept visitor and drop its token hashes. */
  const forget = (visitorId: string) => {
    ensure();
    options.transactionSync(() => {
      sql.exec(
        "UPDATE hub_channel_visitors SET revoked=1 WHERE visitor_id=?",
        visitorId,
      );
      sql.exec(
        "DELETE FROM hub_channel_visitor_tokens WHERE visitor_id=?",
        visitorId,
      );
    });
  };

  return { ensure, mint, refresh, authenticate, forget };
}
/** Anonymous visitor identity owner. */
export type ChannelVisitors = ReturnType<typeof createChannelVisitors>;
