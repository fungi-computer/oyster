import {
  createTeamWorkflowRuns,
  createTeamWorkflowTriggers,
  type WorkflowErrorPort,
  type WorkflowRunAuthority,
  type WorkflowTriggerAdmission,
} from "@fungi.computer/braid/runtime";
import { AppInstanceError } from "../index.js";

/** Standalone denial is the Instance's revoked refusal; other failures retry. */
export const standaloneTriggerErrors: WorkflowErrorPort = {
  denied: () => new AppInstanceError("revoked"),
  isDenied: (cause) =>
    cause instanceof AppInstanceError && cause.code === "revoked",
};

const hubOnly = (port: string) =>
  new Error(`Standalone Workflows has no ${port}`);

/**
 * Trigger starts reuse the shared cached-plan start owner over this host's run
 * store. The Hub-only reviewer and Team run termination ports have no
 * standalone producer, so each refuses instead of inventing authority.
 */
export function createStandaloneWorkflowTriggerHost(options: {
  authority: WorkflowRunAuthority;
  runs: Pick<
    Parameters<typeof createTeamWorkflowRuns>[0],
    "sql" | "transactionSync" | "teamId" | "now"
  >;
  triggers: Omit<
    Parameters<typeof createTeamWorkflowTriggers>[0],
    "runs" | "errors"
  >;
  /** Whether this member may have run endings reported to the Agent Session. */
  admitDelivery: Parameters<typeof createTeamWorkflowRuns>[0]["admitDelivery"];
  /** Dispatch re-admits this protected owner context for every trigger run. */
  recordCaller(
    runId: string,
    memberId: string,
    computerId: string | null,
  ): void;
}) {
  const authority = options.authority;
  const runs = createTeamWorkflowRuns({
    ...options.runs,
    authority,
    member: (memberId) => authority.member(memberId),
    memberComputer: (memberId, computerId) =>
      authority.memberComputer(memberId, computerId),
    catalog: (memberId) => authority.catalog(memberId),
    admission: () => "active",
    errors: {
      app: (code) =>
        code === "denied" ? standaloneTriggerErrors.denied() : hubOnly(code),
      suspended: () => hubOnly("suspension"),
    },
    // Revocation is the store write itself; no Computer cleanup family runs here.
    wake: () => undefined,
    // Standalone graph nodes dispatch through the host's own frame owner.
    callWorkflowApp: () =>
      Promise.resolve({ kind: "refused", code: "not_granted" }),
    reviewer: () => Promise.reject(hubOnly("Team reviewer")),
    admitDelivery: options.admitDelivery,
    terminateGraphRun: () => Promise.reject(hubOnly("Team run termination")),
  });
  const triggers = createTeamWorkflowTriggers({
    ...options.triggers,
    errors: standaloneTriggerErrors,
    runs: {
      ...runs,
      async startCachedGraph(
        binding,
        request,
        admission?: WorkflowTriggerAdmission,
      ) {
        const started = await runs.startCachedGraph(
          binding,
          request,
          admission,
        );
        // A replay re-records the same caller after a lost reply.
        if (started.kind === "started" || started.kind === "replay")
          options.recordCaller(
            started.runId,
            binding.armedBy,
            binding.computerId,
          );
        return started;
      },
    },
  });
  // The shared start/capture producer consumes authority; this composition
  // does not manufacture a ceiling or turn saved caller data into admission.
  return { authority, runs, triggers };
}
