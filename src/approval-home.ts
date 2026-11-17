import { z } from "zod";
import * as Schema from "effect/Schema";
import { hostActorSchema } from "@fungi.computer/puffball/app-method-runtime";
import {
  ApprovalLedger,
  type ApprovalRecord,
  type ApprovalApplyHost,
  type ApprovalAdmission,
  type ApprovalHome,
  type Approvals,
  type ApprovalApplyResult,
} from "@fungi.computer/approvals";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { invokeModuleOperation } from "@fungi.computer/mycelium/remote";
import type { OysterHost } from "./host.js";
import { keyAppAccess, oysterPrincipalIsOwner } from "./authorization.js";
import type { HostActor } from "@fungi.computer/puffball/app";
import type { TenantScope } from "./tenant.js";
import { sha256 } from "./release.js";
import type { AppSurfaceCache } from "./mcp.js";

const cancellationPruneLimit = 128;

const identity = z.string().min(1).max(256);
const targetSchema = z.strictObject({
  actor: hostActorSchema,
  installationId: identity,
  sessionId: identity.nullable(),
});
const callSchema = targetSchema.extend({
  operation: identity,
  access: z.enum(["write", "external"]),
  authorityFence: identity,
  idempotencyKey: identity,
  input: z.json(),
  deadlineAt: z.number().int().nonnegative(),
});
/** Host-generated App call metadata; the operation's input contains no actor or approval choice. */
export type OysterApprovalCall = z.output<typeof callSchema>;
/** The originating call receives the output or this terminal decision, never a pending notice. */
export type OysterApprovalResult =
  | Exclude<ApprovalApplyResult, { kind: "refused" }>
  | Readonly<{ kind: "denied"; by: string; note?: string; message: string }>
  | Readonly<{
      kind: "refused";
      reason:
        | Exclude<
            Extract<ApprovalApplyResult, { kind: "refused" }>["reason"],
            "expired"
          >
        | "approval_expired"
        | "cancelled";
      denialNote?: string;
    }>;

/** Ledger lifecycle names stay internal; every tool uses the same expiry code. */
function callOutcome(result: ApprovalApplyResult): OysterApprovalResult {
  return result.kind === "refused"
    ? {
        ...result,
        reason:
          result.reason === "expired" ? "approval_expired" : result.reason,
      }
    : result;
}

function callKey(call: OysterApprovalCall): string {
  return JSON.stringify([
    call.actor,
    call.installationId,
    call.sessionId,
    call.operation,
    call.idempotencyKey,
  ]);
}
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const intentRow = Schema.decodeUnknownSync(
  Schema.Struct({ target_json: Schema.String }),
);
const wakeRow = Schema.decodeUnknownSync(
  Schema.Struct({ at: Schema.NullOr(Schema.Number) }),
);

/** The registry's durable App effect home. Mycelium still owns operation/schema invocation. */
export class OysterApprovalHome {
  readonly ledger: ApprovalLedger;
  private readonly active = new Map<string, AbortController>();
  private readonly waiting = new Map<string, () => void>();
  // The home's artifact store and capability configuration are fixed, unlike
  // the authority read fresh from current() for every recheck and dispatch.
  private surfaces: AppSurfaceCache | undefined;
  constructor(
    private readonly host: Readonly<{
      owner: WatchdogSqliteOwner;
      scope: TenantScope;
      current: () => Promise<OysterHost>;
      /** Commit only intent state and its wake, never an App effect. */
      commit: <T>(
        write: () => Promise<T>,
        nextWakeAt: () => number | null,
      ) => Promise<T>;
    }>,
  ) {
    host.owner.sql.exec(
      "CREATE TABLE IF NOT EXISTS oyster_approval_targets (record_id TEXT PRIMARY KEY, target_json TEXT NOT NULL) STRICT",
    );
    // A cancellation is terminal intent for this call identity, even if its
    // submit RPC arrives later or this home restarts before it arrives.
    host.owner.sql.exec(
      "CREATE TABLE IF NOT EXISTS oyster_approval_cancellations (call_key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT",
    );
    host.owner.sql.exec(
      "CREATE INDEX IF NOT EXISTS oyster_approval_cancellations_expiry ON oyster_approval_cancellations (expires_at)",
    );
    this.pruneCancellations();
    this.ledger = this.createLedger();
    // A new native home represents boot, before any live call can claim work.
    while (this.ledger.recoverClaims().length > 0) {
      // Each bounded batch settles part of the finite orphan set.
    }
    while (this.ledger.withdrawWaiting() > 0) {
      // No waiting call survived this native home's restart.
    }
  }

