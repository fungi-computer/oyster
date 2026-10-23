import { z } from "zod";
import {
  describeModule,
  invokeModuleOperation,
} from "@fungi.computer/mycelium/remote";
import {
  PendingApprovalSchema,
  ApprovalRefusalSchema,
} from "@fungi.computer/approvals";
import { jsonSchemaToZod } from "@fungi.computer/forage";
import { admits } from "./apps/gate.js";
import {
  createMcpWorkflowControl,
  WORKFLOW_CONTROL_MODULE_ID,
} from "./workflows.js";
import { causeClass } from "./cause-class.js";
import { deriveDeclaredOperations } from "./apps/operations.js";
import { appToolPolicySchema, type AppToolPolicy } from "./apps/tools.js";
import { emptyAppDeclaration } from "@fungi.computer/puffball/app";
import type { DeclaredOperations, Installation } from "./apps/installation.js";
import {
  admittedMethodCallerFacts,
  invocationCallerContext,
} from "./invocation.js";
import { guestLimits } from "./guest-policy.js";
import {
  Mycelium,
  type CapabilitySource,
  type Grants,
  type ModuleRegistration,
} from "@fungi.computer/mycelium";
import { appToolSchemas, appToolFamilySchemas } from "@fungi.computer/forage";
import { Knapsack } from "@fungi.computer/knapsack";
import * as Schema from "effect/Schema";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import type { OysterHost, OysterPrincipal, OysterJson } from "./host.js";
import { keyAppAccess } from "./keys.js";
import type {
  McpPrincipal,
  McpCatalogSnapshot,
} from "@fungi.computer/mycelium/mcp";
import {
  defaultAssetPolicy,
  sha256,
  verifyRelease,
  type VerifiedRelease,
} from "./release.js";

/** Mints the requestId a tool family tool sends on the caller's behalf to its
 * declared `call` method: each MCP call is its own independent run, never a
 * replay the caller controls. */
const toolFamilyCallIds = defineIdFamily({
  family: "oyster-tool-family-call",
  version: 1,
  kinds: { call: { prefix: "call" } },
});

/** An installation ID as a guest binding name: `spawn-git` becomes `SPAWN_GIT`. */
export function appBindingName(installationId: string): string {
  return installationId.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
}

/** Why an App method call from the MCP catalog was refused. */
export class AppMethodRefused extends Error {
  override readonly name = "AppMethodRefused";
  /** `detail` is the App's own caller-facing refusal message, when it gave one. */
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(
      detail === undefined
        ? `App method refused: ${code}`
        : `App method refused: ${code}: ${detail}`,
    );
  }
}

/**
 * The App-tool access one caller's catalog capture used, re-checked at call
 * time against a fresh read. An Agent's policy is one blanket level for
 * every installation (`host.appToolPolicy`); a key's is its own grants,
 * resolved per installation (`keyAppAccess`) -- an installation the key has
 * no grant for is captured as absent, never merely refused, so it is never
 * listed at all.
 */
export type OysterCallerAccess =
  | Readonly<{ kind: "agent"; policy: AppToolPolicy }>
  | Readonly<{
      kind: "key";
      keyId: string;
      byInstallation: ReadonlyMap<string, AppToolPolicy>;
    }>
  | null;

function capturedAccessFor(
  access: OysterCallerAccess,
  installationId: string,
): AppToolPolicy | null {
  if (access === null) return null;
  return access.kind === "agent"
    ? access.policy
    : (access.byInstallation.get(installationId) ?? null);
}

/** Re-read one actor's current App-tool access for one installation, fresh. */
async function freshAccessFor(
  host: Pick<OysterHost, "appToolPolicy" | "keys">,
  actor: Extract<OysterPrincipal["actor"], { kind: "agent" | "team-key" }>,
  installationId: string,
): Promise<AppToolPolicy | null> {
  if (actor.kind === "agent")
    return (await host.appToolPolicy?.(actor)) ?? null;
  const key = (await host.keys?.live(actor.keyId)) ?? null;
  return key === null ? null : keyAppAccess(key, installationId);
}

