/**
 * Bonsai on a standalone Oyster: the whole Worker is Oyster's own git-enabled
 * entry, plus agents on Workers AI. Bonsai is installed into it as an App
 * Release (scripts/release.mjs); nothing here is specific to Bonsai.
 */
import {
  createOysterGitWorker,
  createOysterGitMcpOwner,
  oysterGitRoot,
  type OysterGitWorkerEnv,
  type OysterGitRoot,
} from "../workers-git.js";
import { defaultTenant, tenantScope, type TenantScope } from "../tenant.js";
import { onBoxVmIngress } from "@fungi.computer/computer";
import { WorkerEntrypoint } from "cloudflare:workers";
import { installationWorkerEntrypoint } from "../installation-execution.js";
import { putContentObject } from "../build-contract.js";
import { workflowGitPassTokenSchema } from "@fungi.computer/braid/runtime";
import {
  standaloneComputerCapabilities,
  standaloneWorkspace,
  type StandaloneComputerEnv,
} from "./computer.js";
import {
  StandaloneAgentBase,
  standaloneAgents,
  type StandaloneAgentsEnv,
} from "./agents.js";
import { workersMedia, type OysterMediaEnv } from "./media.js";
import { StandaloneInstance as ComputerInstance } from "./instance.js";
// Every guest binding in every frame is this one entrypoint, routed by props.
export { OysterBinding } from "./instance.js";
import {
  StandaloneWorkflowRunsBase,
  type StandaloneWorkflowEnv,
} from "./workflows.js";
import {
  standaloneTenancyForRequest,
  StandaloneSeedConfigurationChanged,
  type StandaloneTenancyEnv,
} from "./tenancy.js";
export { StandaloneTenants } from "./tenancy.js";
import { standalonePreviewRequest } from "./preview.js";
import {
  standaloneMachineLinkRoutes,
  type StandaloneMachineLinkBindings,
} from "./machine-link.js";
export { MachineLinkDO } from "./machine-link.js";
import { standaloneWorkflowControl } from "./workflow-control.js";
import {
  standaloneWorkflowWebhookRoutes,
  standaloneWorkflowWebhookControls,
} from "./workflow-webhooks.js";
import { Hono, type ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { standaloneBuildRoutes } from "./builds.js";
import {
  standaloneComputerFleetRoutes,
  standaloneComputerSelection,
} from "./computer-fleet.js";
import {
  serveOysterComputerEgress,
  type OysterComputerEgressProps,
} from "./computer-egress.js";
import {
  appSourceOwnerRoutes,
  type AppSourceBindingEnv,
} from "./app-source.js";

export { StandaloneGraphWorkflow } from "./workflows.js";

export { MediaOperationDO } from "@fungi.computer/darkroom/cloudflare";

/** Every binding the standalone Bonsai root receives. */
export type StandaloneEnv = OysterGitWorkerEnv &
  StandaloneTenancyEnv &
  StandaloneComputerEnv &
  StandaloneAgentsEnv &
  StandaloneMachineLinkBindings &
  OysterMediaEnv &
  StandaloneWorkflowEnv &
  AppSourceBindingEnv & {
    OYSTER_HOME_INSTALLATION: string;
    /** `disabled` closes the Computer's public download lane. */
    COMPUTER_PUBLIC_EGRESS?: string;
  };

/** A tenant's registry: it owns that tenant's installations and App builds. */
const tenantRegistry = (env: StandaloneComputerEnv, scope: TenantScope) =>
  env.REGISTRY.getByName(scope.durableName("registry"));
/** The standalone fleet belongs to its default tenant, whose registry also
 * owns build jobs on the fixed build Computer. */
const computerRegistry = (env: StandaloneEnv) =>
  tenantRegistry(env, tenantScope(defaultTenant, env.OYSTER_ORIGIN));

export { ComputerDO } from "./computer.js";
export {
  WorkspaceProxy,
  WorkspaceServiceProxy,
} from "@fungi.computer/computer";

import {
  StandaloneRegistry as BaseRegistry,
  type StandaloneRegistryGit,
} from "./registry.js";

/** The registry uses the same root, with its own in-process Computer selection. */
export class OysterRegistry extends BaseRegistry {
  readonly #rootEnv: StandaloneEnv;
  readonly #root = standaloneRoot(() => this.selectedComputer());
  constructor(
    state: DurableObjectState,
    env: StandaloneEnv,
    git: StandaloneRegistryGit = {},
  ) {
    super(state, env, git);
    this.#rootEnv = env;
  }
  protected hostFor(scope: TenantScope) {
    return this.#root.hostFor(this.#rootEnv, scope);
  }
}
export { OysterKeys } from "../workers-git.js";
// WEBHOOKS keeps its deployed class name; the standalone owner also delivers to Workflows.
export { StandaloneEventDelivery as OysterWebhooks } from "./instance.js";

export { AgentDirectory } from "./agents.js";

/** The one composition root: every door reaches a tenant's host through `hostFor`. */
const standaloneRoot = (selectComputer: typeof standaloneComputerSelection) => {
  const root: OysterGitRoot<StandaloneEnv> = oysterGitRoot<StandaloneEnv>({
    tenancy: (env) => ({
      resolve: async (request) =>
        (await standaloneTenancyForRequest(env, request)).oyster.resolve(
          request,
        ),
    }),

    homeInstallationId: (env) => env.OYSTER_HOME_INSTALLATION,
    agents: standaloneAgents,
    workflows: standaloneWorkflowControl,
    workspace: async (env, keysLive, scope, request) =>
      standaloneWorkspace(
        env,
        keysLive,
        await selectComputer(tenantRegistry(env, scope), request),
      ),
    capabilities: (env, workspace, keysLive) => [
      ...standaloneComputerCapabilities(env, workspace, keysLive),
      ...workersMedia(env, workspace),
    ],
    // A presented bearer names the library that issued it; only that
    // library's run owner admits it, for one installation repository and scope.
    workflowGitPass: async (env, _scope, bearer, target) => {
      const parsed = workflowGitPassTokenSchema.safeParse(bearer);
      if (!parsed.success) return null;
      return env.WORKFLOW_RUNS.getByName(
        parsed.data.ownerId,
      ).admitWorkflowGitPass(
        bearer,
        {
          kind: "installation",
          installationId: target.installationId,
          repository: target.repository,
        },
        target.scope,
      );
    },
    // A build job's clone reads one repository as the owner who started it.
    buildGitPass: async (env, scope, pass, target) => {
      const admitted = await tenantRegistry(env, scope).admitBuildGitPass(
        pass,
        target,
      );
      return admitted === null
        ? null
        : {
            kind: "actor",
            actor: { kind: "member", memberId: admitted.requestedBy },
            role: "owner",
          };
    },
    // Operator source seeding and owner builds share the one owner guard.
    ownerRoutes: (env, scope) =>
      appSourceOwnerRoutes(env, scope)
        .route(
          "/",
          standaloneBuildRoutes(() => tenantRegistry(env, scope)),
        )
        .route(
          "/",
          standaloneComputerFleetRoutes(() => tenantRegistry(env, scope)),
        )
        .route(
          "/",
          standaloneWorkflowWebhookControls(env, () =>
            root.hostFor(env, scope),
          ),
        ),
  });
  return root;
};
const oysterRoot = standaloneRoot(standaloneComputerSelection);
export class OysterMcp extends createOysterGitMcpOwner(oysterRoot) {}
/** Background wakes readmit members through this root's tenancy, as HTTP and MCP do. */
export class StandaloneInstance extends ComputerInstance<StandaloneEnv> {
  protected hostFor(scope: TenantScope) {
    return oysterRoot.hostFor(this.env, scope);
  }
}
/** Agent App tools derive the same catalog as HTTP and MCP for the Agent's pinned tenant. */
export class StandaloneAgent extends StandaloneAgentBase<StandaloneEnv> {
  protected hostFor(scope: TenantScope) {
    return oysterRoot.hostFor(this.env, scope);
  }
}
/** Workflow runs admit through the same root composition as HTTP. */
export class StandaloneWorkflowRuns extends StandaloneWorkflowRunsBase<StandaloneEnv> {
  protected hostFor(scope: TenantScope) {
    return oysterRoot.hostFor(this.env, scope);
  }
}
const oyster = createOysterGitWorker(oysterRoot);

/** Private loopback execution uses this root's ordinary host composition. */
export class OysterInstallationExecutor extends installationWorkerEntrypoint<StandaloneEnv>(
  (env, scope) => oysterRoot.hostFor(env, scope),
) {}

/** The Computer's egress gateway: its own HTTPS Git back into this Worker. */
export class OysterComputerEgress extends WorkerEntrypoint<
  StandaloneEnv,
  OysterComputerEgressProps
> {
  override fetch(request: Request): Promise<Response> {
    const computerObjectId = this.ctx.props.computerObjectId;
    const registry = computerRegistry(this.env);
    return serveOysterComputerEgress(request, {
      origin: this.env.OYSTER_ORIGIN,
      computerId: computerObjectId,
      publicEgress: this.env.COMPUTER_PUBLIC_EGRESS,
      internetAccess: () =>
        this.env.COMPUTER.get(
          this.env.COMPUTER.idFromString(computerObjectId),
        ).internetAccess(),
      build: {
        gitPassFor: (target) =>
          registry.buildGitPassFor(computerObjectId, target),
        exchangeTemplate: (repository, request) =>
          registry.exchangeBuildTemplate(computerObjectId, repository, request),
        admitBuild: (jobId) =>
          registry.admitBuildReport(jobId, computerObjectId),
        admitObject: (jobId, grant) =>
          registry.admitBuildObject(jobId, computerObjectId, grant),
        // The bytes stream from the Computer to R2, which checks the digest;
        // the registry only admits the upload and later reads the facts.
        storeObject: (object, body, mediaType) =>
          putContentObject(
            this.env.RELEASES,
            object,
            // R2 takes a stream of known length; the stated length is exact.
            body?.pipeThrough(new FixedLengthStream(object.byteLength)) ?? null,
            mediaType,
          ),
        submitCandidate: (jobId, manifest, grant, credentialId) =>
          registry.submitBuildCandidate(jobId, manifest, grant, credentialId),
        record: (event) => registry.recordBuildEvent(event),
      },
      // Back through this Worker's own default export, the way every other client arrives.
      forward: (admitted) => this.ctx.exports.default.fetch(admitted),
    });
  }
}

const standaloneWorkerErrorHandler: ErrorHandler = (error, context) => {
  if (error instanceof StandaloneSeedConfigurationChanged) {
    const { refusal } = error;
    return context.json(
      {
        ...refusal,
        message: `Standalone seed/origin mismatch: existing data was seeded for ${refusal.seededOrigin}, but OYSTER_ORIGIN is ${refusal.configuredOrigin}. Deploy under a fresh Worker name or reset this Worker's data.`,
      },
      409,
    );
  }
  if (error instanceof HTTPException) return error.getResponse();
  console.error(error);
  return context.text("Internal Server Error", 500);
};

export default {
  async fetch(request, env, context) {
    const preview = await standalonePreviewRequest(
      request,
      env,
      (computerId) => computerRegistry(env).ownsComputer(computerId),
      (computerId, signature, port, service) =>
        env.COMPUTER.getByName(computerId).portPreview(
          signature,
          port,
          service,
        ),
    );
    if (preview !== null) return preview;
    const ingress = onBoxVmIngress(request, env, env.COMPUTER);
    if (ingress !== undefined) return ingress;
    const fetchOyster = oyster.fetch;
    if (fetchOyster === undefined)
      throw new Error("Oyster fetch handler is missing");
    return new Hono()
      .onError(standaloneWorkerErrorHandler)
      .all("/local/mesh/join", () =>
        standaloneMachineLinkRoutes(env)
          .onError(standaloneWorkerErrorHandler)
          .fetch(request, env, context),
      )
      .all("/api/teams/:teamId/local/mesh/:deviceId/connect", () =>
        standaloneMachineLinkRoutes(env)
          .onError(standaloneWorkerErrorHandler)
          .fetch(request, env, context),
      )
      .route(
        "/",
        standaloneWorkflowWebhookRoutes(env, async (incoming) => {
          const admitted = await oysterRoot.admit(env, incoming);
          return admitted === null
            ? null
            : oysterRoot.hostFor(env, admitted.scope);
        }),
      )
      .all("*", () => fetchOyster(request, env, context))
      .fetch(request, env, context);
  },
} satisfies ExportedHandler<StandaloneEnv>;
