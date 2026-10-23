/** The standalone registry Durable Object as an `InstallationStore`. */
import type { InstallationStore } from "../host.js";
import type { TenantScope } from "../tenant.js";
import type { OysterWorkerEnv } from "../workers.js";
import { installationOperationsPort } from "../installation-operations.js";

/** Read and commit installations in the scope's registry. */
export function registryInstallations(
  env: Pick<OysterWorkerEnv, "REGISTRY">,
  scope: TenantScope,
): InstallationStore {
  const registry = () => env.REGISTRY.getByName(scope.durableName("registry"));
  return {
    operations: installationOperationsPort(
      (request) => registry().installationOperation(request),
      { tenantId: scope.tenantId, origin: scope.origin },
    ),
    generation: async () => registry().generation(),
    list: async () => registry().list(),
    get: async (id) => registry().get(id),
    compareAndPut: async (
      installation,
      expectedAuthorityVersion,
      expectedGeneration,
    ) =>
      await registry().compareAndPut(
        installation,
        expectedAuthorityVersion,
        expectedGeneration,
        scope.tenantId,
      ),
  };
}
