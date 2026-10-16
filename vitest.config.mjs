import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/shell/*.test.ts",
      "test/page/*.test.ts",
      "test/apps-*.test.ts",
      "test/git-journal.test.ts",
      "test/event-recipients.test.ts",
      "test/build-jobs.test.ts",
      "test/template-repository.test.ts",
      "test/app-sources.test.ts",
      "test/template-push.test.ts",
      "test/app-builds.test.ts",
      "test/artifact-writer.test.ts",
      "test/workspace-build-script.test.ts",
      "test/build/candidate-builder.test.ts",
    ],
  },
});
