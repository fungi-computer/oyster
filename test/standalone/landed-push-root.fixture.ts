import root from "./workflows-root.fixture.js";
import { createArtifactsRestNamespace } from "@fungi.computer/burrow";
export * from "./workflows-root.fixture.js";

// The production root and backend owners are unchanged. Both its HTTP git door
// and its GIT entrypoint use the same external, native-Git provider fixture.
export default {
  fetch(
    request: Parameters<typeof root.fetch>[0],
    env: Parameters<typeof root.fetch>[1] & { GIT_ORIGIN: string },
    context: Parameters<typeof root.fetch>[2],
  ) {
    return root.fetch(
      request,
      {
        ...env,
        ARTIFACTS: createArtifactsRestNamespace({
          accountId: "workflow-proof",
          namespace: "local",
          apiToken: "local-provider",
          fetch: (input, init) => {
            const original = new Request(input, init);
            const url = new URL(original.url);
            return fetch(
              new Request(
                new URL(url.pathname + url.search, env.GIT_ORIGIN),
                original,
              ),
            );
          },
        }),
      },
      context,
    );
  },
};
