// The git root (git-root.fixture.ts), with Artifacts reached over its REST API on a
// local native-Git provider instead of Cloudflare. Nothing else is replaced.
import { createArtifactsRestNamespace } from "@fungi.computer/burrow";
import type { OysterGitWorkerEnv } from "@fungi.computer/oyster/workers-git";
import example from "./git-root.fixture.js";
export * from "./git-root.fixture.js";

export default {
  fetch(request, env, context) {
    const provider = new URL(env.GIT_PROVIDER);
    if (example.fetch === undefined)
      throw new Error("Example fetch handler is missing");
    return example.fetch(
      request,
      {
        ...env,
        ARTIFACTS: createArtifactsRestNamespace({
          accountId: "git-door-proof",
          namespace: "local",
          apiToken: "local-provider",
          fetch: (input, init) => {
            const url = new URL(new Request(input, init).url);
            return fetch(
              new Request(new URL(url.pathname + url.search, provider), init),
            );
          },
        }),
      },
      context,
    );
  },
} satisfies ExportedHandler<OysterGitWorkerEnv & { GIT_PROVIDER: string }>;
