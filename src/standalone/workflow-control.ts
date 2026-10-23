import { cancelReplySchema, statusReply } from "@fungi.computer/workflows-wire";
import type { OysterHost } from "../host.js";
import type { StandaloneWorkflowEnv } from "./workflows.js";
import { AppInstanceError } from "../index.js";

/** Locate runs in the existing library owners; never create a second run index. */
export function standaloneWorkflowControl(
  env: Pick<StandaloneWorkflowEnv, "WORKFLOW_RUNS">,
  host: Pick<OysterHost, "auth" | "installations">,
): NonNullable<OysterHost["workflows"]> {
  return async (principal) => {
    if (principal.actor.kind !== "member") return null;
    const actor = principal.actor;
    const requireOwner = async () => {
      const current = await host.auth.resolve(actor);
      if (current === null || !("role" in current) || current.role !== "owner")
        throw new AppInstanceError("revoked");
    };
    await requireOwner();
    const call = async (operation: "status" | "cancel", runId: string) => {
      await requireOwner();
      for (const installation of await host.installations.list()) {
        if (
          installation.status !== "enabled" ||
          !installation.authority.approvedGrants.some(
            (grant) => grant.capability === "workflow.run",
          )
        )
          continue;
        const result = await env.WORKFLOW_RUNS.getByName(
          installation.installationId,
        ).control(principal, operation, runId);
        if (result !== null) return result;
      }
      return null;
    };
    return {
      status: async (runId) => {
        const snapshot = await call("status", runId);
        return snapshot === null
          ? null
          : statusReply.parse(JSON.parse(JSON.stringify(snapshot)));
      },
      cancel: async (runId) => {
        const result = await call("cancel", runId);
        return cancelReplySchema.parse(
          result ?? { kind: "refused", reason: "denied" },
        );
      },
    };
  };
}