/** What one Release contributes to every MCP catalog: its verified build,
 * its declared operations and its compiled tool schemas. */
export type ReleaseSurface = Readonly<{
  release: VerifiedRelease;
  api: NonNullable<VerifiedRelease["api"]>;
  declaredOperations: DeclaredOperations;
  toolSchemas: ReturnType<typeof appToolSchemas>;
}>;

/**
 * Per-host memo of each installed Release's catalog surface. A Release's
 * artifacts are immutable and content-addressed, so verifying the build,
 * deriving its operations and compiling its tool schemas happens once per
 * Release ID and artifact digest, not on every catalog capture: an MCP call
 * captures the catalog several times (refresh, session acquire, the pre-call
 * authority check), and redoing this for every installed App on each one
 * exhausted a Durable Object's CPU and memory. Only Release-derived facts are
 * cached; installation authority, caller access and tool-family listings
 * are still read fresh on every capture. A failed build is not cached.
 */
export type AppSurfaceCache = (
  release: Installation["release"],
) => Promise<ReleaseSurface | null>;

/** Make one {@link AppSurfaceCache} for a host whose artifact store and capabilities stay fixed. */
export function appSurfaceCache(
  host: Pick<OysterHost, "artifacts" | "capabilities">,
): AppSurfaceCache {
  const surfaces = new Map<string, Promise<ReleaseSurface | null>>();
  const build = async (
    installed: Installation["release"],
  ): Promise<ReleaseSurface | null> => {
    const release = await verifyRelease(
      host.artifacts,
      installed,
      defaultAssetPolicy,
      false,
    );
    if (release.api === null) return null;
    return {
      release,
      api: release.api,
      declaredOperations: await deriveDeclaredOperations(
        installed,
        release.declaration ?? emptyAppDeclaration,
        host.capabilities ?? [],
      ),
      toolSchemas: appToolSchemas(release.api),
    };
  };
  return (installed) => {
    const key = `${installed.releaseId}:${installed.artifact.artifactDigest}`;
    let entry = surfaces.get(key);
    if (entry === undefined) {
      entry = build(installed).catch((cause: unknown) => {
        surfaces.delete(key);
        throw cause;
      });
      surfaces.set(key, entry);
    }
    return entry;
  };
}

/** Derive the current principal's admitted App modules and grants. */
export async function oysterAppSnapshot(
  host: Pick<
    OysterHost,
    | "installations"
    | "instances"
    | "artifacts"
    | "guestLimits"
    | "backgroundOriginKey"
    | "computerId"
    | "capabilities"
    | "appToolPolicy"
    | "keys"
  >,
  surfaces: AppSurfaceCache,
  principal: OysterPrincipal,
  installations: readonly Installation[],
  access: OysterCallerAccess,
  sessionId?: string,
  /** Shares one tool-family listing per Instance across the two
   * `appModules` passes one `oysterAppMethods` call can make (the eager
   * grants/version pass, and a session-scoped re-derivation); never shared
   * across separate calls, so it never serves another request's listing. */
  familyListingCache = new Map<string, unknown>(),
): Promise<
  Readonly<{
    modules: Readonly<Record<string, ModuleRegistration>>;
    levels: Readonly<Record<string, AppToolPolicy["level"]>>;
    fences: Readonly<Record<string, string>>;
    effects: Readonly<
      Record<string, Readonly<Record<string, "read" | "write" | "external">>>
    >;
  }>
