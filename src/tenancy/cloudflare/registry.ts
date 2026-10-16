import { DurableObject } from "cloudflare:workers";
import type { Brand } from "effect/Brand";
import * as Schema from "effect/Schema";
import { tenantIdSchema, type TenantId } from "../../tenant.js";
import type {
  Identity,
  ManagedTenantRegistry,
  Membership,
  ReadonlyTenantRegistry,
  Tenant,
  TenantCreateInput,
} from "../contracts.js";
import {
  checkedOrigin,
  immutable,
  createMemberId,
  membershipVersionSchema,
} from "../registry-record.js";

const statusSchema = Schema.Literals(["active", "suspended", "deleting"]);
const tenantRow = Schema.Struct({
  id: tenantIdSchema,
  handle: tenantIdSchema,
  origin: Schema.String,
  status: statusSchema,
});
const membershipRow = Schema.Struct({
  member_id: Schema.NonEmptyString,
  role: Schema.Literals(["owner", "member"]),
  membership_version: membershipVersionSchema,
});
const memberRow = Schema.Struct({ member_id: Schema.NonEmptyString });
const domainRow = Schema.Struct({ host: Schema.String });
const identitySchema = Schema.Struct({
  provider: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
});
const tenantAdmissionSchema = Schema.Struct({
  host: Schema.String,
  identity: identitySchema,
  tenant: Schema.Struct({
    id: tenantIdSchema,
    handle: tenantIdSchema,
    origin: Schema.String,
    status: statusSchema,
    owners: Schema.Array(Schema.NonEmptyString),
    domains: Schema.Array(Schema.String),
  }),
  membership: Schema.NullOr(
    Schema.Struct({
      memberId: Schema.NonEmptyString,
      role: Schema.Literals(["owner", "member"]),
      membershipVersion: membershipVersionSchema,
    }),
  ),
}).pipe(Schema.brand("TenantAdmission"));
/** The registry owner's atomic read of one host and one identity. */
export type RegistryAdmission = Readonly<{
  /** The tenant registered at the requested host. */
  tenant: Tenant;
  /** The identity's live membership in that tenant, or null. */
  membership: Membership | null;
}>;
/** One request's atomic registry read, with the host and identity it named. */
export type AdmissionRecord = RegistryAdmission &
  Readonly<{
    /** The canonical URL host the request named. */
    host: string;
    /** The external identity whose membership was read. */
    identity: Identity;
  }>;
/**
 * One atomic registry read for one request. Only {@link durableObjectRegistry}
 * constructs it, so lower layers cannot mint authority.
 */
export type TenantAdmission = AdmissionRecord & Brand<"TenantAdmission">;
const createSchema = Schema.Struct({
  handle: tenantIdSchema,
  origin: Schema.String,
  domains: Schema.Array(Schema.String),
  owner: identitySchema,
});

