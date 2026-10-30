/**
 * Oyster's one authorization owner. Every Oyster HTTP route is registered
 * through {@link routes} with a typed {@link Requirement}; a table's `serve`
 * is the only place those declarations become a Hono router, so an undeclared
 * route cannot be served and a declared one cannot skip its decision.
 *
 * Who may reach what is decided here once, from one {@link Authority}: the
 * owner reaches everything; a named key reaches exactly its Ear Tag grants
 * (Apps, Agents, the Computer); an Agent reaches its App tool policy. An
 * anonymous request reaches only the public routes: sign-in, robots.txt and
 * digest-pinned assets. The App gate
 * (`apps/gate.ts`) still owns App-declaration rules; it asks this module for a
 * principal's App reach.
 */
import { Hono, type Context, type Env, type ErrorHandler } from "hono";
import { timing } from "hono/timing";
import type { MiddlewareHandler } from "hono/types";
import * as Schema from "effect/Schema";
import type { HostActor } from "@fungi.computer/puffball/app";
import type { AppToolPolicy } from "./apps/tools.js";
import { oysterKeyVocabulary, type LiveOysterKey } from "./keys.js";
import type { CapabilityEnv, OysterAuthResult, OysterHost } from "./host.js";
import type { TenantPrincipal } from "./tenant.js";

/**
 * One live key's access to one installation: `write` when its grants admit
 * `apps.use` there, `read` when they admit `apps.read`, otherwise `null` --
 * including for an installation added after the key was issued, unless the
 * key holds "All Apps" (`targets: {kind: "all"}`). The same shape as an
 * Agent's stored {@link AppToolPolicy}; its caller adds `bindingName` (which
 * varies by caller: the plain installation id for the gate, the uppercased
 * binding name for MCP) to reach the full `AppToolAccess`.
 */
export function keyAppAccess(
  key: LiveOysterKey,
  installationId: string,
): AppToolPolicy | null {
  const level = oysterKeyVocabulary.grantsAllow(
    key.grants,
    "apps.use",
    installationId,
  )
    ? "write"
    : oysterKeyVocabulary.grantsAllow(key.grants, "apps.read", installationId)
      ? "read"
      : null;
  if (level === null) return null;
  return {
    level,
    revision: `key:${key.keyId}:${String(key.grantVersion)}`,
    grantedBy: key.owner,
  };
}

/** Agent access is scoped to the granted Agent ids, never inferred from App grants. */
export function keyAgentAccess(key: LiveOysterKey, agentId: string): boolean {
  return oysterKeyVocabulary.grantsAllow(key.grants, "agents.use", agentId);
}

/** Whether a live key's own grants turn its Computer access on. Off by default. */
export function keyAllowsComputerUse(key: LiveOysterKey): boolean {
  return oysterKeyVocabulary.grantsAllow(key.grants, "computer.use");
}

/** The owner, as every owner route receives it. */
export type OwnerPrincipal = Readonly<{
  actor: Extract<HostActor, { kind: "member" }>;
  role: "owner";
}>;

/** True only for a member admitted with the owner role. */
export function oysterPrincipalIsOwner(
  principal: TenantPrincipal,
): principal is OwnerPrincipal {
  return "role" in principal && principal.role === "owner";
}

/** A member, owner or not, as member routes receive it. */
export type MemberPrincipal = Extract<
  TenantPrincipal,
  { role: "owner" | "member" }
>;

/** The live facts this module reads to decide; every host supplies the same ports. */
export type AuthorityPorts = Readonly<{
  /** One key's live grants; `null` for an unknown, revoked, expired or suspended key. */
  liveKey: (keyId: string) => Promise<LiveOysterKey | null>;
  /** An Agent's host-attested App tool policy; `null` grants no App reach. */
  appToolPolicy: (
    actor: Extract<HostActor, { kind: "agent" }>,
  ) => AppToolPolicy | null | Promise<AppToolPolicy | null>;
}>;

/** A host's own ports: its key store's liveness and its Agents' tool policy. */
export function hostAuthorityPorts(
  host: Pick<OysterHost, "keys" | "appToolPolicy">,
): AuthorityPorts {
  return {
    liveKey: async (keyId) => (await host.keys?.live(keyId)) ?? null,
    appToolPolicy: async (actor) => (await host.appToolPolicy?.(actor)) ?? null,
  };
}

/**
 * One request's authority, resolved once from its principal. A key carries
 * its live grants, or `null` once it is no longer live, which reaches nothing.
 */
