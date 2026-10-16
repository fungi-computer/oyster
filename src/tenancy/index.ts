import { createOysterTenancy } from "./oyster.js";
import type { MiddlewareHandler } from "hono";
import { tenantScope, type TenantId, type TenantPrincipal } from "../tenant.js";
import type {
  AuthAdapter,
  Identity,
  ManagedTenantRegistry,
  ManagedTenancy,
  ReadonlyTenantRegistry,
  ReadonlyTenancy,
  Tenant,
  TenancyAdmission,
  TenancyHooks,
  TenancyPolicy,
  TenantResolverAdapter,
  TenancyVariables,
} from "./contracts.js";

/** Configuration composes resolution, live registry authority and auth adapters. */
export type TenancyConfig<
  Registry extends ReadonlyTenantRegistry = ReadonlyTenantRegistry,
  Kind extends "origin" | "path" = "origin" | "path",
> = Readonly<{
  /** Select tenants only from the parsed request URL. */
  resolve: TenantResolverAdapter<Kind>;
  /** The tenant and canonical membership authority. */
  registry: Registry;
  /** Ordered authentication adapters; pass alone advances the chain. */
  auth: readonly AuthAdapter[];
  /** Optional abuse-only policy applied after authentication. */
  policy?: TenancyPolicy;
  /** Lifecycle notifications for managed registry hosts. */
  on?: TenancyHooks;
}>;

function managed(
  registry: ReadonlyTenantRegistry,
): registry is ManagedTenantRegistry {
  return (
    "create" in registry &&
    typeof registry.create === "function" &&
    "setStatus" in registry &&
    typeof registry.setStatus === "function" &&
    "delete" in registry &&
    typeof registry.delete === "function"
  );
}

/** Managed registries expose provisioning and cleanup; readonly registries do not. */
export function createTenancy<Kind extends "origin" | "path">(
  config: TenancyConfig<ManagedTenantRegistry, Kind>,
): ManagedTenancy<Kind>;
/** Resolve and authenticate requests without exposing registry mutations. */
export function createTenancy<Kind extends "origin" | "path">(
  config: TenancyConfig<ReadonlyTenantRegistry, Kind>,
): ReadonlyTenancy<Kind>;
export function createTenancy(
  config: TenancyConfig,
): ReadonlyTenancy | ManagedTenancy {
  const registry = config.registry;
  const adapters = [...config.auth];
  const policy = config.policy;
  const resolve = async (request: Request): Promise<Tenant | null> => {
    const url = new URL(request.url);
    const id = await config.resolve.resolve(url, registry);
    if (id === null) return null;
    const tenant = await registry.get(id);
    if (tenant === null || tenant.status === "deleting") return null;
    if (
      config.resolve.kind === "origin" &&
      (url.protocol !== "https:" || !tenant.domains.includes(url.host))
    )
      return null;
    return tenant;
  };
  const member = async (
    tenantId: TenantId,
    identity: Identity,
  ): Promise<TenantPrincipal | null> => {
    const status = await registry.status(tenantId);
    if (status === null || status === "deleting") return null;
    const membership = await registry.membershipOf(tenantId, identity);
    return membership === null
      ? null
      : {
          actor: { kind: "member", memberId: membership.memberId },
          role: membership.role,
        };
  };
  const memberById: ReadonlyTenancy["memberById"] = async (
    tenantId,
    memberId,
  ) => {
    if ((await registry.status(tenantId)) !== "active") return null;
    const membership = await registry.memberById(tenantId, memberId);
    if (
      membership?.memberId !== memberId ||
      (await registry.status(tenantId)) !== "active"
    )
      return null;
    return {
      actor: { kind: "member", memberId: membership.memberId },
      role: membership.role,
      membershipVersion: membership.membershipVersion,
    };
  };
  const admit = async (
    request: Request,
    tenant: Tenant,
  ): Promise<TenancyAdmission> => {
    if (tenant.status !== "active") return { kind: "refused", status: 403 };
    for (const adapter of adapters) {
      const result = await adapter.authenticate(request, tenant);
      if (result.kind === "pass") continue;
      if (result.kind === "refused") return result;
      const principal =
        result.kind === "identity"
          ? await member(tenant.id, result.identity)
          : result.principal;
      if (principal === null) return { kind: "refused", status: 403 };
      const outcome = await policy?.({ tenant, principal, request });
      if (outcome?.kind === "refuse")
        return { kind: "refused", status: 429, retryAfter: outcome.retryAfter };
      const status = await registry.status(tenant.id);
      if (status === null || status === "deleting")
        return { kind: "refused", status: 404 };
      if (status !== "active") return { kind: "refused", status: 403 };
      return { kind: "admitted", tenant, principal };
    }
    return { kind: "refused", status: 401 };
  };
  const authenticate = async (
    request: Request,
    selected: Tenant,
  ): Promise<TenancyAdmission> => {
    const tenant = await resolve(request);
    return tenant?.id === selected.id
      ? admit(request, tenant)
      : { kind: "refused", status: 404 };
  };
  const middleware: ReadonlyTenancy["middleware"] =
    (options = {}): MiddlewareHandler<{ Variables: TenancyVariables }> =>
    async (context, next) => {
      const request = context.req.raw;
      const tenant = await resolve(request);
      const admission: TenancyAdmission =
        tenant === null
          ? { kind: "refused", status: 404 }
          : await admit(request, tenant);
      if (admission.kind === "refused") {
        if (admission.retryAfter !== undefined)
          context.header("Retry-After", String(admission.retryAfter));
        const messages = {
          401: "unauthorized",
          403: "forbidden",
          404: "not_found",
          429: "rate_limited",
        };
        return context.json(
          { error: messages[admission.status] },
          admission.status,
        );
      }
      const { principal } = admission;
      if (
        options.role !== undefined &&
        (principal.actor.kind !== "member" ||
          !("role" in principal) ||
          (options.role === "owner" && principal.role !== "owner"))
      )
        return context.json({ error: "forbidden" }, 403);
      context.set("tenant", admission.tenant);
      context.set("principal", principal);
      return next();
    };
  const readonly: ReadonlyTenancy = {
    resolve,
    member,
    memberById,
    authenticate,
    middleware,
  };
  const api =
    config.resolve.kind === "origin"
      ? { ...readonly, oyster: () => createOysterTenancy(readonly) }
      : readonly;
  if (!managed(registry)) return api;
  const hooks = { ...config.on };
  const deleting = new Map<TenantId, Promise<void>>();
  return {
    ...api,
    async create(input) {
      const tenant = await registry.create(input);
      await hooks["tenant.created"]?.({ tenant });
      return tenant;
    },
    delete(id) {
      const existing = deleting.get(id);
      if (existing !== undefined) return existing;
      const pending = Promise.resolve()
        .then(async () => {
          const tenant = await registry.get(id);
          if (tenant === null) return;
          await registry.setStatus(id, "deleting");
          await hooks["tenant.deleting"]?.({
            tenant: { ...tenant, status: "deleting" },
            scope: tenantScope(tenant.id, tenant.origin),
          });
          await registry.delete(id);
        })
        .finally(() => {
          deleting.delete(id);
        });
      deleting.set(id, pending);
      return pending;
    },
  };
}

export type {
  AuthAdapter,
  AuthResult,
  Identity,
  ManagedTenantRegistry,
  ManagedTenancy,
  Membership,
  ReadonlyTenantRegistry,
  ReadonlyTenancy,
  Tenant,
  TenantCreateInput,
  TenancyAdmission,
  TenancyHooks,
  TenancyPolicy,
  TenancyVariables,
  TenantResolverAdapter,
} from "./contracts.js";
