import type {
  WorkflowArmer,
  WorkflowTriggerPrincipal,
} from "@fungi.computer/braid/runtime";
import type { AppToolPolicy } from "./apps/index.js";
import type { InvocationFacts } from "./invocation.js";
import { AppInstanceError } from "./index.js";
import { agentWorkflowOperationSchema } from "./workflows.js";

/** Use the actual host-captured policy, never an Agent-supplied grantor or revision. */
export async function workflowAgentAuthority(
  facts: InvocationFacts,
  operation: string,
  readPolicy: (agentId: string) => Promise<AppToolPolicy | null>,
): Promise<{
  armer: WorkflowArmer;
  principal: WorkflowTriggerPrincipal;
} | null> {
  if (facts.subject.kind !== "call") throw new AppInstanceError("revoked");
  const actor = facts.subject.context.actor;
  if (actor.kind === "member")
    return {
      armer: { armedBy: actor.memberId, armedVia: null },
      principal: { kind: "member", memberId: actor.memberId },
    };
  if (
    actor.kind !== "agent" ||
    !agentWorkflowOperationSchema.safeParse(operation).success
  )
    return null;
  const captured = facts.subject.agentPolicy;
  const policy = await readPolicy(actor.agentId);
  const write =
    operation !== "catalog" &&
    operation !== "schedules" &&
    operation !== "eventTriggers";
  if (
    policy === null ||
    captured?.policyRevision !== policy.revision ||
    captured.grantorMemberId !== policy.grantedBy ||
    (write && policy.level !== "write")
  )
    throw new AppInstanceError("revoked");
  return {
    armer: {
      armedBy: policy.grantedBy,
      armedVia: {
        kind: "policy",
        agentId: actor.agentId,
        policyRevision: policy.revision,
        grantorMemberId: policy.grantedBy,
      },
    },
    principal: {
      kind: "agent",
      agentId: actor.agentId,
      grantorMemberId: policy.grantedBy,
    },
  };
}