export type Authority =
  | Readonly<{ kind: "owner"; principal: OwnerPrincipal }>
  | Readonly<{ kind: "member"; principal: MemberPrincipal }>
  | Readonly<{
      kind: "key";
      principal: TenantPrincipal;
      key: LiveOysterKey | null;
    }>
  | Readonly<{
      kind: "agent";
      principal: TenantPrincipal;
      actor: Extract<HostActor, { kind: "agent" }>;
    }>;

/** Resolve one principal's authority through the live key port. */
export async function authorityOf(
  principal: TenantPrincipal,
  ports: AuthorityPorts,
): Promise<Authority> {
  if (oysterPrincipalIsOwner(principal)) return { kind: "owner", principal };
  if ("role" in principal) return { kind: "member", principal };
  const { actor } = principal;
  switch (actor.kind) {
    case "team-key":
      return {
        kind: "key",
        principal,
        key: await ports.liveKey(actor.keyId),
      };
    case "agent":
      return { kind: "agent", principal, actor };
  }
}

/** Whether this authority reaches one Agent and its Sessions. Only the owner and granted keys do. */
export function reachesAgent(authority: Authority, agentId: string): boolean {
  switch (authority.kind) {
    case "owner":
      return true;
    case "key":
      return authority.key !== null && keyAgentAccess(authority.key, agentId);
    case "member":
    case "agent":
      return false;
  }
}

/**
 * Whether this authority reaches the host's Computer, its workspace files and
 * the media written there. Members do; a key only with `computer.use`;
 * Agents reach a Computer only through their own attachment owner.
 */
export function reachesComputer(authority: Authority): boolean {
  switch (authority.kind) {
    case "owner":
    case "member":
      return true;
    case "key":
      return authority.key !== null && keyAllowsComputerUse(authority.key);
    case "agent":
      return false;
  }
}

/**
 * A key's or Agent's tool access to one installation, in the App gate's
 * policy shape; `null` when it reaches none. Members and the owner hold
 * no tool policy: the App gate decides them by role.
 */
export async function appToolAccess(
  authority: Authority,
  installationId: string,
  ports: AuthorityPorts,
): Promise<AppToolPolicy | null> {
  switch (authority.kind) {
    case "key":
      return authority.key === null
        ? null
        : keyAppAccess(authority.key, installationId);
    case "agent":
      return ports.appToolPolicy(authority.actor);
    case "owner":
    case "member":
      return null;
  }
}

/** One installation as reach decisions see it. */
export type ReachableInstallation = Readonly<{ installationId: string }>;

/**
 * Whether this authority may see or open one installation at all (the home
 * list, Git). A key needs `apps.read` there; `use` needs `apps.use`.
 * Nothing anonymous reaches one.
 */
export async function reachesInstallation(
  authority: Authority,
  installation: ReachableInstallation,
  access: "read" | "use",
  ports: AuthorityPorts,
): Promise<boolean> {
  switch (authority.kind) {
    case "owner":
    case "member":
      return true;
    case "key":
    case "agent": {
      const policy = await appToolAccess(
        authority,
        installation.installationId,
        ports,
      );
      return policy !== null && (access === "read" || policy.level === "write");
    }
  }
}

/** Whether a live key's grants permit a one-use device enrollment. */
export function allowsMachineEnrollment(key: LiveOysterKey): boolean {
  return (
    key.grants.length === 1 &&
    key.grants[0]?.capability === "machine.enroll" &&
    oysterKeyVocabulary.grantsAllow(key.grants, "machine.enroll")
  );
}

/** The request facts a requirement reads. */
export type RequestFacts = Readonly<{
  /** The incoming request. */
  request: Request;
  /** One path parameter of the matched route. */
  param: (name: string) => string | undefined;
  /** Decode the JSON body (shared with the handler's own read); `null` when it does not match. */
  body: <T>(schema: Schema.Decoder<T>) => Promise<T | null>;
  /** The request's principal, authenticated once by the serving table. */
  principal: () => Promise<OysterAuthResult>;
  /** Whether an App sent this request (the page bridge, or any capability call). */
  mediated: boolean;
  ports: AuthorityPorts;
}>;

