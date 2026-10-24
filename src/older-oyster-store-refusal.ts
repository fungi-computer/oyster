import { olderOysterStoreResponse } from "./older-oyster-store.js";
import type { TenantScope } from "./tenant.js";
import type { OysterWorkerEnv } from "./workers.js";

/** Scopes whose registry answered "not older" in this isolate; a refusal is never cached. */
const cleanScopes = new WeakMap<object, Set<string>>();

/** Answer with the refusal when the request's registry holds an older store. */
export async function refuseOlderOysterStore(
  request: Request,
  env: Pick<OysterWorkerEnv, "REGISTRY">,
  scope: TenantScope,
): Promise<Response | null> {
  const name = scope.durableName("registry");
  let clean = cleanScopes.get(env);
  if (clean === undefined) {
    clean = new Set();
    cleanScopes.set(env, clean);
  }
  if (clean.has(name)) return null;
  if (await env.REGISTRY.getByName(name).storeFromOlderOyster())
    return olderOysterStoreResponse(request);
  clean.add(name);
  return null;
}
