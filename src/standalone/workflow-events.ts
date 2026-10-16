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
      const { libraryId, context, installationAuthority } =
        await options.admitInvocation(frame, "armEventTrigger");
      if (context.actor.kind !== "member") return { error: "not_granted" };
      if (context.computerId === null)
        return {
          kind: "refused" as const,
          reason: "Select a Computer before arming an event trigger",
        };
      // Standalone has no Agent arming source: the owner arms as themself.
      return router.arm(
        { armedBy: context.actor.memberId, armedVia: null },
        { ...target, installationId: libraryId },
        context.computerId,
        installationAuthority,
      );
    },
    async disarm(frame: Frame, raw: EventDisarmInput) {
      const { eventTriggerId } = eventDisarmInputSchema.parse(raw);
      const { libraryId, context } = await options.admitInvocation(
        frame,
        "disarmEventTrigger",
      );
      if (context.actor.kind !== "member") return { error: "not_granted" };
      return router.disarm(
        { kind: "member", memberId: context.actor.memberId },
        libraryId,
        eventTriggerId,
      );
    },
    async list(frame: Frame) {
      const { libraryId, context } = await options.admitInvocation(
        frame,
        "eventTriggers",
      );
      if (context.actor.kind !== "member") return { error: "not_granted" };
      return {
        eventTriggers: await router.list(
          { kind: "member", memberId: context.actor.memberId },
          libraryId,
        ),
      };
    },
  };
}
