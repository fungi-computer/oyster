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
} from "../workers-git.js";
import { defaultTenant, tenantScope, type TenantScope } from "../tenant.js";
import { onBoxVmIngress } from "@fungi.computer/computer";
import { WorkerEntrypoint } from "cloudflare:workers";
import { putContentObject } from "../build-contract.js";
import { workflowGitPassPrefix } from "../git.js";
import { z } from "zod";
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
import { standaloneTenancy, type StandaloneTenancyEnv } from "./tenancy.js";
export { StandaloneTenants } from "./tenancy.js";
import { standalonePreviewRequest } from "./preview.js";
import { standaloneBuildRoutes } from "./builds.js";
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
/** The standalone's one Computer belongs to its default tenant, whose
 * registry minted every build job that Computer runs. */
const computerRegistry = (env: StandaloneEnv) =>
  tenantRegistry(env, tenantScope(defaultTenant, env.OYSTER_ORIGIN));

export { ComputerDO } from "./computer.js";
export {
  WorkspaceProxy,
  WorkspaceServiceProxy,
} from "@fungi.computer/computer";

export { StandaloneRegistry as OysterRegistry } from "./registry.js";
export { OysterKeys } from "../workers-git.js";
// WEBHOOKS keeps its deployed class name; the standalone owner also delivers to Workflows.
export { StandaloneEventDelivery as OysterWebhooks } from "./instance.js";

export { AgentDirectory } from "./agents.js";

/** After Oyster's bearer prefix: `<library>.<pass>`, as the library minted it. */
const workflowGitPassToken = z
  .string()
  .regex(/^([a-zA-Z0-9_-]{1,256})\.([0-9a-f]{64})$/u)
  .transform((token) => {
    const [libraryId = "", passId = ""] = token.split(".");
    return [libraryId, passId] as const;
  });
/** The one composition root: every door reaches a tenant's host through `hostFor`. */
const oysterRoot = oysterGitRoot<StandaloneEnv>({
  tenancy: (env) => ({
    resolve: async (request) =>
      (await standaloneTenancy(env)).oyster.resolve(request),
  }),

  homeInstallationId: (env) => env.OYSTER_HOME_INSTALLATION,
  agents: standaloneAgents,
  workspace: standaloneWorkspace,
  capabilities: (env, workspace, keysLive) => [
    ...standaloneComputerCapabilities(env, workspace, keysLive),
    ...workersMedia(env, workspace),
  ],
  // A presented pass names the library that minted it; only that library's
  // run owner admits it, for one installation repository and scope.
  workflowGitPass: async (env, _scope, pass, target) => {
    const parsed = workflowGitPassToken.safeParse(
      pass.slice(workflowGitPassPrefix.length),
    );
    if (!parsed.success) return null;
    const [libraryId, passId] = parsed.data;
    return env.WORKFLOW_RUNS.getByName(libraryId).admitWorkflowGitPass(
      passId,
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
    appSourceOwnerRoutes(env, scope).route(
      "/",
      standaloneBuildRoutes(() => tenantRegistry(env, scope)),
    ),
});
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

export default {
  async fetch(request, env, context) {
    const preview = await standalonePreviewRequest(
      request,
      env,
      env.OYSTER_COMPUTER_ID,
      (signature, port, service) =>
        env.COMPUTER.getByName(env.OYSTER_COMPUTER_ID).portPreview(
          signature,
          port,
          service,
        ),
    );
    if (preview !== null) return preview;
    const ingress = onBoxVmIngress(request, env, env.COMPUTER);
    if (ingress !== undefined) return ingress;
    if (oyster.fetch === undefined)
      throw new Error("Oyster fetch handler is missing");
    return oyster.fetch(request, env, context);
  },
} satisfies ExportedHandler<StandaloneEnv>;
