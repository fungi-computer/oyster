import { createHash } from "node:crypto";
import { z } from "zod";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import {
  Watchdog,
  type WatchdogSqliteOwner,
  type WatchdogExecutionDecision,
} from "@fungi.computer/watchdog";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { hostActorSchema } from "@fungi.computer/puffball/app-method-runtime";
import {
  installationIdSchema,
  installationSchema,
  isCommittedInstallation,
  ownerCodec,
  type Installation,
} from "./apps/installation.js";
import { instanceIds, instanceIdSchema } from "./instance-id.js";
import { tenantIdSchema, tenantScope } from "./tenant.js";
import type { InstallationCommit } from "./host.js";
import {
  uiBootCheckOutcomeSchema,
  type UiBootCheckOutcome,
} from "./boot-gate.js";

// Request identity has Watchdog's public job-key bound; it is not a retry cap.
export const installationRequestIdSchema = z.string().min(1).max(256);
const scopeSchema = z.strictObject({
  tenantId: ownerCodec(tenantIdSchema),
  origin: z.url(),
});
const releaseCodec = ownerCodec(releaseSchema);
const identity = {
  requestId: installationRequestIdSchema,
  requestedInstallationId: installationIdSchema,
  installationId: installationIdSchema,
  release: releaseCodec,
};
const creationSchema = z.enum(["fresh", "replacement", "reminted"]);
const refusalSchema = z.strictObject({
  state: z.literal("refused"),
  status: z.number().int().min(400).max(599),
  code: z.string().min(1).max(200),
});
const successSchema = z.strictObject({
  state: z.literal("succeeded"),
  installation: installationSchema,
  creation: creationSchema,
  uiCheck: uiBootCheckOutcomeSchema.nullable(),
});
const unconfirmedSchema = z.strictObject({
  state: z.literal("unconfirmed"),
  outcome: z.enum(["outcome_unknown", "interrupted", "cancelled"]),
});
/** Application evidence, never a classification of an edge's HTTP response. */
const installationOutcomeSchema = z.discriminatedUnion("state", [
  successSchema,
  refusalSchema,
  unconfirmedSchema,
]);
export type InstallationOutcome = z.output<typeof installationOutcomeSchema>;
const pendingOperationSchema = z.strictObject({
  ...identity,
  state: z.literal("pending"),
});
const successReferenceSchema = z.strictObject({
  ...identity,
  state: z.literal("succeeded"),
  reference: z.strictObject({
    generation: z.string().min(1),
    instanceId: ownerCodec(instanceIdSchema),
    authorityVersion: z.number().int().positive(),
    status: z.enum(["enabled", "disabled", "deleted"]),
  }),
  creation: creationSchema,
  uiCheck: uiBootCheckOutcomeSchema.nullable(),
});
type SuccessReference = z.output<typeof successReferenceSchema>;
function matchesReference(
  operation: SuccessReference,
  installation: Installation | null,
) {
  return isCommittedInstallation(
    installation,
    {
      owner: { kind: "installation", id: operation.installationId },
      instanceId: operation.reference.instanceId,
      appId: operation.release.appId,
      releaseId: operation.release.releaseId,
      authorityVersion: operation.reference.authorityVersion,
      status: operation.reference.status,
    },
    operation.release,
  );
}
const terminalOperationSchema = z.discriminatedUnion("state", [
  successReferenceSchema,
  refusalSchema.extend(identity),
  unconfirmedSchema.extend(identity),
]);
/** One wire contract for admission and subsequent authoritative observation. */
export const installationOperationSchema = z.discriminatedUnion("state", [
  pendingOperationSchema,
  successReferenceSchema
    .extend({ installation: installationSchema.nullable() })
    .refine(
      (operation) =>
        operation.installation === null ||
        matchesReference(operation, operation.installation),
      "Installation does not match its committed reference",
    ),
  refusalSchema.extend(identity),
  unconfirmedSchema.extend(identity),
]);
export type InstallationOperation = z.output<
  typeof installationOperationSchema
