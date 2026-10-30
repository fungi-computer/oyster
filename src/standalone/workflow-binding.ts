import * as S from "effect/Schema";
import { z } from "zod";
import { graphReviewSchema, reviewAnswerSchema } from "@fungi.computer/braid";
import {
  graphStartRequestSchema,
  workflowTriggerTargetSchema,
  type WorkflowGitPassGrant,
} from "@fungi.computer/braid/runtime";
import {
  runReply,
  answerReviewReply,
  catalogReplySchema,
  statusReply,
  cancelReplySchema,
  runsReplySchema,
  runsInputSchema,
  eventArmReplySchema,
  eventDisarmInputSchema,
  eventTriggersReplySchema,
  scheduleArmReplySchema,
  scheduleDisarmInputSchema,
  schedulePauseInputSchema,
  schedulePauseReplySchema,
  scheduleListInputSchema,
  schedulesReplySchema,
  triggerDisarmReplySchema,
  triggerListInputSchema,
} from "@fungi.computer/workflows-wire";
import type { Installation } from "../apps/index.js";
import { workflowAttestationSchema } from "@fungi.computer/puffball/app-method-runtime";
import {
  appEventFactSchema,
  type AppEventFact,
} from "@fungi.computer/puffball/app-event-facts";
import type { HostRecipientEvent } from "../workers-git.js";
import type { FrameBindingMethods, FrameBindingProps } from "../cloudflare.js";
import type { InvocationFacts, InvocationFrame } from "../invocation.js";
import type { OysterJson } from "../host.js";
import { AppInstanceError } from "../index.js";
import type { StandaloneWorkflowRunsBase } from "./workflows.js";

export const runKey = S.Struct({ runId: S.String });
export const reviewKey = S.Struct({
  runId: graphReviewSchema.fields.runId,
  nodeId: graphReviewSchema.fields.nodeId,
  iteration: graphReviewSchema.fields.iteration,
  answer: reviewAnswerSchema,
});
/** The App supplies its immutable publication row; the host supplies the library. */
export const triggerArmTargetSchema = workflowTriggerTargetSchema.omit({
  installationId: true,
});
export type TriggerArmTarget = z.output<typeof triggerArmTargetSchema>;
export type ScheduleDisarmInput = z.output<typeof scheduleDisarmInputSchema>;
export type EventDisarmInput = z.output<typeof eventDisarmInputSchema>;

/** The frame gate needs only these run-owner calls; it re-decodes each reply with the method's owner schema. */
export type WorkflowRunCalls = Pick<
  StandaloneWorkflowRunsBase,
  | "admitWorkflowGit"
  | "catalog"
  | "start"
  | "status"
  | "cancel"
  | "answerReview"
  | "armSchedule"
  | "pauseSchedule"
  | "disarmSchedule"
  | "schedules"
  | "armEventTrigger"
  | "disarmEventTrigger"
  | "eventTriggers"
  | "runs"
>;
export type WorkflowBindingEnv = Readonly<{
  WORKFLOW_RUNS: Readonly<{
    getByName(installationId: string): WorkflowRunCalls;
  }>;
}>;
/** Each Workflows library receives emitted App events at its run owner. */
export type WorkflowEventEnv = Readonly<{
  WORKFLOW_RUNS: Readonly<{
    getByName(installationId: string): Readonly<{
      deliverEvent(fact: AppEventFact): Promise<"accepted">;
    }>;
  }>;
}>;

const effectArgs = <A>(schema: S.Codec<A, unknown>) =>
  S.decodeUnknownSync(schema, { onExcessProperty: "error" });
