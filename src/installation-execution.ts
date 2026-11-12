import { WorkerEntrypoint } from "cloudflare:workers";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { z } from "zod";
import { emptyAppDeclaration } from "@fungi.computer/puffball/app";
import {
  applyInstallationCommand,
  isCommittedInstallation,
} from "./apps/installation.js";
import { deriveDeclaredOperations } from "./apps/operations.js";
import { pendingCapabilities } from "./apps/permissions.js";
import { BootGateError } from "./boot-gate.js";
import { failureDiagnostic } from "./cause-class.js";
import { guestLimits } from "./guest-policy.js";
import { instanceSchema, selectionOf } from "./index.js";
import { ReleaseError, verifyRelease } from "./release.js";
import { tenantScope, type TenantScope } from "./tenant.js";
import {
  retainedInstallationCommandSchema,
  installationRequestIdSchema,
  InstallationOperationError,
  type RetainedInstallationCommand,
  type InstallationOutcome,
} from "./installation-operations.js";
import type { InstanceResult, OysterHost } from "./host.js";
import { instanceRefusalStatus } from "./instance-refusal.js";

const refused = (status: number, code: string): InstallationOutcome => ({
  state: "refused",
  status,
  code,
});
const unconfirmed: InstallationOutcome = {
  state: "unconfirmed",
  outcome: "outcome_unknown",
};

/**
 * Delays before each further attempt at one Instance step. A cold Instance
 * (first backend construction, a Durable Object reset or an overloaded
 * isolate) can fail its first generic attempt and pass the next one.
 */
const instanceRetryDelaysMs = [500, 2_000] as const;

/**
 * Retry only generic Instance failures; typed refusals are final. Both steps
 * are safe to repeat: preparation never changes the active runtime, and apply
 * replays the pinned committed fact (an applied selection is `unchanged`).
 */
