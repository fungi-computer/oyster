import { defineConfig } from "vitest/config";

// The agent browser module's laws: CDP client, provider sessions, Quick
// Reads, URL policy, leases and billing order. Node only; no real provider.
export default defineConfig({
  test: {
    include: ["test/browser/*.test.ts"],
    environment: "node",
  },
});
