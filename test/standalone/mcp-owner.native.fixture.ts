import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createOysterGitWorker,
  createOysterGitMcpOwner,
  oysterGitRoot,
  type OysterGitWorkerEnv,
} from "@fungi.computer/oyster/workers-git";
import {
  standaloneTenancy,
  type StandaloneTenancyEnv,
} from "../../src/standalone/tenancy.js";

export { StandaloneTenants } from "../../src/standalone/tenancy.js";
export { StandaloneRegistry as OysterRegistry } from "../../src/standalone/registry.js";
export { OysterInstance } from "@fungi.computer/oyster/workers";
export { OysterKeys } from "@fungi.computer/oyster/workers-git";

export type ProofEnv = OysterGitWorkerEnv &
  StandaloneTenancyEnv & { FRONT_A: Fetcher; FRONT_B: Fetcher };

const root = oysterGitRoot<ProofEnv>({
  tenancy: (env) => ({
    resolve: async (request) =>
      (await standaloneTenancy(env)).oyster.resolve(request),
  }),
});

export class OysterMcp extends createOysterGitMcpOwner(root) {}

export class McpFrontendA extends WorkerEntrypoint<ProofEnv> {
  readonly #oyster = createOysterGitWorker(root);

  override async fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
  ): Promise<Response> {
    const shared = await standaloneTenancy(this.env);
    const owner = await shared.owner();
    if (
      owner === null ||
      owner.actor.memberId === (this.env.OYSTER_OWNER_NAME ?? "owner") ||
      owner.membershipVersion <= 0
    )
      throw new Error(
        "Native MCP proof requires a registry-owned canonical owner",
      );
    if (this.#oyster.fetch === undefined)
      throw new Error("Missing Worker fetch");
    return this.#oyster.fetch(request, this.env, this.ctx);
  }
}

export class McpFrontendB extends McpFrontendA {}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ready");
    const front = url.pathname.startsWith("/front-a/")
      ? env.FRONT_A
      : env.FRONT_B;
    const canonical = new URL(env.OYSTER_ORIGIN);
    canonical.pathname = url.pathname.replace(/^\/front-[ab]/u, "");
    canonical.search = url.search;
    return front.fetch(new Request(canonical, request));
  },
} satisfies ExportedHandler<ProofEnv>;