class RegistryObject extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState) {
    super(ctx, {});
    // Pre-launch registries require a fresh store; CREATE IF NOT EXISTS does not
    // upgrade an old memberships table. No incremental migration is supported.
    // DEFAULT 1 is only an insert placeholder: the AFTER INSERT trigger replaces
    // it with the durable clock revision in the same atomic statement. Lookups
    // decode the stored revision and never supply a default.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','suspended','deleting')));
      CREATE TABLE IF NOT EXISTS domains (host TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, ordinal INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS domains_tenant ON domains(tenant_id);
      CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, member_id TEXT UNIQUE NOT NULL, PRIMARY KEY(provider,subject));
      CREATE TABLE IF NOT EXISTS memberships (tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','member')), membership_version INTEGER NOT NULL DEFAULT 1 CHECK(membership_version BETWEEN 1 AND 9007199254740991), PRIMARY KEY(tenant_id,member_id));
      CREATE TABLE IF NOT EXISTS membership_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991));
      INSERT OR IGNORE INTO membership_clock VALUES(1,0);
      CREATE TRIGGER IF NOT EXISTS membership_insert_revision AFTER INSERT ON memberships BEGIN
        UPDATE membership_clock SET revision=revision+1 WHERE id=1;
        UPDATE memberships SET membership_version=(SELECT revision FROM membership_clock WHERE id=1) WHERE tenant_id=NEW.tenant_id AND member_id=NEW.member_id;
      END;
      CREATE TRIGGER IF NOT EXISTS membership_role_revision AFTER UPDATE OF role ON memberships WHEN OLD.role!=NEW.role BEGIN
        UPDATE membership_clock SET revision=revision+1 WHERE id=1;
        UPDATE memberships SET membership_version=(SELECT revision FROM membership_clock WHERE id=1) WHERE tenant_id=NEW.tenant_id AND member_id=NEW.member_id;
      END;
      CREATE TRIGGER IF NOT EXISTS membership_delete_revision AFTER DELETE ON memberships BEGIN
        UPDATE membership_clock SET revision=revision+1 WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS tenant_status_membership_revision AFTER UPDATE OF status ON tenants WHEN OLD.status!=NEW.status BEGIN
        UPDATE membership_clock SET revision=revision+1 WHERE id=1;
        UPDATE memberships SET membership_version=(SELECT revision FROM membership_clock WHERE id=1) WHERE tenant_id=NEW.id;
      END;
    `);
  }
  #get(id: TenantId): Tenant | null {
    const raw = this.ctx.storage.sql
      .exec("SELECT id,handle,origin,status FROM tenants WHERE id = ?", id)
      .toArray()[0];
    if (raw === undefined) return null;
    const row = Schema.decodeUnknownSync(tenantRow)(raw);
    const domains = this.ctx.storage.sql
      .exec("SELECT host FROM domains WHERE tenant_id = ? ORDER BY ordinal", id)
      .toArray()
      .map((value) => Schema.decodeUnknownSync(domainRow)(value).host);
    const owners = this.ctx.storage.sql
      .exec(
        "SELECT member_id FROM memberships WHERE tenant_id = ? AND role = 'owner' ORDER BY member_id",
        id,
      )
      .toArray()
      .map((value) => Schema.decodeUnknownSync(memberRow)(value).member_id);
    return immutable({
      ...row,
      domains,
      owners,
      origin: checkedOrigin(row.origin, domains),
    });
  }
  get(id: TenantId): Promise<Tenant | null> {
    return Promise.resolve(
      this.#get(Schema.decodeUnknownSync(tenantIdSchema)(id)),
    );
  }
  byHandle(handle: string): Promise<Tenant | null> {
    const row = this.ctx.storage.sql
      .exec("SELECT id FROM tenants WHERE handle = ?", handle)
      .toArray()[0];
    return Promise.resolve(
      row === undefined
        ? null
        : this.#get(
            Schema.decodeUnknownSync(Schema.Struct({ id: tenantIdSchema }))(row)
              .id,
          ),
    );
  }
  byDomain(host: string): Promise<Tenant | null> {
    const row = this.ctx.storage.sql
      .exec("SELECT tenant_id FROM domains WHERE host = ?", host)
      .toArray()[0];
    return Promise.resolve(
      row === undefined
        ? null
        : this.#get(
            Schema.decodeUnknownSync(
              Schema.Struct({ tenant_id: tenantIdSchema }),
            )(row).tenant_id,
          ),
    );
  }
  status(id: TenantId): Promise<Tenant["status"] | null> {
    return Promise.resolve(this.#get(id)?.status ?? null);
  }
  memberById(id: TenantId, memberId: string) {
    const tenantId = Schema.decodeUnknownSync(tenantIdSchema)(id);
    const canonicalId = Schema.decodeUnknownSync(Schema.NonEmptyString)(
      memberId,
    );
    const row = this.ctx.storage.sql
      .exec(
        "SELECT member_id,role,membership_version FROM memberships WHERE tenant_id=? AND member_id=?",
        tenantId,
        canonicalId,
      )
      .toArray()[0];
    if (row === undefined) return Promise.resolve(null);
    const stored = Schema.decodeUnknownSync(membershipRow)(row);
    return Promise.resolve({
      memberId: stored.member_id,
      role: stored.role,
      membershipVersion: stored.membership_version,
    });
  }
  membershipOf(id: TenantId, identity: Identity) {
    return Promise.resolve(
      this.#membershipOf(
        id,
        Schema.decodeUnknownSync(identitySchema)(identity),
      ),
    );
  }
  /** One atomic read of the tenant at `host` and `identity`'s live membership. */
  admission(host: string, identity: Identity) {
    const domain = Schema.decodeUnknownSync(Schema.String)(host);
    const member = Schema.decodeUnknownSync(identitySchema)(identity);
    return Promise.resolve(
      this.ctx.storage.transactionSync(() => {
        const row = this.ctx.storage.sql
          .exec("SELECT tenant_id FROM domains WHERE host = ?", domain)
          .toArray()[0];
        if (row === undefined) return null;
        const tenant = this.#get(
          Schema.decodeUnknownSync(
            Schema.Struct({ tenant_id: tenantIdSchema }),
          )(row).tenant_id,
        );
        return tenant === null
          ? null
          : { tenant, membership: this.#membershipOf(tenant.id, member) };
      }),
    );
  }
  #membershipOf(id: TenantId, owner: Identity) {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT m.member_id,m.role,m.membership_version FROM memberships m JOIN identities i ON m.member_id=i.member_id WHERE m.tenant_id=? AND i.provider=? AND i.subject=?`,
        id,
        owner.provider,
        owner.subject,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const stored = Schema.decodeUnknownSync(membershipRow)(row);
    return {
      memberId: stored.member_id,
      role: stored.role,
      membershipVersion: stored.membership_version,
    };
  }
  create(input: TenantCreateInput): Promise<Tenant> {
    return Promise.resolve().then(() => {
      const parsed = Schema.decodeUnknownSync(createSchema)(input);
      const origin = checkedOrigin(parsed.origin, parsed.domains);
      return this.ctx.storage.transactionSync(() => {
        const raw = this.ctx.storage.sql
          .exec(
            "SELECT member_id FROM identities WHERE provider=? AND subject=?",
            parsed.owner.provider,
            parsed.owner.subject,
          )
          .toArray()[0];
        const memberId =
          raw === undefined
            ? createMemberId()
            : Schema.decodeUnknownSync(memberRow)(raw).member_id;
        if (raw === undefined)
          this.ctx.storage.sql.exec(
            "INSERT INTO identities (provider,subject,member_id) VALUES (?,?,?)",
            parsed.owner.provider,
            parsed.owner.subject,
            memberId,
          );
        this.ctx.storage.sql.exec(
          "INSERT INTO tenants (id,handle,origin,status) VALUES (?,?,?,'active')",
          parsed.handle,
          parsed.handle,
          origin,
        );
        for (const [ordinal, host] of parsed.domains.entries())
          this.ctx.storage.sql.exec(
            "INSERT INTO domains (host,tenant_id,ordinal) VALUES (?,?,?)",
            host,
            parsed.handle,
            ordinal,
          );
        this.ctx.storage.sql.exec(
          "INSERT INTO memberships (tenant_id,member_id,role) VALUES (?,?,'owner')",
          parsed.handle,
          memberId,
        );
        return immutable({
          id: parsed.handle,
          handle: parsed.handle,
          origin,
          status: "active",
          domains: parsed.domains,
          owners: [memberId],
        });
      });
    });
  }
  setStatus(id: TenantId, status: Tenant["status"]): Promise<void> {
    const parsed = Schema.decodeUnknownSync(statusSchema)(status);
    if (this.#get(id) === null) throw new Error("Tenant does not exist");
    this.ctx.storage.sql.exec(
      "UPDATE tenants SET status=? WHERE id=?",
      parsed,
      id,
    );
    return Promise.resolve();
  }
  delete(id: TenantId): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM memberships WHERE tenant_id=?",
        id,
      );
      this.ctx.storage.sql.exec("DELETE FROM domains WHERE tenant_id=?", id);
      this.ctx.storage.sql.exec("DELETE FROM tenants WHERE id=?", id);
    });
    return Promise.resolve();
  }
}

