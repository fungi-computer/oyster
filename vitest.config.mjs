import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/shell/*.test.ts",
      "test/apps-*.test.ts",
      "test/git-journal.test.ts",
      "test/event-recipients.test.ts",
      "test/build-jobs.test.ts",
      "test/template-repository.test.ts",
      "test/app-sources.test.ts",
      "test/app-builds.test.ts",
    ],
  },
});
