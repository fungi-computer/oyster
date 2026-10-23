import { defineConfig } from "vitest/config";

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
    server: { deps: { inline: ["@cloudflare/codemode"] } },
  },
});