> {
  const limits = guestLimits(host.guestLimits);
  const generation = await host.installations.generation();
  const caller = invocationCallerContext(principal, host.computerId ?? null);
  const { actor } = principal;
  const visitor = actor.kind === "visitor";
  const modules: Record<string, ModuleRegistration> = {};
  const levels: Record<string, AppToolPolicy["level"]> = {};
  const fences: Record<string, string> = {};
  const effects: Record<
    string,
    Record<string, "read" | "write" | "external">
  > = {};
  for (const installation of installations) {
    if (installation.status !== "enabled" || installation.instanceId === null)
      continue;
    if (visitor && installation.visibility !== "public") continue;
    const captured = capturedAccessFor(access, installation.installationId);
    // A key that holds no grant for this installation never sees it listed
    // at all. An Agent's one blanket policy either covers every
    // installation or none, so this never hides one from an Agent; an
    // unapproved Agent still sees the list, refused at call time, as today.
    if (access?.kind === "key" && captured === null) continue;
    const surface = await surfaces(installation.release);
    if (surface === null) continue;
    const { release, api, declaredOperations, toolSchemas } = surface;
    const instanceId = installation.instanceId;
    const declaration = release.declaration ?? emptyAppDeclaration;
    const id = `oyster-app:${installation.installationId}`;
    // A member/owner/visitor, or an Agent/key with no captured access,
    // defaults to "write" here exactly as every module always did before:
    // the deeper gate (`admits`), not this coarse Mycelium-level grant, is
    // what actually enforces visitor/role ceilings. Only a captured
    // Agent/key access with its own level narrows this.
    levels[id] = captured?.level ?? "write";
    // Shared by every operation this installation exposes (ordinary methods
    // and, below, a tool family's dynamic per-row tools): the same staleness
    // check, the same owner-approved policy check, the same `admits` gate and
    // the same Instance call. A tool family tool is sugar over this same
    // admitted call to its declared `call` method; it gets no separate check.
    const callAppMethod = async (
      name: string,
      effect: "read" | "write" | "external",
      input: unknown,
      signal?: AbortSignal,
    ): Promise<OysterJson> => {
      signal?.throwIfAborted();
      const currentInstallation = await host.installations.get(
        installation.installationId,
      );
      signal?.throwIfAborted();
      if (
        currentInstallation?.status !== "enabled" ||
        currentInstallation.instanceId !== instanceId ||
        currentInstallation.authority.authorityVersion !==
          installation.authority.authorityVersion ||
        currentInstallation.release.releaseId !==
          installation.release.releaseId ||
        currentInstallation.release.artifact.artifactDigest !==
          installation.release.artifact.artifactDigest
      )
        throw new AppMethodRefused("stale_authority");
      if (actor.kind === "agent" || actor.kind === "team-key") {
        const fresh = Schema.decodeUnknownOption(appToolPolicySchema, {
          onExcessProperty: "error",
        })(await freshAccessFor(host, actor, installation.installationId));
        const capturedParsed = Schema.decodeUnknownOption(appToolPolicySchema, {
          onExcessProperty: "error",
        })(captured);
        // A call never pre-approved in the first place (no captured
        // policy) is `not_approved`; one that WAS approved but whose
        // authority has since changed or vanished entirely -- a key
        // revoked or expired after capture, say -- is `stale_authority`,
        // just like the other authority drift below. Only the absence
        // of a captured policy gets the former code.
        if (capturedParsed._tag === "None")
          throw new AppMethodRefused("not_approved");
        if (
          fresh._tag === "None" ||
          fresh.value.revision !== capturedParsed.value.revision ||
          fresh.value.grantedBy !== capturedParsed.value.grantedBy ||
          fresh.value.level !== capturedParsed.value.level
        )
          throw new AppMethodRefused("stale_authority");
      }
      signal?.throwIfAborted();
      const json = Schema.decodeUnknownSync(Schema.Json)(input);
      const decision = admits(
        {
          installation: {
            status: installation.status,
            visibility: installation.visibility,
            instanceId: installation.instanceId,
            authority: installation.authority,
            artifactDigest: installation.release.artifact.artifactDigest,
          },
          declaration,
          declaredOperations,
          api,
          principal: {
            actor,
            role: "role" in principal ? principal.role : null,
          },
          access:
            captured === null
              ? null
              : {
                  level: captured.level,
                  revision: captured.revision,
                  grantedBy: captured.grantedBy,
                  bindingName: appBindingName(installation.installationId),
                },
        },
        { kind: "method", name, input: json, via: "mcp" },
      );
      if (decision.kind === "refused")
        throw new AppMethodRefused(decision.code);
      const result = await host.instances.get(instanceId, limits).call(
        await admittedMethodCallerFacts(
          host,
          installation,
          release,
          caller,
          decision.grants,
          { name, effect },
          [],
          sessionId,
          actor.kind === "agent" && captured !== null
            ? {
                policyRevision: captured.revision,
                grantorMemberId: captured.grantedBy,
              }
            : undefined,
        ),
        api,
        name,
        json,
      );
      if (!result.ok) throw new AppMethodRefused(result.code);
      if (result.value.kind === "refused")
        throw new AppMethodRefused(result.value.code, result.value.message);
      return result.value.value;
    };
    const operationEffects: Record<string, "read" | "write" | "external"> = {};
    effects[id] = operationEffects;
    let familyFacts: OysterJson | null = null;
    const toolOperations = Object.entries(toolSchemas)
      .filter(([, method]) => !visitor || method.effect === "read")
      .map(([name, method]) => {
        operationEffects[name] = method.effect;
        const appMethod = Mycelium.operation({
          replay: "unsafe",
          access: method.effect === "read" ? "read" : "write",
          description: `${method.description}\nEffect: ${method.effect}.`,
          input: method.input,
          output: method.output,
          execute: async (input, context) => {
            const value = await callAppMethod(
              name,
              method.effect,
              input,
              context.signal,
            );
            return method.output.parse(value);
          },
        });
        return [name, appMethod] as const;
      });
    // A tool family publishes a dynamic, signed set of typed tools from one
    // App (e.g. each published Workflow becomes its own tool). forage decodes
    // that listing and compiles its schemas; it supplies no admission or
    // invocation arguments by design, so the host supplies both here, reusing
    // the exact same `callAppMethod` gate as every other method on this App.
    // A visitor who cannot see non-read ordinary methods cannot see these
    // either; a caller the App itself refuses to list for (stale authority,
    // an unapproved App-tool policy, a missing capability grant) sees none.
    const family = api.toolFamily;
    const familyOperations =
      family === undefined ||
      (visitor && api.methods[family.call]?.effect !== "read")
        ? []
        : await (async () => {
            try {
              let listing = familyListingCache.get(instanceId);
              if (listing === undefined) {
                listing = await callAppMethod(family.list, "read", {});
                familyListingCache.set(instanceId, listing);
              }
              const compiled = appToolFamilySchemas(api, listing);
              if (compiled === null) return [];
              familyFacts = Schema.decodeUnknownSync(Schema.Json)(listing);
              return compiled.tools.map((tool) => {
                operationEffects[compiled.name + "." + tool.row.tool] =
                  compiled.effect;
                const operation = Mycelium.operation({
                  replay: "unsafe",
                  access: compiled.effect === "read" ? "read" : "write",
                  description: `${tool.description}\nEffect: ${compiled.effect}.`,
                  input: tool.input,
                  output: tool.output,
                  execute: async (input, context) => {
                    // The declaring App owns every field below except
                    // `requestId` (this call's own identity) and `input`
                    // (the caller's tool-shaped payload): `tool.row.call` is
                    // opaque data this host never reads into or defaults.
                    // `requestId` is last: a row whose own `call` data named
                    // that key would otherwise replay the same run forever.
                    const value = await callAppMethod(
                      compiled.call,
                      compiled.effect,
                      {
                        ...tool.row.call,
                        input,
                        requestId: toolFamilyCallIds.call.generate(),
                      },
                      context.signal,
                    );
                    return tool.output.parse(value);
                  },
                });
                return [
                  `${compiled.name}.${tool.row.tool}`,
                  operation,
                ] as const;
              });
            } catch (error) {
              // One App's bad listing -- a refused or throwing Instance
              // call, or a reply forage's signed-listing codec rejects --
              // withholds only this App's family tools. Every other App's
              // ordinary and family operations are built independently and
              // stay unaffected; the whole catalog build never aborts for it.
              // An ordinary closed refusal (the same gate any App method
              // already produces) stays quiet; anything else is reported
              // exactly like any other AppInstance failure.
              if (
                !(error instanceof AppMethodRefused) ||
                error.code === "failed"
              )
                console.error("AppInstance failure", {
                  stage: "tool_family_listing",
                  installationId: installation.installationId,
                  causeClass:
                    error instanceof AppMethodRefused
                      ? "Refused"
                      : causeClass(error),
                });
              return [];
            }
          })();
    fences[id] = await sha256(
      new TextEncoder().encode(
        JSON.stringify({
          installation,
          generation,
          principal,
          access: captured,
          api,
          family: familyFacts,
          computerId: host.computerId ?? null,
        }),
      ),
    );
    modules[id] = Mycelium.module({
      id,
      name: appBindingName(installation.installationId),
      description:
        release.declaration?.displayName ?? installation.installationId,
      operations: Object.fromEntries([...toolOperations, ...familyOperations]),
    });
  }
  return { modules, levels, fences, effects };
}