/** A refusal this module returns before any handler runs. */
function refused(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Every requirement kind; the law test proves each has both outcomes. */
export type RequirementKind =
  | "public"
  | "door"
  | "owner"
  | "member"
  | "app"
  | "apps"
  | "agent"
  | "agents"
  | "computer";

/** How the law and the host table read one route's requirement. */
export type DeclaredRequirement = Readonly<{
  kind: RequirementKind;
  /** An owner route's reach: `direct` refuses App-mediated requests. */
  via?: "direct" | "direct-or-app";
  /** Why a route needs no Oyster principal (`public`, `door`). */
  reason?: string;
}>;

/** The token only this module holds; a requirement cannot be minted without it. */
const mint = Symbol("oyster.requirement.mint");

/** A requirement's label and decision, readable only inside this module. */
type MintRecord<Admitted> = Readonly<{
  declared: DeclaredRequirement;
  admit: (facts: RequestFacts) => Promise<Admitted | Response>;
}>;

/** Module-private reader of a requirement's mint record; set once below. */
let mintRecordOf: <Admitted>(
  value: Requirement<Admitted>,
) => MintRecord<Admitted> | undefined;

/**
 * One route's declared requirement: an opaque, frozen value only this module
 * mints. Its label and decision live in private fields that only this module
 * reads, so a copy, a look-alike, an overridden method or a relabelled field
 * changes nothing a route serves, and registering a non-minted value throws.
 */
export class Requirement<Admitted> {
  /** Type-only: what the requirement admits. Never present at run time. */
  declare readonly admitted?: Admitted;
  readonly #declared: DeclaredRequirement;
  readonly #admit: (facts: RequestFacts) => Promise<Admitted | Response>;

  static {
    mintRecordOf = (value) =>
      #declared in value
        ? { declared: value.#declared, admit: value.#admit }
        : undefined;
  }

  /** Module-private: use the requirement constructors below. */
  constructor(
    token: symbol,
    declared: DeclaredRequirement,
    admit: (facts: RequestFacts) => Promise<Admitted | Response>,
  ) {
    if (token !== mint)
      throw new Error("Only authorization.ts mints route requirements");
    this.#declared = Object.freeze({ ...declared });
    this.#admit = admit;
    Object.freeze(this);
  }
}

function requirement<Admitted>(
  declared: DeclaredRequirement,
  admit: (facts: RequestFacts) => Promise<Admitted | Response>,
): Requirement<Admitted> {
  return new Requirement(mint, declared, admit);
}

/** Authenticate, or answer the table's own unauthenticated refusal. */
async function signedIn(
  facts: RequestFacts,
): Promise<TenantPrincipal | Response> {
  const result = await facts.principal();
  return result.kind === "admitted"
    ? result.principal
    : unauthenticated(facts.request, result);
}

/** A browser page asks to sign in; every other refused request gets its status. */
export function unauthenticated(
  request: Request,
  result: Extract<OysterAuthResult, { kind: "refused" }>,
): Response {
  if (
    (result.status === 401 || result.status === 403) &&
    request.method === "GET" &&
    (request.headers.get("Accept") ?? "").includes("text/html")
  )
    return new Response(null, { status: 302, headers: { Location: "/login" } });
  const headers = new Headers();
  if (result.retryAfter !== undefined)
    headers.set("Retry-After", String(result.retryAfter));
  return Response.json(
    { error: "Sign in to use this Oyster" },
    { status: result.status, headers },
  );
}

/** Served without any principal: sandboxed App bytes, page assets, sign-in. */
export function publicRoute(reason: string): Requirement<null> {
  return requirement({ kind: "public", reason }, () => Promise.resolve(null));
}

/**
 * The route verifies its own credential (MCP, Git, signed webhook delivery,
 * device enrollment); `reason` names that credential. A door that reads an
 * Oyster principal decides its reach through this module's functions.
 */
export function door(reason: string): Requirement<null> {
  return requirement({ kind: "door", reason }, () => Promise.resolve(null));
}

/** Where an owner request came from: the owner directly, or an App acting through the shell. */
export type OwnerOrigin = "owner-direct" | "app";

/** What an owner route receives. */
export type OwnerAdmission = Readonly<{
  principal: OwnerPrincipal;
  origin: OwnerOrigin;
}>;

/**
 * The owner only. `direct` also refuses an App-mediated request (one the
 * page bridge sends with `X-Oyster-Installation`, and every request a
 * capability table serves): consent and secrets never ride an App.
 */
export function owner(
  via: "direct" | "direct-or-app",
): Requirement<OwnerAdmission> {
  return requirement({ kind: "owner", via }, async (facts) => {
    const principal = await signedIn(facts);
    if (principal instanceof Response) return principal;
    if (!oysterPrincipalIsOwner(principal)) return refused(403, "Owner only");
    const origin: OwnerOrigin = facts.mediated ? "app" : "owner-direct";
    if (via === "direct" && origin === "app")
      return refused(403, "Owner direct only");
    return { principal, origin };
  });
}

/**
 * Any member, owner or not; never a key or Agent. `deny` shapes the
 * refusal for a contract whose wire already names one.
 */
export function member(
  deny: () => Response = () => refused(403, "Members only"),
): Requirement<Readonly<{ principal: MemberPrincipal }>> {
  return requirement({ kind: "member" }, async (facts) => {
    const principal = await signedIn(facts);
    if (principal instanceof Response) return principal;
    return "role" in principal ? { principal } : deny();
  });
}

/**
 * An App route: any signed-in principal, decided per call by the App gate,
 * which reads this module's {@link appToolAccess}.
 */
export function app(): Requirement<Readonly<{ principal: TenantPrincipal }>> {
  return requirement({ kind: "app" }, async (facts) => {
    const principal = await signedIn(facts);
    return principal instanceof Response ? principal : { principal };
  });
}

/** What a collection route receives: the authority and its reach over each item. */
export type CollectionAdmission<Item> = Readonly<{
  authority: Authority;
  /** Whether this authority may see one item of the collection. */
  reaches: (item: Item) => Promise<boolean>;
}>;

/** The installation list (the home page): the owner sees all, keys their granted ones. */
export function apps(): Requirement<
  CollectionAdmission<ReachableInstallation>
> {
  return requirement({ kind: "apps" }, async (facts) => {
    const authority = await signedInAuthority(facts);
    if (authority instanceof Response) return authority;
    return {
      authority,
      reaches: (installation) =>
        reachesInstallation(authority, installation, "read", facts.ports),
    };
  });
}

/** Resolve a signed-in principal's authority, refusing an anonymous request. */
async function signedInAuthority(
  facts: RequestFacts,
): Promise<Authority | Response> {
  const principal = await signedIn(facts);
  if (principal instanceof Response) return principal;
  return authorityOf(principal, facts.ports);
}

/** What an Agent route receives. */
export type AgentAdmission = Readonly<{
  authority: Authority;
  principal: TenantPrincipal;
  agentId: string;
}>;

/**
 * One Agent, named by the route's `:agentId` (or by `id` from the request):
 * the owner, or a key granted `agents.use` for that Agent id.
 */
export function agent(
  id: (facts: RequestFacts) => Promise<string | null> = (facts) =>
    Promise.resolve(facts.param("agentId") ?? null),
): Requirement<AgentAdmission> {
  return requirement({ kind: "agent" }, async (facts) => {
    const authority = await signedInAuthority(facts);
    if (authority instanceof Response) return authority;
    const agentId = await id(facts);
    if (agentId === null) return refused(400, "Name the Agent");
    if (!reachesAgent(authority, agentId))
      return refused(403, "Agent access denied");
    return { authority, principal: authority.principal, agentId };
  });
}

/** Agents (and their inbox rows): the owner sees all, a key its granted Agents. */
export function agents(): Requirement<CollectionAdmission<string>> {
  return requirement({ kind: "agents" }, async (facts) => {
    const authority = await signedInAuthority(facts);
    if (authority instanceof Response) return authority;
    return {
      authority,
      reaches: (agentId) => Promise.resolve(reachesAgent(authority, agentId)),
    };
  });
}

/** The host's Computer, its workspace files and media: see {@link reachesComputer}. */
export function computer(): Requirement<
  Readonly<{ principal: TenantPrincipal }>
> {
  return requirement({ kind: "computer" }, async (facts) => {
    const authority = await signedInAuthority(facts);
    if (authority instanceof Response) return authority;
    if (!reachesComputer(authority))
      return refused(403, "Computer access requires an owner or key");
    return { principal: authority.principal };
  });
}

/** An HTTP method a route may declare. */
export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One declared route, as the law test and the host's table read it. */
export type RouteDeclaration = Readonly<{
  methods: readonly Method[] | "ALL";
  path: string;
  requirement: DeclaredRequirement;
}>;

/** How a served table reads one request's principal. */
type PrincipalSource<E extends Env> = (
  context: Context<E>,
) => Promise<OysterAuthResult>;

/** A handler receives the request and exactly what its requirement admitted. */
export type Handler<E extends Env, P extends string, Admitted> = (
  context: Context<E, P>,
  admitted: Admitted,
) => Response | Promise<Response>;

/** Per-route options; middleware runs after the requirement admits. */
export type RouteOptions<E extends Env, P extends string> = Readonly<{
  middleware?: readonly MiddlewareHandler<E, P>[];
}>;

type Entry<E extends Env> =
  | Readonly<{
      kind: "route";
      declaration: RouteDeclaration;
      /** Register requirement, then middleware, then handler on one router. */
      mount: (
        hono: Hono<E>,
        principal: PrincipalSource<E>,
        ports: AuthorityPorts,
        mediated: (request: Request) => boolean,
      ) => void;
    }>
  | Readonly<{ kind: "table"; table: Routes<E> }>;

/** A table's routes and error handler, readable only inside this module. */
type TableRecord<E extends Env> = Readonly<{
  entries: readonly Entry<E>[];
  errorHandler: () => ErrorHandler<E> | undefined;
}>;

/** Module-private reader of a table's record; set once below. */
let tableRecordOf: <E extends Env>(
  table: Routes<E>,
) => TableRecord<E> | undefined;

/** A table's record, or a refusal for anything `routes()` did not build. */
function recordOf<E extends Env>(table: Routes<E>): TableRecord<E> {
  const record = tableRecordOf(table);
  if (record === undefined)
    throw new Error("routes() did not build this route table");
  return record;
}

/**
 * A declared route table: a frozen, opaque value only {@link routes} builds.
 * Its routes live in a private record; including or serving reads only that
 * record, never a method a copy could override. A table cannot serve itself:
 * only {@link serveHost}, {@link serveDoors} and {@link serveCapability} do,
 * each with the principal its composition root admits. There is no `use`: a
 * path-wide middleware could serve a path no route declares.
 */
export class Routes<E extends Env> {
  readonly #entries: Entry<E>[] = [];
  #errorHandler: ErrorHandler<E> | undefined = undefined;

  static {
    tableRecordOf = (table) =>
      #entries in table
        ? {
            entries: table.#entries,
            errorHandler: () => table.#errorHandler,
          }
        : undefined;
  }

  /** Module-private: use {@link routes}. */
  constructor(token: symbol) {
    if (token !== mint)
      throw new Error("Only authorization.ts builds route tables");
    Object.freeze(this);
  }

  /** Register one GET route. */
  get<P extends string, A>(
    path: P,
    requirement: Requirement<A>,
    handler: Handler<E, P, A>,
    options?: RouteOptions<E, NoInfer<P>>,
  ): this {
    return this.#register(["GET"], path, requirement, handler, options);
  }

  /** Register one POST route. */
  post<P extends string, A>(
    path: P,
    requirement: Requirement<A>,
    handler: Handler<E, P, A>,
    options?: RouteOptions<E, NoInfer<P>>,
  ): this {
    return this.#register(["POST"], path, requirement, handler, options);
  }

  /** Register one PUT route. */
  put<P extends string, A>(
    path: P,
    requirement: Requirement<A>,
    handler: Handler<E, P, A>,
    options?: RouteOptions<E, NoInfer<P>>,
  ): this {
    return this.#register(["PUT"], path, requirement, handler, options);
  }

  /** Register one DELETE route. */
  delete<P extends string, A>(
    path: P,
    requirement: Requirement<A>,
    handler: Handler<E, P, A>,
    options?: RouteOptions<E, NoInfer<P>>,
  ): this {
    return this.#register(["DELETE"], path, requirement, handler, options);
  }

  /** Register one route for every method. */
  all<P extends string, A>(
    path: P,
    requirement: Requirement<A>,
    handler: Handler<E, P, A>,
    options?: RouteOptions<E, NoInfer<P>>,
  ): this {
    return this.#register("ALL", path, requirement, handler, options);
  }

  /** Register one route for several methods. */
  on<P extends string, A>(
    methods: readonly Method[],
    path: P,
    requirement: Requirement<A>,
    handler: Handler<E, P, A>,
    options?: RouteOptions<E, NoInfer<P>>,
  ): this {
    return this.#register(methods, path, requirement, handler, options);
  }

  /** Serve another table's routes at this position, keeping its own error handler. */
  include(other: Routes<E>): this {
    recordOf(other);
    this.#entries.push({ kind: "table", table: other });
    return this;
  }

  /** Answer an error thrown by this table's own handlers. */
  onError(handler: ErrorHandler<E>): this {
    this.#errorHandler = handler;
    return this;
  }

  /** Every route this table and its included tables declare, in serving order. */
  declarations(): readonly RouteDeclaration[] {
    return declarationsOf(this);
  }

  #register<P extends string, A>(
    methods: readonly Method[] | "ALL",
    path: P,
    requirement: Requirement<A>,
    handler: Handler<E, P, A>,
    options: RouteOptions<E, P> = {},
  ): this {
    // Only the mint record decides: a copy or look-alike has none, and a
    // minted value's own properties are never read.
    const record = mintRecordOf(requirement);
    if (record === undefined)
      throw new Error(
        `${path} names a requirement authorization.ts did not mint`,
      );
    this.#entries.push({
      kind: "route",
      declaration: { methods, path, requirement: record.declared },
      mount: (hono, principal, ports, mediated) => {
        // One admission per request, shared down the middleware chain.
        const admittedFor = new WeakMap<object, Readonly<{ value: A }>>();
        const gate: MiddlewareHandler<E, P> = async (context, next) => {
          const admitted = await record.admit({
            request: context.req.raw,
            param: (name) => context.req.param(name),
            body: async (schema) => {
              const decoded = Schema.decodeUnknownOption(
                Schema.fromJsonString(schema),
              )(await context.req.text());
              return decoded._tag === "Some" ? decoded.value : null;
            },
            principal: () => principal(context),
            mediated: mediated(context.req.raw),
            ports,
          });
          if (admitted instanceof Response) return admitted;
          admittedFor.set(context, { value: admitted });
          await next();
          return undefined;
        };
        const finish: Handler<E, P, null> = async (context) => {
          const admitted = admittedFor.get(context);
          if (admitted === undefined)
            throw new Error("A route handler ran without its admission");
          return handler(context, admitted.value);
        };
        // Hono runs same-path handlers in registration order.
        const chain = [gate, ...(options.middleware ?? [])];
        for (const step of chain)
          if (methods === "ALL") hono.all(path, step);
          else hono.on([...methods], path, step);
        if (methods === "ALL")
          hono.all(path, (context) => finish(context, null));
        else hono.on([...methods], path, (context) => finish(context, null));
      },
    });
    return this;
  }
}