const workflowArgs = {
  catalog: effectArgs(
    S.Tuple([S.Struct({ installationId: S.optionalKey(S.String) })]),
  ),
  runGraph: effectArgs(S.Tuple([graphStartRequestSchema])),
  graphStatus: effectArgs(S.Tuple([runKey])),
  cancel: effectArgs(S.Tuple([runKey])),
  answerReview: effectArgs(S.Tuple([reviewKey])),
  armSchedule: (args: unknown) => z.tuple([triggerArmTargetSchema]).parse(args),
  disarmSchedule: (args: unknown) =>
    z.tuple([scheduleDisarmInputSchema]).parse(args),
  pauseSchedule: (args: unknown) =>
    z.tuple([schedulePauseInputSchema]).parse(args),
  schedules: (args: unknown) => z.tuple([scheduleListInputSchema]).parse(args),
  armEventTrigger: (args: unknown) =>
    z.tuple([triggerArmTargetSchema]).parse(args),
  disarmEventTrigger: (args: unknown) =>
    z.tuple([eventDisarmInputSchema]).parse(args),
  eventTriggers: (args: unknown) =>
    z.tuple([triggerListInputSchema]).parse(args),
  runs: (args: unknown) => z.tuple([runsInputSchema]).parse(args),
};
const workflowResults = {
  catalog: catalogReplySchema,
  runGraph: runReply,
  graphStatus: statusReply,
  cancel: cancelReplySchema,
  answerReview: answerReviewReply,
  armSchedule: scheduleArmReplySchema,
  disarmSchedule: triggerDisarmReplySchema,
  pauseSchedule: schedulePauseReplySchema,
  schedules: schedulesReplySchema,
  armEventTrigger: eventArmReplySchema,
  disarmEventTrigger: triggerDisarmReplySchema,
  eventTriggers: eventTriggersReplySchema,
  runs: runsReplySchema,
};
const workflowMethod = z.enum([
  "catalog",
  "runGraph",
  "graphStatus",
  "cancel",
  "answerReview",
  "armSchedule",
  "pauseSchedule",
  "disarmSchedule",
  "schedules",
  "armEventTrigger",
  "disarmEventTrigger",
  "eventTriggers",
  "runs",
]);
/** The guest factory and the live Instance gate consume the same owner grammars. */
export const workflowFrameMethods = {
  WORKFLOWS: Object.fromEntries(
    workflowMethod.options.map((method) => [
      method,
      {
        decodeArgs: workflowArgs[method],
        decodeResult: (value: unknown) =>
          z.json().parse(workflowResults[method].parse(value)),
        requiredOperations: () => [method],
      },
    ]),
  ),
} satisfies FrameBindingMethods<OysterJson>;

/**
 * The host recipients of an App's accepted EVENTS.emit: every enabled
 * Workflows library approved to arm triggers. The host records one durable
 * delivery per library and returns; the emit never waits on a library.
 */
export async function workflowEventRecipients(
  installations: Readonly<{
    list(): Promise<
      readonly Pick<Installation, "installationId" | "status" | "authority">[]
    >;
  }>,
): Promise<readonly string[]> {
  return (await installations.list())
    .filter(
      (installation) =>
        installation.status === "enabled" &&
        installation.authority.approvedGrants.some(
          (grant) => grant.capability === "workflow.arm",
        ),
    )
    .map((installation) => installation.installationId);
}

/**
 * One recorded delivery to one library: the host-attested fact reaches its
 * run owner, which fires only its own armed triggers and replays by event id,
 * so the delivery owner's retries never start a run twice.
 */
export async function deliverWorkflowEvent(
  env: WorkflowEventEnv,
  libraryId: string,
  event: HostRecipientEvent,
): Promise<void> {
  const fact = appEventFactSchema.parse({
    type: event.type,
    payload: event.payload,
    eventId: event.eventId,
    installationId: event.source.installationId,
    appId: event.source.appId,
    releaseId: event.source.releaseId,
  });
  await env.WORKFLOW_RUNS.getByName(libraryId).deliverEvent(fact);
}

/** What a Workflow node frame attests when its Git step is admitted. */
export const workflowGitPassRequestSchema = z.lazy(() =>
  z.strictObject({
    installationId: z.string().min(1).max(256),
    idempotencyKey: z.string().min(1).max(128),
    workflow: workflowAttestationSchema,
    memberId: z.string().min(1).max(256),
    computerId: z.string().min(1).max(256),
  }),
);
export type WorkflowGitPassRequest = z.output<
  typeof workflowGitPassRequestSchema
>;
/** Each run library's per-step Workflow Git admission. */
export type WorkflowGitStepEnv = Readonly<{
  WORKFLOW_RUNS: Readonly<{
    getByName(libraryId: string): Pick<WorkflowRunCalls, "admitWorkflowGit">;
  }>;
}>;

/**
 * The public grant for the Git step a member Workflow node frame is running,
 * from the run library that dispatched it; null for any other frame. Every
 * native command the step starts carries this grant, never a credential.
 */