/** `OysterCallerAccess`, with any `Map` turned into a sorted, JSON-stable array of entries: `JSON.stringify` on a `Map` itself silently drops its contents, which would collapse every key's version hash to one. */
type SerializableCallerAccess =
  | OysterCallerAccess
  | Readonly<{
      kind: "key";
      keyId: string;
      byInstallation: readonly (readonly [string, AppToolPolicy])[];
    }>;

function serializableAccess(
  access: OysterCallerAccess,
): SerializableCallerAccess {
  return access === null || access.kind === "agent"
    ? access
    : {
        kind: access.kind,
        keyId: access.keyId,
        byInstallation: [...access.byInstallation.entries()].sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      };
}

/**
 * Capture installed App methods for MCP or agents as one principal-scoped source.
 * Enabled installations become `env.<APP>` modules using the Instance call path; a dotted method such as `repos.list` is `env.<APP>.repos.list()`.
 * Visitors see only public read methods; owners see every discoverable
 * method. A key sees only the installations its own grants admit, each at
 * the level (`read`/`write`) those grants give it; Mycelium itself refuses a
 * write call up front when the module's own grant is `read`
 * (`mycelium/src/access.ts`). Call again to capture changes to Releases,
 * installation authority or the caller's own grants.
 */
export async function oysterAppMethods(
  host: Pick<
    OysterHost,
    | "installations"
    | "instances"
    | "artifacts"
    | "guestLimits"
    | "backgroundOriginKey"
    | "computerId"
    | "capabilities"
    | "appToolPolicy"
    | "keys"
    | "approvals"
  >,
  principal: OysterPrincipal,
  access: OysterCallerAccess,
  surfaces: AppSurfaceCache,
  preloadedInstallations?: readonly Installation[],
): Promise<CapabilitySource & { readonly grants: Grants }> {
  const installations =
    preloadedInstallations ?? (await host.installations.list());
  // Shared so a session-scoped re-derivation below reuses this call's tool-
  // family listings instead of asking each Instance for them twice.
  const familyListingCache = new Map<string, unknown>();
  const initial = await oysterAppSnapshot(
    host,
    surfaces,
    principal,
    installations,
    access,
    undefined,
    familyListingCache,
  );
  const modules = admittedAppModules(host, principal, initial, null);
  const version = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        access: serializableAccess(access),
        installations: [...installations]
          .sort((a, b) => a.installationId.localeCompare(b.installationId))
          .map((installation) => [
            installation.installationId,
            installation.instanceId,
            installation.release.releaseId,
            installation.release.artifact.artifactDigest,
            installation.authority.authorityVersion,
            installation.status,
            installation.visibility,
          ]),
      }),
    ),
  );
  return {
    id: "oyster-apps",
    grants: initial.levels,
    acquire: async ({ signal, session }) => {
      signal.throwIfAborted();
      const acquiredModules =
        session === undefined
          ? modules
          : admittedAppModules(
              host,
              principal,
              await oysterAppSnapshot(
                host,
                surfaces,
                principal,
                installations,
                access,
                session.sessionId,
                familyListingCache,
              ),
              session.sessionId,
            );
      signal.throwIfAborted();
      return {
        snapshot: { version, modules: acquiredModules },
        release: () => Promise.resolve(),
      };
    },
  };
}

