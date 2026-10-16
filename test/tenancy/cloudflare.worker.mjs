import { durableObjectRegistry } from "../../src/tenancy/cloudflare.ts";
export { TenancyRegistryDO } from "../../src/tenancy/cloudflare.ts";
export default {
  async fetch(request, env) {
    const registry = durableObjectRegistry(env.TENANTS);
    const url = new globalThis.URL(request.url);
    if (url.pathname === "/create")
      return globalThis.Response.json(
        await registry.create(await request.json()),
      );
    if (url.pathname === "/status") {
      const input = await request.json();
      await registry.setStatus(input.id, input.status);
      return new globalThis.Response(null, { status: 204 });
    }
    if (url.pathname === "/get")
      return globalThis.Response.json(
        await registry.get(url.searchParams.get("id")),
      );
    if (url.pathname === "/member") {
      const input = await request.json();
      return globalThis.Response.json(
        await registry.membershipOf(input.id, input.identity),
      );
    }
    return new globalThis.Response("local tenancy proof");
  },
};