  private createLedger(persistIntent?: (record: ApprovalRecord) => undefined) {
    const home: ApprovalHome = { kind: "oyster", id: this.host.scope.tenantId };
    const host = { owner: this.host.owner, home, now: Date.now };
    if (persistIntent === undefined) return new ApprovalLedger(host);
    return new ApprovalLedger({ ...host, persistIntent });
  }

  async submit(raw: OysterApprovalCall): Promise<OysterApprovalResult> {
    // Maintained decoder snapshots the host's serialized call before any await.
    const call = callSchema.parse(raw);
    // This check survives deletion of the marker: an expired envelope can
    // never register fresh work, including an automatically approved write.
    if (call.deadlineAt <= Date.now())
      return { kind: "refused", reason: "approval_expired" };
    const key = callKey(call);
    if (
      this.host.owner.sql
        .exec(
          "SELECT call_key FROM oyster_approval_cancellations WHERE call_key = ?",
          key,
        )
        .toArray().length > 0
    )
      return { kind: "refused", reason: "cancelled" };
    if (this.active.has(key)) return { kind: "refused", reason: "in-flight" };
    const controller = new AbortController();
    this.active.set(key, controller);
    try {
      return await this.run(call, controller.signal);
    } finally {
      this.active.delete(key);
    }
  }

  /** Trusted host cancellation, pinned to the same caller and operation identity. */
  async cancel(raw: OysterApprovalCall): Promise<void> {
    const call = callSchema.parse(raw);
    const key = callKey(call);
    await this.host.commit(
      () => {
        this.pruneCancellations();
        this.host.owner.sql.exec(
          "INSERT OR IGNORE INTO oyster_approval_cancellations (call_key, expires_at) VALUES (?, ?)",
          key,
          call.deadlineAt,
        );
        this.active.get(key)?.abort();
        return Promise.resolve();
      },
      () => this.nextWakeAt(),
    );
  }

  private pruneCancellations(): void {
    this.host.owner.sql.exec(
      "DELETE FROM oyster_approval_cancellations WHERE call_key IN (SELECT call_key FROM oyster_approval_cancellations WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)",
      Date.now(),
      cancellationPruneLimit,
    );
  }

  private nextWakeAt(): number | null {
    const cancellation = wakeRow(
      this.host.owner.sql
        .exec("SELECT MIN(expires_at) AS at FROM oyster_approval_cancellations")
        .toArray()[0],
    ).at;
    const approval = this.ledger.nextWakeAt();
    if (cancellation === null) return approval;
    return approval === null ? cancellation : Math.min(approval, cancellation);
  }

