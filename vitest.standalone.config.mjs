import { defineConfig } from "vitest/config";

// The standalone host's own laws, beside the starter Apps it installs.
export default defineConfig({
  test: { include: ["test/standalone/*.test.ts"], environment: "node" },
});
