import { AppInstanceError } from "../index.js";
import {
  oysterBindingEntrypoint,
  type OysterBindingTable,
} from "../workers.js";
import {
  OysterGitInstance,
  OysterWebhooks,
  eventsBindingFor,
  gitBindings,
  type HostRecipientEvent,
  type OysterGitWorkerEnv,
} from "../workers-git.js";
import {
  agentFrameMethods,
  dispatchAgentBinding,
  type StandaloneAgentsEnv,
} from "./agents.js";
import {
  computerFrameMethods,
  computerInvocation,
  standaloneWorkspace,
  type StandaloneComputerEnv,
} from "./computer.js";
import {
  dispatchMediaBinding,
  mediaFrameMethods,
  type OysterMediaEnv,
} from "./media.js";
import {
  appSourceFrameMethods,
  dispatchAppSourceBinding,
  type AppSourceBindingEnv,
} from "./app-source.js";
import {
  workflowFrameMethods,
  dispatchWorkflowBinding,
  deliverWorkflowEvent,
  openWorkflowGitPass,
  workflowEventRecipients,
  type WorkflowBindingEnv,
  type WorkflowEventEnv,
  type WorkflowGitPassEnv,
} from "./workflow-binding.js";
import {
  appsFrameMethods,
  dispatchAppsBuildsBinding,
} from "./app-builds-binding.js";

export type StandaloneInstanceEnv = OysterGitWorkerEnv &
  WorkflowBindingEnv &
  WorkflowEventEnv &
  WorkflowGitPassEnv &
  StandaloneComputerEnv &
  StandaloneAgentsEnv &
  OysterMediaEnv &
  AppSourceBindingEnv;

/** Git and Events plus the declared Computer, Media, Workflow, Agent and App
 * source bindings. */
export const standaloneBindings: OysterBindingTable<StandaloneInstanceEnv> = {
  ...gitBindings,
  /** Catalog and fork are source operations; build, status and select
   * run on this Oyster's Computer and installations. */
  APPS: {
    methods: { ...appSourceFrameMethods.APPS, ...appsFrameMethods.APPS },
    dispatch: (context, frame, props, method, args) =>
      Object.hasOwn(appSourceFrameMethods.APPS, method)
        ? dispatchAppSourceBinding(
            context.env,
            context.scope(),
            frame,
            method,
            args,
          )
        : dispatchAppsBuildsBinding(
            context.env,
            context.scope(),
            frame,
            props,
            method,
            args,
            context.backgroundHost,
          ),
  },
  COMPUTER: {
    methods: computerFrameMethods.COMPUTER,
    async dispatch(context, frame, _props, method, args) {
      if (method !== "workflowGitPass")
        return computerInvocation(context.env, frame, method, args);
      // A published Workflow Git step's pass, minted by the library that runs it.
      const host = await context.backgroundHost();
      if (host === null) throw new AppInstanceError("revoked");
      return openWorkflowGitPass(context.env, host.installations, frame, args);
    },
  },
  MEDIA: {
    methods: mediaFrameMethods.MEDIA,
    dispatch: (context, frame, props, method, args) =>
      dispatchMediaBinding(
        context.env,
        frame,
        props,
        method,
        args,
        standaloneWorkspace(context.env),
      ),
  },
  WORKFLOWS: {
    methods: workflowFrameMethods.WORKFLOWS,
    dispatch: (context, frame, props, method, args) =>
      dispatchWorkflowBinding(context.env, frame, props, method, args),
  },
  INBOX: {
    methods: agentFrameMethods.INBOX,
    dispatch: (context, frame, props, method, args) =>
      dispatchAgentBinding(
        context.env,
        context.scope(),
        frame,
        props,
        method,
        args,
      ),
  },
  AGENTS: {
    methods: agentFrameMethods.AGENTS,
    dispatch: (context, frame, props, method, args) =>
      dispatchAgentBinding(
        context.env,
        context.scope(),
        frame,
        props,
        method,
        args,
      ),
  },
  /** The emit commits to the delivery owner; Workflows libraries receive it afterwards. */
  EVENTS: eventsBindingFor<StandaloneInstanceEnv>(async (context) => {
    const host = await context.backgroundHost();
    if (host === null) throw new AppInstanceError("revoked");
    return workflowEventRecipients(host.installations);
  }),
};

/** The standalone root's one guest binding entrypoint, over `standaloneBindings`. */
export class OysterBinding extends oysterBindingEntrypoint(
  standaloneBindings,
) {}

/** The standalone Instance serves `standaloneBindings`; its root names `hostFor`. */
export abstract class StandaloneInstance<
  Env extends StandaloneInstanceEnv = StandaloneInstanceEnv,
> extends OysterGitInstance<Env> {
  protected override readonly bindings: OysterBindingTable<Env> =
    standaloneBindings;
}

/**
 * The tenant's event delivery owner, whose host recipients are Workflows
 * libraries. A library that is down keeps its own row pending and retried, or
 * failed after the last retry; the emitting App's write has already returned.
 */
export class StandaloneEventDelivery extends OysterWebhooks<WorkflowEventEnv> {
  protected override deliverToRecipient(
    delivery: Readonly<{ recipient: string; event: HostRecipientEvent }>,
  ): Promise<void> {
    return deliverWorkflowEvent(this.env, delivery.recipient, delivery.event);
  }
}
