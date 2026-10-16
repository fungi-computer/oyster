import { WorkerEntrypoint } from "cloudflare:workers";
import root from "./workflows-root.fixture.js";
export * from "./workflows-root.fixture.js";

export type CanonicalEnv = Parameters<typeof root.fetch>[1] & {
  CANONICAL_ROOT: Fetcher;
};

/** The unchanged root receives the request as ordinary incoming traffic. */
export class CanonicalRoot extends WorkerEntrypoint<CanonicalEnv> {
  override fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
  ): Promise<Response> {
    return root.fetch(request, this.env, this.ctx);
  }
}

// The local CLI listens on loopback HTTP. Present the configured canonical
// HTTPS origin at the fixture transport boundary, before the unchanged root
// performs tenant resolution, authentication, and App admission.
export default {
  fetch(request, env) {
    const incoming = new URL(request.url);
    const canonical = new URL(
      incoming.pathname + incoming.search,
      env.OYSTER_ORIGIN,
    );
    return env.CANONICAL_ROOT.fetch(new Request(canonical, request));
  },
} satisfies ExportedHandler<CanonicalEnv>;
