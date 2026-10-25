import {
  TenancyRegistryDO,
  admittedRegistry,
  durableObjectRegistry,
  type TenantAdmission,
} from "../tenancy/cloudflare.js";
import {
  createTenancy,
  type Identity,
  type Tenant,
  type ReadonlyTenancy,
} from "../tenancy/index.js";
import { ownerKey } from "../tenancy/owner-key.js";
import { hosts } from "../tenancy/resolve.js";
import { ownerOrKeyAuth } from "../auth.js";
import type { OysterGitWorkerEnv } from "../workers-git.js";
import { HTTPException } from "hono/http-exception";
import {
  defaultTenant,
  tenantScope,
  type TenantPrincipal,
  type OysterTenancy,
  type TenantId,
} from "../tenant.js";
import * as Schema from "effect/Schema";

const seedSchema = Schema.Struct({
  origin: Schema.String,
  owner: Schema.Struct({
    provider: Schema.NonEmptyString,
    subject: Schema.NonEmptyString,
  }),
});
const seedKey = "standalone-owner-seed";

/** Trusted standalone provisioning inputs; credentials never enter the seed. */
export type StandaloneSeed = Readonly<{
  origin: string;
  owner: Identity;
}>;

export type StandaloneSeedRefusal = Readonly<{
  kind: "refused";
  code: "seed_configuration_changed";
  seededOrigin: string;
  configuredOrigin: string;
  recovery: "fresh_worker_name_or_reset_worker_data";
}>;

export class StandaloneSeedConfigurationChanged extends Error {
  readonly refusal: StandaloneSeedRefusal;

  constructor(refusal: StandaloneSeedRefusal) {
    super("Standalone seed configuration changed");
    this.name = "StandaloneSeedConfigurationChanged";
    this.refusal = refusal;
  }
}

/** A fresh registry namespace with one host-provisioned standalone tenant. */
export class StandaloneTenants extends TenancyRegistryDO {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState) {
    super(state);
    this.#state = state;
  }

  /** Reuse only the exact configured tenant and its current canonical owner. */
  seed(input: StandaloneSeed): Promise<Tenant | StandaloneSeedRefusal> {
    return this.#state.blockConcurrencyWhile(async () => {
      input = Schema.decodeUnknownSync(seedSchema)(input);
      const scope = tenantScope(defaultTenant, input.origin);
      const domain = new URL(scope.origin).host;
      const raw = await this.#state.storage.get(seedKey);
      if (raw !== undefined) {
        const marker = Schema.decodeUnknownSync(seedSchema)(raw);
        if (
          marker.origin !== scope.origin ||
          marker.owner.provider !== input.owner.provider ||
          marker.owner.subject !== input.owner.subject
        ) {
          return {
            kind: "refused",
            code: "seed_configuration_changed",
            seededOrigin: marker.origin,
            configuredOrigin: scope.origin,
            recovery: "fresh_worker_name_or_reset_worker_data",
          };
        }
      }
      let tenant = await this.get(defaultTenant);
      if (tenant === null) {
        if (raw !== undefined)
          throw new Error("Previously seeded standalone tenant is missing");
        // Persist the attempt first: a crash must never turn removal into creation.
        await this.#state.storage.put(seedKey, {
          origin: scope.origin,
          owner: input.owner,
        });
        tenant = await this.create({
          handle: defaultTenant,
          origin: scope.origin,
          domains: [domain],
          owner: input.owner,
        });
      }
      const owner = await this.membershipOf(defaultTenant, input.owner);
      if (
        tenant.handle !== defaultTenant ||
        tenant.origin !== scope.origin ||
        tenant.domains.length !== 1 ||
        tenant.domains[0] !== domain ||
        tenant.status !== "active" ||
        owner?.role !== "owner" ||
        tenant.owners.length !== 1 ||
        tenant.owners[0] !== owner.memberId
      )
        throw new Error(
          "Standalone tenant does not match its configured owner",
        );
      if (raw === undefined)
        await this.#state.storage.put(seedKey, {
          origin: scope.origin,
          owner: input.owner,
        });
      return tenant;
    });
  }
}

/** The same trusted bindings are used by HTTP, MCP and cold root readers. */
export type StandaloneTenancyEnv = Pick<
  OysterGitWorkerEnv,
  "OYSTER_ORIGIN" | "OYSTER_OWNER_NAME" | "OYSTER_OWNER_KEY" | "KEYS"
