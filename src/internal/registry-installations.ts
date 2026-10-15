/** The standalone registry Durable Object as an `InstallationStore`. */
import type { InstallationStore } from "../host.js";
import type { TenantScope } from "../tenant.js";
import type { OysterWorkerEnv } from "../workers.js";

/** Read and commit installations in the scope's registry. */
export function registryInstallations(
  env: Pick<OysterWorkerEnv, "REGISTRY">,
  scope: TenantScope,
): InstallationStore {
  const registry = () => env.REGISTRY.getByName(scope.durableName("registry"));
  return {
    list: async () => registry().list(),
    get: async (id) => registry().get(id),
    put: async (installation) => {
      await registry().put(installation, scope.tenantId);
    },
    compareAndPut: async (installation, expectedAuthorityVersion) =>
      await registry().compareAndPut(
        installation,
        expectedAuthorityVersion,
        scope.tenantId,
      ),
  };
}
