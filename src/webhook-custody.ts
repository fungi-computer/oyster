import { createHash, randomBytes } from "node:crypto";
import { Base64Url } from "effect/encoding";
import { z } from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { CredentialError } from "@fungi.computer/veil/credential-store";
import {
  armedWorkflowTriggerSchema,
  type ArmedWorkflowTrigger,
} from "@fungi.computer/braid/runtime";
import {
  verifyFungiV1,
  verifyGithub,
  verifyStandardWebhooks,
  standardWebhookSecret,
  type EventRequest,
} from "@fungi.computer/veil/event-verifiers";
import type { WebhookDelivery } from "./webhook-ingress.js";
import type {
  SealedTable002,
  SecretSealer,
} from "./credential-migration-002.js";

export const workflowWebhookVerifierSchema = z.enum([
  "fungi-v1",
  "github",
  "standard-webhooks",
]);
export type WorkflowWebhookVerifier = z.output<
  typeof workflowWebhookVerifierSchema
>;
const idSchema = z.string().min(1).max(256);
const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const generationSchema = z.number().int().positive();
const keySchema = z.strictObject({
  secret: secretSchema,
  generation: generationSchema,
});
/** The open row a verification holds in memory; never stored like this. */
const rowSchema = z.strictObject({
  id: idSchema,
  creator: idSchema,
  binding: armedWorkflowTriggerSchema,
  verifier: workflowWebhookVerifierSchema,
  current: keySchema,
  previous: keySchema
    .extend({ expiresAt: z.number().int().nonnegative() })
    .nullable(),
});
/** The stored record: everything but the key bytes, which are sealed. */
const recordSchema = rowSchema.extend({
  current: z.strictObject({ generation: generationSchema }),
  previous: z
    .strictObject({
      generation: generationSchema,
      expiresAt: z.number().int().nonnegative(),
    })
    .nullable(),
});
const secretsSchema = z.strictObject({
  current: secretSchema,
  previous: secretSchema.nullable(),
});
const storedSchema = z.strictObject({ record: z.string(), sealed: z.string() });
const refused = { kind: "refused" } as const;
const DAY = 24 * 60 * 60 * 1000;
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const verifiers = {
  "fungi-v1": verifyFungiV1,
  github: verifyGithub,
  "standard-webhooks": verifyStandardWebhooks,
};
type KeyRow = z.output<typeof rowSchema>;
type Stored = z.output<typeof storedSchema>;
type Verification = ReturnType<(typeof verifiers)[WorkflowWebhookVerifier]>;
const context = (id: string) => ["workflow-webhook", id];

function ensureKeys(sql: WatchdogSqliteOwner["sql"]) {
  sql.exec(`CREATE TABLE IF NOT EXISTS oyster_workflow_webhook_keys (
    id TEXT PRIMARY KEY, record TEXT NOT NULL, sealed TEXT NOT NULL
  ) STRICT`);
}

async function sealRow(sealer: SecretSealer, row: KeyRow) {
  const record = recordSchema.parse({
    ...row,
    current: { generation: row.current.generation },
    previous:
      row.previous === null
        ? null
        : {
            generation: row.previous.generation,
            expiresAt: row.previous.expiresAt,
          },
  });
  const secrets = secretsSchema.parse({
    current: row.current.secret,
    previous: row.previous?.secret ?? null,
  });
  return {
    id: row.id,
    record: JSON.stringify(record),
    sealed: await sealer.seal(context(row.id), JSON.stringify(secrets)),
  };
}

/** A stored record that still names a key, or a key that no longer opens, refuses. */
async function openRow(sealer: SecretSealer, stored: Stored): Promise<KeyRow> {
  const record = recordSchema.parse(JSON.parse(stored.record));
  const secrets = secretsSchema.parse(
    JSON.parse(await sealer.open(context(record.id), stored.sealed)),
  );
  if ((record.previous === null) !== (secrets.previous === null))
    throw new CredentialError("denied");
  return rowSchema.parse({
    ...record,
    current: { ...record.current, secret: secrets.current },
    previous:
      record.previous === null
        ? null
        : { ...record.previous, secret: secrets.previous },
  });
}

/** Migration 002's step: the plaintext JSON record gains its sealed key bytes. */
export const workflowWebhookKeys002: SealedTable002 = {
  table: "oyster_workflow_webhook_keys",
  plaintext: (columns) => columns.length > 0 && !columns.includes("sealed"),
  secretColumns: ["record"],
  ensure: ensureKeys,
  async seal(sealer, raw) {
    const legacy = z.object({ record: z.string() }).parse(raw);
    return sealRow(sealer, rowSchema.parse(JSON.parse(legacy.record)));
  },
};

function matchingEvent(
  row: KeyRow | null,
  scheme: WorkflowWebhookVerifier,
  current: Verification,
  previous: Verification,
  now: () => number,
): string | null {
  if (row?.verifier !== scheme) return null;
  if (current.status === "ok") return current.eventId;
  if (
    previous.status === "ok" &&
    row.previous !== null &&
    row.previous.expiresAt > now()
  )
    return previous.eventId;
  return null;
}