>;
const installationAdmissionSchema = z.strictObject({
  requestId: installationRequestIdSchema,
  installationId: installationIdSchema,
  release: releaseCodec,
  actor: hostActorSchema,
  intent: z.enum(["install-or-select", "install-or-remint", "create-only"]),
  // A Workflow may reuse the owner's approval, never grant new authority.
  origin: z.enum(["owner-direct", "workflow"]),
});
export type InstallationAdmission = z.output<
  typeof installationAdmissionSchema
>;
const planSchema = z
  .strictObject({
    installation: installationSchema,
    hasBackend: z.boolean(),
    prepared: z.boolean(),
    uiCheck: uiBootCheckOutcomeSchema.nullable().optional(),
  })
  .refine(
    (plan) =>
      !plan.prepared ||
      (plan.uiCheck !== undefined &&
        (plan.installation.status !== "enabled" || plan.uiCheck !== null)),
  );
/** Retained intent and exact baseline; recovery never re-reduces a newer row. */
export const retainedInstallationCommandSchema = z.strictObject({
  admission: installationAdmissionSchema,
  scope: scopeSchema,
  installationId: installationIdSchema,
  instanceId: ownerCodec(instanceIdSchema),
  generation: z.string().min(1),
  baseline: installationSchema.nullable(),
  acceptedAt: z.number().int().nonnegative(),
  creation: creationSchema,
  plan: planSchema.nullable(),
  operation: pendingOperationSchema,
});
export type RetainedInstallationCommand = z.output<
  typeof retainedInstallationCommandSchema
>;
const settledInstallationCommandSchema = z.strictObject({
  kind: z.literal("settled"),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  scope: scopeSchema,
  generation: z.string().min(1),
  acceptedAt: z.number().int().nonnegative(),
  settledAt: z.number().int().nonnegative(),
  operation: terminalOperationSchema,
});
const storedCommandSchema = z.union([
  retainedInstallationCommandSchema,
  settledInstallationCommandSchema,
]);
type StoredCommand = z.output<typeof storedCommandSchema>;
const inputDigest = (input: InstallationAdmission) =>
  createHash("sha256")
    .update(JSON.stringify(installationAdmissionSchema.parse(input)))
    .digest("hex");

/** Host-side port; RPC transport and tenant context belong to the adapter. */
export type InstallationOperations = Readonly<{
  /** Accept one command, or replay the retained operation for its request id. */
  admit(input: InstallationAdmission): Promise<InstallationOperation>;
  /** The operation's current state, when it names this installation. */
  read(
    requestId: string,
    installationId: string,
  ): Promise<InstallationOperation | null>;
  /** Only pending recovery is executable; terminal history returns null. */
  load(requestId: string): Promise<RetainedInstallationCommand | null>;
  /** Record the executor's one reduced installation for this command. */
  plan(
    requestId: string,
    installation: Installation,
    hasBackend: boolean,
  ): Promise<RetainedInstallationCommand>;
  /** Commit the planned installation against its exact baseline. */
  commit(
    requestId: string,
    uiCheck: UiBootCheckOutcome | null,
  ): Promise<InstallationCommit>;
}>;

const installationOperationRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("admit"),
    scope: scopeSchema,
    input: installationAdmissionSchema,
  }),
  z.strictObject({
    action: z.literal("read"),
    scope: scopeSchema,
    requestId: installationRequestIdSchema,
    installationId: installationIdSchema,
  }),
  z.strictObject({
    action: z.literal("load"),
    scope: scopeSchema,
    requestId: installationRequestIdSchema,
  }),
  z.strictObject({
    action: z.literal("plan"),
    scope: scopeSchema,
    requestId: installationRequestIdSchema,
    installation: installationSchema,
    hasBackend: z.boolean(),
  }),
  z.strictObject({
    action: z.literal("commit"),
    scope: scopeSchema,
    requestId: installationRequestIdSchema,
    uiCheck: uiBootCheckOutcomeSchema.nullable(),
  }),
]);
export type InstallationOperationRequest = z.output<
  typeof installationOperationRequestSchema
