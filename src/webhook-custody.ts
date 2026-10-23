import { createHash, randomBytes } from "node:crypto";
import { Base64Url } from "effect/encoding";
import { z } from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
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

export const workflowWebhookVerifierSchema = z.enum([
  "fungi-v1",
  "github",
  "standard-webhooks",
]);
export type WorkflowWebhookVerifier = z.output<
  typeof workflowWebhookVerifierSchema
>;
const idSchema = z.string().min(1).max(256);
const keySchema = z.strictObject({
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  generation: z.number().int().positive(),
});
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
type Verification = ReturnType<(typeof verifiers)[WorkflowWebhookVerifier]>;

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
 */
export function workflowWebhookCustody<Principal>(options: {
  sql: WatchdogSqliteOwner["sql"];
  transactionSync: WatchdogSqliteOwner["transactionSync"];
  now(): number;
  owner(principal: Principal): Promise<string | null>;
}) {
  const { sql } = options;
  sql.exec(`CREATE TABLE IF NOT EXISTS oyster_workflow_webhook_keys (
    id TEXT PRIMARY KEY, record TEXT NOT NULL
  ) STRICT`);
  sql.exec(`CREATE TABLE IF NOT EXISTS oyster_workflow_webhook_revoked (
    id TEXT PRIMARY KEY
  ) STRICT`);
  const read = (id: string) => {
    const raw = sql
      .exec("SELECT record FROM oyster_workflow_webhook_keys WHERE id=?", id)
      .toArray()[0];
    if (raw === undefined) return null;
    const envelope = z.object({ record: z.string() }).parse(raw);
    return rowSchema.parse(JSON.parse(envelope.record));
  };
  const write = (row: z.output<typeof rowSchema>) => {
    sql.exec(
      "INSERT INTO oyster_workflow_webhook_keys(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      row.id,
      JSON.stringify(row),
    );
  };
  const newKey = (generation: number) => ({
    secret: Base64Url.encode(randomBytes(32)),
    generation,
  });
  const dummy = Base64Url.encode(randomBytes(32));
  const disclosure = (row: z.output<typeof rowSchema>, actor: string) =>
    actor !== row.creator
      ? null
      : row.verifier === "standard-webhooks"
        ? standardWebhookSecret(row.current.secret)
        : row.current.secret;
  const withOwnedBinding = async <Result>(
    principal: Principal,
    bindingId: string,
    update: (row: KeyRow, actor: string) => Result,
  ): Promise<Result | typeof refused> => {
    const actor = await options.owner(principal);
    if (actor === null) return refused;
    return options.transactionSync(() => {
      const row = read(idSchema.parse(bindingId));
      return row === null ? refused : update(row, actor);
    });
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
        const row = rowSchema.parse({
          id,
          creator,
          binding,
          verifier: scheme,
          current: newKey(1),
          previous: null,
        });
        write(row);
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
        row.previous = { ...row.current, expiresAt: options.now() + DAY };
        row.current = newKey(row.current.generation + 1);
        write(row);
        return { kind: "rotated" as const, secret: disclosure(row, actor) };
      });
    },
    async retirePrevious(principal: Principal, bindingId: string) {
      return withOwnedBinding(principal, bindingId, (row) => {
        row.previous = null;
        write(row);
        return { kind: "retired" as const };
      });
    },
    async revoke(principal: Principal, bindingId: string) {
      return withOwnedBinding(principal, bindingId, (row) => {
        // Delete ALL key bytes immediately; the tombstone prevents redisclosure.
        sql.exec("DELETE FROM oyster_workflow_webhook_keys WHERE id=?", row.id);
        sql.exec(
          "INSERT INTO oyster_workflow_webhook_revoked(id) VALUES(?) ON CONFLICT DO NOTHING",
          row.id,
        );
        return { kind: "revoked" as const };
      });
    },
    async list(principal: Principal, after: string | null = null) {
      if ((await options.owner(principal)) === null)
        return { bindings: [], next: null };
      const cursor = after === null ? "" : idSchema.parse(after);
      const rows = sql
        .exec(
          "SELECT record FROM oyster_workflow_webhook_keys WHERE id>? ORDER BY id LIMIT 101",
          cursor,
        )
        .toArray();
      const bindings = rows.slice(0, 100).map((raw) => {
        const row = rowSchema.parse(
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
        return read(idSchema.parse(bindingId)) !== null;
      },
      /** Always does six maintained verifier checks, including unknown IDs. */
      verify(delivery: WebhookDelivery) {
        const row = idSchema.safeParse(delivery.bindingId).success
          ? read(delivery.bindingId)
          : null;
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
