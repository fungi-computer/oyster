import { z } from "zod";
import { computerSizeSchema } from "@fungi.computer/computer/backing";
import { ApprovalRefusalSchema } from "@fungi.computer/approvals";
import { oysterApprovalDeadlineAt } from "./approval-deadline.js";
import { admits } from "./apps/gate.js";
import {
  createMcpWorkflowControl,
  WORKFLOW_CONTROL_MODULE_ID,
} from "./workflows.js";
import { causeClass } from "./cause-class.js";
import { deriveDeclaredOperations } from "./apps/operations.js";
import { appToolPolicySchema, type AppToolPolicy } from "./apps/tools.js";
import {
  isAgentExtensionApi,
  isAgentExtensionWireMethod,
} from "@fungi.computer/agar/backend-definition";
import { emptyAppDeclaration } from "@fungi.computer/puffball/app";
import type { DeclaredOperations, Installation } from "./apps/installation.js";
import {
  admittedMethodCallerFacts,
  invocationCallerContext,
} from "./invocation.js";
import { guestLimits } from "./guest-policy.js";
import {
  BadResponse,
  Mycelium,
  type CapabilitySource,
  type Grants,
  type ModuleRegistration,
  type MyceliumJsonValue,
} from "@fungi.computer/mycelium";
import { appJsonSchema, appToolFamilySchemas } from "@fungi.computer/forage";
import { forageDiscoveryInstructions } from "@fungi.computer/mycelium/effect";
import { Knapsack } from "@fungi.computer/knapsack";
import * as Schema from "effect/Schema";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import {
  computerCreateRequestSchema,
  computerPageSchema,
} from "@fungi.computer/computer/fleet/inventory-wire";
import {
  computerBackendViewSchema,
  localBackendAttachSchema,
  localBackendDetachSchema,
} from "@fungi.computer/computer/fleet/wire";
import { computerStateSchema } from "@fungi.computer/computer/fleet/wire";
import { teamComputerDirectorySchema } from "@fungi.computer/nacre/workbench";
import type { InvocationContext } from "@fungi.computer/mycelium";
import type { ComputerControlPort } from "./computer-control-port.js";
export type { ComputerControlPort } from "./computer-control-port.js";
import type { OysterHost, OysterJson } from "./host.js";
import {
  appToolAccess,
  authorityOf,
  hostAuthorityPorts,
} from "./authorization.js";
import type { TenantPrincipal } from "./tenant.js";

import {
  defaultAssetPolicy,
  sha256,
  verifyRelease,
  type VerifiedRelease,
} from "./release.js";

/** Captured capabilities and grants offered to one admitted MCP caller. */
export type OysterMcpCatalogSnapshot = Readonly<{
  instructions: string;
  sources: readonly CapabilitySource[];
  /** An omitted module has no grant. */
  grants: Grants;
}>;

/** Shared host result guidance for Agent and MCP instructions, not per method. */
export const appApprovalInstructions = [
  "A write (including Effect: external) may instead return AppApprovalResult:",
  "type AppApprovalResult =",
  '  | { kind: "denied"; by: string; note?: string; message: string }',
  '  | { kind: "refused"; reason: string; denialNote?: string };',
  "A write needing approval waits in this call. Approval returns its output; denial or expiry returns here, never as a Session message.",
].join("\n");

const fleetIds = defineIdFamily({
  family: "mcp-computer-control",
  version: 1,
  kinds: { request: { prefix: "computer_request" } },
});
const fleetComputerId = z.strictObject({
  computerId: z.string().min(1).max(256),
});
/**
 * `reason: true` asks for a failed start's plain-words reason. Callers that
 * never ask get the state shape every released client decodes strictly.
 */
