import { describe, expect, it } from "vitest";
import { createTenancy } from "../../src/tenancy/index.js";
import { hosts, path } from "../../src/tenancy/resolve.js";
import { memoryRegistry } from "../../src/tenancy/registry.js";
const input = {
  handle: "alpha",
  origin: "https://alpha.example.test",
  domains: ["alpha.example.test", "custom.example.test"],
  owner: { provider: "fixture", subject: "owner" },
};
describe("URL resolvers", () => {
  it("custom domains resolve only registered hosts", async () => {
    const registry = memoryRegistry();
    const tenant = await registry.create(input);
    const tenancy = createTenancy({
      resolve: hosts(registry),
      registry,
      auth: [],
    });
    await expect(
      tenancy.resolve(new Request("https://custom.example.test/api")),
    ).resolves.toEqual(tenant);
    await expect(
      tenancy.resolve(new Request("https://stranger.example.test/")),
    ).resolves.toBeNull();
  });
  it("path tenants use the maintained route parser and still require provisioning", async () => {
    const registry = memoryRegistry();
    const tenant = await registry.create(input);
    const tenancy = createTenancy({
      resolve: path("/t/:tenant"),
      registry,
      auth: [],
    });
    await expect(
      tenancy.resolve(new Request("https://api.example.test/t/alpha/messages")),
    ).resolves.toEqual(tenant);
    for (const suffix of ["unknown", "alpha--other", "%ZZ", "alpha%2Fother"])
      await expect(
        tenancy.resolve(new Request(`https://api.example.test/t/${suffix}`)),
      ).resolves.toBeNull();
    await expect(
      tenancy.resolve(new Request("https://api.example.test/other/alpha")),
    ).resolves.toBeNull();
  });
});
