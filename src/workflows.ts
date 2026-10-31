import { z } from "zod";
import { Mycelium, type ModuleRegistration } from "@fungi.computer/mycelium";
import { cancelReplySchema, statusReply } from "@fungi.computer/workflows-wire";
import * as Schema from "effect/Schema";
import { releaseIdSchema } from "@fungi.computer/puffball/effect";
import type { ReleaseId } from "@fungi.computer/puffball";
import { appComputerAdmissionRefusalSchema } from "@fungi.computer/agar/computer-contracts";
import { causeClass } from "./cause-class.js";
export {
  createWorkflowWebhooks,
  workflowWebhookCommandSchema,
  workflowWebhookControlResponse,
} from "./webhooks.js";
export { workflowWebhookRefusal } from "./webhook-ingress.js";

/** Existing authoring operations available to an admitted Agent App invocation. */
export const agentWorkflowOperationSchema = z.enum([
  "catalog",
  "schedules",
  "armSchedule",
  "pauseSchedule",
  "resumeSchedule",
  "disarmSchedule",
  "eventTriggers",
  "armEventTrigger",
  "disarmEventTrigger",
]);
export const agentAppWorkflowRequestSchema = z.strictObject({
  authorityVersion: z.number().int().nonnegative(),
  method: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256).optional(),
  releaseId: z.string().pipe(z.custom<ReleaseId>(Schema.is(releaseIdSchema))),
  installationId: z.string().min(1).max(256),
  computerId: z.string().min(1).max(256).nullable(),
  operation: agentWorkflowOperationSchema,
  requestId: z.uuidv7(),
});
export type AgentAppWorkflowRequest = z.output<
  typeof agentAppWorkflowRequestSchema
>;
export type AgentAppWorkflowPreparation =
  | z.output<typeof appComputerAdmissionRefusalSchema>
  | Readonly<{
      kind: "admitted";
      attachmentId: string;
      attachmentVersion: number;
      grantorMemberId: string;
      computerId: string | null;
      authorityVersion: number;
      releaseId: string;
      appId: string;
    }>;

/** Neutral identity shared by both host catalogs. */
export const WORKFLOW_CONTROL_MODULE_ID = "workflow-control";

/**
 * Host-bound calls re-admit their principal on every execution.
 *
 * @inline
 */
export type WorkflowControl = Readonly<{
  /** Read an admitted run's current status, or null when it is unavailable. */
  status(runId: string): Promise<z.output<typeof statusReply> | null>;
  /** Cancel an admitted run through the host's current Workflow authority. */
  cancel(runId: string): Promise<z.output<typeof cancelReplySchema>>;
}>;

const jsonValue = z.json();
type Json = z.output<typeof jsonValue>;
function retain<I, O extends Json>(spec: {
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  execute(input: I): Promise<O>;
}): (input: Json) => Promise<Json> {
  return async (input) =>
    spec.output.parseAsync(
      await spec.execute(await spec.input.parseAsync(input)),
    );
}

/** The same module and parsed execution closures serve either host. */
export type WorkflowControlModule = Readonly<{
  module: ModuleRegistration;
  operations: Readonly<
    Record<
      "status" | "cancel",
      (input: z.core.util.JSONType) => Promise<z.core.util.JSONType>
    >
  >;
}>;

/** Parsed MCP and Agent operations over the host's live Workflow authority. */
export function createMcpWorkflowControl(
  control: WorkflowControl,
): WorkflowControlModule {
  const input = z.strictObject({ runId: z.string().min(1).max(256) });
  const specs = {
    cancel: {
      description:
        "Cancel a run you started or administer. Completed runs remain terminal.",
      input,
      output: z.union([
        cancelReplySchema,
        z.strictObject({ kind: z.literal("error"), error: z.string() }),
      ]),
      execute: async ({ runId }: z.output<typeof input>) => {
        try {
          return cancelReplySchema.parse(await control.cancel(runId));
        } catch (cause) {
          console.error("Workflow cancellation unavailable", causeClass(cause));
          return {
            kind: "error" as const,
            error: "Workflow cancellation unavailable",
          };
        }
      },
    },
    status: {
      description:
        "Read the live status and step projection of a Workflow run.",
      input,
      output: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("found"), snapshot: jsonValue }),
        z.object({ kind: z.literal("error"), error: z.string() }),
      ]),
      execute: async ({ runId }: z.output<typeof input>) => {
        try {
          const snapshot = await control.status(runId);
          return snapshot === null
            ? { kind: "error" as const, error: "Workflow run not found" }
            : { kind: "found" as const, snapshot };
        } catch (cause) {
          console.error("Workflow status unavailable", causeClass(cause));
          return {
            kind: "error" as const,
            error: "Workflow status unavailable",
          };
        }
      },
    },
  };
  return {
    module: Mycelium.module({
      id: WORKFLOW_CONTROL_MODULE_ID,
      name: "workflows",
      operations: {
        cancel: Mycelium.operation({ ...specs.cancel, replay: "unsafe" }),
        status: Mycelium.operation({ ...specs.status, replay: "safe" }),
      },
    }),
    operations: {
      cancel: retain(specs.cancel),
      status: retain(specs.status),
    },
  };
}