>;
const installationOperationReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("refused"),
    code: z.enum([
      "request_conflict",
      "stale_authority",
      "needs_consent",
      "unavailable",
      "stored_operation_invalid",
    ]),
  }),
  z.strictObject({
    kind: z.literal("operation"),
    operation: installationOperationSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("command"),
    command: retainedInstallationCommandSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("commit"),
    commit: z.discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({
        ok: z.literal(false),
        code: z.literal("stale_authority"),
      }),
    ]),
  }),
]);
export type InstallationOperationReply = z.output<
  typeof installationOperationReplySchema
>;
export class InstallationOperationError extends Error {
  constructor(
    readonly code: Extract<
      InstallationOperationReply,
      { kind: "refused" }
    >["code"],
  ) {
    super(
      code === "stored_operation_invalid"
        ? "Stored installation operation is incompatible or invalid; republish this standalone preview."
        : code,
    );
  }
}
/** Decode ordinary RPC replies and rehydrate only the owner's closed refusal. */
export function installationOperationsPort(
  send: (
    request: InstallationOperationRequest,
  ) => Promise<InstallationOperationReply>,
  scope: RetainedInstallationCommand["scope"],
): InstallationOperations {
  const call = async (request: InstallationOperationRequest) => {
    const reply = installationOperationReplySchema.parse(await send(request));
    if (reply.kind === "refused")
      throw new InstallationOperationError(reply.code);
    return reply;
  };
  return {
    async admit(input) {
      const reply = await call({ action: "admit", scope, input });
      if (reply.kind !== "operation" || reply.operation === null)
        throw new InstallationOperationError("unavailable");
      return reply.operation;
    },
    async read(requestId, installationId) {
      const reply = await call({
        action: "read",
        scope,
        requestId,
        installationId,
      });
      if (reply.kind !== "operation")
        throw new InstallationOperationError("unavailable");
      return reply.operation;
    },
    async load(requestId) {
      const reply = await call({ action: "load", scope, requestId });
      if (reply.kind !== "command")
        throw new InstallationOperationError("unavailable");
      return reply.command;
    },
    async plan(requestId, installation, hasBackend) {
      const reply = await call({
        action: "plan",
        scope,
        requestId,
        installation,
        hasBackend,
      });
      if (reply.kind !== "command" || reply.command === null)
        throw new InstallationOperationError("unavailable");
      return reply.command;
    },
    async commit(requestId, uiCheck) {
      const reply = await call({ action: "commit", scope, requestId, uiCheck });
      if (reply.kind !== "commit")
        throw new InstallationOperationError("unavailable");
      return reply.commit;
    },
  };
}
export const installationCommandIds = defineIdFamily({
  family: "app-installation",
  version: 1,
  kinds: {
    installation: { prefix: "installation" },
    request: { prefix: "installreq" },
  },
});
const storedRow = z.strictObject({
  command: z.string(),
  provisional_outcome: z.string().nullable(),
});
const settledRetentionMs = 90 * 24 * 60 * 60 * 1_000;
// A maintenance quantum, never an admission quota or lifetime history limit.
const retentionBatchSize = 16;
const retentionCandidateRow = z.strictObject({
  request_id: installationRequestIdSchema,
  installation_id: installationIdSchema,
  settled_at: z.number().int().nonnegative(),
  retention_due_at: z.number().int().nonnegative(),
  provisional_outcome: z.string().nullable(),
});
const retentionWakeRow = z.strictObject({
  due: z.number().int().nonnegative().nullable(),
});
/** Current contract only: obsolete preview data is refused, never translated. */
function readStored<A>(schema: z.ZodType<A>, encoded: string): A {
  try {
    return schema.parse(JSON.parse(encoded));
  } catch (cause) {
    if (cause instanceof SyntaxError || cause instanceof z.ZodError)
      throw new InstallationOperationError("stored_operation_invalid");
    throw cause;
  }
}
const jobKey = (requestId: string) =>
  `installation:${createHash("sha256").update(requestId).digest("hex")}`;
