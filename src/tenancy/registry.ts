import {
  checkedOrigin,
  immutable,
  createMemberId,
  membershipVersionSchema,
} from "./registry-record.js";
import * as Schema from "effect/Schema";
import { tenantIdSchema, type TenantId } from "../tenant.js";
import type {
  Identity,
  ManagedTenantRegistry,
  Membership,
  Tenant,
} from "./contracts.js";

/** Initial live membership records for a disposable in-memory registry. */
export type MemoryMembership = Readonly<{
  /** Provisioned tenant whose membership is seeded. */
  tenantId: TenantId;
  /** External identity tuple mapped to the canonical member ID. */
  identity: Identity;
  /** Canonical member identity supplied by the host. */
  memberId: string;
  /** Live tenant role for this canonical member. */
  role: Membership["role"];
}>;
/** Provisioned records and canonical member mappings owned by the host. */
export type MemoryRegistryOptions = Readonly<{
  /** Initial validated provisioned records. */
  tenants?: readonly Tenant[];
  /** Initial identity-to-member mappings and roles. */
  memberships?: readonly MemoryMembership[];
}>;

/** The memory adapter always supplies the optional custom-domain index. */
export type MemoryRegistry = ManagedTenantRegistry &
  Readonly<{
    /** Look up a registered canonical host. */
    byDomain(host: string): Promise<Tenant | null>;
  }>;

/** In-memory tenant and member owner; create updates both atomically. */
export function memoryRegistry(
  options: MemoryRegistryOptions = {},
): MemoryRegistry {
  const tenants = new Map<TenantId, Tenant>();
  const handles = new Map<string, TenantId>();
  const domains = new Map<string, TenantId>();
  const identities = new Map<string, Map<string, string>>();
  const memberships = new Map<TenantId, Map<string, Membership>>();
  let revision = 0;
  const nextRevision = () => {
    revision = Schema.decodeUnknownSync(membershipVersionSchema)(revision + 1);
    return revision;
  };
  const canonicalMember = (identity: Identity): string | undefined =>
    identities.get(identity.provider)?.get(identity.subject);
  const retainMember = (identity: Identity, memberId: string) => {
    let subjects = identities.get(identity.provider);
    if (subjects === undefined) {
      subjects = new Map();
      identities.set(identity.provider, subjects);
    }
    const previous = subjects.get(identity.subject);
    if (previous !== undefined && previous !== memberId)
      throw new Error("Identity already has a canonical member mapping");
    subjects.set(identity.subject, memberId);
  };
  const insert = (tenant: Tenant) => {
    if (
      tenants.has(tenant.id) ||
      handles.has(tenant.handle) ||
      tenant.domains.some((domain) => domains.has(domain))
    )
      throw new Error("Tenant identity, handle or domain already exists");
    const stored = immutable(tenant);
    tenants.set(tenant.id, stored);
    handles.set(tenant.handle, tenant.id);
    for (const domain of tenant.domains) domains.set(domain, tenant.id);
    return stored;
  };
  for (const tenant of options.tenants ?? []) {
    Schema.decodeUnknownSync(tenantIdSchema)(tenant.id);
    Schema.decodeUnknownSync(tenantIdSchema)(tenant.handle);
    insert({ ...tenant, origin: checkedOrigin(tenant.origin, tenant.domains) });
  }
  for (const membership of options.memberships ?? []) {
    if (!tenants.has(membership.tenantId))
      throw new Error("Membership tenant does not exist");
    retainMember(membership.identity, membership.memberId);
    let entries = memberships.get(membership.tenantId);
    if (entries === undefined) {
      entries = new Map();
      memberships.set(membership.tenantId, entries);
    }
    entries.set(membership.memberId, {
      memberId: membership.memberId,
      role: membership.role,
      membershipVersion: nextRevision(),
    });
  }
  const get = (id: TenantId) => tenants.get(id) ?? null;
  return {
    get: (id) => Promise.resolve(get(id)),
    byHandle(handle) {
      const id = handles.get(handle);
      return Promise.resolve(id === undefined ? null : get(id));
    },
    byDomain(host) {
      const id = domains.get(host);
      return Promise.resolve(id === undefined ? null : get(id));
    },
    status: (id) => Promise.resolve(get(id)?.status ?? null),
    memberById(id, memberId) {
      const member = memberships.get(id)?.get(memberId);
      return Promise.resolve(member === undefined ? null : { ...member });
    },
    membershipOf(id, identity) {
      const memberId = canonicalMember(identity);
      return Promise.resolve(
        memberId === undefined
          ? null
          : (memberships.get(id)?.get(memberId) ?? null),
      );
    },
    create(input) {
      return Promise.resolve().then(() => {
        const handle = Schema.decodeUnknownSync(tenantIdSchema)(input.handle);
        const origin = checkedOrigin(input.origin, input.domains);
        const id = handle;
        const memberId = canonicalMember(input.owner) ?? createMemberId();
        const tenant: Tenant = {
          id,
          handle,
          origin,
          domains: [...input.domains],
          owners: [memberId],
          status: "active",
        };
        const stored = insert(tenant);
        retainMember(input.owner, memberId);
        memberships.set(
          id,
          new Map([
            [
              memberId,
              {
                memberId,
                role: "owner",
                membershipVersion: nextRevision(),
              },
            ],
          ]),
        );
        return stored;
      });
    },
    setStatus(id, status) {
      const tenant = get(id);
      if (tenant === null)
        return Promise.reject(new Error("Tenant does not exist"));
      if (tenant.status !== status) {
        const membershipVersion = nextRevision();
        for (const [memberId, membership] of memberships.get(id) ?? [])
          memberships
            .get(id)
            ?.set(memberId, { ...membership, membershipVersion });
      }
      tenants.set(id, immutable({ ...tenant, status }));
      return Promise.resolve();
    },
    delete(id) {
      const tenant = get(id);
      if (tenant === null) return Promise.resolve();
      nextRevision();
      tenants.delete(id);
      handles.delete(tenant.handle);
      memberships.delete(id);
      for (const domain of tenant.domains) domains.delete(domain);
      return Promise.resolve();
    },
  };
}
