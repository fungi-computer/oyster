import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// web.fetch reads HTML with the native HTMLRewriter, so it runs in workerd.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-09-02",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: [
      "test/web-source.cloudflare.test.mjs",
      "test/web-standalone.cloudflare.test.mjs",
    ],
  },
});
