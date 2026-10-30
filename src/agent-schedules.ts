import { z } from "zod";
import {
  agentScheduleListInputSchema,
  agentScheduleTargetSchema,
} from "@fungi.computer/shiitake-extensions/schedules";

export {
  agentSchedulePageSchema,
  agentScheduleControlReceiptSchema,
} from "@fungi.computer/shiitake-extensions/schedules";
export type {
  AgentSchedulePage,
  AgentScheduleTarget,
  AgentScheduleControlReceipt,
} from "@fungi.computer/shiitake-extensions/schedules";

/** The App selects one Agent; its host must admit that target before opening it. */
export const appAgentScheduleListInputSchema =
  agentScheduleListInputSchema.extend({
    /** The native directory identity whose owner the host must admit. */
    agentId: z.string().min(1),
  });
/** A single bounded native read, not an all-Agent inventory grant. */
export type AppAgentScheduleListInput = z.input<
  typeof appAgentScheduleListInputSchema
>;

/** Both hosts decode the ordinary AGENTS packet with the native owner's grammar. */
export const agentScheduleBindingArgs = {
  /** One bounded content-bearing read, admitted independently of manage. */
  schedules: z.tuple([appAgentScheduleListInputSchema]),
  /** Pause the exact listed schedule, retaining future resume and accepted work. */
  pauseSchedule: z.tuple([agentScheduleTargetSchema]),
  /** Cancel future occurrences of the exact identity without erasing history. */
  deleteSchedule: z.tuple([agentScheduleTargetSchema]),
};