/** Evaluate both slots for EVERY scheme; never short-circuit on success. */
function verifiedEvent(
  row: KeyRow | null,
  request: EventRequest,
  dummy: string,
  now: () => number,
) {
  let eventId: string | null = null;
  for (const scheme of workflowWebhookVerifierSchema.options) {
    const current = verifiers[scheme](row?.current.secret ?? dummy, request);
    const previous = verifiers[scheme](row?.previous?.secret ?? dummy, request);
    const match = matchingEvent(row, scheme, current, previous, now);
    if (match !== null) eventId = match;
  }
  return eventId;
}

function deliveryIdentity(
  verifier: WorkflowWebhookVerifier,
  eventId: string,
  body: Uint8Array,
) {
  // GitHub deliberately retains its unsigned ID plus body hash: accepted
  // weaker freshness. Neither signatures nor key bytes enter the identity.
  switch (verifier) {
    case "github":
      return hash(JSON.stringify([eventId, hash(body)]));
    case "fungi-v1":
      return hash(body);
    case "standard-webhooks":
      return hash(eventId);
  }
}

/**
 * This owner lives INSIDE the Team DO / standalone store. Only verification is
 * handed to ingress. No read-existing-secret method, master key or generation
 * derivation exists. Host authentication supplies the principal; owner() must
 * resolve CURRENT server-side ownership, not trust a caller-supplied role.
 * Key bytes rest only in the owner's S1 envelope; `ready` is the host's
 * migration 002, which runs before any row is read or written.
 */
