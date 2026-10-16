import type { TenantScope } from "../tenant.js";
import type { StandaloneAgentsEnv } from "./agents.js";

/** Host-only lookup from the already selected frame tenant; never derive it from an App or caller. */
export function agentDirectoryForScope(
  env: Pick<StandaloneAgentsEnv, "AGENT_DIRECTORY">,
  scope: Pick<TenantScope, "durableName">,
) {
  return env.AGENT_DIRECTORY.getByName(scope.durableName("agents"));
}
