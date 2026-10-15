// qualify-packed.mjs supplies the strict Workers environment explicitly.
import {
  createCloudflareAppInstance,
  type AppInstanceLoader,
} from "@fungi.computer/oyster/cloudflare";

export const cloudflare: typeof createCloudflareAppInstance =
  createCloudflareAppInstance;
export const loader: AppInstanceLoader<unknown> = {
  get: () => ({ getDurableObjectClass: () => undefined }),
};

import {
  OysterMcp,
  createOysterMcpOwner,
  type OysterWorkerEnv,
} from "@fungi.computer/oyster/workers";
import {
  createOysterGitMcpOwner,
  oysterGitRoot,
  ownerOrKeyTenancy,
  type OysterGitWorkerEnv,
} from "@fungi.computer/oyster/workers-git";
export const defaultMcpOwner: typeof OysterMcp = OysterMcp;
export const customMcpOwner: typeof createOysterMcpOwner = createOysterMcpOwner;
export class GitMcpOwner extends createOysterGitMcpOwner(
  oysterGitRoot<OysterGitWorkerEnv>({ tenancy: ownerOrKeyTenancy }),
) {}
declare const workerEnv: OysterWorkerEnv;
void workerEnv.MCP;