  private async run(
    call: OysterApprovalCall,
    signal: AbortSignal,
  ): Promise<OysterApprovalResult> {
    const cancelled = () => signal.aborted;
    const expiresAt = Math.min(
      Date.now() + 5 * 60_000,
      call.deadlineAt - 30_000,
    );
    if (cancelled()) return { kind: "refused", reason: "cancelled" };
    if (call.deadlineAt <= Date.now())
      return { kind: "refused", reason: "approval_expired" };
    const actor = call.actor;
    const target = targetSchema.parse({
      actor: call.actor,
      installationId: call.installationId,
      sessionId: call.sessionId,
    });
    const principalId = await sha256(
      new TextEncoder().encode(JSON.stringify(target.actor)),
    );
    const ledger = this.createLedger((record) => {
      this.host.owner.sql.exec(
        "INSERT INTO oyster_approval_targets VALUES (?, ?)",
        record.recordId,
        JSON.stringify(target),
      );
    });

    const staged = await this.host.commit(
      () =>
        ledger.request({
          requester: {
            principalId,
            agentId: actor.kind === "agent" ? actor.agentId : null,
            sessionId: target.sessionId,
            displayName:
              actor.kind === "member"
                ? actor.memberId
                : actor.kind === "agent"
                  ? actor.agentId
                  : actor.keyId,
          },
          module: "oyster-app:" + target.installationId,
          operation: call.operation,
          access: call.access,
          reversibility:
            call.access === "external" ? "irreversible-external" : "reversible",
          authorityFence: call.authorityFence,
          idempotencyKey: call.idempotencyKey,
          inputJson: JSON.stringify(call.input),
          expiresAt,
        }),
      () => this.nextWakeAt(),
    );
    if (staged.kind === "refused") return callOutcome(staged);
    const recordId = staged.record.recordId;
    try {
      if (ledger.get(recordId)?.state === "pending" && !cancelled())
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            this.waiting.delete(recordId);
            resolve();
          };
          const timer = setTimeout(finish, Math.max(0, expiresAt - Date.now()));
          this.waiting.set(recordId, finish);
          signal.addEventListener("abort", finish, { once: true });
          // The answer may have arrived while the native commit was finishing.
          if (cancelled() || ledger.get(recordId)?.state !== "pending")
            finish();
        });
      if (cancelled()) return { kind: "refused", reason: "cancelled" };
      const record = ledger.get(recordId);
      if (
        record?.state === "denied" &&
        record.reason === "declined" &&
        record.by?.kind === "human"
      ) {
        const by = record.by.memberId;
        const denied = {
          kind: "denied",
          by,
          message: `Denied by ${by}.${record.denialNote === undefined ? "" : ` User-provided note: ${JSON.stringify(record.denialNote)}`}`,
        } satisfies OysterApprovalResult;
        return record.denialNote === undefined
          ? denied
          : { ...denied, note: record.denialNote };
      }
      if (record?.state === "pending" || record?.state === "expired")
        return { kind: "refused", reason: "approval_expired" };
      if (
        record?.state === "approved" &&
        record.by?.kind !== "policy" &&
        Date.now() >= expiresAt
      )
        return { kind: "refused", reason: "approval_expired" };
      // Native commit completed before the waiting caller claims the effect.
      const deadlineAt = Math.min(call.deadlineAt, Date.now() + 30_000);
      return callOutcome(
        await ledger.apply(recordId, this.execution(signal, deadlineAt)),
      );
    } finally {
      ledger.withdraw(recordId);
    }
  }

  /** Bind each read/decision to current membership, not the renderer's actor bytes. */
  capability(rawActor: HostActor): Approvals {
    const actor = hostActorSchema.parse(rawActor);
    return this.ledger.capability({
      actor: async (record) => {
        if (actor.kind === "agent") return { kind: "agent" };
        if (actor.kind === "team-key") return { kind: "key" };
        const host = await this.host.current();
        const principal = await host.auth.resolve(actor);
        if (
          principal === null ||
          !("role" in principal) ||
          principal.actor.memberId !== actor.memberId
        )
          return null;
        return {
          kind: "human",
          memberId: actor.memberId,
          role: principal.role,
          actingForAgent: false,
          mayUseOperation:
            record === null ||
            (await this.resolve(record, actor)).kind === "authorized",
        };
      },
      decision: (recordId) => {
        this.waiting.get(recordId)?.();
        return Promise.resolve();
      },
    });
  }

  /** Alarms expire records only. They never execute a former call's effect. */
  reconcile(): Promise<number | null> {
    this.pruneCancellations();
    this.ledger.expirePending();
    for (const [recordId, finish] of this.waiting)
      if (this.ledger.get(recordId)?.state !== "pending") finish();
    return Promise.resolve(this.nextWakeAt());
  }

  private async resolve(record: ApprovalRecord, answerer?: HostActor) {
    const raw = this.host.owner.sql
      .exec(
        "SELECT target_json FROM oyster_approval_targets WHERE record_id = ?",
        record.recordId,
      )
      .toArray()[0];
    if (raw === undefined) throw new Error("Native approval target is missing");
    const target = targetSchema.parse(decodeJson(intentRow(raw).target_json));
    const actor = answerer ?? target.actor;
    const host = await this.host.current();
    // resolve() admits background humans only. Non-human callers retain their
    // tag and prove their own current grant below, never a member role.
    const principal =
      actor.kind === "member" ? await host.auth.resolve(actor) : { actor };
    if (principal === null)
      return {
        kind: "refused",
        reason: "not-granted",
      } satisfies ApprovalAdmission;
    const installation = await host.installations.get(target.installationId);
    if (installation?.status !== "enabled")
      return {
        kind: "refused",
        reason: "not-granted",
      } satisfies ApprovalAdmission;
    const { oysterAppSnapshot, appSurfaceCache } = await import("./mcp.js");
    let access: import("./mcp.js").OysterCallerAccess = null;
    if (actor.kind === "agent") {
      const policy = await host.appToolPolicy?.(actor);
      if (policy === null || policy === undefined)
        return {
          kind: "refused",
          reason: "not-granted",
        } satisfies ApprovalAdmission;
      access = { kind: "agent", policy };
    } else if (actor.kind === "team-key") {
      const key = await host.keys?.live(actor.keyId);
      if (key === null || key === undefined)
        return {
          kind: "refused",
          reason: "not-granted",
        } satisfies ApprovalAdmission;
      const owner = await host.auth.resolve({
        kind: "member",
        memberId: key.owner,
      });
      if (
        owner?.actor.kind !== "member" ||
        owner.actor.memberId !== key.owner ||
        !oysterPrincipalIsOwner(owner)
      )
        return {
          kind: "refused",
          reason: "not-granted",
        } satisfies ApprovalAdmission;
      const policy = keyAppAccess(key, target.installationId);
      if (policy === null)
        return {
          kind: "refused",
          reason: "not-granted",
        } satisfies ApprovalAdmission;
      access = {
        kind: "key",
        keyId: actor.keyId,
        byInstallation: new Map([[target.installationId, policy]]),
      };
    }
    const snapshot = await oysterAppSnapshot(
      host,
      (this.surfaces ??= appSurfaceCache(host)),
      principal,
      [installation],
      access,
      target.sessionId,
      "direct",
    );
    const module = snapshot.modules[record.module];
    const fence = snapshot.fences[record.module];
    const effect = snapshot.effects[record.module]?.[record.operation];
    if (module === undefined || fence === undefined || effect === undefined)
      return {
        kind: "refused",
        reason: "not-granted",
      } satisfies ApprovalAdmission;
    if (snapshot.levels[record.module] !== "write" || effect !== record.access)
      return {
        kind: "refused",
        reason: "read-only",
      } satisfies ApprovalAdmission;
    return { kind: "authorized", module, fence } satisfies {
      kind: "authorized";
      module: import("@fungi.computer/mycelium").ModuleRegistration;
      fence: string;
    };
  }

  private execution(
    callerSignal: AbortSignal,
    deadlineAt: number,
  ): ApprovalApplyHost {
    const signal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())),
    ]);
    return {
      recheck: async (record) => {
        signal.throwIfAborted();
        const current = await this.resolve(record);
        signal.throwIfAborted();
        return current.kind === "refused"
          ? current
          : { kind: "authorized", authorityFence: current.fence };
      },
      dispatch: async ({ record, input }) => {
        // Reconstruct again at dispatch; never widen a captured operation or fence.
        const current = await this.resolve(record);
        signal.throwIfAborted();
        if (current.kind === "refused") return current;
        if (current.fence !== record.authorityFence)
          return { kind: "refused", reason: "not-granted" };
        const output = await invokeModuleOperation(
          current.module,
          record.operation,
          input,
          {
            executionId: "approval:" + record.recordId,
            toolCallId: "approval:" + record.recordId,
            deadlineAt,
            signal,
          },
        );
        return { kind: "completed", output };
      },
    };
  }
}