const fleetStateRead = z.strictObject({
  computerId: z.string().min(1).max(256),
  reason: z.literal(true).exactOptional(),
});
const fleetCreate = z.strictObject({
  name: computerCreateRequestSchema.shape.name
    .unwrap()
    .nullable()
    .default(null),
  size: computerCreateRequestSchema.shape.size
    .unwrap()
    .nullable()
    .default(null),
  requestId: computerCreateRequestSchema.shape.requestId
    .nullable()
    .default(null),
});
const fleetComputer = z.strictObject({
  computerId: z.string(),
  name: z.string(),
  size: computerSizeSchema,
});
const fleetBackends = z.strictObject({
  backends: z.array(computerBackendViewSchema),
});
const fleetAttachInput = z.strictObject({
  computerId: localBackendAttachSchema.shape.computerId,
  publicKey: localBackendAttachSchema.shape.publicKey,
  hostLabel: localBackendAttachSchema.shape.hostLabel,
  folderLabel: localBackendAttachSchema.shape.folderLabel,
  requestId: localBackendAttachSchema.shape.requestId.nullable().default(null),
});
const fleetAttachment = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("attached"),
    requestId: z.string(),
    backendId: z.string(),
  }),
  z.strictObject({
    kind: z.enum(["uncertain", "denied", "conflict", "invalid"]),
    requestId: z.string(),
  }),
]);
const fleetDetachment = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("detached"), detached: z.boolean() }),
  z.strictObject({ kind: z.enum(["denied", "uncertain", "invalid"]) }),
]);
const fleetStop = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stopped") }),
  z.strictObject({ kind: z.enum(["denied", "busy", "uncertain"]) }),
]);
const fleetDelete = z.strictObject({
  computerId: fleetComputerId.shape.computerId,
  confirmHandle: z.string().min(1).max(256),
});
const fleetDeletion = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("deleted") }),
  z.strictObject({
    kind: z.enum(["denied", "mismatch", "unsupported", "uncertain"]),
  }),
]);
/** Directory pages read to find one Computer's name; a Team never has more. */
const maximumDirectoryPages = 20;
const fleetCreation = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("created"),
    requestId: z.string(),
    computer: fleetComputer,
  }),
  z.strictObject({
    kind: z.enum(["uncertain", "denied", "conflict", "invalid"]),
    requestId: z.string(),
  }),
]);

