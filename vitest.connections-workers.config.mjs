import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./test/connections/oauth.worker.mjs",
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-09-02",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          OWNER: { className: "ConnectionsOwner", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["test/connections/oauth-redirect.workers.test.mjs"],
  },
});
