import {
  createWorkflowSchedules,
  type WorkflowInstallationAuthority,
} from "@fungi.computer/braid/runtime";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import type { workflowAgentAuthority } from "../workflow-agent-authority.js";
import {
  scheduleDisarmInputSchema,
  schedulePauseInputSchema,
  scheduleResumeInputSchema,
  scheduleListInputSchema,
  type ScheduleListInput,
} from "@fungi.computer/workflows-wire";
import {
  triggerArmTargetSchema,
  type TriggerArmTarget,
  type ScheduleDisarmInput,
} from "./workflow-binding.js";

/** The host supplies this result only after reopening the protected invocation. */
export type TriggerAdmission = Readonly<{
  authority: Awaited<ReturnType<typeof workflowAgentAuthority>>;
  libraryId: string;
  context: AppMethodCallContext;
  /** The admitted frame's selection and verified artifact, pinned on arm. */
  installationAuthority: WorkflowInstallationAuthority;
}>;

export type ScheduleOperation =
  | "armSchedule"
  | "pauseSchedule"
  | "resumeSchedule"
  | "disarmSchedule"
  | "schedules";

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
      const { libraryId, context, installationAuthority, authority } =
        await options.admitInvocation(frame, "armSchedule");
      if (authority === null) return { error: "not_granted" };
      if (context.computerId === null)
        return {
          kind: "refused" as const,
          reason: "Select a Computer before arming a schedule",
        };

      return schedules.arm(
        authority.armer,
        { ...target, installationId: libraryId },
        context.computerId,
        installationAuthority,
      );
    },
    async disarm(frame: Frame, raw: ScheduleDisarmInput) {
      const { scheduleId } = scheduleDisarmInputSchema.parse(raw);
      const { libraryId, authority } = await options.admitInvocation(
        frame,
        "disarmSchedule",
      );
      if (authority === null) return { error: "not_granted" };
      return schedules.disarm(authority.principal, libraryId, scheduleId);
    },
    async pause(frame: Frame, raw: { scheduleId: string }) {
      const { scheduleId } = schedulePauseInputSchema.parse(raw);
      const { libraryId, authority } = await options.admitInvocation(
        frame,
        "pauseSchedule",
      );
      if (authority === null) return { error: "not_granted" };
      return schedules.pause(authority.principal, libraryId, scheduleId);
    },
    async resume(frame: Frame, raw: { scheduleId: string }) {
      const { scheduleId } = scheduleResumeInputSchema.parse(raw);
      const { libraryId, authority } = await options.admitInvocation(
        frame,
        "resumeSchedule",
      );
      if (authority === null) return { error: "not_granted" };
      return schedules.resume(authority.principal, libraryId, scheduleId);
    },
    async list(frame: Frame, raw: ScheduleListInput) {
      const input = scheduleListInputSchema.parse(raw);
      const { libraryId, authority } = await options.admitInvocation(
        frame,
        "schedules",
      );
      if (authority === null) return { error: "not_granted" };
      return schedules.list(authority.principal, libraryId, input);
    },
  };
}