/**
 * Capture the host's fixed Computer for one caller as a Knapsack source.
 * The host decides whether the caller holds Computer access; the Computer
 * owner accepts every call. Null when the host has no Computer or the caller
 * has no access. Grants name exactly the one captured module.
 */
export async function oysterComputerTools(
  host: Pick<OysterHost, "computerId" | "computer">,
  principal: OysterPrincipal,
): Promise<(CapabilitySource & { readonly grants: Grants }) | null> {
  if (host.computerId === undefined || host.computer === undefined) return null;
  const computer = await host.computer(principal);
  if (computer === null) return null;
  const id = `computer:${host.computerId}`;
  return {
    ...Knapsack.computer({
      id,
      name: "workspace",
      namespace: ["computers"],
      computer,
    }),
    grants: { [id]: "write" },
  };
}

/**
 * Load the current catalog for an authenticated owner or key: installed App
 * methods, plus the host's Computer when the caller holds Computer access.
 * A key sees exactly the installations and levels its own grants admit, and
 * the Computer only with its own `computer.use` grant; each App retains its
 * own caller checks regardless. The owner's stored write approval of an
 * Agent's App tools is that principal's confirmation for App writes, so a
 * headless client can write; the shared MCP server asks the client to
 * approve every other write (an owner's own calls, the Computer). Each call
 * still re-admits the key, rechecks that same stored approval, and passes
 * the App's gate.
 */
