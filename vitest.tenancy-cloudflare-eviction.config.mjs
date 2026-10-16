import config from "./vitest.tenancy-cloudflare.config.mjs";
export default {
  ...config,
  test: {
    ...config.test,
    include: ["test/tenancy/cloudflare-eviction.cloudflare.test.mjs"],
  },
};
