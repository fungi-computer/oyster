import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./test/tenancy/cold-directory.worker.mjs",
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-09-02",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          OYSTER_ORIGIN: "https://root.example.test",
          OYSTER_OWNER_KEY: "local-cold-root-owner-secret-with-24-characters",
          OYSTER_OWNER_NAME: "root-owner",
        },
        r2Buckets: ["RELEASES"],
        durableObjects: {
          TENANTS: { className: "TenancyRegistryDO", useSQLite: true },
          INSTANCES: { className: "ColdKitInstance", useSQLite: true },
          REGISTRY: { className: "OysterRegistry", useSQLite: true },
          KEYS: { className: "OysterKeys", useSQLite: true },
          WEBHOOKS: { className: "OysterWebhooks", useSQLite: true },
        },
      },
    }),
  ],
  test: { include: ["test/tenancy/cold-directory.cloudflare.test.mjs"] },
});