export function oysterMcpCatalogLoad(
  host: Pick<
    OysterHost,
    | "installations"
    | "instances"
    | "artifacts"
    | "guestLimits"
    | "backgroundOriginKey"
    | "computerId"
    | "computer"
    | "capabilities"
    | "appToolPolicy"
    | "keys"
    | "workflows"
  >,
): (principal: McpPrincipal) => Promise<McpCatalogSnapshot> {
  const surfaces = appSurfaceCache(host);
  return async (principal) => {
    const { actor } = principal;
    // One read of the installation list serves both a key's grant check
    // below and oysterAppMethods' own capture, instead of two.
    const installations = await host.installations.list();
    let access: OysterCallerAccess = null;
    if (actor.kind === "agent") {
      const policy = (await host.appToolPolicy?.(actor)) ?? null;
      access = policy === null ? null : { kind: "agent", policy };
    } else if (actor.kind === "team-key") {
      // Always a "key" access, even an empty one for an unknown, revoked,
      // expired or suspended key: that keeps every installation invisible
      // (via appModules' own `access?.kind === "key"` check) rather than
      // falling through to the member/owner default of "write" below.
      const key = (await host.keys?.live(actor.keyId)) ?? null;
      const byInstallation = new Map<string, AppToolPolicy>();
      if (key !== null)
        for (const installation of installations) {
          const level = keyAppAccess(key, installation.installationId);
          if (level !== null)
            byInstallation.set(installation.installationId, level);
        }
      access = { kind: "key", keyId: actor.keyId, byInstallation };
    }
    const apps = await oysterAppMethods(
      host,
      principal,
      access,
      surfaces,
      installations,
    );
    const computer = await oysterComputerTools(host, principal);
    const control = await host.workflows?.(principal);
    const workflowSources: CapabilitySource[] =
      control == null
        ? []
        : [
            {
              id: "oyster-workflows",
              acquire: () =>
                Promise.resolve({
                  snapshot: {
                    version: WORKFLOW_CONTROL_MODULE_ID,
                    modules: [createMcpWorkflowControl(control).module],
                  },
                  release: () => Promise.resolve(),
                }),
            },
          ];
    const workflowGrants: Grants =
      control == null ? {} : { [WORKFLOW_CONTROL_MODULE_ID]: "write" };
    if (computer === null)
      return {
        instructions:
          "Installed Apps on this Oyster. Each App is env.<APP>; dotted method names are nested properties, e.g. env.BONSAI.repos.list({}). Use forage.search / forage.describe to find methods.",
        grants: { ...apps.grants, ...workflowGrants },
        sources: [apps, ...workflowSources],
      };
    return {
      instructions:
        'Installed Apps and this Oyster\'s Computer. Each App is env.<APP>; dotted method names are nested properties, e.g. env.BONSAI.repos.list({}). The Computer is env.computers.workspace, e.g. env.computers.workspace.exec({command: "ls"}). Use forage.search / forage.describe to find methods.',
      grants: { ...apps.grants, ...computer.grants, ...workflowGrants },
      sources: [apps, computer, ...workflowSources],
    };
  };
}
/** Exact authoring metadata: an absent source description stays omitted. */
type NativeDescriptionMetadata = { description?: string };

