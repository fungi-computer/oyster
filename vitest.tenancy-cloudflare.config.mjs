import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./test/tenancy/cloudflare.worker.mjs",
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-09-02",
        durableObjects: {
          TENANTS: { className: "TenancyRegistryDO", useSQLite: true },
        },
        ratelimits: {
          NATIVE_LIMITER: {
            namespace_id: "tenancy-proof",
            simple: { limit: 600, period: 60 },
          },
        },
      },
    }),
  ],
  test: { include: ["test/tenancy/cloudflare.cloudflare.test.mjs"] },
});
