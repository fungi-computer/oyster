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
  type PendingApproval,
  type ApprovalApplyResult,
} from "@fungi.computer/approvals";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { invokeModuleOperation } from "@fungi.computer/mycelium/remote";
import { oysterPrincipalIsOwner, type OysterHost } from "./host.js";
import type { HostActor } from "@fungi.computer/puffball/app";
import type { TenantScope } from "./tenant.js";
import { sha256 } from "./release.js";
import { keyAppAccess } from "./keys.js";

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
});
/** Host-generated App call metadata; the operation's input contains no actor or approval choice. */
export type OysterApprovalCall = z.output<typeof callSchema>;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const intentRow = Schema.decodeUnknownSync(
  Schema.Struct({ target_json: Schema.String }),
);

/** The registry's durable App effect home. Mycelium still owns operation/schema invocation. */
export class OysterApprovalHome {
  readonly ledger: ApprovalLedger;
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
    this.ledger = this.createLedger();
    // A new native home represents boot, not a live per-call ledger facade.
    this.ledger.recoverClaims();
  }

  private createLedger(persistIntent?: (record: ApprovalRecord) => undefined) {
    const home: ApprovalHome = { kind: "oyster", id: this.host.scope.tenantId };
    const host = { owner: this.host.owner, home, now: Date.now };
    if (persistIntent === undefined) return new ApprovalLedger(host);
    return new ApprovalLedger({ ...host, persistIntent });
  }

  async submit(
    raw: OysterApprovalCall,
  ): Promise<PendingApproval | ApprovalApplyResult> {
    // Maintained decoder snapshots the host's serialized call before any await.
    const call = callSchema.parse(raw);
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
        }),
      () => ledger.nextWakeAt(),
    );
    if (staged.kind === "refused") return staged;
    // Only this call's own policy approval applies inline; a retry reports
    // status and leaves every other approved record to the home's work loop.
    if (!staged.created || staged.record.state !== "approved")
      return ledger.outcome(staged.record);
    // The native commit is complete before any external effect can run.
    return ledger.applyInline(staged.record.recordId, this.execution());
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
      decision: async (recordId) => {
        await this.ledger.apply(recordId, this.execution());
      },
    });
  }

  /** One native alarm quantum; apply owns the fresh grant/fence check and single claim. */
  async reconcile(): Promise<number | null> {
    this.ledger.expirePending();
    for (const recordId of this.ledger.pendingApplications())
      await this.ledger.apply(recordId, this.execution());
    return this.ledger.nextWakeAt();
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
      appSurfaceCache(host),
      principal,
      [installation],
      access,
      target.sessionId ?? undefined,
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

  private execution(): ApprovalApplyHost {
    return {
      recheck: async (record) => {
        const current = await this.resolve(record);
        return current.kind === "refused"
          ? current
          : { kind: "authorized", authorityFence: current.fence };
      },
      dispatch: async ({ record, input }) => {
        // Reconstruct again at dispatch; never widen a captured operation or fence.
        const current = await this.resolve(record);
        if (current.kind === "refused") return current;
        if (current.fence !== record.authorityFence)
          return { kind: "refused", reason: "not-granted" };
        const deadlineAt = Date.now() + 30_000;
        const signal = AbortSignal.timeout(30_000);
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
