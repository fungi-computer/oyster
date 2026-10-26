import { defineConfig } from "vitest/config";
import { URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "./dist/testing/workers-runtime.js",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: [
      "test/page/*.test.ts",
      "test/apps-*.test.ts",
      "test/git-journal.test.ts",
      "test/event-recipients.test.ts",
      "test/build-jobs.test.ts",
      "test/template-repository.test.ts",
      "test/app-sources.test.ts",
      "test/template-push.test.ts",
      "test/app-builds.test.ts",
      "test/app-build-manifest.test.ts",
      "test/install-release-cli.test.ts",
      "test/artifact-writer.test.ts",
      "test/workspace-build-script.test.ts",
      "test/build/candidate-builder.test.ts",
      "test/build/candidate-diagnostic.test.ts",
    ],
  },
});
