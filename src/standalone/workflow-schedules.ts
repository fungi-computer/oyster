import {
  createWorkflowSchedules,
  type WorkflowInstallationAuthority,
} from "@fungi.computer/braid/runtime";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import { scheduleDisarmInputSchema } from "@fungi.computer/workflows-wire";
import {
  triggerArmTargetSchema,
  type TriggerArmTarget,
  type ScheduleDisarmInput,
} from "./workflow-binding.js";

/** The host supplies this result only after reopening the protected invocation. */
export type TriggerAdmission = Readonly<{
  libraryId: string;
  context: AppMethodCallContext;
  /** The admitted frame's selection and verified artifact, pinned on arm. */
  installationAuthority: WorkflowInstallationAuthority;
}>;

export type ScheduleOperation = "armSchedule" | "disarmSchedule" | "schedules";

/** Host controls and alarm delivery compose the shared schedule owner unchanged. */
export function createStandaloneWorkflowSchedules<Frame>(
  options: Parameters<typeof createWorkflowSchedules>[0] & {
    admitInvocation(
      frame: Frame,
      operation: ScheduleOperation,
    ): Promise<TriggerAdmission>;
  },
) {
  const schedules = createWorkflowSchedules(options);
  return {
    nextWake: schedules.nextWake,
    /** Native DO alarm delivery enters the same shared occurrence/fire path. */
    alarm: () => schedules.fireDue(),
    async arm(frame: Frame, raw: TriggerArmTarget) {
      const target = triggerArmTargetSchema.parse(raw);
      const { libraryId, context, installationAuthority } =
        await options.admitInvocation(frame, "armSchedule");
      if (context.actor.kind !== "member") return { error: "not_granted" };
      if (context.computerId === null)
        return {
          kind: "refused" as const,
          reason: "Select a Computer before arming a schedule",
        };
      // Standalone has no Agent arming source: the owner arms as themself.
      return schedules.arm(
        { armedBy: context.actor.memberId, armedVia: null },
        { ...target, installationId: libraryId },
        context.computerId,
        installationAuthority,
      );
    },
    async disarm(frame: Frame, raw: ScheduleDisarmInput) {
      const { scheduleId } = scheduleDisarmInputSchema.parse(raw);
      const { libraryId, context } = await options.admitInvocation(
        frame,
        "disarmSchedule",
      );
      if (context.actor.kind !== "member") return { error: "not_granted" };
      return schedules.disarm(
        { kind: "member", memberId: context.actor.memberId },
        libraryId,
        scheduleId,
      );
    },
    async list(frame: Frame) {
      const { libraryId, context } = await options.admitInvocation(
        frame,
        "schedules",
      );
      if (context.actor.kind !== "member") return { error: "not_granted" };
      return {
        schedules: await schedules.list(
          { kind: "member", memberId: context.actor.memberId },
          libraryId,
        ),
      };
    },
  };
}