/** Start a declared route table. */
export function routes<E extends Env>(): Routes<E> {
  return new Routes<E>(mint);
}

/** A table's declarations, read from its record and its included records. */
function declarationsOf<E extends Env>(
  table: Routes<E>,
): readonly RouteDeclaration[] {
  return recordOf(table).entries.flatMap((entry) =>
    entry.kind === "route" ? [entry.declaration] : declarationsOf(entry.table),
  );
}

/** What a header hook may read of a finished response: never its body or request. */
export type ResponseView = Readonly<{
  status: number;
  /** A copy: changing it changes nothing served. */
  headers: Headers;
}>;

/** One header hook: the headers to add to a finished response, if any. */
export type ResponseHeaders = (
  response: ResponseView,
) => Readonly<Record<string, string>> | null;

/** How the host table is served beyond its principal and ports. */
export type HostServeOptions = Readonly<{
  /**
   * Headers to add to every finished response (never an upgraded socket).
   * Each hook sees only a read-only view of the response the route answered
   * with, after its requirement decided, and can only add headers.
   */
  headers?: readonly ResponseHeaders[];
  /** Record Server-Timing through Hono's own `timing` middleware. */
  serverTiming?: Readonly<{ totalDescription: string }>;
}>;

/** What `serveTable` needs; never built from caller-supplied fields. */
type ServeRules = Readonly<{
  headers: readonly ResponseHeaders[];
  serverTiming: Readonly<{ totalDescription: string }> | null;
  mediated: (request: Request) => boolean;
}>;