/** Native registry instance; its public shape exposes no runtime-private state. */
export type TenancyRegistryDO = ManagedTenantRegistry &
  Required<Pick<ReadonlyTenantRegistry, "byDomain">> &
  Readonly<{
    /** One atomic read of the tenant at a host and one identity's membership. */
    admission(
      host: string,
      identity: Identity,
    ): Promise<RegistryAdmission | null>;
  }> &
  Rpc.DurableObjectBranded;
/** Re-export from a host Worker and bind a SQLite-backed Durable Object namespace. */
export const TenancyRegistryDO: new (
  ctx: DurableObjectState,
) => TenancyRegistryDO = RegistryObject;
/** A read-only registry that includes the provisioned-domain index. */
export type DomainRegistry = ReadonlyTenantRegistry &
  Required<Pick<ReadonlyTenantRegistry, "byDomain">>;
/** Read-only native registry, with one-read request admission. */
export type DurableReadonlyRegistry = DomainRegistry &
  Readonly<{
    /** Read the tenant at `host` and `identity`'s membership atomically, once. */
    admission(
      host: string,
      identity: Identity,
    ): Promise<TenantAdmission | null>;
  }>;
/** Managed native registry includes the provisioned-domain index. */
export type DurableRegistry = ManagedTenantRegistry & DurableReadonlyRegistry;
/** Explicitly expose only read methods when the host requests a read-only facade. */
export function durableObjectRegistry(
  binding: Pick<DurableObjectNamespace<TenancyRegistryDO>, "getByName">,
  options: { readonly: true },
): DurableReadonlyRegistry;
/** Use one namespace's registry object as the tenant and owner mapping authority. */
export function durableObjectRegistry(
  binding: Pick<DurableObjectNamespace<TenancyRegistryDO>, "getByName">,
  options?: { readonly?: false },
): DurableRegistry;
export function durableObjectRegistry(
  binding: Pick<DurableObjectNamespace<TenancyRegistryDO>, "getByName">,
  options: { readonly?: boolean } = {},
): DurableReadonlyRegistry | DurableRegistry {
  const stub = () => binding.getByName("registry");
  const read: DurableReadonlyRegistry = {
    get: async (id) => {
      const result = await stub().get(id);
      return result === null ? null : immutable(result);
    },
    byHandle: async (handle) => {
      const result = await stub().byHandle(handle);
      return result === null ? null : immutable(result);
    },
    byDomain: async (host) => {
      const result = await stub().byDomain(host);
      return result === null ? null : immutable(result);
    },
    status: async (id) => await stub().status(id),
    memberById: async (id, memberId) => {
      const result = await stub().memberById(id, memberId);
      return result === null
        ? null
        : {
            memberId: result.memberId,
            role: result.role,
            membershipVersion: result.membershipVersion,
          };
    },
    membershipOf: async (id, identity) => {
      const result = await stub().membershipOf(id, identity);
      return result === null
        ? null
        : {
            memberId: result.memberId,
            role: result.role,
            membershipVersion: result.membershipVersion,
          };
    },
    admission: async (host, identity) => {
      const result = await stub().admission(host, identity);
      return result === null
        ? null
        : Schema.decodeUnknownSync(tenantAdmissionSchema)({
            host,
            identity,
            tenant: result.tenant,
            membership: result.membership,
          });
    },
  };
  return options.readonly === true
    ? read
    : {
        ...read,
        create: async (input) => {
          const result = await stub().create(input);
          return immutable(result);
        },
        setStatus: async (id, status) => {
          await stub().setStatus(id, status);
        },
        delete: async (id) => {
          await stub().delete(id);
        },
      };
}

/**
 * Answer registry reads only from one request's admission. Any other tenant,
 * host, identity or member reads as absent, so every refusal stays closed.
 */
export function admittedRegistry(admission: TenantAdmission): DomainRegistry {
  const { host, identity, membership } = admission;
  const tenant = immutable(admission.tenant);
  const selected = (id: TenantId) => (id === tenant.id ? tenant : null);
  const member = (id: TenantId) =>
    id === tenant.id && membership !== null ? { ...membership } : null;
  return {
    get: (id) => Promise.resolve(selected(id)),
    byHandle: (handle) =>
      Promise.resolve(handle === tenant.handle ? tenant : null),
    byDomain: (requested) =>
      Promise.resolve(requested === host ? tenant : null),
    status: (id) => Promise.resolve(selected(id)?.status ?? null),
    membershipOf: (id, requested) =>
      Promise.resolve(
        requested.provider === identity.provider &&
          requested.subject === identity.subject
          ? member(id)
          : null,
      ),
    memberById: (id, memberId) =>
      Promise.resolve(member(id)?.memberId === memberId ? member(id) : null),
  };
}
