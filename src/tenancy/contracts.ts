import type { OysterTenancy } from "../tenant.js";
import type { TenantId, TenantPrincipal, TenantScope } from "../tenant.js";
import type { Hono, MiddlewareHandler } from "hono";

/** An external identity; the registry owns its canonical member mapping. */
export type Identity = Readonly<{
  /** Verified issuer/provider namespace, kept separate from the subject. */
  provider: string;
  /** Stable verified subject within that provider. */
  subject: string;
  /** Optional display metadata, never a membership lookup key. */
  email?: string;
}>;
/** One provisioned tenant and its registry-owned canonical public origin. */
export type Tenant = Readonly<{
  /** Host-selected tenant identity used by scope naming. */
  id: TenantId;
  /** Provisioned label used by hostname and path resolution. */
  handle: string;
  /** Canonical HTTPS origin matching one declared domain. */
  origin: string;
  /** Suspended tenants refuse admission; deleting tenants do not resolve. */
  status: "active" | "suspended" | "deleting";
  /** Stored canonical identities of this tenant's owners. */
  owners: readonly string[];
  /** Registered canonical URL hosts, including any configured port. */
  domains: readonly string[];
}>;
/** A live membership, carrying a stored host-owned member identity. */
export type Membership = Readonly<{
  /** Canonical member ID minted or supplied by the registry owner. */
  memberId: string;
  /** Authority granted by this tenant's membership record. */
  role: "owner" | "member";
  /** Positive safe revision owned by the registry; changes never reuse a deleted membership's revision. */
  membershipVersion: number;
}>;
/** Reads existing authority; this port cannot mutate tenants or members. */
export type ReadonlyTenantRegistry = Readonly<{
  /** Read a provisioned record, or null after removal. */
  get(id: TenantId): Promise<Tenant | null>;
  /** Resolve a provisioned handle; unknown handles never fall back. */
  byHandle(handle: string): Promise<Tenant | null>;
  /** Optional index for custom-domain resolution. */
  byDomain?(host: string): Promise<Tenant | null>;
  /** Read live admission status, or null for a removed tenant. */
  status(id: TenantId): Promise<Tenant["status"] | null>;
  /** Look up the separate provider/subject pair and its canonical membership. */
  membershipOf(id: TenantId, identity: Identity): Promise<Membership | null>;
  /** Read the stored membership for a canonical member ID; null means absent. */
  memberById(id: TenantId, memberId: string): Promise<Membership | null>;
}>;
/** A single create transition records tenant and owner membership together. */
export type TenantCreateInput = Readonly<{
  /** New provisioned tenant handle. */
  handle: string;
  /** HTTPS origin validated against domains before storage. */
  origin: string;
  /** Canonical hosts owned by this tenant. */
  domains: readonly string[];
  /** External identity whose canonical owner membership is recorded atomically. */
  owner: Identity;
}>;
/** Mutable registry owner; remove is called only after teardown succeeds. */
export type ManagedTenantRegistry = ReadonlyTenantRegistry &
  Readonly<{
    /** Atomically store a tenant and mint/reuse its canonical owner membership. */
    create(input: TenantCreateInput): Promise<Tenant>;
    /** Change admission status without discarding the tenant's scope record. */
    setStatus(id: TenantId, status: Tenant["status"]): Promise<void>;
    /** Remove the record and its memberships after successful teardown. */
    delete(id: TenantId): Promise<void>;
  }>;
/** Request URL resolution, with an explicit origin/path distinction. */
export type TenantResolverAdapter<
  Kind extends "origin" | "path" = "origin" | "path",
> = Readonly<{
  /** Origin resolvers can host Oyster; path resolvers serve APIs only. */
  kind: Kind;
  /** Resolve only from the parsed request URL and provisioned registry. */
  resolve(url: URL, registry: ReadonlyTenantRegistry): Promise<TenantId | null>;
}>;
/** Adapter output: pass only when the presented credential is not this adapter's. */
export type AuthResult =
  | Readonly<{
      /** A verified external identity requiring registry membership admission. */
      kind: "identity";
      /** Verified provider and subject, not a caller-selected member ID. */
      identity: Identity;
    }>
  | Readonly<{
      /** A canonical principal already attested for the selected tenant. */
      kind: "principal";
      /** Host-attested actor, with a role only for a member. */
      principal: TenantPrincipal;
    }>
  | Readonly<{
      /** This adapter does not recognize the presented credential. */
      kind: "pass";
    }>
  | Readonly<{
      /** Recognized but invalid credential; stop the chain. */
      kind: "refused";
      /** Authentication or authorization refusal. */
      status: 401 | 403;
    }>;
