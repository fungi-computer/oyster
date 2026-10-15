import type { HostActor } from "@fungi.computer/puffball/app-method-runtime";
import * as Schema from "effect/Schema";
import type { OysterAuth } from "./host.js";

/**
 * A host-minted tenant slug: 2–40 lowercase ASCII letters or digits, with
 * single interior hyphens. The repository separator `--` is forbidden.
 * Hosts resolve it before authentication; App-controlled inputs never select it.
 */
export const tenantIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9]|-(?!-)){0,38}[a-z0-9]$/u),
).pipe(Schema.brand("OysterTenantId"));

/** A validated host-selected tenant identity. */
export type TenantId = typeof tenantIdSchema.Type;

/** A canonical host actor with a tenant role only when the actor is a member. */
export type TenantPrincipal =
  | Readonly<{
      /** Stored member identity resolved by the tenant registry. */
      actor: Extract<HostActor, { kind: "member" }>;
      /** The member's admitted role; membership does not imply ownership. */
      role: "owner" | "member";
      /** The host attests this member is the tenant's only member. */
      soleMember?: true;
    }>
  | Readonly<{
      /** An Agent or Team key retains its canonical actor identity. */
      actor: Exclude<HostActor, { kind: "member" }>;
    }>;

/** The single-tenant Oyster identity whose durable names remain unchanged. */
export const defaultTenant: TenantId =
  Schema.decodeUnknownSync(tenantIdSchema)("default");

/** Resolves a request before authentication; null means refuse, never fallback. */
export type TenantResolver = Readonly<{
  /** Return the host-selected tenant and canonical origin, or refuse this URL. */
  resolve(
    request: Request,
  ): Promise<Readonly<{ tenantId: TenantId; origin: string }> | null>;
}>;

function configuredOrigin(origin: string): URL {
  const url = new URL(origin);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "Configure an HTTP(S) origin without credentials or a path",
    );
  }
  return url;
}

/** The only source of durable names for a standalone Oyster tenant. */
export type TenantScope = Readonly<{
  /** Host-selected tenant identity; never taken from App input. */
  tenantId: TenantId;
  /** Canonical HTTP(S) origin for this tenant's public routes. */
  origin: string;
  /** Name of a tenant-owned Durable Object within its binding namespace. */
  durableName(
    kind: "registry" | "keys" | "webhooks" | "git-push" | "agents" | "mcp",
  ): string;
  /** Name within the Computer binding; nondefault Computers await host support. */
  computerName(computerId: string): string;
  /** R2 prefix for mutable workspace files; immutable release bytes may be shared. */
  workspacePrefix: string;
  /**
   * Provider prefix for an installation slug without `--`.
   * The Git adapter must validate the final prefix + repo against the provider's
   * 128-character limit; a prefix alone cannot establish that a repo name fits.
   */
  repositoryPrefix(installationId: string): string;
}>;

const installationIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/u),
  Schema.isPattern(/^(?!.*--)/u),
);

/**
 * Name tenant-owned stores without changing any default-tenant name. The `t.`
 * repository namespace cannot be a default installation slug, which forbids dots.
 * Hub supplies its own Team-scoped ports and does not use this naming contract.
 */
export function tenantScope(tenantId: TenantId, origin: string): TenantScope {
  const canonicalOrigin = configuredOrigin(origin).origin;
  const isDefault = tenantId === defaultTenant;
  const durablePrefix = isDefault ? "" : `t.${tenantId}.`;
  return {
    tenantId,
    origin: canonicalOrigin,
    durableName: (kind) => `${durablePrefix}${kind}`,
    computerName: (computerId) => `${durablePrefix}${computerId}`,
    workspacePrefix: isDefault
      ? "workspace/"
      : `tenants/${tenantId}/workspace/`,
    repositoryPrefix(installationId) {
      const installation =
        Schema.decodeUnknownSync(installationIdSchema)(installationId);
      return isDefault
        ? `${installation}--`
        : `t.${tenantId}--${installation}--`;
    },
  };
}

/**
 * Admit defaultTenant only at the configured origin. Scheme, host and port must
 * match after URL canonicalization; unknown origins never fall back to default.
 */
export function singleTenant(origin: string): TenantResolver {
  const canonicalOrigin = configuredOrigin(origin).origin;
  return {
    resolve: (request) =>
      Promise.resolve(
        new URL(request.url).origin === canonicalOrigin
          ? { tenantId: defaultTenant, origin: canonicalOrigin }
          : null,
      ),
  };
}

/** A host-selected scope paired with its existing authentication port. */
export type ResolvedTenant = Readonly<{
  /** Canonical origin and durable names selected before authentication. */
  scope: TenantScope;
  /** Authentication bound to this tenant; resolution does not invoke it. */
  auth: OysterAuth;
}>;

/** Resolve an origin-scoped host; null refuses the request without a fallback. */
export type OysterTenancy = Readonly<{
  /** Select one tenant before authentication; unknown origins return null. */
  resolve(request: Request): Promise<ResolvedTenant | null>;
}>;

/** Preserve the default tenant's names and auth only at the configured origin. */
export function implicitTenancy(
  origin: string,
  auth: OysterAuth,
): OysterTenancy {
  const resolver = singleTenant(origin);
  const scope = tenantScope(defaultTenant, origin);
  return {
    async resolve(request) {
      return (await resolver.resolve(request)) === null
        ? null
        : { scope, auth };
    },
  };
}