export async function workflowGitStepGrant(
  env: WorkflowGitStepEnv,
  installations: Readonly<{
    list(): Promise<
      readonly Pick<Installation, "installationId" | "status" | "authority">[]
    >;
  }>,
  frame: Readonly<{ facts: InvocationFacts; signal: AbortSignal }>,
): Promise<WorkflowGitPassGrant | null> {
  const { subject, selection } = frame.facts;
  if (
    subject.kind !== "call" ||
    subject.context.workflow === undefined ||
    subject.context.idempotencyKey === undefined ||
    subject.context.actor.kind !== "member" ||
    subject.context.computerId === null ||
    selection.owner.kind !== "installation"
  )
    return null;
  const request = workflowGitPassRequestSchema.parse({
    installationId: selection.owner.id,
    idempotencyKey: subject.context.idempotencyKey,
    workflow: subject.context.workflow,
    memberId: subject.context.actor.memberId,
    computerId: subject.context.computerId,
  });
  for (const library of await installations.list()) {
    if (
      library.status !== "enabled" ||
      !library.authority.approvedGrants.some(
        (grant) => grant.capability === "workflow.run",
      )
    )
      continue;
    frame.signal.throwIfAborted();
    const grant = await env.WORKFLOW_RUNS.getByName(
      library.installationId,
    ).admitWorkflowGit(request);
    if (grant !== null) return grant;
  }
  return null;
}

/** Called only after the Instance's shared gate resolves this live frame. */
export async function dispatchWorkflowBinding(
  env: WorkflowBindingEnv,
  frame: InvocationFrame,
  props: FrameBindingProps,
  method: string,
  args: readonly unknown[],
): Promise<OysterJson> {
  frame.signal.throwIfAborted();
  if (
    props.binding !== "WORKFLOWS" ||
    (frame.facts.subject.kind !== "call" &&
      !(method === "runGraph" && frame.facts.subject.name === "onGitPush")) ||
    frame.facts.selection.owner.kind !== "installation"
  )
    throw new AppInstanceError("revoked");
  const runs = env.WORKFLOW_RUNS.getByName(frame.facts.selection.owner.id);
  let result: unknown;
  switch (method) {
    case "catalog": {
      const [input] = workflowArgs.catalog(args);
      result = await runs.catalog(frame.facts, input);
      break;
    }
    case "runGraph": {
      const [input] = workflowArgs.runGraph(args);
      result = await runs.start(frame.facts, input);
      break;
    }
    case "graphStatus": {
      const [input] = workflowArgs.graphStatus(args);
      result = await runs.status(frame.facts, input);
      break;
    }
    case "cancel": {
      const [input] = workflowArgs.cancel(args);
      result = await runs.cancel(frame.facts, input);
      break;
    }
    case "answerReview": {
      const [input] = workflowArgs.answerReview(args);
      result = await runs.answerReview(frame.facts, input);
      break;
    }
    case "armSchedule": {
      const [input] = workflowArgs.armSchedule(args);
      result = await runs.armSchedule(frame.facts, input);
      break;
    }
    case "disarmSchedule": {
      const [input] = workflowArgs.disarmSchedule(args);
      result = await runs.disarmSchedule(frame.facts, input);
      break;
    }
    case "pauseSchedule": {
      const [input] = workflowArgs.pauseSchedule(args);
      result = await runs.pauseSchedule(frame.facts, input);
      break;
    }
    case "schedules": {
      const [input] = workflowArgs.schedules(args);
      result = await runs.schedules(frame.facts, input);
      break;
    }
    case "armEventTrigger": {
      const [input] = workflowArgs.armEventTrigger(args);
      result = await runs.armEventTrigger(frame.facts, input);
      break;
    }
    case "disarmEventTrigger": {
      const [input] = workflowArgs.disarmEventTrigger(args);
      result = await runs.disarmEventTrigger(frame.facts, input);
      break;
    }
    case "eventTriggers":
      workflowArgs.eventTriggers(args);
      result = await runs.eventTriggers(frame.facts);
      break;
    case "runs": {
      const [input] = workflowArgs.runs(args);
      result = await runs.runs(
        frame.facts,
        input.workflowId === undefined ? {} : { workflowId: input.workflowId },
      );
      break;
    }
    default:
      throw new AppInstanceError("revoked");
  }
  frame.signal.throwIfAborted();
  return z
    .json()
    .parse(workflowResults[workflowMethod.parse(method)].parse(result));
}