/** One set of schemas and operations for MCP and direct broker invocation. */
export function computerControlSpecs(port: ComputerControlPort) {
  return {
    list: {
      replay: "safe" as const,
      access: "read" as const,
      description:
        "List a page of permitted Computers. Follow nextOffset for another page.",
      input: computerPageSchema,
      output: teamComputerDirectorySchema,
      /** Return an admitted inventory page to MCP or the retained broker. */
      execute: (
        input: z.output<typeof computerPageSchema>,
        context: InvocationContext,
      ) => port.list(input, context),
    },
    state: {
      replay: "safe" as const,
      access: "read" as const,
      description:
        "Read runtime state without waking a Computer, including its live admission queue position. Pass reason: true to get why a failed start failed.",
      input: fleetStateRead,
      output: computerStateSchema,
      /** Return liveness without waking the runtime. */
      execute: async (
        input: z.output<typeof fleetStateRead>,
        context: InvocationContext,
      ): Promise<z.output<typeof computerStateSchema>> => {
        const state = await port.state(input.computerId, context);
        if (state.state !== "start_failed" || input.reason === true)
          return state;
        return { state: state.state };
      },
    },
    start: {
      replay: "unsafe" as const,
      description:
        "Start a hosted Computer through ordinary admission. Waits until connected; poll computers.state while queued. Safe to retry.",
      input: fleetComputerId,
      output: computerStateSchema,
      /** Admit and start this Computer. */
      execute: (
        input: z.output<typeof fleetComputerId>,
        context: InvocationContext,
      ) => port.start(input.computerId, context),
    },
    create: {
      replay: "unsafe" as const,
      description:
        "Create a Computer with an optional friendly name and size (small, default or large; default when omitted). Request identity is generated automatically. If the outcome is uncertain, retry with its returned requestId and the original name and size input; do not start a second creation.",
      input: fleetCreate,
      output: fleetCreation,
      /** Mint one identity or preserve the requestId for an uncertain retry. */
      execute: async (
        input: z.output<typeof fleetCreate>,
        context: InvocationContext,
      ): Promise<z.output<typeof fleetCreation>> => {
        const requestId = input.requestId ?? fleetIds.request.generate();
        const result = await port.create(
          {
            name: input.name ?? undefined,
            size: input.size ?? undefined,
            requestId,
          },
          context,
        );
        return { ...result, requestId };
      },
    },
    stop: {
      replay: "unsafe" as const,
      description:
        'Stop a Computer now and free its running slot. Running commands end; files are kept and the next start brings it back. Only the signed-in owner may; "busy" means it is starting or finishing an operation, so try again.',
      input: fleetComputerId,
      output: fleetStop,
      /** End the runtime; the Computer and its Workspace stay. */
      execute: (
        input: z.output<typeof fleetComputerId>,
        context: InvocationContext,
      ): Promise<z.output<typeof fleetStop>> =>
        port.stop(input.computerId, context),
    },
    delete: {
      replay: "unsafe" as const,
      description:
        'Delete a Computer and erase its Workspace, permanently. Pass its exact name as confirmHandle; a different handle deletes nothing. Only the signed-in owner may, never a Team key or an Agent. "uncertain" means retry: a delete cut short finishes on the next attempt.',
      input: fleetDelete,
      output: fleetDeletion,
      /** Match the handle to the Computer's own name before anything is erased. */
      execute: async (
        input: z.output<typeof fleetDelete>,
        context: InvocationContext,
      ): Promise<z.output<typeof fleetDeletion>> => {
        let name: string | undefined;
        for (
          let page = 0, offset = 0;
          page < maximumDirectoryPages && name === undefined;
          page += 1
        ) {
          const listed = await port.list({ limit: 100, offset }, context);
          name = listed.computers.find(
            (computer) => computer.computerId === input.computerId,
          )?.name;
          if (listed.nextOffset === null) break;
          offset = listed.nextOffset;
        }
        if (name === undefined) return { kind: "denied" };
        if (name !== input.confirmHandle) return { kind: "mismatch" };
        return port.delete(input.computerId, context);
      },
    },
    backends: {
      replay: "safe" as const,
      description:
        "List one Computer's attached execution backends (platform container, on-box VM, members' machines) with live status.",
      input: fleetComputerId,
      output: fleetBackends,
      /** Return the attached list without waking any backend. */
      execute: async (
        input: z.output<typeof fleetComputerId>,
        context: InvocationContext,
      ): Promise<z.output<typeof fleetBackends>> => ({
        backends: await port.backends(input.computerId, context),
      }),
    },
    attachLocal: {
      replay: "unsafe" as const,
      description:
        "Attach this authenticated member's machine to a Computer as an execution backend. Send only the device public key and labels; the folder path and private key stay on the machine. Retry an uncertain outcome with its returned requestId.",
      input: fleetAttachInput,
      output: fleetAttachment,
      /** Mint one identity or preserve the requestId for an uncertain retry. */
      execute: async (
        input: z.output<typeof fleetAttachInput>,
        context: InvocationContext,
      ): Promise<z.output<typeof fleetAttachment>> => {
        const requestId = input.requestId ?? fleetIds.request.generate();
        const result = await port.attachLocal({ ...input, requestId }, context);
        return { ...result, requestId };
      },
    },
    detachLocal: {
      replay: "unsafe" as const,
      description:
        "Detach a machine this member attached from a Computer. Its live connection closes and the Computer keeps its files. Safe to retry.",
      input: localBackendDetachSchema,
      output: fleetDetachment,
      /** Close the attachment and its live connection; a gone one settles. */
      execute: (
        input: z.output<typeof localBackendDetachSchema>,
        context: InvocationContext,
      ): Promise<z.output<typeof fleetDetachment>> =>
        port.detachLocal(input, context),
    },
  };
}

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
 * resolved per installation (`appToolAccess`) -- an installation the key has
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
  host: Pick<OysterHost, "appToolPolicy" | "keys" | "computerId">,
  actor: Extract<TenantPrincipal["actor"], { kind: "agent" | "team-key" }>,
  installationId: string,
): Promise<AppToolPolicy | null> {
  const ports = hostAuthorityPorts(host);
  return appToolAccess(
    await authorityOf({ actor }, ports),
    installationId,
    ports,
  );
}

/** Immutable Release data shared by captures; no validator graphs live here. */
export type ReleaseSurface = Readonly<{
  release: VerifiedRelease;
  api: NonNullable<VerifiedRelease["api"]>;
  declaredOperations: DeclaredOperations;
  methods: NonNullable<VerifiedRelease["api"]>["methods"];
}>;

