import { seededAvatar } from "@fungi.computer/sprite/avatar";
// The standalone Computer composition behind Oyster's shared MCP owner. Only
// the Bonsai App, media and workflows are left out; the workspace, its
// Computer capability routes and the native ComputerDO are the real ones. The
// tenancy counts every tenant resolution and authentication so the proof can
// show that one request authenticates exactly once.
import {
  createOysterGitWorker,
  createOysterGitMcpOwner,
  oysterGitRoot,
  ownerOrKeyTenancy,
  type OysterGitWorkerEnv,
} from "@fungi.computer/oyster/workers-git";
import type { OysterAgents } from "@fungi.computer/oyster/agents";
import type { OysterTenancy } from "@fungi.computer/oyster/tenant";
import {
  standaloneComputerCapabilities,
  standaloneWorkspace,
  type StandaloneComputerEnv,
} from "../../src/standalone/computer.js";

export { ComputerDO } from "../../src/standalone/computer.js";
export { OysterComputerEgress } from "../../src/standalone/worker.js";
export {
  WorkspaceProxy,
  WorkspaceServiceProxy,
} from "@fungi.computer/computer";
export { OysterRegistry, OysterInstance } from "@fungi.computer/oyster/workers";
export { OysterKeys } from "@fungi.computer/oyster/workers-git";

type ProofEnv = OysterGitWorkerEnv & StandaloneComputerEnv;

const counts = { resolve: 0, authenticate: 0 };

function countingTenancy(env: ProofEnv): OysterTenancy {
  const tenancy = ownerOrKeyTenancy(env);
  return {
    resolve: async (request) => {
      counts.resolve += 1;
      const tenant = await tenancy.resolve(request);
      if (tenant === null) return null;
      const { auth } = tenant;
      return {
        ...tenant,
        auth: {
          ...auth,
          authenticate: (incoming) => {
            counts.authenticate += 1;
            return auth.authenticate(incoming);
          },
        },
      };
    },
  };
}

const notInProof = () =>
  Promise.reject(new Error("This proof only reads one Agent's policy"));

/** One fixed Agent for the owner's direct policy read; named keys hold their own issued grants. */
const proofAgents = (): OysterAgents => ({
  list: () =>
    Promise.resolve([
      {
        agentId: "amber",
        name: "Amber",
        avatar: seededAvatar("amber"),
        sessionOperations: [],
      },
    ]),
  policyRevision: () => Promise.resolve(null),
  policyStatus: () => Promise.resolve(null),
  appToolPolicy: () => Promise.resolve(null),
  create: notInProof,
  rename: notInProof,
  setAvatar: notInProof,
  approveAppToolPolicy: notInProof,
  mcpServers: notInProof,
  addMcpServer: notInProof,
  removeMcpServer: notInProof,
  fetch: notInProof,
  inbox: notInProof,
  revision: notInProof,
  visit: notInProof,
});

const root = oysterGitRoot<ProofEnv>({
  tenancy: countingTenancy,
  workspace: standaloneWorkspace,
  agents: proofAgents,
  capabilities: standaloneComputerCapabilities,
});

export class OysterMcp extends createOysterGitMcpOwner(root) {}

const oyster = createOysterGitWorker(root);

export default {
  fetch(request, env, context) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ready");
    // Read and reset this isolate's counters between measured requests.
    if (pathname === "/proof/authentications") {
      const observed = { ...counts };
      counts.resolve = 0;
      counts.authenticate = 0;
      return Response.json(observed);
    }
    if (oyster.fetch === undefined)
      throw new Error("Oyster fetch handler is missing");
    return oyster.fetch(request, env, context);
  },
} satisfies ExportedHandler<ProofEnv>;
