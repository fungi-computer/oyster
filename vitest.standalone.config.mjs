import { defineConfig } from "vitest/config";
import { scaledBudgetMs } from "../../tooling/repository/scripts/proof-budget.mjs";

// The standalone host's own laws, beside the starter Apps it installs.
export default defineConfig({
  resolve: {
    alias: {
      // Lets Node import Shiitake's Cloudflare module for the Agent store laws.
      "cloudflare:workers": new URL(
        "./test/standalone/cloudflare-workers.fixture.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["test/standalone/*.test.ts"],
    environment: "node",
    // The default 5 s misses on a loaded host; the base stretches with host load.
    testTimeout: scaledBudgetMs(10_000),
    server: { deps: { inline: ["@cloudflare/codemode"] } },
  },
});