/** Authentication proves an identity, or attests a principal for this tenant. */
export type AuthAdapter = Readonly<{
  /** Stable adapter name for host composition. */
  id: string;
  /** Optional relative login/callback routes, mounted explicitly by the host. */
  routes?: Hono;
  /** Verify the credential for the host-selected tenant; pass advances the chain. */
  authenticate(request: Request, tenant: Tenant): Promise<AuthResult>;
}>;
/** Abuse-only admission policy; it does not meter or bill usage. */
export type TenancyPolicy = (
  context: Readonly<{
    /** Provisioned tenant selected before authentication. */
    tenant: Tenant;
    /** Admitted canonical actor and member role, if applicable. */
    principal: TenantPrincipal;
    /** Original request, for trusted host abuse-policy inputs. */
    request: Request;
  }>,
) => Promise<
  | Readonly<{
      /** Continue admission. */
      kind: "allow";
    }>
  | Readonly<{
      /** Refuse for abuse limiting. */
      kind: "refuse";
      /** The policy's rate-limiting HTTP status. */
      status: 429;
      /** Retry delay in seconds for the HTTP Retry-After header. */
      retryAfter: number;
    }>
>;
/** Lifecycle callbacks run after create and before physical deletion. */
export type TenancyHooks = Readonly<{
  /** Notification after the atomic registry create has committed. */
  "tenant.created"?: (
    context: Readonly<{
      /** Newly committed tenant, including its canonical owner membership. */
      tenant: Tenant;
    }>,
  ) => Promise<void>;
  /** Idempotent cleanup before removal; failures retain the deleting record. */
  "tenant.deleting"?: (
    context: Readonly<{
      /** Registry-owned record marked deleting. */
      tenant: Tenant;
      /** Scope built from the record's canonical origin, never a request. */
      scope: TenantScope;
    }>,
  ) => Promise<void>;
}>;
/** Typed result of tenant authentication and abuse-policy admission. */
export type TenancyAdmission =
  | Readonly<{
      /** Successful request admission. */
      kind: "admitted";
      /** Provisioned tenant whose live status permits admission. */
      tenant: Tenant;
      /** Canonical actor admitted within that tenant. */
      principal: TenantPrincipal;
    }>
  | Readonly<{
      /** No principal or tenant is exposed on refusal. */
      kind: "refused";
      /** Safe authentication, authorization, absence or abuse outcome. */
      status: 401 | 403 | 404 | 429;
      /** Optional retry delay in seconds for an abuse refusal. */
      retryAfter?: number;
    }>;
/** Typed Hono context fields populated only after admission. */
export type TenancyVariables = {
  /** The admitted provisioned tenant. */
  tenant: Tenant;
  /** The admitted canonical principal. */
  principal: TenantPrincipal;
};
/** Read-only host API; no create/delete methods are exposed. */
export type ReadonlyTenancy<
  Kind extends "origin" | "path" = "origin" | "path",
> = Readonly<{
  /** Resolve the provisioned tenant from the request URL. */
  resolve(request: Request): Promise<Tenant | null>;
  /** Re-resolve the request and authenticate within the selected tenant. */
  authenticate(request: Request, tenant: Tenant): Promise<TenancyAdmission>;
  /** Read canonical membership without deriving IDs from external identity data. */
  member(
    tenantId: TenantId,
    identity: Identity,
  ): Promise<TenantPrincipal | null>;
  /** Resolve current active-tenant membership by stored member ID, without credentials. */
  memberById(
    tenantId: TenantId,
    memberId: string,
  ): Promise<
    (TenantPrincipal & Readonly<{ membershipVersion: number }>) | null
  >;
  /** Admit requests and populate Hono context before reaching protected handlers. */
  middleware(
    options?: Readonly<{
      /** Require a member role; owners satisfy member, keys/Agents satisfy neither. */
      role?: "owner" | "member";
    }>,
  ): MiddlewareHandler<{
    /** Context fields supplied only after successful tenant admission. */
    Variables: TenancyVariables;
  }>;
}> &
  (Kind extends "origin"
    ? Readonly<{
        /** Bind canonical tenant scope and authentication to the Oyster host port. */
        oyster(): OysterTenancy;
      }>
    : Record<never, never>);
/** Managed hosts can provision tenants and run teardown through the kit. */
export type ManagedTenancy<Kind extends "origin" | "path" = "origin" | "path"> =
  ReadonlyTenancy<Kind> &
    Readonly<{
      /** Delegate atomic provisioning, then invoke the created hook. */
      create(input: TenantCreateInput): Promise<Tenant>;
      /** Hold deleting status until all configured cleanup succeeds. */
      delete(id: TenantId): Promise<void>;
    }>;