> &
  Readonly<{
    TENANTS: DurableObjectNamespace<StandaloneTenants>;
  }>;

/** A live registry-owned owner; the configured label is never its member ID. */
export type StandaloneOwner = Readonly<{
  actor: Readonly<{ kind: "member"; memberId: string }>;
  role: "owner";
  membershipVersion: number;
}>;

/**
 * Read-only kit authority and the canonical Oyster bridge share one seed.
 * Every entry admits with exactly one TENANTS read: an HTTP request through
 * `oyster.resolve`, and each `owner()` or `tenancy` call at its own top.
 */
export type StandaloneTenancy = Readonly<{
  tenantId: TenantId;
  tenancy: ReadonlyTenancy<"origin">;
  oyster: OysterTenancy;
  owner(): Promise<StandaloneOwner | null>;
}>;

/** A request may seed the standalone tenant only at its configured origin. */
export async function standaloneTenancyForRequest(
  env: StandaloneTenancyEnv,
  request: Request,
): Promise<StandaloneTenancy> {
  const configuredOrigin = tenantScope(defaultTenant, env.OYSTER_ORIGIN).origin;
  const requestOrigin = new URL(request.url).origin;
  if (requestOrigin !== configuredOrigin)
    throw new HTTPException(404, {
      res: Response.json(
        {
          kind: "refused",
          code: "origin_mismatch",
          configuredOrigin,
          requestOrigin,
          message: `Request origin ${requestOrigin} does not match configured OYSTER_ORIGIN ${configuredOrigin}. Set OYSTER_ORIGIN to this Worker's URL.`,
        },
        { status: 404 },
      ),
    });
  return standaloneTenancy(env);
}

const environments = new WeakMap<
  StandaloneTenancyEnv,
  Promise<StandaloneTenancy>
>();

/** Seed once per environment, then admit every entry from one fresh registry read. */
export function standaloneTenancy(
  env: StandaloneTenancyEnv,
): Promise<StandaloneTenancy> {
  let pending = environments.get(env);
  if (pending === undefined) {
    pending = composeTenancy(env).catch((cause: unknown) => {
      if (environments.get(env) === pending) environments.delete(env);
      throw cause;
    });
    environments.set(env, pending);
  }
  return pending;
}

/** The kit's admission over one registry read; it performs no further I/O. */
type Admitted = Readonly<{
  tenancy: ReadonlyTenancy<"origin">;
  owner: StandaloneOwner | null;
  login(request: Request): Promise<Response>;
}>;