async function withColdRetry<T>(
  step: "preparation" | "activation",
  run: () => Promise<InstanceResult<T>>,
): Promise<InstanceResult<T>> {
  for (let attempt = 1; ; attempt++) {
    const outcome = await run();
    if (outcome.ok || outcome.code !== "failed") return outcome;
    console.error(`Installation ${step} failed`, {
      attempt,
      causeClass: outcome.causeClass,
    });
    const wait = instanceRetryDelaysMs[attempt - 1];
    if (wait === undefined) return outcome;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** Ordinary Worker-side verification and lifecycle I/O for one retained intent. */
export async function executeInstallation(
  host: OysterHost,
  input: RetainedInstallationCommand,
): Promise<InstallationOutcome> {
  let command = retainedInstallationCommandSchema.parse(input);
  const operations = host.installations.operations;
  if (operations === undefined) return unconfirmed;
  const principal = await host.auth.resolve(command.admission.actor);
  if (
    principal === null ||
    !("role" in principal) ||
    principal.role !== "owner"
  )
    return refused(403, "install_authority_unavailable");
  // A Workflow can publish a build and update an approved installation, but
  // creating an installation always needs the owner's direct confirmation.
  if (command.admission.origin !== "owner-direct" && command.baseline === null)
    return refused(409, "needs_consent");
  if ((await host.installations.generation()) !== command.generation)
    return refused(409, "stale_authority");
  let verified;
  try {
    // Default verification reads UI/artifact bytes HERE, never inside REGISTRY.
    verified = await verifyRelease(host.artifacts, command.admission.release);
  } catch (cause) {
    if (cause instanceof ReleaseError) return refused(422, cause.code);
    console.error("Installation release verification failed", {
      requestId: command.admission.requestId,
      ...failureDiagnostic(cause),
    });
    return unconfirmed;
  }
  if (command.plan === null) {
    const declaration = verified.declaration ?? emptyAppDeclaration;
    const baseline = command.baseline;
    const declaredOperations = await deriveDeclaredOperations(
      verified.release,
      declaration,
      host.capabilities ?? [],
    );
    // A Workflow reuses the owner's approval; any capability its baseline
    // has not approved waits for the owner.
    if (
      command.admission.origin === "workflow" &&
      pendingCapabilities(
        baseline?.authority ?? { approvedGrants: [] },
        declaration,
        declaredOperations,
      ).length > 0
    )
      return refused(409, "needs_consent");
    const reduced = applyInstallationCommand(
      baseline,
      baseline === null
        ? {
            kind: "install",
            release: command.admission.release,
            releasePin: "pinned",
          }
        : {
            kind: "select-release",
            release: command.admission.release,
            releasePin: "pinned",
          },
      {
        by: principal.actor,
        role: principal.role,
        expectedVersion: baseline?.authority.authorityVersion ?? null,
        declaration,
        declaredOperations,
        now: command.acceptedAt,
        identity: {
          installationId: command.installationId,
          instanceId: command.instanceId,
        },
        // Only a fresh owner-direct Tourtois install in the configured home
        // slot receives the ordinary persisted Shell grant. App/workflow
        // requests cannot opt in; selection only intersects existing grants.
        builtInShell:
          baseline === null &&
          command.admission.origin === "owner-direct" &&
          verified.release.appId === "app_tourtois" &&
          command.installationId === host.homeInstallationId,
      },
    );
    if (Result.isFailure(reduced)) return refused(409, reduced.failure.code);
    try {
      command = await operations.plan(
        command.admission.requestId,
        reduced.success.next,
        verified.backend !== null,
      );
    } catch (cause) {
      // The owner's own approval rule is a definitive domain refusal.
      if (
        cause instanceof InstallationOperationError &&
        cause.code === "needs_consent"
      )
        return refused(409, "needs_consent");
      throw cause;
    }
  }
  const plan = command.plan;
  if (plan === null) return unconfirmed;
  const next = plan.installation;
  const state = { ...selectionOf(next), status: next.status };
  const current = await host.installations.get(command.installationId);
  const alreadyCommitted = isCommittedInstallation(
    current,
    state,
    next.release,
  );
  if (
    !alreadyCommitted &&
    JSON.stringify(current) !== JSON.stringify(command.baseline)
  )
    return refused(409, "stale_authority");
  // A matching row cannot substitute for retained preparation evidence.
  if (alreadyCommitted && !plan.prepared) return unconfirmed;
  const instance =
    verified.backend === null
      ? null
      : host.instances.get(state.instanceId, guestLimits(host.guestLimits));
  let uiCheck = plan.uiCheck;
  if (!alreadyCommitted && !plan.prepared) {
    if (instance === null) {
      try {
        uiCheck = await host.bootUi(verified.release);
      } catch (cause) {
        if (cause instanceof BootGateError) return refused(422, cause.code);
        console.error("Installation UI boot check failed", {
          requestId: command.admission.requestId,
          ...failureDiagnostic(cause),
        });
        return unconfirmed;
      }
    } else {
      const prepared = await withColdRetry("preparation", () =>
        instance.prepare(state, next.release),
      );
      if (!prepared.ok)
        // Preparation never changes the active runtime and runs before the
        // commit, so a generic failure here leaves the previous release live.
        return prepared.code === "failed"
          ? refused(503, "installation_not_applied")
          : refused(instanceRefusalStatus(prepared.code), prepared.code);
      uiCheck = prepared.value;
    }
  }
  if (uiCheck === undefined || (next.status === "enabled" && uiCheck === null))
    return unconfirmed;
  const commit = await operations.commit(command.admission.requestId, uiCheck);
  if (!commit.ok) return refused(409, commit.code);
  if (instance !== null) {
    // Replay the pinned fact; NEVER derive version N+1 from a current row here.
    const applied = await withColdRetry("activation", () =>
      instance.apply(state, next.release),
    );
    if (!applied.ok) {
      // The selection is committed, so a persistent generic failure is not
      // "nothing changed": it is a definitive, retryable activation failure.
      if (applied.code === "failed")
        return refused(503, "installation_not_activated");
      // Native apply can return stale_authority from its POST-application
      // owner check. That code does not establish that application never ran.
      return applied.code === "stale_authority"
        ? unconfirmed
        : refused(instanceRefusalStatus(applied.code), applied.code);
    }
    const receipt = Schema.decodeUnknownSync(instanceSchema)(applied.value);
    if (
      receipt.instanceId !== state.instanceId ||
      receipt.owner.kind !== "installation" ||
      receipt.owner.id !== state.owner.id ||
      receipt.appId !== state.appId ||
      receipt.releaseId !== state.releaseId ||
      receipt.authorityVersion !== state.authorityVersion ||
      receipt.status !== (next.status === "enabled" ? "active" : next.status)
    )
      return unconfirmed;
  }
  if (
    (await host.installations.generation()) !== command.generation ||
    !isCommittedInstallation(
      await host.installations.get(command.installationId),
      state,
      next.release,
    )
  )
    return unconfirmed;
  return {
    state: "succeeded",
    installation: next,
    creation: command.creation,
    uiCheck,
  };
}

const executionProps = z.strictObject({
  requestId: installationRequestIdSchema,
  scope: retainedInstallationCommandSchema.shape.scope,
});
/** A loopback export with ordinary Worker I/O, not another resource or HTTP API. */
export function installationWorkerEntrypoint<Env>(
  hostFor: (env: Env, scope: TenantScope) => OysterHost | Promise<OysterHost>,
): new (
  ctx: ExecutionContext,
  env: Env,
) => WorkerEntrypoint<Env, unknown> & {
  /** Execute the retained command these props name, in its tenant scope. */
  run(): Promise<InstallationOutcome>;
} {
  return class extends WorkerEntrypoint<Env, unknown> {
    /** Execute the retained command these props name, in its tenant scope. */
    async run(): Promise<InstallationOutcome> {
      const props = executionProps.parse(this.ctx.props);
      const scope = tenantScope(props.scope.tenantId, props.scope.origin);
      const host = await hostFor(this.env, scope);
      const command = await host.installations.operations?.load(
        props.requestId,
      );
      if (
        command?.scope.tenantId !== scope.tenantId ||
        command.scope.origin !== scope.origin
      )
        return unconfirmed;
      return executeInstallation(host, command);
    }
  };
}
