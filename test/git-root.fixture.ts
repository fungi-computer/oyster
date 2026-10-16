// Oyster's git root alone, the layer the standalone host builds on. Add Git to an Oyster Worker. `host.git` is the whole seam: `createOyster`
// mounts the git door at `/git/<installation>/<repo>.git`, and every clone,
// fetch and push passes host authentication, live installation admission and
// the App's own push policy before Artifacts sees a byte.
//
// One root composes every tenant host. HTTP, MCP and background wakes all reach
// it through `root.hostFor`, so they share one auth, one workspace and one
// capability set.
import type { TenantScope } from "@fungi.computer/oyster/tenant";
import {
  createOysterGitMcpOwner,
  createOysterGitWorker,
  OysterGitInstance,
  oysterGitRoot,
  ownerOrKeyTenancy,
  type OysterGitWorkerEnv,
} from "@fungi.computer/oyster/workers-git";

export { OysterRegistry } from "@fungi.computer/oyster/workers";
// The one binding entrypoint, whose table also hands Apps `env.GIT` and `env.EVENTS`.
export {
  OysterBinding,
  OysterKeys,
  OysterWebhooks,
} from "@fungi.computer/oyster/workers-git";

// The owner key, or a named key minted at POST /api/keys, signs `git` in.
const root = oysterGitRoot<OysterGitWorkerEnv>({ tenancy: ownerOrKeyTenancy });

export class OysterMcp extends createOysterGitMcpOwner(root) {}

/** Instances that hand Apps `env.GIT` and `env.EVENTS`; wakes use the root's host. */
export class OysterInstance extends OysterGitInstance {
  protected hostFor(scope: TenantScope) {
    return root.hostFor(this.env, scope);
  }
}

export default createOysterGitWorker(root);