/** The page bridge names the installation an App call comes from. */
const bridged = (request: Request) =>
  request.headers.has("X-Oyster-Installation");

/**
 * Serve one table: the only `Hono` the Oyster host builds. Each route runs
 * its requirement first, then its middleware, then its handler. Nothing a
 * caller supplies runs before a route's requirement: timing is Hono's own
 * middleware, and header hooks run on the finished response.
 */
function serveTable<E extends Env>(
  table: Routes<E>,
  principal: PrincipalSource<E>,
  ports: AuthorityPorts,
  rules: ServeRules,
): Hono<E> {
  const { entries, errorHandler } = recordOf(table);
  const hono = new Hono<E>();
  if (rules.serverTiming !== null) {
    const { totalDescription } = rules.serverTiming;
    hono.use(
      timing({
        totalDescription,
        enabled: (context) => context.res.status !== 101,
      }),
    );
  }
  const hooks = rules.headers;
  hono.use(async (context, next) => {
    await next();
    const response = context.res;
    // An upgraded socket keeps the runtime's own response.
    if (response.status === 101) return;
    const headers = new Headers(response.headers);
    for (const hook of hooks) {
      const added = hook({
        status: response.status,
        headers: new Headers(response.headers),
      });
      if (added !== null)
        for (const [name, value] of Object.entries(added))
          headers.set(name, value);
    }
    // A fresh response with mutable headers, the route's status and body.
    context.res = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
  for (const entry of entries)
    if (entry.kind === "table")
      hono.route(
        "/",
        serveTable(entry.table, principal, ports, {
          headers: [],
          serverTiming: null,
          mediated: rules.mediated,
        }),
      );
    else entry.mount(hono, principal, ports, rules.mediated);
  const handler = errorHandler();
  if (handler !== undefined) hono.onError(handler);
  return hono;
}

/** A served table: it answers requests and names what it serves, and is never a router. */
export type ServedTable<E extends Env> = Readonly<{
  /** Answer one request. */
  fetch: (...request: Parameters<Hono<E>["fetch"]>) => Promise<Response>;
  /** Answer one request built from a path or URL (tests and composition). */
  request: (...request: Parameters<Hono<E>["request"]>) => Promise<Response>;
  /** Every path the router answers, for the law test. */
  servedPaths: () => readonly string[];
}>;

function servedView<E extends Env>(hono: Hono<E>): ServedTable<E> {
  return Object.freeze({
    fetch: async (...request: Parameters<Hono<E>["fetch"]>) =>
      hono.fetch(...request),
    request: async (...request: Parameters<Hono<E>["request"]>) =>
      hono.request(...request),
    servedPaths: () => hono.routes.map((route) => route.path),
  });
}

const hostServeOptionNames = new Set<PropertyKey>(["headers", "serverTiming"]);

/**
 * Serve a tenant host's table: the composition root (`oysterRouteTable`)
 * supplies how a request authenticates. An option this function does not
 * know is refused rather than ignored.
 */
export function serveHost<E extends Env>(
  table: Routes<E>,
  authenticate: (request: Request) => Promise<OysterAuthResult>,
  ports: AuthorityPorts,
  options: HostServeOptions = {},
): ServedTable<E> {
  for (const name of Reflect.ownKeys(options))
    if (!hostServeOptionNames.has(name))
      throw new Error(`serveHost has no option ${String(name)}`);
  return servedView(
    serveTable(table, (context) => authenticate(context.req.raw), ports, {
      headers: Object.hasOwn(options, "headers") ? (options.headers ?? []) : [],
      serverTiming: Object.hasOwn(options, "serverTiming")
        ? (options.serverTiming ?? null)
        : null,
      mediated: bridged,
    }),
  );
}

/**
 * Serve a table of doors and public routes only (a Worker's top-level
 * dispatch, before any tenant is selected): a route that needs an Oyster
 * principal is refused, never admitted.
 */
export function serveDoors<E extends Env>(table: Routes<E>): ServedTable<E> {
  return servedView(
    serveTable(
      table,
      () => Promise.resolve({ kind: "refused", status: 401 }),
      { liveKey: () => Promise.resolve(null), appToolPolicy: () => null },
      { headers: [], serverTiming: null, mediated: bridged },
    ),
  );
}

/**
 * Serve one capability's declared table under the host dispatcher's
 * admission, read from `c.env`: the App already holds the capability, and
 * each route still decides its own resource. Every request here is
 * App-mediated, however it was admitted (a header or a browser socket's
 * query), so `owner("direct")` always refuses inside a capability.
 */
export function serveCapability(
  table: Routes<CapabilityEnv>,
  ports: AuthorityPorts,
): ServedTable<CapabilityEnv> {
  return servedView(
    serveTable(
      table,
      (context) =>
        Promise.resolve({ kind: "admitted", principal: context.env.principal }),
      ports,
      { headers: [], serverTiming: null, mediated: () => true },
    ),
  );
}
