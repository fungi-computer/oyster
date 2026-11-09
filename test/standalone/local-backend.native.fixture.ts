import standalone, { type StandaloneEnv } from "../../src/standalone/worker.js";
export * from "../../src/standalone/worker.js";

/** Production Computer and registry; health is the only fixture route. */
export default {
  async fetch(
    request: Parameters<NonNullable<typeof standalone.fetch>>[0],
    env: StandaloneEnv,
    context: ExecutionContext,
  ) {
    if (new URL(request.url).pathname === "/health")
      return new Response("ready");
    return standalone.fetch(request, env, context);
  },
} satisfies ExportedHandler<StandaloneEnv>;