async function composeTenancy(
  env: StandaloneTenancyEnv,
): Promise<StandaloneTenancy> {
  const scope = tenantScope(defaultTenant, env.OYSTER_ORIGIN);
  const domain = new URL(scope.origin).host;
  const identity: Identity = {
    provider: "standalone-owner",
    subject: env.OYSTER_OWNER_NAME ?? "owner",
  };
  const seeded = await env.TENANTS.getByName("registry").seed({
    origin: scope.origin,
    owner: identity,
  });
  if ("kind" in seeded) throw new StandaloneSeedConfigurationChanged(seeded);
  const registry = durableObjectRegistry(env.TENANTS, { readonly: true });
  /** The canonical owner, only while the one admitted record still proves it. */
  const ownerOf = ({
    tenant,
    membership,
  }: TenantAdmission): StandaloneOwner | null =>
    tenant.id !== defaultTenant ||
    tenant.status !== "active" ||
    tenant.origin !== scope.origin ||
    tenant.handle !== defaultTenant ||
    tenant.domains.length !== 1 ||
    tenant.domains[0] !== domain ||
    membership?.role !== "owner" ||
    tenant.owners.length !== 1 ||
    tenant.owners[0] !== membership.memberId
      ? null
      : {
          actor: { kind: "member", memberId: membership.memberId },
          role: "owner",
          membershipVersion: membership.membershipVersion,
        };
  const admitted = (admission: TenantAdmission): Admitted => {
    const view = admittedRegistry(admission);
    const owner = ownerOf(admission);
    const ownerAuth = ownerKey({
      registry: view,
      keys: {
        get: () =>
          Promise.resolve(
            owner === null
              ? null
              : { key: env.OYSTER_OWNER_KEY, memberId: owner.actor.memberId },
          ),
      },
      login: { resolveTenant: (request) => tenancy.resolve(request) },
    });
    const resolver = hosts(view);
    const tenancy: ReadonlyTenancy<"origin"> = createTenancy({
      registry: view,
      resolve: {
        kind: "origin",
        resolve: (url, current) =>
          url.origin === scope.origin
            ? resolver.resolve(url, current)
            : Promise.resolve(null),
      },
      auth: [
        ownerAuth,
        {
          id: "standalone-named-key",
          async authenticate(request) {
            if (owner === null) return { kind: "refused", status: 403 };
            const admission = await ownerOrKeyAuth(
              env.OYSTER_OWNER_KEY,
              owner.actor.memberId,
              () => env.KEYS.getByName(scope.durableName("keys")),
            ).authenticate(request);
            // This entry admits only named keys; the owner key has its own entry.
            return admission.kind === "admitted" &&
              admission.principal.actor.kind === "team-key"
              ? { kind: "principal", principal: admission.principal }
              : { kind: "refused", status: 401 };
          },
        },
      ],
    });
    const routes = ownerAuth.routes;
    return {
      tenancy,
      owner,
      login: async (request) =>
        routes === undefined
          ? new Response("Sign-in is not available", { status: 404 })
          : await routes.fetch(request),
    };
  };
  /**
   * The registry only ever stores a tenant's creation-time owner membership,
   * and `ownerOf` proved this admission names exactly one owner. So the
   * admitted owner is the tenant's only member: attest it on that principal.
   */
  const soleOwner = <P extends TenantPrincipal>(
    current: Admitted,
    principal: P,
  ): P =>
    principal.actor.kind === "member" &&
    current.owner?.actor.memberId === principal.actor.memberId
      ? { ...principal, soleMember: true }
      : principal;
  /** The one TENANTS read for an entry at `url`; another origin never reads. */
  const admit = async (url: URL): Promise<Admitted | null> => {
    if (url.origin !== scope.origin) return null;
    const admission = await registry.admission(url.host, identity);
    return admission === null ? null : admitted(admission);
  };
  const atRoot = () => admit(new URL(scope.origin));
  const owner = async () => (await atRoot())?.owner ?? null;
  const tenancy: ReadonlyTenancy<"origin"> = {
    resolve: async (request) =>
      (await (await admit(new URL(request.url)))?.tenancy.resolve(request)) ??
      null,
    authenticate: async (request, tenant) => {
      const current = await admit(new URL(request.url));
      return current === null
        ? { kind: "refused", status: 404 }
        : current.tenancy.authenticate(request, tenant);
    },
    member: async (tenantId, member) =>
      (await (await atRoot())?.tenancy.member(tenantId, member)) ?? null,
    memberById: async (tenantId, memberId) =>
      (await (await atRoot())?.tenancy.memberById(tenantId, memberId)) ?? null,
    middleware: (options) => async (context, next) => {
      const current = await admit(new URL(context.req.url));
      return current === null
        ? context.json({ error: "not_found" }, 404)
        : current.tenancy.middleware(options)(context, next);
    },
    oyster: () => oyster,
  };
  const oyster: OysterTenancy = {
    async resolve(request) {
      const current = await admit(new URL(request.url));
      const tenant = (await current?.tenancy.resolve(request)) ?? null;
      if (current === null || tenant === null) return null;
      // This request's authentication consumes the admission read above.
      // Any other request is its own entry and is admitted afresh.
      const forRequest = (incoming: Request) =>
        incoming === request
          ? Promise.resolve(current)
          : admit(new URL(incoming.url));
      return {
        scope: tenantScope(tenant.id, tenant.origin),
        auth: {
          resolve: async (actor) => {
            if (actor.kind !== "member") return null;
            const current = await atRoot();
            const member =
              (await current?.tenancy.memberById(tenant.id, actor.memberId)) ??
              null;
            return current === null || member === null
              ? null
              : soleOwner(current, member);
          },
          authenticate: async (incoming) => {
            const admittedFor = await forRequest(incoming);
            if (admittedFor === null) return { kind: "refused", status: 404 };
            const result = await admittedFor.tenancy.authenticate(
              incoming,
              tenant,
            );
            return result.kind === "admitted"
              ? {
                  kind: "admitted",
                  principal: soleOwner(admittedFor, result.principal),
                }
              : result;
          },
          login: async (incoming) =>
            (await (await forRequest(incoming))?.login(incoming)) ??
            new Response("Not found", { status: 404 }),
        },
      };
    },
  };
  return { tenantId: defaultTenant, tenancy, oyster, owner };
}