/**
 * Per-host verified data, keyed by immutable Release ID and artifact digest.
 * Authority, caller access and tool-family listings stay fresh per capture.
 * Failed verification is not cached.
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
      methods: Object.fromEntries(
        // Hidden methods and the Agent extension protocol are never tools.
        Object.entries(release.api.methods).filter(
          ([name, method]) =>
            method.hidden !== true && !isAgentExtensionWireMethod(name),
        ),
      ),
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

/** The host parts the App door and its snapshot read. */
export type AppSnapshotHost = Pick<
  OysterHost,
  | "tenantId"
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
>;

/** Everything one installation's App door needs, captured once per catalog acquisition. */
type AppMethodDoor = Readonly<{
  host: AppSnapshotHost;
  installation: Installation;
  surface: ReleaseSurface;
  principal: TenantPrincipal;
  captured: AppToolPolicy | null;
  caller: ReturnType<typeof invocationCallerContext>;
  limits: ReturnType<typeof guestLimits>;
  sessionId: string | null;
}>;

/**
 * The one App door every operation of an installation shares (ordinary
 * methods, a tool family's dynamic tools, and a hosted extension's wire
 * methods): the same staleness check, the same owner-approved policy check,
 * the same `admits` gate and the same Instance call.
 */
const callAdmittedAppMethod = async (
  door: AppMethodDoor,
  name: string,
  effect: "read" | "write" | "external",
  input: unknown,
  signal?: AbortSignal,
): Promise<OysterJson> => {
  const {
    host,
    installation,
    surface: { release, api, declaredOperations },
    principal,
    captured,
    caller,
    limits,
    sessionId,
  } = door;
  const { actor } = principal;
  const instanceId = installation.instanceId;
  if (instanceId === null) throw new AppMethodRefused("stale_authority");
  const declaration = release.declaration ?? emptyAppDeclaration;
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
    currentInstallation.release.releaseId !== installation.release.releaseId ||
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
  if (decision.kind === "refused") throw new AppMethodRefused(decision.code);
  const result = await host.instances.get(instanceId, limits).call(
    await admittedMethodCallerFacts(
      host,
      installation,
      release,
      caller,
      decision.grants,
      { name, effect },
      [],
      sessionId ?? undefined,
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

/** One host-side call of a hosted extension's wire method. */
export type OysterExtensionCall = (
  name: string,
  input: OysterJson,
  signal?: AbortSignal,
) => Promise<OysterJson>;

/**
 * The host-side door for an attached hosted extension: its wire methods go
 * through the same App door as App tools (staleness, fresh policy, `admits`,
 * the Instance call), and never appear as a model-facing operation. Null when
 * the installation's current Release is not an Agent extension.
 */
export async function oysterExtensionDoor(
  host: AppSnapshotHost,
  surfaces: AppSurfaceCache,
  principal: TenantPrincipal,
  access: OysterCallerAccess,
  installation: Installation,
  sessionId: string | null,
): Promise<OysterExtensionCall | null> {
  if (installation.status !== "enabled" || installation.instanceId === null)
    return null;
  const surface = await surfaces(installation.release);
  if (surface === null || !isAgentExtensionApi(surface.api)) return null;
  const door: AppMethodDoor = {
    host,
    installation,
    surface,
    principal,
    captured: capturedAccessFor(access, installation.installationId),
    caller: invocationCallerContext(
      principal,
      host.computerId ?? null,
      host.tenantId,
    ),
    limits: guestLimits(host.guestLimits),
    sessionId,
  };
  return (name, input, signal) => {
    const method = isAgentExtensionWireMethod(name)
      ? surface.api.methods[name]
      : undefined;
    if (method === undefined)
      return Promise.reject(new AppMethodRefused("not_declared"));
    return callAdmittedAppMethod(door, name, method.effect, input, signal);
  };
}

/** Derive the current principal's admitted App modules and grants. */
export async function oysterAppSnapshot(
  host: Pick<
    OysterHost,
    | "tenantId"
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
  surfaces: AppSurfaceCache,
  principal: TenantPrincipal,
  installations: readonly Installation[],
  access: OysterCallerAccess,
  sessionId: string | null,
  mode: "direct" | "approval",
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
  const caller = invocationCallerContext(
    principal,
    host.computerId ?? null,
    host.tenantId,
  );
  const { actor } = principal;
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
    const captured = capturedAccessFor(access, installation.installationId);
    // A key that holds no grant for this installation never sees it listed
    // at all. An Agent's one blanket policy either covers every
    // installation or none, so this never hides one from an Agent; an
    // unapproved Agent still sees the list, refused at call time, as today.
    if (access?.kind === "key" && captured === null) continue;
    const surface = await surfaces(installation.release);
    if (surface === null) continue;
    const { release, api, methods } = surface;
    const id = `oyster-app:${installation.installationId}`;
    // A member/owner, or an Agent/key with no captured access, defaults to
    // "write" here exactly as every module always did before: the deeper gate
    // (`admits`), not this coarse Mycelium-level grant, is what actually
    // enforces role ceilings. Only a captured
    // Agent/key access with its own level narrows this.
    levels[id] = captured?.level ?? "write";
    // Shared by every operation this installation exposes (ordinary methods
    // and, below, a tool family's dynamic per-row tools): the same staleness
    // check, the same owner-approved policy check, the same `admits` gate and
    // the same Instance call. A tool family tool is sugar over this same
    // admitted call to its declared `call` method; it gets no separate check.
    const door: AppMethodDoor = {
      host,
      installation,
      surface,
      principal,
      captured,
      caller,
      limits,
      sessionId,
    };
    const callAppMethod = (
      name: string,
      effect: "read" | "write" | "external",
      input: MyceliumJsonValue,
      signal?: AbortSignal,
    ) => callAdmittedAppMethod(door, name, effect, input, signal);
    const operationEffects: Record<string, "read" | "write" | "external"> = {};
    effects[id] = operationEffects;
    let familyFacts: OysterJson | null = null;
    const outputFor = (
      declared: ReturnType<typeof appJsonSchema>,
      effect: "read" | "write" | "external",
    ) =>
      mode === "approval" && effect !== "read"
        ? approvalOutput(declared)
        : declared;
    const runOperation = async (
      name: string,
      effect: "read" | "write" | "external",
      input: MyceliumJsonValue,
      context: InvocationContext,
      declaredOutput: ReturnType<typeof appJsonSchema>,
      direct: () => Promise<OysterJson>,
    ): Promise<OysterJson> => {
      if (mode === "direct" || effect === "read") return direct();
      if (host.approvals === undefined)
        return { kind: "refused", reason: "not-granted" };
      const fence = fences[id];
      if (fence === undefined)
        throw new Error("App snapshot has no operation authority fence");
      const result = await host.approvals.submit(
        {
          actor,
          installationId: installation.installationId,
          sessionId,
          operation: name,
          access: effect,
          authorityFence: fence,
          idempotencyKey: await sha256(
            new TextEncoder().encode(
              JSON.stringify([
                context.executionId,
                context.toolCallId,
                context.operationOrdinal ?? 0,
              ]),
            ),
          ),
          input,
          deadlineAt: oysterApprovalDeadlineAt(context.deadlineAt),
        },
        context.signal,
      );
      if (result.kind !== "applied") return result;
      // App data must not take the host-only approval branch of the public
      // output union, even when the App declares a permissive object schema.
      if (isApprovalResult(result.output))
        throw new BadResponse({
          reason: "App output cannot impersonate an approval decision",
          rawCause: undefined,
        });
      const output = declaredOutput.safeParse(result.output);
      if (!output.success)
        throw new BadResponse({
          reason: "Capability output failed its declared schema",
          rawCause: output.error,
        });
      return output.data;
    };
    const toolOperations = Object.entries(methods).map(([name, method]) => {
      operationEffects[name] = method.effect;
      const declaredOutput = appJsonSchema(method.output);
      const appMethod = Mycelium.operation({
        replay: "unsafe",
        access: method.effect === "read" ? "read" : "write",
        description: `${method.description}\nEffect: ${method.effect}.`,
        input: appJsonSchema(method.input),
        output: outputFor(declaredOutput, method.effect),
        execute: (input, context) =>
          runOperation(
            name,
            method.effect,
            input,
            context,
            declaredOutput,
            () => callAppMethod(name, method.effect, input, context.signal),
          ),
      });
      return [name, appMethod] as const;
    });
    // A tool family publishes a dynamic, signed set of typed tools from one
    // App (e.g. each published Workflow becomes its own tool). forage decodes
    // that listing and compiles its schemas; it supplies no admission or
    // invocation arguments by design, so the host supplies both here, reusing
    // the exact same `callAppMethod` gate as every other method on this App.
    // A caller the App itself refuses to list for (stale authority, an
    // unapproved App-tool policy, a missing capability grant) sees none.
    const family = api.toolFamily;
    const familyOperations =
      family === undefined
        ? []
        : await (async () => {
            try {
              const listing = await callAppMethod(family.list, "read", {});
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
                  output: outputFor(tool.output, compiled.effect),
                  execute: (input, context) =>
                    runOperation(
                      `${compiled.name}.${tool.row.tool}`,
                      compiled.effect,
                      input,
                      context,
                      tool.output,
                      () => {
                        // The declaring App owns every field below except
                        // `requestId` (this call's own identity) and `input`
                        // (the caller's tool-shaped payload): `tool.row.call` is
                        // opaque data this host never reads into or defaults.
                        // `requestId` is last: a row whose own `call` data named
                        // that key would otherwise replay the same run forever.
                        return callAppMethod(
                          compiled.call,
                          compiled.effect,
                          {
                            ...tool.row.call,
                            input,
                            requestId: toolFamilyCallIds.call.generate(),
                          },
                          context.signal,
                        );
                      },
                    ),
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
          // The canonical caller facts, never the raw principal: a resolver may
          // carry extra registry fields (membershipVersion) that the submit-time
          // principal lacks, which would fence a legitimate approval.
          caller,
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
 * Owners see every discoverable method. A key sees only the installations its own grants admit, each at
 * the level (`read`/`write`) those grants give it; Mycelium itself refuses a
 * write call up front when the module's own grant is `read`
 * (`mycelium/src/access.ts`). Call again to capture changes to Releases,
 * installation authority or the caller's own grants.
 */
export async function oysterAppMethods(
  host: Pick<
    OysterHost,
    | "tenantId"
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
  principal: TenantPrincipal,
  access: OysterCallerAccess,
  surfaces: AppSurfaceCache,
  preloadedInstallations?: readonly Installation[],
): Promise<CapabilitySource & { readonly grants: Grants }> {
  const installations =
    preloadedInstallations ?? (await host.installations.list());
  // Grants need only admitted Release data, not modules, fences or listings.
  const grants: Record<string, AppToolPolicy["level"]> = {};
  for (const installation of installations) {
    if (installation.status !== "enabled" || installation.instanceId === null)
      continue;
    const captured = capturedAccessFor(access, installation.installationId);
    if (access?.kind === "key" && captured === null) continue;
    if ((await surfaces(installation.release)) !== null)
      grants[`oyster-app:${installation.installationId}`] =
        captured?.level ?? "write";
  }
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
          ]),
      }),
    ),
  );
  return {
    id: "oyster-apps",
    grants,
    acquire: async ({ signal, session }) => {
      signal.throwIfAborted();
      const snapshot = await oysterAppSnapshot(
        host,
        surfaces,
        principal,
        installations,
        access,
        session?.sessionId ?? null,
        "approval",
      );
      signal.throwIfAborted();
      return {
        snapshot: { version, modules: Object.values(snapshot.modules) },
        release: () => Promise.resolve(),
      };
    },
  };
}

/**
 * Capture the host's fixed Computer for one caller as a Knapsack source.
 * The host decides whether the caller holds Computer access; the ComputerDO
 * still checks its host-issued grant on every call. Null when the host has no
 * Computer or the caller has no access. Grants name the captured module.
 */
export async function oysterComputerTools(
  host: Pick<OysterHost, "computerId" | "computer">,
  principal: TenantPrincipal,
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
      confirmCalls: true,
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
 * own caller checks regardless. App writes use the host's approval record;
 * stored approval of an Agent's App tools can permit headless App writes.
 * The shared MCP server elicits consent for explicitly confirmed operations,
 * including every advertised Workspace Computer call, even reads. Each call
 * still re-admits the key, checks current App approval and passes the App's
 * gate.
 */
export function oysterMcpCatalogLoad(
  host: Pick<
    OysterHost,
    | "tenantId"
    | "installations"
    | "instances"
    | "artifacts"
    | "guestLimits"
    | "backgroundOriginKey"
    | "computerId"
    | "computer"
    | "computerControl"
    | "capabilities"
    | "appToolPolicy"
    | "keys"
    | "workflows"
  >,
): (principal: TenantPrincipal) => Promise<OysterMcpCatalogSnapshot> {
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
      const ports = hostAuthorityPorts(host);
      const authority = await authorityOf(principal, ports);
      const byInstallation = new Map<string, AppToolPolicy>();
      for (const installation of installations) {
        const level = await appToolAccess(
          authority,
          installation.installationId,
          ports,
        );
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
    const fleet = host.computerControl?.(principal) ?? null;
    const fleetSpecs = fleet === null ? null : computerControlSpecs(fleet);
    const fleetSource: CapabilitySource[] =
      fleetSpecs === null
        ? []
        : [
            {
              id: "oyster-computer-control",
              acquire: () =>
                Promise.resolve({
                  snapshot: {
                    version: "team-computer-control",
                    modules: [
                      Mycelium.module({
                        id: "team-computer-control",
                        name: "computers",
                        operations: {
                          list: Mycelium.operation(fleetSpecs.list),
                          state: Mycelium.operation(fleetSpecs.state),
                          start: Mycelium.operation({
                            ...fleetSpecs.start,
                            confirm: true,
                          }),
                          create: Mycelium.operation({
                            ...fleetSpecs.create,
                            confirm: true,
                          }),
                          stop: Mycelium.operation({
                            ...fleetSpecs.stop,
                            confirm: true,
                          }),
                          delete: Mycelium.operation({
                            ...fleetSpecs.delete,
                            confirm: true,
                          }),
                          backends: Mycelium.operation(fleetSpecs.backends),
                          attachLocal: Mycelium.operation(
                            fleetSpecs.attachLocal,
                          ),
                          detachLocal: Mycelium.operation(
                            fleetSpecs.detachLocal,
                          ),
                        },
                      }),
                    ],
                  },
                  release: () => Promise.resolve(),
                }),
            },
          ];
    const fleetGrants: Grants =
      fleet === null ? {} : { "team-computer-control": "write" };
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
        instructions: [
          "Installed Apps on this Oyster. Each App is env.<APP>; dotted method names are nested properties, e.g. env.BONSAI.repos.list({}).",
          forageDiscoveryInstructions,
          appApprovalInstructions,
        ].join("\n"),
        grants: { ...apps.grants, ...workflowGrants, ...fleetGrants },
        sources: [apps, ...workflowSources, ...fleetSource],
      };
    return {
      instructions: [
        'Installed Apps and this Oyster\'s Computer. Each App is env.<APP>; dotted method names are nested properties, e.g. env.BONSAI.repos.list({}). The Computer is env.computers.workspace, e.g. env.computers.workspace.exec({command: "ls"}).',
        forageDiscoveryInstructions,
        appApprovalInstructions,
      ].join("\n"),
      grants: {
        ...apps.grants,
        ...computer.grants,
        ...workflowGrants,
        ...fleetGrants,
      },
      sources: [apps, computer, ...workflowSources, ...fleetSource],
    };
  };
}
const isApprovalResult = Schema.is(
  Schema.Union([
    ApprovalRefusalSchema.check(
      Schema.makeFilter((value) => value.reason !== "expired"),
    ),
    Schema.Struct({
      kind: Schema.Literal("refused"),
      reason: Schema.Literals(["cancelled", "approval_expired"]),
    }),
    Schema.Struct({
      kind: Schema.Literal("denied"),
      by: Schema.String,
      note: Schema.optionalKey(Schema.String),
      message: Schema.String,
    }),
  ]),
);

/** Approval results are a host contract, not part of each App's declaration. */
function approvalOutput(
  declared: ReturnType<typeof appJsonSchema>,
): Pick<ReturnType<typeof appJsonSchema>, "~standard"> {
  return {
    "~standard": {
      ...declared["~standard"],
      validate: (value) =>
        isApprovalResult(value)
          ? { value }
          : declared["~standard"].validate(value),
    },
  };
}
