import type { StandaloneEnv } from "@fungi.computer/oyster-old-01/standalone";
import { WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";
import {
  defaultTenant,
  tenantScope,
} from "@fungi.computer/oyster-old-01/tenant";
import { oldRegistrySqlRequest } from "./old-worker-http.js";
import {
  OysterArchivingError,
  ReadOnlyOldOysterDO,
} from "./old-worker-readonly.js";
import { streamOldSql } from "./old-worker-stream.js";

// These are the published class identities, with no published constructors or
// callback bodies. Keep the published oyster-v1 migration tag unchanged.
export class StandaloneTenants extends ReadOnlyOldOysterDO {}
export class OysterMcp extends ReadOnlyOldOysterDO {}
export class StandaloneWorkflowRuns extends ReadOnlyOldOysterDO {}
export class StandaloneInstance extends ReadOnlyOldOysterDO {}
export class ComputerDO extends ReadOnlyOldOysterDO {}
export class OysterKeys extends ReadOnlyOldOysterDO {}
export class OysterWebhooks extends ReadOnlyOldOysterDO {}
export class StandaloneAgent extends ReadOnlyOldOysterDO {}
export class AgentDirectory extends ReadOnlyOldOysterDO {}
export class MediaOperationDO extends ReadOnlyOldOysterDO {}
export class OysterBinding extends WorkerEntrypoint {}
export class OysterComputerEgress extends WorkerEntrypoint {}

export class OysterRegistry extends ReadOnlyOldOysterDO {
  async fetch(): Promise<Response> {
    const pendingAt = await this.readPendingAlarm();
    return streamOldSql(this.ctx.storage.sql, {
      pendingAt,
      observedAt: Date.now(),
    });
  }
}

export class StandaloneGraphWorkflow extends WorkflowEntrypoint {
  run(): Promise<never> {
    return Promise.reject(new OysterArchivingError());
  }
}

export default {
  fetch(request: Request, env: StandaloneEnv) {
    return oldRegistrySqlRequest(request, env.OYSTER_OWNER_KEY, () => {
      const scope = tenantScope(defaultTenant, env.OYSTER_ORIGIN);
      // The release-matched bridge binds REGISTRY to the OysterRegistry
      // subclass exported here, whose fetch streams the export.
      return env.REGISTRY.getByName(scope.durableName("registry")).fetch(
        new Request(request.url),
      );
    });
  },
};
