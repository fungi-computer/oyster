import type { OysterWorkerEnv } from "@fungi.computer/oyster-old-001/workers";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  defaultTenant,
  tenantScope,
} from "@fungi.computer/oyster-old-001/tenant";
import { oldRegistrySqlRequest } from "./old-worker-http.js";
import { ReadOnlyOldOysterDO } from "./old-worker-readonly.js";
import { streamOldSql } from "./old-worker-stream.js";

// The packaged 0.0.1 standalone has v1 and mcp-session-owner-v1, not oyster-v1.
export class OysterBinding extends WorkerEntrypoint {}
export class OysterInstance extends ReadOnlyOldOysterDO {}
export class OysterMcp extends ReadOnlyOldOysterDO {}

export class OysterRegistry extends ReadOnlyOldOysterDO {
  async fetch(): Promise<Response> {
    const pendingAt = await this.readPendingAlarm();
    return streamOldSql(this.ctx.storage.sql, {
      pendingAt,
      observedAt: Date.now(),
    });
  }
}

export default {
  fetch(request: Request, env: OysterWorkerEnv) {
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
