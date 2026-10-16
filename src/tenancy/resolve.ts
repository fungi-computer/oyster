import { match, parse } from "path-to-regexp";
import * as Schema from "effect/Schema";
import { tenantIdSchema } from "../tenant.js";
import type {
  ReadonlyTenantRegistry,
  TenantResolverAdapter,
} from "./contracts.js";

/** Resolve a provisioned label immediately below a configured base hostname. */
export function subdomain(baseDomain: string): TenantResolverAdapter<"origin"> {
  const base = new URL(`https://${baseDomain}`);
  if (
    base.host !== baseDomain.toLowerCase() ||
    base.port !== "" ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password ||
    base.hostname.endsWith(".")
  )
    throw new TypeError(
      "Configure a base hostname without credentials, path, port or trailing dot",
    );
  const suffix = `.${base.hostname}`;
  return {
    kind: "origin",
    async resolve(url, registry) {
      if (!url.hostname.endsWith(suffix)) return null;
      const handle = url.hostname.slice(0, -suffix.length);
      const parsed = Schema.decodeUnknownOption(tenantIdSchema)(handle);
      if (parsed._tag === "None") return null;
      return (await registry.byHandle(handle))?.id ?? null;
    },
  };
}

/** Resolve a provisioned custom domain through the registry's domain index. */
export function hosts(
  registry: ReadonlyTenantRegistry,
): TenantResolverAdapter<"origin"> {
  return {
    kind: "origin",
    resolve: async (url) => (await registry.byDomain?.(url.host))?.id ?? null,
  };
}

/** Resolve provisioned path tenants for APIs; this resolver cannot host Oyster. */
export function path(pattern: string): TenantResolverAdapter<"path"> {
  const tokens = parse(pattern).tokens;
  if (
    !tokens.some((token) => token.type === "param" && token.name === "tenant")
  )
    throw new TypeError("A tenant path must contain the :tenant parameter");
  const route = match(pattern, { end: false });
  return {
    kind: "path",
    async resolve(url, registry) {
      let result;
      try {
        result = route(url.pathname);
      } catch (cause) {
        if (cause instanceof URIError) return null;
        throw cause;
      }
      if (result === false) return null;
      const handle = result.params.tenant;
      const parsed = Schema.decodeUnknownOption(tenantIdSchema)(handle);
      if (parsed._tag === "None") return null;
      return (await registry.byHandle(parsed.value))?.id ?? null;
    },
  };
}