function admittedAppModules(
  host: Pick<OysterHost, "approvals">,
  principal: OysterPrincipal,
  snapshot: Awaited<ReturnType<typeof oysterAppSnapshot>>,
  sessionId: string | null,
) {
  return Object.entries(snapshot.modules).map(([id, raw]) => {
    const { description: moduleDescription, ...descriptor } =
      describeModule(raw);
    const installationId = id.slice("oyster-app:".length);
    const moduleMetadata: NativeDescriptionMetadata = {};
    if (moduleDescription !== undefined)
      moduleMetadata.description = moduleDescription;
    return Mycelium.module({
      ...descriptor,
      ...moduleMetadata,
      id,
      name: appBindingName(installationId),
      operations: Object.fromEntries(
        Object.entries(descriptor.operations).map(([path, rawOperation]) => {
          const { description: operationDescription, ...operation } =
            rawOperation;
          const effect = snapshot.effects[id]?.[path];
          const fence = snapshot.fences[id];
          if (effect === undefined || fence === undefined)
            throw new Error("App snapshot has no operation authority facts");
          const declaredOutput = operation.output ?? true;
          // Decode each document at its own root before composing: a nested
          // JSON Schema document's root-relative $refs would otherwise escape.
          const declared = jsonSchemaToZod(declaredOutput);
          const output =
            effect === "read"
              ? declared
              : z.union([
                  declared,
                  jsonSchemaToZod(
                    Schema.toStandardJSONSchemaV1(PendingApprovalSchema)[
                      "~standard"
                    ].jsonSchema.output({ target: "draft-2020-12" }),
                  ),
                  jsonSchemaToZod(
                    Schema.toStandardJSONSchemaV1(ApprovalRefusalSchema)[
                      "~standard"
                    ].jsonSchema.output({ target: "draft-2020-12" }),
                  ),
                ]);
          const outputValidator = z.intersection(output, z.json());
          const operationMetadata: NativeDescriptionMetadata = {};
          if (operationDescription !== undefined)
            operationMetadata.description = operationDescription;
          // App methods are never replayed by the host: a write goes through
          // its approval record, and even a read may have App-side effects.
          const appOperation = Mycelium.operation({
            ...operation,
            ...operationMetadata,
            replay: "unsafe",
            access: effect === "read" ? "read" : "write",
            input: z.intersection(jsonSchemaToZod(operation.input), z.json()),
            output: {
              "~standard": {
                ...outputValidator["~standard"],
                // As appMethodSchemas does, describe the JSON contract
                // without nesting another redundant recursive JSON guard.
                jsonSchema: output["~standard"].jsonSchema,
              },
            },
            execute: async (input, context) => {
              if (effect === "read")
                return z
                  .json()
                  .parse(
                    await invokeModuleOperation(raw, path, input, context),
                  );
              if (principal.actor.kind === "visitor")
                return { kind: "refused", reason: "not-granted" };
              if (host.approvals === undefined)
                return { kind: "refused", reason: "not-granted" };
              // Mycelium numbers each operation call within one execute and
              // replays the same sequence; a direct call is its own execution.
              const ordinal = context.operationOrdinal ?? 0;
              const result = await host.approvals.submit({
                actor: principal.actor,
                installationId,
                sessionId,
                operation: path,
                access: effect,
                authorityFence: fence,
                idempotencyKey: await sha256(
                  new TextEncoder().encode(
                    JSON.stringify([
                      context.executionId,
                      context.toolCallId,
                      ordinal,
                    ]),
                  ),
                ),
                input,
              });
              return z
                .json()
                .parse(result.kind === "applied" ? result.output : result);
            },
          });
          return [path, appOperation];
        }),
      ),
    });
  });
}
