import { createWorkflowEventRouter } from "@fungi.computer/braid/runtime";
import { eventDisarmInputSchema } from "@fungi.computer/workflows-wire";
import type { AppEventFact } from "@fungi.computer/puffball/app-event-facts";
import {
  triggerArmTargetSchema,
  type EventDisarmInput,
  type TriggerArmTarget,
} from "./workflow-binding.js";
import type { TriggerAdmission } from "./workflow-schedules.js";

export type EventTriggerOperation =
  "armEventTrigger" | "disarmEventTrigger" | "eventTriggers";

/** Host controls and App-event delivery compose the shared event router unchanged. */
export function createStandaloneWorkflowEvents<Frame>(
  options: Parameters<typeof createWorkflowEventRouter>[0] & {
    admitInvocation(
      frame: Frame,
      operation: EventTriggerOperation,
    ): Promise<TriggerAdmission>;
  },
) {
  const router = createWorkflowEventRouter(options);
  return {
    /** A host-recorded App event; matching armed triggers start their runs. */
    deliver: (fact: AppEventFact) => router.deliver(fact),
    async arm(frame: Frame, raw: TriggerArmTarget) {
      const target = triggerArmTargetSchema.parse(raw);
      const { libraryId, context, installationAuthority, authority } =
        await options.admitInvocation(frame, "armEventTrigger");
      if (authority === null) return { error: "not_granted" };
      if (context.computerId === null)
        return {
          kind: "refused" as const,
          reason: "Select a Computer before arming an event trigger",
        };

      return router.arm(
        authority.armer,
        { ...target, installationId: libraryId },
        context.computerId,
        installationAuthority,
      );
    },
    async disarm(frame: Frame, raw: EventDisarmInput) {
      const { eventTriggerId } = eventDisarmInputSchema.parse(raw);
      const { libraryId, authority } = await options.admitInvocation(
        frame,
        "disarmEventTrigger",
      );
      if (authority === null) return { error: "not_granted" };
      return router.disarm(authority.principal, libraryId, eventTriggerId);
    },
    async list(frame: Frame) {
      const { libraryId, authority } = await options.admitInvocation(
        frame,
        "eventTriggers",
      );
      if (authority === null) return { error: "not_granted" };
      return {
        eventTriggers: await router.list(authority.principal, libraryId),
      };
    },
  };
}
