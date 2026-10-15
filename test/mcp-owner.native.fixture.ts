import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createOysterGitWorker,
  createOysterGitMcpOwner,
  oysterGitRoot,
  ownerOrKeyTenancy,
  type OysterGitWorkerEnv,
} from "@fungi.computer/oyster/workers-git";
export { OysterRegistry, OysterInstance } from "@fungi.computer/oyster/workers";
export { OysterKeys } from "@fungi.computer/oyster/workers-git";
const root = oysterGitRoot<OysterGitWorkerEnv>({ tenancy: ownerOrKeyTenancy });
export class OysterMcp extends createOysterGitMcpOwner(root) {}
export type ProofEnv = OysterGitWorkerEnv & {
  FRONT_A: Fetcher;
  FRONT_B: Fetcher;
};
export class McpFrontendA extends WorkerEntrypoint<ProofEnv> {
  readonly #oyster = createOysterGitWorker(root);
  fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
  ): Promise<Response> {
    const original = new URL(request.url);
    const canonical = new URL(this.env.OYSTER_ORIGIN);
    canonical.pathname = original.pathname;
    canonical.search = original.search;
    if (this.#oyster.fetch === undefined)
      throw new Error("Missing Worker fetch");
    return Promise.resolve(
      this.#oyster.fetch(
        new Request<unknown, IncomingRequestCfProperties>(canonical, request),
        this.env,
        this.ctx,
      ),
    );
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
    url.pathname = url.pathname.replace(/^\/front-[ab]/u, "");
    return front.fetch(new Request(url, request));
  },
} satisfies ExportedHandler<ProofEnv>;