export function workflowWebhookCustody<Principal>(options: {
  sql: WatchdogSqliteOwner["sql"];
  transactionSync: WatchdogSqliteOwner["transactionSync"];
  now(): number;
  owner(principal: Principal): Promise<string | null>;
  /** Absent without a configured keyring: sealing and opening refuse. */
  sealer: SecretSealer | undefined;
  ready(): Promise<void>;
}) {
  const { sql } = options;
  // A store still in the plaintext shape keeps it until `ready` migrates it.
  ensureKeys(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS oyster_workflow_webhook_revoked (
    id TEXT PRIMARY KEY
  ) STRICT`);
  const ready = () => options.ready();
  const sealer = () => {
    if (options.sealer === undefined) throw new CredentialError("unavailable");
    return options.sealer;
  };
  const read = (id: string): Stored | null => {
    const raw = sql
      .exec(
        "SELECT record, sealed FROM oyster_workflow_webhook_keys WHERE id=?",
        id,
      )
      .toArray()[0];
    return raw === undefined ? null : storedSchema.parse(raw);
  };
  /** Compare-and-swap on the sealed bytes; every seal draws a fresh IV. */
  const replace = (
    before: Stored,
    next: Awaited<ReturnType<typeof sealRow>>,
  ): boolean =>
    sql
      .exec(
        "UPDATE oyster_workflow_webhook_keys SET record=?, sealed=? WHERE id=? AND sealed=? RETURNING id",
        next.record,
        next.sealed,
        next.id,
        before.sealed,
      )
      .toArray().length > 0;
  const newKey = (generation: number) => ({
    secret: Base64Url.encode(randomBytes(32)),
    generation,
  });
  const dummy = Base64Url.encode(randomBytes(32));
  // Unknown IDs open a sealed decoy, so a known ID costs the same work.
  let decoy: string | undefined;
  const openDecoy = async (current: SecretSealer) => {
    // Kept only once sealed; a failed seal refuses this delivery and retries.
    decoy ??= await current.seal(
      ["workflow-webhook-decoy"],
      JSON.stringify({ current: dummy, previous: null }),
    );
    await current.open(["workflow-webhook-decoy"], decoy);
  };
  const disclosure = (row: z.output<typeof rowSchema>, actor: string) =>
    actor !== row.creator
      ? null
      : row.verifier === "standard-webhooks"
        ? standardWebhookSecret(row.current.secret)
        : row.current.secret;
  /** Open, change and swap one owned row; a concurrent change refuses. */
  const withOwnedBinding = async <Result extends object>(
    principal: Principal,
    bindingId: string,
    update: (
      row: KeyRow,
      actor: string,
    ) => Readonly<{ next: KeyRow; result: Result }> | typeof refused,
  ): Promise<Result | typeof refused> => {
    const actor = await options.owner(principal);
    if (actor === null) return refused;
    await ready();
    const stored = read(idSchema.parse(bindingId));
    if (stored === null) return refused;
    const current = sealer();
    const change = update(await openRow(current, stored), actor);
    if (!("next" in change)) return refused;
    const next = await sealRow(current, change.next);
    return options.transactionSync(() =>
      replace(stored, next) ? change.result : refused,
    );
  };
  return {
    async create(
      principal: Principal,
      bindingId: string,
      verifier: WorkflowWebhookVerifier,
      rawBinding: ArmedWorkflowTrigger,
    ) {
      const creator = await options.owner(principal);
      if (creator === null) return refused;
      const id = idSchema.parse(bindingId);
      const scheme = workflowWebhookVerifierSchema.parse(verifier);
      // Supplied only by the host's existing trigger-arm owner, never ingress.
      const binding = armedWorkflowTriggerSchema.parse(rawBinding);
      if (binding.armedBy !== creator || binding.armedVia !== null)
        return refused;
      await ready();
      const row = rowSchema.parse({
        id,
        creator,
        binding,
        verifier: scheme,
        current: newKey(1),
        previous: null,
      });
      const stored = await sealRow(sealer(), row);
      return options.transactionSync(() => {
        if (
          read(id) !== null ||
          sql
            .exec(
              "SELECT id FROM oyster_workflow_webhook_revoked WHERE id=?",
              id,
            )
            .toArray().length > 0
        )
          return refused;
        sql.exec(
          "INSERT INTO oyster_workflow_webhook_keys(id,record,sealed) VALUES(?,?,?)",
          stored.id,
          stored.record,
          stored.sealed,
        );
        return {
          kind: "created" as const,
          bindingId: row.id,
          installationId: row.binding.installationId,
          secret: disclosure(row, creator),
        };
      });
    },
    async rotate(principal: Principal, bindingId: string) {
      return withOwnedBinding(principal, bindingId, (row, actor) => {
        if (row.previous !== null && row.previous.expiresAt > options.now())
          return refused;
        const next = {
          ...row,
          previous: { ...row.current, expiresAt: options.now() + DAY },
          current: newKey(row.current.generation + 1),
        };
        return {
          next,
          result: { kind: "rotated" as const, secret: disclosure(next, actor) },
        };
      });
    },
    async retirePrevious(principal: Principal, bindingId: string) {
      return withOwnedBinding(principal, bindingId, (row) => ({
        next: { ...row, previous: null },
        result: { kind: "retired" as const },
      }));
    },
    async revoke(principal: Principal, bindingId: string) {
      const actor = await options.owner(principal);
      if (actor === null) return refused;
      await ready();
      const id = idSchema.parse(bindingId);
      return options.transactionSync(() => {
        if (read(id) === null) return refused;
        // Delete ALL key bytes immediately; the tombstone prevents redisclosure.
        sql.exec("DELETE FROM oyster_workflow_webhook_keys WHERE id=?", id);
        sql.exec(
          "INSERT INTO oyster_workflow_webhook_revoked(id) VALUES(?) ON CONFLICT DO NOTHING",
          id,
        );
        return { kind: "revoked" as const };
      });
    },
    async list(principal: Principal, after: string | null = null) {
      if ((await options.owner(principal)) === null)
        return { bindings: [], next: null };
      await ready();
      const cursor = after === null ? "" : idSchema.parse(after);
      const rows = sql
        .exec(
          "SELECT record FROM oyster_workflow_webhook_keys WHERE id>? ORDER BY id LIMIT 101",
          cursor,
        )
        .toArray();
      const bindings = rows.slice(0, 100).map((raw) => {
        const row = recordSchema.parse(
          JSON.parse(z.object({ record: z.string() }).parse(raw).record),
        );
        return {
          bindingId: row.id,
          verifier: row.verifier,
          creator: row.creator,
          generation: row.current.generation,
          previousExpiresAt: row.previous?.expiresAt ?? null,
        };
      });
      return {
        bindings,
        next: rows.length > 100 ? (bindings.at(-1)?.bindingId ?? null) : null,
      };
    },
    verification: {
      /** Final owner-store check for an already verified durable reservation. */
      isActive(bindingId: string): boolean {
        return (
          sql
            .exec(
              "SELECT id FROM oyster_workflow_webhook_keys WHERE id=?",
              idSchema.parse(bindingId),
            )
            .toArray().length > 0
        );
      },
      /**
       * Always opens one envelope and does six maintained verifier checks,
       * including unknown IDs. Without a keyring it refuses as unavailable.
       */
      async verify(delivery: WebhookDelivery) {
        await ready();
        const current = sealer();
        const stored = idSchema.safeParse(delivery.bindingId).success
          ? read(delivery.bindingId)
          : null;
        if (stored === null) await openDecoy(current);
        // A row that does not open (old shape, tampered) refuses like an unknown one.
        const row =
          stored === null
            ? null
            : await openRow(current, stored).catch((cause: unknown) => {
                if (
                  cause instanceof CredentialError &&
                  cause.code === "unavailable"
                )
                  throw cause;
                return null;
              });
        const request: EventRequest = {
          headers: delivery.headers,
          body: delivery.body,
          urlToken: null,
          nowSeconds: Math.floor(options.now() / 1000),
        };
        const eventId = verifiedEvent(row, request, dummy, () => options.now());
        if (eventId === null || row === null)
          return { status: "refused" as const };
        return {
          status: "ok" as const,
          eventId: deliveryIdentity(row.verifier, eventId, delivery.body),
          binding: row.binding,
        };
      },
    },
  };
}