type RetainedFact =
  | RetainedInstallationCommand["scope" | "admission" | "baseline"]
  | Installation["release"]
  | Installation["authority"]["approvedGrants"][number]["resources"]
  | Installation["authority"]["approval"];
const same = (left: RetainedFact, right: RetainedFact) =>
  JSON.stringify(left) === JSON.stringify(right);
const version = (record: Installation | null) =>
  record?.authority.authorityVersion ?? 0;

/** Whether a plan only reuses, or narrows, the approval its baseline holds. */
function reusesApproval(baseline: Installation | null, next: Installation) {
  const grants = baseline?.authority.approvedGrants ?? [];
  return (
    next.authority.approvedGrants.every((grant) =>
      grants.some(
        (held) =>
          held.capability === grant.capability &&
          same(held.resources, grant.resources) &&
          grant.operations.every((operation) =>
            held.operations.includes(operation),
          ),
      ),
    ) &&
    (next.authority.approval === null ||
      same(next.authority.approval, baseline?.authority.approval ?? null))
  );
}

/**
 * One registry-owned command journal joined to maintained Watchdog transactions.
 * The executor runs outside this owner. No release bytes or guest work enter it.
 */
export async function createInstallationOperations(
  ports: Readonly<{
    owner: WatchdogSqliteOwner;
    registryName: string;
    generation(): string;
    get(installationId: string): Installation | null;
    compareAndPut(
      installation: Installation,
      expectedVersion: number,
      generation: string,
      scope: RetainedInstallationCommand["scope"],
    ): Promise<InstallationCommit>;
    execute(command: RetainedInstallationCommand): Promise<InstallationOutcome>;
    scheduleWake(at: number): Promise<void>;
  }>,
) {
  const { owner } = ports;
  owner.sql.exec(
    `CREATE TABLE IF NOT EXISTS installation_commands (
      request_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL,
      command TEXT NOT NULL, provisional_outcome TEXT,
      settled_at INTEGER, retention_due_at INTEGER
    ) STRICT`,
  );
  owner.sql.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS installation_commands_latest
      ON installation_commands(installation_id)
      WHERE settled_at IS NOT NULL AND retention_due_at IS NULL`,
  );
  owner.sql.exec(
    `CREATE INDEX IF NOT EXISTS installation_commands_retention
      ON installation_commands(retention_due_at)
      WHERE retention_due_at IS NOT NULL`,
  );
  const load = (requestId: string): StoredCommand | null => {
    const row = owner.sql
      .exec(
        "SELECT command,provisional_outcome FROM installation_commands WHERE request_id=?",
        requestId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const stored = storedRow.parse(row);
    // A stale provisional result must refuse owner reads too, not remain
    // invisibly pending until an alarm tries to settle it.
    if (stored.provisional_outcome !== null)
      readStored(installationOutcomeSchema, stored.provisional_outcome);
    return readStored(storedCommandSchema, stored.command);
  };
  const save = (command: StoredCommand) => {
    const stored = storedCommandSchema.parse(command);
    if ("kind" in stored)
      owner.sql.exec(
        `UPDATE installation_commands
          SET retention_due_at=settled_at+?
          WHERE installation_id=? AND settled_at IS NOT NULL
            AND retention_due_at IS NULL AND request_id<>?`,
        settledRetentionMs,
        stored.operation.installationId,
        stored.operation.requestId,
      );
    owner.sql.exec(
      `INSERT INTO installation_commands
        (request_id,installation_id,command,settled_at,retention_due_at)
        VALUES (?,?,?,?,NULL)
        ON CONFLICT(request_id) DO UPDATE SET
          command=excluded.command,settled_at=excluded.settled_at,
          retention_due_at=excluded.retention_due_at`,
      stored.operation.requestId,
      stored.operation.installationId,
      JSON.stringify(stored),
      "kind" in stored ? stored.settledAt : null,
    );
  };
  const pruneSettled = () => {
    owner.transactionSync(() => {
      const candidates = owner.sql
        .exec(
          `SELECT request_id,installation_id,settled_at,retention_due_at,provisional_outcome
            FROM installation_commands WHERE retention_due_at<=?
            ORDER BY retention_due_at,rowid LIMIT ?`,
          Date.now(),
          retentionBatchSize,
        )
        .toArray();
      for (const candidate of candidates) {
        const parsed = retentionCandidateRow.safeParse(candidate);
        if (!parsed.success)
          throw new InstallationOperationError("stored_operation_invalid");
        const row = parsed.data;
        const command = load(row.request_id);
        if (
          command === null ||
          !("kind" in command) ||
          command.operation.requestId !== row.request_id ||
          command.operation.installationId !== row.installation_id ||
          command.settledAt !== row.settled_at ||
          row.retention_due_at !== command.settledAt + settledRetentionMs ||
          row.provisional_outcome !== null
        )
          throw new InstallationOperationError("stored_operation_invalid");
        owner.sql.exec(
          "DELETE FROM installation_commands WHERE request_id=? AND retention_due_at=?",
          row.request_id,
          row.retention_due_at,
        );
      }
    });
  };
  const nextRetentionWake = () =>
    retentionWakeRow.parse(
      owner.sql
        .exec(
          `SELECT MIN(retention_due_at) AS due FROM installation_commands
            WHERE retention_due_at IS NOT NULL`,
        )
        .toArray()[0],
    ).due;
  const operationOf = (command: StoredCommand): InstallationOperation => {
    const operation = command.operation;
    if (operation.state !== "succeeded") return operation;
    const current =
      ports.generation() === command.generation &&
      command.generation === operation.reference.generation
        ? ports.get(operation.installationId)
        : null;
    return {
      ...operation,
      installation: matchesReference(operation, current) ? current : null,
    };
  };
  // Only the running executor proposes evidence. Watchdog's private claim
  // decides whether it may become terminal, in the settlement transaction.
  const provisional = (requestId: string): InstallationOutcome | null => {
    const row = owner.sql
      .exec(
        "SELECT provisional_outcome FROM installation_commands WHERE request_id=?",
        requestId,
      )
      .toArray()[0];
    const encoded =
      row === undefined
        ? null
        : z
            .strictObject({ provisional_outcome: z.string().nullable() })
            .parse(row).provisional_outcome;
    return encoded === null
      ? null
      : readStored(installationOutcomeSchema, encoded);
  };
  const watchdog = await Watchdog.make({
    owner,
    isAlive: () => Promise.resolve(false),
    wake: { recompute: () => ports.scheduleWake(Date.now()) },
    project: ({ settled }) => {
      if (settled === undefined) return;
      const payload = installationRequestIdSchema.parse(settled.payload);
      const command = load(payload);
      if (command === null || !("admission" in command)) return;
      const proposed = provisional(payload);
      const definitive =
        (proposed?.state === "succeeded" &&
          settled.outcome === "completed" &&
          ports.generation() === command.generation &&
          same(ports.get(command.installationId), proposed.installation)) ||
        (proposed?.state === "refused" && settled.outcome === "failed");
      const result: InstallationOutcome = definitive
        ? proposed
        : {
            state: "unconfirmed",
            outcome:
              settled.outcome === "interrupted" ||
              settled.outcome === "cancelled"
                ? settled.outcome
                : "outcome_unknown",
          };
      const operation = terminalOperationSchema.parse(
        result.state === "succeeded"
          ? {
              ...command.operation,
              state: result.state,
              reference: {
                generation: command.generation,
                instanceId: result.installation.instanceId,
                authorityVersion:
                  result.installation.authority.authorityVersion,
                status: result.installation.status,
              },
              creation: result.creation,
              uiCheck: result.uiCheck,
            }
          : { ...command.operation, ...result },
      );
      save({
        kind: "settled",
        inputDigest: inputDigest(command.admission),
        scope: command.scope,
        generation: command.generation,
        acceptedAt: command.acceptedAt,
        settledAt: Date.now(),
        operation,
      });
      owner.sql.exec(
        "UPDATE installation_commands SET provisional_outcome=NULL WHERE request_id=?",
        payload,
      );
    },
    execute: async (job): Promise<WatchdogExecutionDecision> => {
      const command = load(installationRequestIdSchema.parse(job.payload));
      if (command === null || !("admission" in command))
        return { kind: "outcome_unknown" };
      // Persist the wake handoff before awaiting work in another execution context.
      await ports.scheduleWake(Date.now());
      const result = installationOutcomeSchema.parse(
        await ports.execute(command),
      );
      const latest = load(command.admission.requestId);
      if (latest === null || !("admission" in latest))
        throw new InstallationOperationError("stale_authority");
      if (
        result.state === "succeeded" &&
        (latest.plan === null ||
          !same(result.installation, latest.plan.installation) ||
          result.creation !== latest.creation)
      )
        throw new InstallationOperationError("stale_authority");
      owner.transactionSync(() => {
        owner.sql.exec(
          "UPDATE installation_commands SET provisional_outcome=? WHERE request_id=?",
          JSON.stringify(result),
          command.admission.requestId,
        );
      });
      return result.state === "succeeded"
        ? { kind: "completed" }
        : result.state === "refused"
          ? { kind: "failed", reason: result.code }
          : result.outcome === "cancelled"
            ? { kind: "cancelled" }
            : { kind: "outcome_unknown" };
    },
  });
  const requireCommand = (
    requestId: string,
    scope: RetainedInstallationCommand["scope"],
  ) => {
    const command = load(requestId);
    if (command === null || !same(command.scope, scope))
      throw new InstallationOperationError("unavailable");
    if (!("admission" in command))
      throw new InstallationOperationError("stale_authority");
    return command;
  };
  const dispatch = async (
    raw: InstallationOperationRequest,
  ): Promise<InstallationOperationReply> => {
    const request = installationOperationRequestSchema.parse(raw);
    const scope = tenantScope(request.scope.tenantId, request.scope.origin);
    if (scope.durableName("registry") !== ports.registryName)
      throw new InstallationOperationError("unavailable");
    if (request.action === "admit") {
      if (request.input.actor.kind !== "member")
        throw new InstallationOperationError("unavailable");
      const scheduled = await watchdog.read(jobKey(request.input.requestId));
      // An orphan wake is harmless; an accepted row with no wake is not.
      // No external await separates this persisted wake from atomic admission.
      await ports.scheduleWake(Date.now());
      return owner.transactionSync(() => {
        const prior = load(request.input.requestId);
        if (prior !== null) {
          if (
            ("admission" in prior
              ? !same(prior.admission, request.input)
              : prior.inputDigest !== inputDigest(request.input)) ||
            !same(prior.scope, request.scope)
          )
            throw new InstallationOperationError("request_conflict");
          return { kind: "operation", operation: operationOf(prior) } as const;
        }
        // Expiring App history does not erase Watchdog's job identity.
        // A concurrent admission still replays through the journal above.
        if (scheduled.status === "found")
          throw new InstallationOperationError("unavailable");
        const requested = ports.get(request.input.installationId);
        let installationId = request.input.installationId;
        let creation: RetainedInstallationCommand["creation"] =
          requested === null ? "fresh" : "replacement";
        if (
          requested?.status === "deleted" &&
          request.input.intent === "install-or-remint"
        ) {
          const suffix = installationCommandIds.installation
            .generate()
            .slice("installation_".length);
          installationId = `${installationId.slice(0, 41).replace(/-+$/u, "")}-${suffix}`;
          creation = "reminted";
        }
        const baseline = ports.get(installationId);
        if (
          (creation !== "replacement" ||
            request.input.intent === "create-only") &&
          baseline !== null
        )
          throw new InstallationOperationError("stale_authority");
        const operation = pendingOperationSchema.parse({
          requestId: request.input.requestId,
          requestedInstallationId: request.input.installationId,
          installationId,
          release: request.input.release,
          state: "pending",
        });
        save({
          admission: request.input,
          scope: request.scope,
          installationId,
          instanceId: baseline?.instanceId ?? instanceIds.instance.generate(),
          baseline,
          generation: ports.generation(),
          acceptedAt: Date.now(),
          creation,
          plan: null,
          operation,
        });
        watchdog.transactional.enqueueAcceptedJob({
          jobId: jobKey(request.input.requestId),
          queue: installationId,
          lane: "installation",
          priority: 0,
          payload: request.input.requestId,
          state: "queued",
        });
        return { kind: "operation", operation } as const;
      });
    }
    if (request.action === "read" || request.action === "load") {
      const command = load(request.requestId);
      const admitted =
        command !== null && same(command.scope, request.scope) ? command : null;
      return request.action === "load"
        ? {
            kind: "command",
            command:
              admitted !== null && "admission" in admitted ? admitted : null,
          }
        : {
            kind: "operation",
            operation:
              admitted !== null &&
              (admitted.operation.installationId === request.installationId ||
                admitted.operation.requestedInstallationId ===
                  request.installationId)
                ? operationOf(admitted)
                : null,
          };
    }
    const command = requireCommand(request.requestId, request.scope);
    if (request.action === "plan") {
      const next = request.installation;
      if (
        next.installationId !== command.installationId ||
        next.instanceId !== command.instanceId ||
        next.authority.authorityVersion !== version(command.baseline) + 1 ||
        !same(next.release, command.admission.release)
      )
        throw new InstallationOperationError("stale_authority");
      if (
        command.admission.origin === "workflow" &&
        !reusesApproval(command.baseline, next)
      )
        throw new InstallationOperationError("needs_consent");
      if (
        command.plan !== null &&
        (!same(command.plan.installation, next) ||
          command.plan.hasBackend !== request.hasBackend)
      )
        throw new InstallationOperationError("stale_authority");
      const planned = {
        ...command,
        plan: command.plan ?? {
          installation: next,
          hasBackend: request.hasBackend,
          prepared: false,
        },
      };
      owner.transactionSync(() => {
        save(planned);
      });
      return { kind: "command", command: planned };
    }
    if (command.plan === null)
      throw new InstallationOperationError("unavailable");
    if (
      command.plan.prepared &&
      JSON.stringify(command.plan.uiCheck) !== JSON.stringify(request.uiCheck)
    )
      throw new InstallationOperationError("stale_authority");
    const prepared = {
      ...command,
      plan: { ...command.plan, prepared: true, uiCheck: request.uiCheck },
    };
    owner.transactionSync(() => {
      save(prepared);
    });
    if (ports.generation() !== command.generation)
      return { kind: "commit", commit: { ok: false, code: "stale_authority" } };
    const current = ports.get(command.installationId);
    // Exact replay, not another reducer invocation/version increment.
    const commit = same(current, command.plan.installation)
      ? ({ ok: true } as const)
      : await ports.compareAndPut(
          command.plan.installation,
          version(command.baseline),
          command.generation,
          command.scope,
        );
    return { kind: "commit", commit };
  };
  return {
    async dispatch(
      raw: InstallationOperationRequest,
    ): Promise<InstallationOperationReply> {
      try {
        return await dispatch(raw);
      } catch (cause) {
        if (cause instanceof InstallationOperationError)
          return { kind: "refused", code: cause.code };
        throw cause;
      }
    },
    async tick() {
      // A failed batch rolls back and uses the host's alarm failure handling,
      // rather than repeatedly arming its already-expired deadline.
      pruneSettled();
      try {
        return await watchdog.tick();
      } finally {
        if (await watchdog.hasPendingWork())
          await ports.scheduleWake(Date.now());
        else {
          const due = nextRetentionWake();
          if (due !== null) await ports.scheduleWake(due);
        }
      }
    },
  };
}
