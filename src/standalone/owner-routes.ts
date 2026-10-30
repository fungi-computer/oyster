/**
 * The standalone root's owner routes: App source seeding, builds, the Computer
 * fleet, Agent Computer attachment and Workflow webhook controls. The Worker
 * and the authorization law both compose them from this one function.
 */
import type { OysterEnv, OysterHost } from "../host.js";
import type { Routes } from "../authorization.js";
import type { TenantScope } from "../tenant.js";
import { agentDirectoryForScope } from "./agent-directory.js";
import type { StandaloneAgentsEnv } from "./agents.js";
import { standaloneAgentComputerRoutes } from "./agent-computers.js";
import {
  appSourceOwnerRoutes,
  type AppSourceBindingEnv,
} from "./app-source.js";
import { standaloneBuildRoutes } from "./builds.js";
import type { StandaloneComputerEnv } from "./computer.js";
import { standaloneComputerFleetRoutes } from "./computer-fleet.js";
import { standaloneWorkflowWebhookControls } from "./workflow-webhooks.js";
import type { StandaloneWorkflowEnv } from "./workflows.js";

/** The bindings the standalone owner routes reach, resolved per request. */
export type StandaloneOwnerRoutesEnv = AppSourceBindingEnv &
  Pick<StandaloneComputerEnv, "REGISTRY"> &
  Pick<StandaloneAgentsEnv, "AGENT_DIRECTORY"> &
  Pick<StandaloneWorkflowEnv, "WORKFLOW_RUNS">;

/** Every owner route the standalone root adds to its tenant host. */
export function standaloneOwnerRoutes(
  env: StandaloneOwnerRoutesEnv,
  scope: TenantScope,
  hostFor: () => Promise<Pick<OysterHost, "installations">>,
): Routes<OysterEnv> {
  // A tenant's registry owns its installations, builds and Computer fleet.
  const registry = () => env.REGISTRY.getByName(scope.durableName("registry"));
  const directory = () => agentDirectoryForScope(env, scope);
  return appSourceOwnerRoutes(env, scope)
    .include(standaloneBuildRoutes(registry))
    .include(standaloneComputerFleetRoutes(registry))
    .include(
      standaloneAgentComputerRoutes({
        attach: (principal, command) =>
          directory().attachComputer(command, principal, scope.tenantId),
        detach: (principal, command) =>
          directory().detachComputer(command, principal, scope.tenantId),
        read: (principal, agentId) =>
          directory().readAgentComputers(agentId, principal, scope.tenantId),
      }),
    )
    .include(standaloneWorkflowWebhookControls(env, hostFor));
}
