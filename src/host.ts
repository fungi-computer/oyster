import type { OysterApprovalCall } from "./approval-home.js";
import type {
  PendingApproval,
  ApprovalApplyResult,
} from "@fungi.computer/approvals";
import { hostGateFacts, releaseCache } from "./internal/host-gate.js";
import type { WorkflowControl } from "./workflows.js";
import type { ComputerControlPort } from "./computer-control-port.js";
import {
  InstallationOperationError,
  installationCommandIds,
  installationRequestIdSchema,
  type InstallationOperations,
  type InstallationOperation,
} from "./installation-operations.js";
export type { InstallationOperations };
import {
  completedInstallationResponse,
  observeInstallation,
  InstallationObservationError,
} from "./installation-client.js";

import {
  instanceRefusalBody,
  instanceRefusalStatus,
} from "./instance-refusal.js";
import { appSandbox } from "./app-sandbox.js";
import type { KnapsackComputer } from "@fungi.computer/knapsack";
import {
  shellModuleAsset,
  shellModuleAssetPath,
} from "@fungi.computer/puffball/assets";
import type { TenantPrincipal } from "./tenant.js";
import { gitRepositoryNameSchema } from "@fungi.computer/puffball/git-representation";
import {
  gillRequestSchema,
  decodeGillReply,
  decodeDeclaredGillResponse,
  type GillCall,
  type GillReply,
} from "@fungi.computer/gills";
import { causeClass } from "./cause-class.js";
import {
  appStorageKeyNameSchema,
  appStorageWriteSchema,
  appStorageResetSchema,
  type AppStorageWire,
} from "@fungi.computer/agar/storage";
import type { OysterRootDirectory } from "./root-data.js";
import {
  type AppGitPushFact,
  type GitPushQuestion,
  type GitPushVerdict,
  type GitWriter,
} from "@fungi.computer/agar/git";
import { guestLimits, type GuestLimits } from "./guest-policy.js";
import {
  APP_INVOCATION_CEILING_MS,
  admittedCallerFacts,
  admittedMethodCallerFacts,
  invocationAuthorityOf,
  invocationCallerContext,
  invocationFacts,
  type InvocationFacts,
} from "./invocation.js";
export type { GuestLimits } from "./guest-policy.js";
import { appFacetResponse } from "./backend-request.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { match } from "path-to-regexp";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { type BackgroundSyncRefusal } from "@fungi.computer/puffball/background-replay";
import { emptyAppDeclaration } from "@fungi.computer/puffball/app";
import {
  applyInstallationCommand,
  installationIdSchema,
  type Installation,
  type InstallationCommand,
  type InstallationReader,
} from "./apps/installation.js";
import { admits, scopedBindings, grantsFor } from "./apps/gate.js";
import {
  appPermissionPageSchema,
  permissionSaveSchema,
} from "./apps/permissions.js";
import type { AppToolPolicy } from "./apps/tools.js";
import type { LiveOysterKey } from "./keys.js";
import {
  deriveDeclaredOperations,
  appCallOperation,
} from "./apps/operations.js";
import {
  appBackendActorHeader,
  appBackendComputerHeader,
  appMethodRefusalStatus,
  type AppMethodReply,
} from "@fungi.computer/agar/backend";
import type { AppCapabilityId, HostActor } from "@fungi.computer/puffball/app";
import {
  appCallsDescriptor,
  type CapabilityDescriptor,
} from "./capability-descriptor.js";
export {
  capabilityDescriptorSchema,
  capabilityMethodKindSchema,
  capabilityMethodSchema,
  type CapabilityDescriptor,
  type CapabilityMethodKind,
} from "./capability-descriptor.js";
import type { Release } from "@fungi.computer/puffball";
import type { UiBootCheckOutcome } from "./boot-gate.js";
import {
  selectionOf,
  type Instance,
  type InstanceId,
  type OwnerState,
  type AppInstanceErrorCode,
} from "./index.js";
import {
  parseRelease,
  readVerified,
  sha256,
  type ArtifactStore,
  type VerifiedRelease,
} from "./release.js";
import { createGitDoor, type GitDoorTarget } from "./git.js";
import { buildGitPassPrefix, presentedGitKey } from "./git-auth.js";
import { workflowGitPassPrefix } from "@fungi.computer/braid/runtime";
import type { AdmittedGit } from "./git-admission.js";
import {
  loadPageAssets,
  PageAssetsLoadError,
  type PageAssetLoader,
} from "./page-assets.js";
import { fungiFaviconHref } from "@fungi.computer/sigils/favicon";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CenteredCard,
  CardHeader,
  CardTitle,
  CardContent,
} from "@fungi.computer/caps/components/card";
import { Form, Field, FormFooter } from "@fungi.computer/caps/components/field";
import { Input } from "@fungi.computer/caps/components/input";
import { Button } from "@fungi.computer/caps/components/button";
import { parseArtifactRef, type AppApi } from "@fungi.computer/puffball";

export {
  ReleaseError,
  defaultAssetPolicy,
  parseRelease,
  resolveBackend,
  sha256,
  verifyRelease,
  type ArtifactStore,
  type VerifiedRelease,
} from "./release.js";

/**
 * The anonymous reader of a public installation. The host admits it only when
 * authentication refuses; it reaches that App's page and its `read` methods.
 */
export type OysterVisitor = Readonly<{ actor: Readonly<{ kind: "visitor" }> }>;

/** Who an admitted request acts for: an authenticated tenant principal or the visitor. */
export type OysterPrincipal = TenantPrincipal | OysterVisitor;

/** Narrow an admitted principal to the anonymous public reader. */
export function oysterPrincipalIsVisitor(
  principal: OysterPrincipal,
): principal is OysterVisitor {
  return principal.actor.kind === "visitor";
}

/** True only for a member admitted with the owner role. */
export function oysterPrincipalIsOwner(
  principal: OysterPrincipal,
): principal is Readonly<{
  actor: Extract<HostActor, { kind: "member" }>;
  role: "owner";
}> {
  return "role" in principal && principal.role === "owner";
}

/** Stable actor identity for host storage and backend attribution. */
export function oysterPrincipalId(principal: TenantPrincipal): string {
  switch (principal.actor.kind) {
    case "member":
      return principal.actor.memberId;
    case "agent":
      return principal.actor.agentId;
    case "team-key":
      return principal.actor.keyId;
  }
}

/** The outcome of authenticating one request. */
export type OysterAuthResult =
  | Readonly<{ kind: "admitted"; principal: TenantPrincipal }>
  | Readonly<{
      kind: "refused";
      status: 401 | 403 | 404 | 429;
      retryAfter?: number;
    }>;

/** The host's sign-in: who may use this Oyster. */
export type OysterAuth = Readonly<{
  /** Resolve a retained actor through current host membership, without replaying credentials. */
  resolve: (actor: HostActor) => Promise<TenantPrincipal | null>;
  /** Authenticate one request from its headers or cookies. */
  authenticate: (request: Request) => Promise<OysterAuthResult>;
  /** Handle the browser sign-in form post; returns the response to send. */
  login?: (request: Request) => Promise<Response>;
}>;

/** A serializable registry commit result, including across native DO RPC. */
export type InstallationCommit =
  Readonly<{ ok: true }> | Readonly<{ ok: false; code: "stale_authority" }>;

/** Durable commits remain with the host's registry; reads are tenant-scoped. */
export type InstallationStore = InstallationReader &
  Readonly<{
    /** Absence makes installation commands unavailable, never synchronous. */
    operations?: InstallationOperations;
    /** Opaque identity of this store incarnation; replacing the store mints another. */
    generation: () => Promise<string>;
    /**
     * Atomically commit one reducer-produced record only over the version it
     * was computed from (0: no record). Every writer reads, may await
     * activation, then commits here, so a concurrent commit is never undone.
     */
    compareAndPut: (
      installation: Installation,
      expectedAuthorityVersion: number,
      expectedGeneration: string,
    ) => Promise<InstallationCommit>;
  }>;

/** A JSON value crossing the method boundary. */
export type OysterJson = Schema.Json;

/** The result of one Instance operation; refusals carry Oyster's error code. */
export type InstanceResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      code: AppInstanceErrorCode | "failed";
      /** Closed host diagnostic; absent when the execution owner did not supply one. */
      causeClass?:
        | "Error"
        | "TypeError"
        | "RangeError"
        | "SyntaxError"
        | "AbortError"
        | "TimeoutError"
        | "Other";
    }>;

/** One running App Instance, wherever the host runs it. */
export type InstanceHandle = Readonly<{
  /** Check lifecycle and construction without activating or changing Instance state. */
  prepare: (
    state: OwnerState,
    release: Release,
  ) => Promise<InstanceResult<UiBootCheckOutcome | null>>;
  /** Activate a complete owner state only after its registry selection commits. */
  apply: (
    state: OwnerState,
    release: Release,
  ) => Promise<InstanceResult<Instance>>;
  /** Deliver an admitted Git push under this exact Instance selection. */
  onGitPush: (facts: InvocationFacts, fact: AppGitPushFact) => Promise<void>;
  /** Deliver a lane refusal only through an active zero-grant lifecycle frame. */
  syncRefused: (
    facts: InvocationFacts,
    refusal: BackgroundSyncRefusal,
  ) => Promise<void>;
  /** Ask a whole-push policy under host-admitted immutable caller facts. */
  authorizeGitPush: (
    facts: InvocationFacts,
    question: GitPushQuestion,
  ) => Promise<GitPushVerdict>;
  /** Forward an admitted HTTP request to the backend. */
  fetch: (facts: InvocationFacts, request: Request) => Promise<Response>;
  /** Invoke a declared read Gill through the same immutable invocation frame. */
  gill: (
    facts: InvocationFacts,
    api: AppApi,
    source: string,
    input: GillCall,
  ) => Promise<InstanceResult<GillReply>>;
  /** Invoke one declared App method; an App refusal is a refused reply. */
  call: (
    facts: InvocationFacts,
    api: AppApi,
    name: string,
    input: OysterJson,
  ) => Promise<InstanceResult<AppMethodReply>>;
}>;

/** Finds the running Instance for an Instance ID. */
export type InstanceDirectory = Readonly<{
  /** The Instance with this ID. The adapter must enforce the supplied guest budgets. */
  get: (instanceId: InstanceId, limits?: GuestLimits) => InstanceHandle;
}>;

/** An MCP endpoint mounted at `/mcp`. */
export type OysterMcp = Readonly<{
  /** Answer one MCP HTTP request. */
  handleRequest: (request: Request) => Promise<Response>;
  /** Close an explicitly supplied process-local adapter; remote owners expose no close. */
  close?: () => Promise<void>;
}>;

/** What Oyster's git door needs from the host beyond sign-in and Instances. */
export type OysterGitHost = Readonly<{
  /** Project the authenticated host principal into the canonical writer grammar. */
  writerOf(principal: TenantPrincipal): Extract<GitWriter, { kind: "actor" }>;
  /** Admit a host-minted Workflow Git pass for exactly one repository and
   * scope, as its arming member under the Workflow's branch grant. */
  workflowPass?(
    pass: string,
    target: GitDoorTarget,
  ): Promise<Extract<GitWriter, { kind: "actor" }> | null>;
  /** Admit a host-minted build job clone pass: one repository, read only, as
   * the owner who started the build. */
  buildPass?(
    pass: string,
    target: GitDoorTarget,
  ): Promise<Extract<GitWriter, { kind: "actor" }> | null>;
  /** Construct the installation-scoped admitted store, policy and durable journal. */
  git(installation: Installation): Promise<AdmittedGit>;
}>;

/** The host's admission of one capability request: who, for which installation. */
export type CapabilityAdmission = Readonly<{
  /** The principal the host authenticated for this request. */
  principal: TenantPrincipal;
  /** The enabled installation the gate admitted for this capability. */
  installation: Installation;
}>;

/** Capability routes read the host's admission from `c.env`; they never authenticate. */
export type CapabilityEnv = { Bindings: CapabilityAdmission };

/** A capability adapter whose routes require live installation admission. */
export type OysterCapability = Readonly<
  CapabilityDescriptor & {
    /** The permission declared by an App Release to use this contract. */
    permission: AppCapabilityId;
    /** Routes relative to the descriptor's base path. */
    routes: Hono<CapabilityEnv>;
  }
>;

/** What the host stamps once per request; inner routes read it with `c.get`. */
export type OysterVariables = {
  principal: OysterPrincipal;
  installation?: Installation;
};

/** Owner routes run after the host's owner guard and read `c.get("principal")`. */
export type OysterEnv = { Variables: OysterVariables };

/** Everything a host supplies to run Oyster. */
export type OysterHost = Readonly<{
  /** Native approval home. A host without one cannot execute App tool writes. */
  approvals?: Readonly<{
    /** Stage an admitted operation; only the native home may apply it. */
    submit(
      call: OysterApprovalCall,
    ): Promise<PendingApproval | ApprovalApplyResult>;
  }>;
  /**
   * Host-bound Workflow control; absence exposes no Workflow authority.
   * @inlineType WorkflowControl
   */
  workflows?: (principal: OysterPrincipal) => Promise<WorkflowControl | null>;
  /** Owner-admitted durable Computer inventory, absent on hosts without a fleet. */
  computerControl?: (principal: OysterPrincipal) => ComputerControlPort | null;
  auth: OysterAuth;
  /** Host-held sealing key for member writes; never exposed to the guest.
   * Absence refuses eligible named member writes, even when the App has no sync continuation.
   */
  backgroundOriginKey?: () => Promise<CryptoKey>;
  artifacts: ArtifactStore;
  installations: InstallationStore;
  instances: InstanceDirectory;
  /** Report-only host UI check; backend construction remains Instance-owned and blocking. */
  bootUi: (release: Release) => Promise<UiBootCheckOutcome>;
  /** Fixed Computer selected by the host; request input never selects it. */
  computerId?: string;
  /** The fixed Computer's advertised calls for one admitted caller, or null
   * when the caller holds no Computer access (for a key, without its own
   * `computer.use` grant). The Computer owner accepts each call against the
   * authority the host issued.
   */
  computer?: (
    principal: OysterPrincipal,
  ) => KnapsackComputer | null | Promise<KnapsackComputer | null>;
  /** Host-attested Agent tool policy; absence grants no App tool access. A
   * key's App access is its own grants (Ear Tag), read through `keys.live`
   * and `keyAppAccess`, never this port. */
  appToolPolicy?: (
    actor: Extract<HostActor, { kind: "agent" }>,
  ) => AppToolPolicy | null | Promise<AppToolPolicy | null>;
  /** The Ear Tag-backed key store this host owns. */
  keys?: Readonly<{
    /** One key's live facts by id; `null` for an unknown, revoked, expired or suspended key. */
    live(keyId: string): Promise<LiveOysterKey | null>;
  }>;
  /** Guest CPU/subrequest budgets; defaults to 1,000 ms and 50 per invocation. */
  guestLimits?: Partial<GuestLimits>;
  /** Shared Mycelium MCP handler; it authenticates every request itself. */
  mcp?: OysterMcp;
  /** The git door for Apps that use GIT; mounted at `/git/*`. */
  git?: OysterGitHost;
  /** Owner-only `/api/*` routes the host adds (keys, webhooks); they read the
   * admitted owner with `c.get("principal")` and never authenticate again. */
  ownerRoutes?: Hono<OysterEnv>;
  /** Adapters granted only when the Release declares them and admission passes. */
  capabilities?: readonly OysterCapability[];
  /**
   * Root-owned desktop data and per-App storage; HTTP access remains
   * owner-only. With it, the home installation's page is the trusted shell:
   * `pageScript` must render that shell in the top-level `#oyster-shell`
   * document, where it runs with this host's escalated permissions.
   */
  workbench?: Readonly<{
    /** Read the owner's live installation directory. */
    directory(): Promise<OysterRootDirectory>;
    /** Open storage after fresh installation and owner admission. */
    storage(
      installationId: string,
      ownerId: string,
    ): Pick<AppStorageWire, "read" | "write" | "reset"> &
      Readonly<{
        /** Stream changes for an admitted declared storage key. */
        events(key: string): Promise<Response>;
      }>;
  }>;
  /** Root-selected home installation; the core never imports a specific home App. */
  homeInstallationId?: string;
  /** Browser composition supplied by a deployable host; defaults to Oyster shell. */
  pageScript?: string;
  /**
   * Host page-source acquisition; defaults to the generated Oyster assets.
   * @inlineType PageAssetLoader
   */
  pageAssets?: PageAssetLoader;
  /** Page title shown in the shell. */
  title?: string;
}>;

const installRequestSchema = Schema.Struct({
  release: Schema.Unknown,
  installationId: Schema.optional(
    Schema.String.pipe(
      Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/)),
    ),
  ),
});
const maxBackendBody = 1024 * 1024;
const maxMethodBody = 64 * 1024;
class MethodBodyTooLarge extends Error {}

async function methodInput(request: Request): Promise<OysterJson> {
  let bytes = 0;
  const body = request.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxMethodBody) throw new MethodBodyTooLarge();
        controller.enqueue(chunk);
      },
    }),
  );
  return Schema.decodeUnknownSync(Schema.Json)(
    await new Response(body ?? null).json(),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const visibilitySchema = Schema.Struct({
  visibility: Schema.Literals(["private", "public"]),
});

function refusal(status: number, error: string, retryAfter?: number): Response {
  const init: ResponseInit = { status };
  if (retryAfter !== undefined)
    init.headers = { "Retry-After": String(retryAfter) };
  return Response.json({ error }, init);
}

function installationOperationRefusal(
  cause: InstallationOperationError,
): Response {
  return cause.code === "stored_operation_invalid"
    ? Response.json(
        { error: cause.code, message: cause.message },
        { status: 409 },
      )
    : refusal(cause.code === "unavailable" ? 503 : 409, cause.code);
}

/** A refusal no cache may keep: its answer depends on current authority. */
function noStoreRefusal(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function instanceRefusal(
  code: AppInstanceErrorCode | "failed",
  causeClass?: Extract<InstanceResult<never>, { ok: false }>["causeClass"],
): Response {
  if (code === "failed") {
    if (causeClass === undefined)
      console.error("AppInstance failure", {
        stage: "instance_execution",
        code,
      });
    else
      console.error("AppInstance failure", {
        stage: "instance_execution",
        code,
        causeClass,
      });
    return refusal(502, "App execution failed");
  }
  return Response.json(instanceRefusalBody(code), {
    status: instanceRefusalStatus(code),
  });
}

/** An App's typed refusal keeps its code and caller-facing message. */
function methodResponse(reply: AppMethodReply): Response {
  return reply.kind === "ok"
    ? Response.json(reply.value)
    : Response.json(
        { error: reply.code, message: reply.message },
        { status: appMethodRefusalStatus[reply.code] },
      );
}

/**
 * Admit the retained command shared by POST and PUT selection. Only POST's
 * explicit install-or-remint intent
 * may choose a fresh id for a tombstone; ordinary selection keeps the retired
 * id unavailable. App-mediated build selection stays refused until it has
 * designated install authority.
 */
async function admitInstallation(
  host: OysterHost,
  installationId: string,
  release: Release,
  principal: OysterPrincipal,
  intent: "install-or-select" | "install-or-remint" | "create-only",
  origin: "owner-direct" | "workflow" | "app",
  requestId: string = installationCommandIds.request.generate(),
): Promise<Response | InstallationOperation> {
  // App-mediated installation needs installFree/designated-marketplace
  // authority. A member's owner role is not that delegated App authority.
  if (origin !== "owner-direct" && origin !== "workflow")
    return refusal(403, "install_authority_unavailable");
  if (!oysterPrincipalIsOwner(principal)) return refusal(403, "Owner only");
  if (!installationIdSchema.safeParse(installationId).success)
    return refusal(400, "Invalid installation id");
  if (!installationRequestIdSchema.safeParse(requestId).success)
    return refusal(400, "Invalid installation request identity");
  const operations = host.installations.operations;
  if (operations === undefined)
    return refusal(503, "Installation commands unavailable");
  try {
    return await operations.admit({
      requestId,
      installationId,
      release,
      actor: principal.actor,
      intent,
      origin,
    });
  } catch (cause) {
    if (cause instanceof InstallationOperationError)
      return installationOperationRefusal(cause);
    throw cause;
  }
}

/** Completed selection, without re-deriving or executing outside Watchdog. */
export async function installOrSelect(
  host: OysterHost,
  installationId: string,
  release: Release,
  principal: OysterPrincipal,
  intent: "install-or-select" | "install-or-remint" | "create-only",
  origin: "owner-direct" | "workflow" | "app",
  requestId: string = installationCommandIds.request.generate(),
  signal: AbortSignal = new AbortController().signal,
): Promise<Response> {
  const admitted = await admitInstallation(
    host,
    installationId,
    release,
    principal,
    intent,
    origin,
    requestId,
  );
  if (admitted instanceof Response) return admitted;
  const operations = host.installations.operations;
  if (operations === undefined)
    return refusal(503, "Installation commands unavailable");
  try {
    return completedInstallationResponse(
      await observeInstallation({
        requestId,
        initial: admitted,
        read: () => operations.read(requestId, installationId),
        signal,
      }),
    );
  } catch (cause) {
    if (
      cause instanceof InstallationObservationError &&
      cause.cause instanceof InstallationOperationError
    )
      return installationOperationRefusal(cause.cause);
    if (cause instanceof InstallationObservationError)
      return Response.json(
        { error: "Installation outcome unconfirmed", requestId },
        { status: 503 },
      );
    throw cause;
  }
}

/** The tab icon of every Oyster page a person opens at the top level. */
const tabIcon = `<link rel="icon" type="image/svg+xml" href="${fungiFaviconHref}">`;

/**
 * Create the Oyster App server: a Hono app that installs App Releases, serves
 * their UI, forwards their backend requests and methods to their Instances,
 * and mounts the host's MCP endpoint. The host's adapters decide where state
 * lives and who may sign in.
 */
export function createOyster(host: OysterHost): Hono<OysterEnv> {
  const limits = guestLimits(host.guestLimits);
  const app = new Hono<OysterEnv>();
  const releaseOf = releaseCache(host.artifacts);
  const operationDescriptors = host.capabilities ?? [];
  const gateFacts = (
    installation: Installation,
    release: VerifiedRelease,
    principal: OysterPrincipal,
  ) => hostGateFacts(host, installation, release, principal);
  // Current approval for the home shell's code, read on every entry request.
  const shellApproved = async (
    installation: Installation,
    release: VerifiedRelease,
  ) => {
    const declaration = release.declaration ?? emptyAppDeclaration;
    return (
      grantsFor(
        {
          status: installation.status,
          authority: installation.authority,
          artifactDigest: installation.release.artifact.artifactDigest,
        },
        declaration,
        await deriveDeclaredOperations(
          installation.release,
          declaration,
          operationDescriptors,
        ),
        "team.workbenchHost",
      ) !== null
    );
  };
  const reduceInstallation = async (
    current: Installation | null,
    command: InstallationCommand,
    release: VerifiedRelease,
    principal: OysterPrincipal,
    identity: Pick<Installation, "installationId" | "instanceId">,
  ) => {
    const context = invocationCallerContext(principal, host.computerId ?? null);
    const declaration = release.declaration ?? emptyAppDeclaration;
    return applyInstallationCommand(current, command, {
      by: context.actor,
      role: context.role ?? null,
      expectedVersion: current?.authority.authorityVersion ?? null,
      declaration,
      declaredOperations: await deriveDeclaredOperations(
        release.release,
        declaration,
        operationDescriptors,
      ),
      now: Date.now(),
      identity,
    });
  };

  const title = host.title ?? "Oyster";
  const asset = async (name: string, contentType: string, source: string) => ({
    path: `/_oyster/assets/${(await sha256(new TextEncoder().encode(source))).slice(7)}/${name}`,
    contentType,
    source,
  });
  const prepareAssets = async () => {
    const {
      pageScript,
      publicHomeScript,
      grantConsentScript,
      fontStyles,
      loginFontStyles,
      shellStyles,
    } = await (host.pageAssets ?? loadPageAssets)();
    return Promise.all([
      asset(
        "page.js",
        "text/javascript; charset=utf-8",
        host.pageScript ?? pageScript,
      ),
      asset(
        "public-home.js",
        "text/javascript; charset=utf-8",
        publicHomeScript,
      ),
      asset(
        "grant-consent.js",
        "text/javascript; charset=utf-8",
        grantConsentScript,
      ),
      asset("fonts.css", "text/css; charset=utf-8", fontStyles),
      asset("login-fonts.css", "text/css; charset=utf-8", loginFontStyles),
      asset("styles.css", "text/css; charset=utf-8", shellStyles),
    ]).then(([page, publicHome, grantConsent, fonts, loginFonts, styles]) => ({
      page,
      publicHome,
      grantConsent,
      fonts,
      loginFonts,
      styles,
    }));
  };
  let preparedAssets: ReturnType<typeof prepareAssets> | undefined;
  const assets = () =>
    (preparedAssets ??= prepareAssets().catch((cause: unknown) => {
      preparedAssets = undefined;
      throw cause instanceof PageAssetsLoadError
        ? cause
        : new PageAssetsLoadError(cause);
    }));

  // The home page imports this host-owned entry, never the Release module's
  // own URL: released Oyster 0.2.0 served that URL immutable, so a browser may
  // hold a copy it would import without a request. The entry is never cached
  // and rechecks current approval before it names the module.
  app.get(
    `/ui-entry/:installationId/:releaseId${shellModuleAssetPath}`,
    async (context) => {
      const installation = await host.installations.get(
        context.req.param("installationId"),
      );
      if (
        installation?.status !== "enabled" ||
        installation.release.releaseId !== context.req.param("releaseId")
      )
        return noStoreRefusal(404, "Not found");
      const release = await releaseOf(installation.release);
      if (
        release.ui?.kind !== "assets" ||
        shellModuleAsset(release.ui.build) === undefined
      )
        return noStoreRefusal(404, "Not found");
      if (!(await shellApproved(installation, release)))
        return noStoreRefusal(403, "not_approved");
      const module = `/ui/${installation.installationId}/${installation.release.releaseId}${shellModuleAssetPath}`;
      return new Response(`export * from ${JSON.stringify(module)};\n`, {
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    },
  );

  // App UI: digest-pinned, sandboxed, and readable without a session because
  // the opaque-origin frame cannot carry one.
  app.get("/ui/:installationId/:releaseId/*", async (context) => {
    const installation = await host.installations.get(
      context.req.param("installationId"),
    );
    if (
      installation?.status !== "enabled" ||
      installation.release.releaseId !== context.req.param("releaseId")
    )
      return refusal(404, "Not found");
    const release = await releaseOf(installation.release);
    const prefix = `/ui/${installation.installationId}/${installation.release.releaseId}`;
    const path = new URL(context.req.url).pathname.slice(prefix.length) || "/";
    const origin = new URL(context.req.url).origin;
    if (release.ui === null) return refusal(404, "This App has no UI");
    if (release.ui.kind === "html") {
      if (path !== "/") return refusal(404, "Not found");
      const bytes = await readVerified(
        host.artifacts,
        release.ui.artifactRef,
        release.ui.digest,
      );
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors ${origin}; base-uri 'none'; form-action 'none'; sandbox ${appSandbox}`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    }
    const wanted = path === "/" ? "/index.html" : path;
    const asset = release.ui.build.assets.find((item) => item.path === wanted);
    if (asset === undefined) return refusal(404, "Not found");
    // The Release's shell module is read only through the host's entry, but
    // keeps the same per-request check; other UI assets stay digest-cacheable.
    const shellEntry = wanted === shellModuleAssetPath;
    if (shellEntry && !(await shellApproved(installation, release)))
      return noStoreRefusal(403, "not_approved");
    const bytes = await readVerified(
      host.artifacts,
      asset.artifactRef,
      asset.digest,
    );
    const scope = `${origin}${prefix}/`;
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": asset.contentType,
        "Content-Security-Policy": `default-src 'none'; script-src ${scope} 'wasm-unsafe-eval'; style-src ${scope} 'unsafe-inline'; img-src ${scope} blob: data:; media-src blob:; font-src ${scope} data:; connect-src data: ${scope}; worker-src blob:; frame-src 'none'; frame-ancestors ${origin}; base-uri 'none'; form-action 'none'; sandbox ${appSandbox}`,
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": shellEntry
          ? "no-store"
          : "public, max-age=31536000, immutable",
      },
    });
  });

  app.get("/_oyster/assets/*", async (context) => {
    const wanted = new URL(context.req.url).pathname;
    const found = Object.values(await assets()).find(
      ({ path }) => path === wanted,
    );
    if (found === undefined) return refusal(404, "Not found");
    return new Response(found.source, {
      headers: {
        "Content-Type": found.contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.get("/login", async () => {
    const { loginFonts, styles } = await assets();
    const form = renderToStaticMarkup(
      createElement(
        CenteredCard,
        null,
        createElement(
          CardHeader,
          null,
          createElement(CardTitle, { level: 2 }, "Sign in"),
        ),
        createElement(
          CardContent,
          null,
          createElement(
            Form,
            { method: "post", action: "/login" },
            createElement(Field, {
              label: "Owner key",
              required: true,
              children: createElement(Input, {
                name: "key",
                type: "password",
                autoComplete: "current-password",
                required: true,
              }),
            }),
            createElement(
              FormFooter,
              { layout: "stretch", divider: false },
              createElement(Button, { type: "submit" }, "Sign in"),
            ),
          ),
        ),
      ),
    );
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in · ${escapeHtml(title)}</title>${tabIcon}<link rel="stylesheet" href="${styles.path}"><link rel="stylesheet" href="${loginFonts.path}"></head><body class="px-lg">${form}</body></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  });
  app.post("/login", (context) =>
    host.auth.login === undefined
      ? refusal(404, "Sign-in is not available")
      : host.auth.login(context.req.raw),
  );

  if (host.mcp !== undefined) {
    const mcp = host.mcp;
    app.all("/mcp", (context) => mcp.handleRequest(context.req.raw));
  }

  if (host.git !== undefined) {
    const git = host.git;
    app.route(
      "/",
      createGitDoor({
        authenticate: async (request, target) => {
          // A Workflow Git pass header is admitted only by the pass port,
          // never as a session or key.
          const presented = presentedGitKey(request);
          if (
            presented.kind === "key" &&
            presented.value.startsWith(workflowGitPassPrefix)
          )
            return git.workflowPass === undefined
              ? null
              : git.workflowPass(presented.value, target);
          // A build clone pass likewise reaches only the build pass port.
          if (
            presented.kind === "key" &&
            presented.value.startsWith(buildGitPassPrefix)
          )
            return git.buildPass === undefined
              ? null
              : git.buildPass(presented.value, target);
          const result = await host.auth.authenticate(request);
          return result.kind === "admitted"
            ? git.writerOf(result.principal)
            : null;
        },
        isPublic: async (installationId) =>
          (await host.installations.get(installationId))?.visibility ===
          "public",
        git: async (installationId) => {
          const installation = await host.installations.get(installationId);
          if (installation?.status !== "enabled") return null;
          return git.git(installation);
        },
      }),
    );
  }
  // A public installation's page and read methods admit anonymous visitors.
  const visitor: OysterVisitor = { actor: { kind: "visitor" } };
  const visitorRoute = /^\/apps\/([^/]+)\/(?:|methods\/([A-Za-z0-9_.]+))$/u;
  const visitorMayReach = async (request: Request) => {
    const match = visitorRoute.exec(new URL(request.url).pathname);
    if (match === null) return null;
    const [, installationId = "", method] = match;
    const page = method === undefined;
    if (page ? request.method !== "GET" : request.method !== "POST")
      return null;
    const installation = await host.installations.get(installationId);
    if (
      installation?.status !== "enabled" ||
      installation.visibility !== "public"
    )
      return null;
    if (page) return installation;
    const release = await releaseOf(installation.release);
    return release.api?.methods[method]?.effect === "read"
      ? installation
      : null;
  };

  // The public home and public App reads admit visitors; other routes require authentication.
  app.use("*", async (context, next) => {
    const result = await host.auth.authenticate(context.req.raw);
    const installation =
      result.kind === "refused" ? await visitorMayReach(context.req.raw) : null;
    if (
      result.kind === "refused" &&
      (result.status === 401 || result.status === 403) &&
      ((context.req.method === "GET" && context.req.path === "/") ||
        installation !== null)
    ) {
      if (installation !== null) context.set("installation", installation);
      context.set("principal", visitor);
      await next();
      return undefined;
    }
    if (result.kind === "refused") {
      const accept = context.req.header("Accept") ?? "";
      if (
        (result.status === 401 || result.status === 403) &&
        context.req.method === "GET" &&
        accept.includes("text/html")
      )
        return context.redirect("/login");
      return refusal(
        result.status,
        "Sign in to use this Oyster",
        result.retryAfter,
      );
    }
    context.set("principal", result.principal);
    await next();
    return undefined;
  });

  const capabilityRoutes = (host.capabilities ?? []).flatMap((capability) =>
    Object.entries(capability.methods).map(([name, method]) => ({
      capability,
      operation: `route:${capability.id}:${name}`,
      method: method.method,
      kind: method.kind,
      matches: match(`${capability.base}${method.path}`, {
        end: method.kind !== "transport",
        sensitive: true,
      }),
    })),
  );
  // Capability routes run under the principal stamped above; they receive the
  // admission as their env and never authenticate again.
  app.use("*", async (context, next) => {
    const url = new URL(context.req.url);
    const candidates = capabilityRoutes.filter(
      (route) =>
        (route.method === "ANY" || route.method === context.req.method) &&
        route.matches(url.pathname),
    );
    if (candidates.length === 0) return next();
    const principal = context.get("principal");
    if (oysterPrincipalIsVisitor(principal))
      return refusal(401, "Sign in to use capabilities");
    const browserTransport =
      context.req.header("Upgrade")?.toLowerCase() === "websocket" &&
      context.req.header("Origin") === url.origin &&
      candidates.some((route) => route.kind === "transport");
    const installationId =
      context.req.header("X-Oyster-Installation") ??
      (browserTransport ? url.searchParams.get("oysterInstallation") : null);
    const installation =
      installationId === null
        ? null
        : await host.installations.get(installationId);
    if (installation?.status !== "enabled")
      return refusal(403, "Capability permission denied");
    const facts = await gateFacts(
      installation,
      await releaseOf(installation.release),
      principal,
    );
    for (const { capability, operation } of candidates) {
      if (
        admits(facts, {
          kind: "capability-route",
          capability: capability.permission,
          operation,
        }).kind === "refused"
      )
        continue;
      url.pathname = `/${url.pathname.slice(capability.base.length)}`;
      return capability.routes.fetch(new Request(url, context.req.raw), {
        principal,
        installation,
      });
    }
    return refusal(403, "Capability permission denied");
  });

  app.get("/", async (context) => {
    const publicHome = context.get("principal").actor.kind === "visitor";
    if (!publicHome && host.homeInstallationId !== undefined) {
      const home = await host.installations.get(host.homeInstallationId);
      if (home?.status === "enabled")
        return context.redirect(
          `/apps/${encodeURIComponent(home.installationId)}/`,
        );
    }
    const installations = (await host.installations.list()).filter(
      (installation) =>
        installation.status === "enabled" &&
        (!publicHome || installation.visibility === "public"),
    );
    if (publicHome) {
      const apps: {
        href: string;
        displayName: string;
        icon: string | null;
      }[] = [];
      for (const installation of installations) {
        const release = await releaseOf(installation.release);
        if (release.ui === null) continue;
        apps.push({
          href: `/apps/${encodeURIComponent(installation.installationId)}/`,
          displayName: release.declaration?.displayName ?? "App",
          icon: release.declaration?.icon ?? null,
        });
      }
      const config = JSON.stringify({ title, apps }).replaceAll("<", "\\u003c");
      return new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>${tabIcon}<link rel="stylesheet" href="${(await assets()).fonts.path}"><style>html,body{margin:0;min-height:100%;font-family:var(--font-sans);background:var(--color-base-100);color:var(--color-base-content)}#oyster-public-home{min-height:100vh;display:flex;flex-direction:column}</style><div id="oyster-public-home"></div><script type="application/json" id="oyster-public-config">${config}</script><script type="module" src="${(await assets()).publicHome.path}"></script>`,
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy":
              "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        },
      );
    }
    const items = installations
      .map(
        (installation) =>
          `<li><a href="/apps/${escapeHtml(installation.installationId)}/">${escapeHtml(installation.installationId)}</a> <small>${escapeHtml(installation.release.releaseId)}</small>${oysterPrincipalIsOwner(context.get("principal")) ? ` <a href="/api/installations/${encodeURIComponent(installation.installationId)}/grants">App access</a>` : ""}</li>`,
      )
      .join("");
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>${tabIcon}<h1>${escapeHtml(title)}</h1><ul>${items || "<li>No Apps installed yet.</li><li>Install Apps with <code>npx oyster install-apps</code></li>"}</ul>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  });

  app.use("/api/*", async (context, next) => {
    if (!oysterPrincipalIsOwner(context.get("principal")))
      return refusal(403, "Only the owner manages this Oyster");
    await next();
    return undefined;
  });

  app.put("/api/installations/:installationId/visibility", async (context) => {
    const generation = await host.installations.generation();
    const current = await host.installations.get(
      context.req.param("installationId"),
    );
    if (current === null || current.status === "deleted")
      return refusal(404, "Not found");
    const body = Schema.decodeUnknownOption(visibilitySchema)(
      await context.req.json(),
    );
    if (body._tag === "None") return refusal(400, "Invalid visibility");
    const update = await reduceInstallation(
      current,
      { kind: "set-visibility", visibility: body.value.visibility },
      await releaseOf(current.release),
      context.get("principal"),
      current,
    );
    if (Result.isFailure(update)) return refusal(409, update.failure.code);
    const next = update.success.next;
    const release = await releaseOf(current.release);
    const refused = await prepare(next, release);
    if (refused !== null) return refused;
    const commit = await host.installations.compareAndPut(
      next,
      current.authority.authorityVersion,
      generation,
    );
    if (!commit.ok) return refusal(409, commit.code);
    const activationRefusal = await apply(next, release);
    if (activationRefusal !== null) return activationRefusal;
    return Response.json(next);
  });

  if (host.ownerRoutes !== undefined) {
    const ownerRoutes = host.ownerRoutes;
    const owned = new Hono<OysterEnv>();
    owned.use("/api/*", async (context, next) => {
      if (!oysterPrincipalIsOwner(context.get("principal")))
        return refusal(403, "Owner only");
      await next();
      return undefined;
    });
    owned.route("/", ownerRoutes);
    app.route("/", owned);
  }

  app.get("/api/workbench/directory", async (context) => {
    if (!oysterPrincipalIsOwner(context.get("principal")))
      return refusal(403, "Owner only");
    if (host.workbench === undefined) return refusal(404, "Not found");
    let directory = await host.workbench.directory();
    if (host.computerId !== undefined)
      directory = {
        ...directory,
        computer: { computerId: host.computerId, name: host.computerId },
      };
    return Response.json(directory, {
      headers: { "Cache-Control": "no-store" },
    });
  });
  app.all(
    "/api/workbench/storage/:installationId/:operation",
    async (context) => {
      const principal = context.get("principal");
      if (!oysterPrincipalIsOwner(principal)) return refusal(403, "Owner only");
      const workbench = host.workbench;
      if (workbench === undefined) return refusal(404, "Not found");
      const view = workbench.storage(
        context.req.param("installationId"),
        oysterPrincipalId(principal),
      );
      const operation = context.req.param("operation");
      if (
        (operation === "read" || operation === "events") &&
        context.req.method === "GET"
      ) {
        const key = Schema.decodeUnknownOption(appStorageKeyNameSchema)(
          context.req.query("key"),
        );
        if (key._tag === "None") return refusal(400, "Invalid storage key");
        return operation === "read"
          ? Response.json(await view.read(key.value))
          : view.events(key.value);
      }
      if (
        (operation === "write" || operation === "reset") &&
        context.req.method === "POST"
      ) {
        if (operation === "write") {
          const input = Schema.decodeUnknownOption(appStorageWriteSchema, {
            onExcessProperty: "error",
          })(await context.req.json());
          return input._tag === "None"
            ? refusal(400, "Invalid storage write")
            : Response.json(await view.write(input.value));
        }
        const input = Schema.decodeUnknownOption(appStorageResetSchema, {
          onExcessProperty: "error",
        })(await context.req.json());
        return input._tag === "None"
          ? refusal(400, "Invalid storage reset")
          : Response.json(await view.reset(input.value));
      }
      return refusal(404, "Not found");
    },
  );

  app.get("/api/installations", async () =>
    Response.json(await host.installations.list()),
  );

  app.put("/api/artifacts/:artifactRef", async (context) => {
    let artifactRef;
    try {
      artifactRef = parseArtifactRef(context.req.param("artifactRef"));
    } catch {
      return refusal(400, "Invalid artifact reference");
    }
    const expected = context.req.query("digest");
    const bytes = new Uint8Array(await context.req.arrayBuffer());
    if (expected === undefined || (await sha256(bytes)) !== expected)
      return refusal(422, "Artifact bytes do not match the digest");
    await host.artifacts.put(artifactRef, bytes);
    return new Response(null, { status: 204 });
  });

  const prepare = async (
    installation: Installation,
    verifiedRelease: VerifiedRelease,
  ) => {
    if (verifiedRelease.backend === null) return null;
    const result = await host.instances
      .get(selectionOf(installation).instanceId, limits)
      .prepare(
        { ...selectionOf(installation), status: installation.status },
        installation.release,
      );
    return result.ok ? null : instanceRefusal(result.code, result.causeClass);
  };
  const apply = async (
    installation: Installation,
    verifiedRelease: VerifiedRelease,
  ) => {
    if (verifiedRelease.backend === null) return null;
    const result = await host.instances
      .get(selectionOf(installation).instanceId, limits)
      .apply(
        { ...selectionOf(installation), status: installation.status },
        installation.release,
      );
    return result.ok ? null : instanceRefusal(result.code, result.causeClass);
  };

  app.post("/api/installations", async (context) => {
    let request;
    let release;
    try {
      request = Schema.decodeUnknownSync(installRequestSchema)(
        await context.req.json(),
      );
      release = parseRelease(request.release);
    } catch {
      return refusal(400, "Invalid install request");
    }
    const installationId =
      request.installationId ?? release.appId.replaceAll("_", "-");
    if (!installationIdSchema.safeParse(installationId).success)
      return refusal(400, "Invalid installation id");
    const key = installationRequestIdSchema.safeParse(
      context.req.header("Idempotency-Key"),
    );
    if (!key.success)
      return refusal(400, "Invalid installation request identity");
    const admitted = await admitInstallation(
      host,
      installationId,
      release,
      context.get("principal"),
      "install-or-remint",
      context.req.raw.headers.has("X-Oyster-Installation")
        ? "app"
        : "owner-direct",
      key.data,
    );
    return admitted instanceof Response
      ? admitted
      : Response.json(admitted, { status: 202 });
  });

  app.get("/api/installations/:installationId/status", async (context) => {
    if (
      !oysterPrincipalIsOwner(context.get("principal")) ||
      context.req.raw.headers.has("X-Oyster-Installation")
    )
      return refusal(403, "Owner only");
    const key = installationRequestIdSchema.safeParse(
      context.req.query("requestId"),
    );
    if (!key.success)
      return refusal(400, "Invalid installation request identity");
    const operations = host.installations.operations;
    if (operations === undefined)
      return refusal(503, "Installation commands unavailable");
    try {
      const operation = await operations.read(
        key.data,
        context.req.param("installationId"),
      );
      return operation === null
        ? refusal(404, "Installation request not found")
        : Response.json(operation);
    } catch (cause) {
      if (cause instanceof InstallationOperationError)
        return installationOperationRefusal(cause);
      throw cause;
    }
  });

  app.get("/api/installations/:installationId/grants", async (context) => {
    if (context.req.raw.headers.has("X-Oyster-Installation"))
      return refusal(403, "Owner direct only");
    const generation = await host.installations.generation();
    const current = await host.installations.get(
      context.req.param("installationId"),
    );
    if (current === null || current.status === "deleted")
      return refusal(404, "Not found");
    const verified = await releaseOf(current.release);
    const declaration = verified.declaration ?? emptyAppDeclaration;
    const declared = await deriveDeclaredOperations(
      current.release,
      declaration,
      operationDescriptors,
    );
    const config = appPermissionPageSchema.parse({
      storeGeneration: generation,
      installationId: current.installationId,
      appId: current.appId,
      appName: declaration.displayName ?? current.installationId,
      artifactDigest: current.release.artifact.artifactDigest,
      permissions: {
        authority: current.authority,
        declaredOperations: declared,
      },
    });
    if (context.req.header("Accept")?.includes("application/json"))
      return Response.json(config, {
        headers: { "Cache-Control": "no-store" },
      });
    const encoded = JSON.stringify(config).replaceAll("<", "\\u003c");
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(config.appName)} permissions</title><link rel="stylesheet" href="${(await assets()).fonts.path}"><style>html,body{margin:0;min-height:100%;font-family:var(--font-sans);background:var(--color-base-100);color:var(--color-base-content)}</style><div id="oyster-consent"></div><script type="application/json" id="oyster-consent-config">${encoded}</script><script type="module" src="${(await assets()).grantConsent.path}"></script>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        },
      },
    );
  });

  app.put(
    "/api/installations/:installationId/grants",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => refusal(413, "Approval request too large"),
    }),
    async (context) => {
      // Capability-origin requests cannot become direct owner consent.
      if (context.req.raw.headers.has("X-Oyster-Installation"))
        return refusal(403, "Owner direct only");
      const principal = context.get("principal");
      if (!oysterPrincipalIsOwner(principal)) return refusal(403, "Owner only");
      const body = Schema.decodeUnknownOption(
        Schema.fromJsonString(Schema.Unknown),
      )(await context.req.text());
      if (body._tag === "None") return refusal(400, "Invalid approval");
      const parsed = permissionSaveSchema.safeParse(body.value);
      if (!parsed.success || parsed.data.command.kind !== "change-grants")
        return refusal(400, "Invalid approval");
      const generation = await host.installations.generation();
      if (generation !== parsed.data.storeGeneration)
        return refusal(409, "stale_authority");
      const current = await host.installations.get(
        context.req.param("installationId"),
      );
      if (current === null) return refusal(404, "Not found");
      // A retired installation's pins can never match a live record: the
      // page already offers a reload, which then finds the App gone.
      if (current.status === "deleted") return refusal(409, "stale_authority");
      if (
        current.authority.authorityVersion !== parsed.data.authorityVersion ||
        current.release.artifact.artifactDigest !== parsed.data.artifactDigest
      )
        return refusal(409, "stale_authority");
      const release = await releaseOf(current.release);
      const update = await reduceInstallation(
        current,
        parsed.data.command,
        release,
        principal,
        current,
      );
      if (Result.isFailure(update)) return refusal(409, update.failure.code);
      const preflightRefusal = await prepare(update.success.next, release);
      if (preflightRefusal !== null) return preflightRefusal;
      const commit = await host.installations.compareAndPut(
        update.success.next,
        parsed.data.authorityVersion,
        parsed.data.storeGeneration,
      );
      if (!commit.ok) return refusal(409, commit.code);
      const refused = await apply(update.success.next, release);
      if (refused !== null) return refused;
      return Response.json(update.success.next);
    },
  );

  app.put("/api/installations/:installationId/release", async (context) => {
    let release;
    try {
      release = parseRelease(await context.req.json());
    } catch {
      return refusal(400, "Invalid Release");
    }
    const key = installationRequestIdSchema.safeParse(
      context.req.header("Idempotency-Key") ??
        installationCommandIds.request.generate(),
    );
    if (!key.success)
      return refusal(400, "Invalid installation request identity");
    // PUT retains its completed-response meaning. Cancellation only stops this
    // observer; Watchdog's retained command continues independently.
    return installOrSelect(
      host,
      context.req.param("installationId"),
      release,
      context.get("principal"),
      "install-or-select",
      context.req.raw.headers.has("X-Oyster-Installation")
        ? "app"
        : "owner-direct",
      key.data,
      context.req.raw.signal,
    );
  });

  app.delete("/api/installations/:installationId", async (context) => {
    const generation = await host.installations.generation();
    const current = await host.installations.get(
      context.req.param("installationId"),
    );
    if (current === null || current.status === "deleted")
      return refusal(404, "Not found");
    const update = await reduceInstallation(
      current,
      { kind: "set-status", status: "deleted" },
      await releaseOf(current.release),
      context.get("principal"),
      current,
    );
    if (Result.isFailure(update)) return refusal(409, update.failure.code);
    const next = update.success.next;
    const release = await releaseOf(current.release);
    const refused = await prepare(next, release);
    if (refused !== null) return refused;
    const commit = await host.installations.compareAndPut(
      next,
      current.authority.authorityVersion,
      generation,
    );
    if (!commit.ok) return refusal(409, commit.code);
    const activationRefusal = await apply(next, release);
    if (activationRefusal !== null) return activationRefusal;
    return new Response(null, { status: 204 });
  });

  const enabled = async (context: Context<OysterEnv>) => {
    const installationId = context.req.param("installationId") ?? "";
    const resolved = context.get("installation");
    const installation =
      resolved?.installationId === installationId
        ? resolved
        : await host.installations.get(installationId);
    return installation?.status === "enabled" ? installation : null;
  };

  app.get("/apps/:installationId/", async (context) => {
    const installation = await enabled(context);
    if (installation === null) return refusal(404, "Not found");
    const release = await releaseOf(installation.release);
    const declaration = release.declaration;
    const principal = context.get("principal");
    const facts = await gateFacts(installation, release, principal);
    const capabilities: CapabilityDescriptor[] = [];
    for (const capability of host.capabilities ?? []) {
      const methods = Object.fromEntries(
        Object.entries(capability.methods).filter(
          ([name]) =>
            admits(facts, {
              kind: "capability-route",
              capability: capability.permission,
              operation: `route:${capability.id}:${name}`,
            }).kind === "admitted",
        ),
      );
      if (Object.keys(methods).length > 0) {
        const { id, version, base } = capability;

        capabilities.push({ id, version, base, methods });
      }
    }
    if (
      principal.actor.kind === "member" &&
      (declaration?.calls?.length ?? 0) > 0 &&
      declaration?.calls?.some((call) =>
        call.methods.some(
          (method) =>
            admits(facts, {
              kind: "capability-route",
              capability: "apps.call",
              operation: appCallOperation(call.appId, method),
            }).kind === "admitted",
        ),
      )
    ) {
      capabilities.push({
        ...appCallsDescriptor,
        base: `/apps/${encodeURIComponent(installation.installationId)}/calls/`,
      });
    }
    const workbench =
      oysterPrincipalIsOwner(principal) &&
      host.workbench !== undefined &&
      installation.installationId === host.homeInstallationId &&
      declaration?.capabilities.includes("team.workbenchHost") === true &&
      grantsFor(
        facts.installation,
        facts.declaration,
        facts.declaredOperations,
        "team.workbenchHost",
      ) !== null;
    const uiUrl = `/ui/${installation.installationId}/${installation.release.releaseId}/`;
    const config = {
      workbench,
      // The home shell's own code: the module its Release ships beside
      // index.html. Null when that Release ships none; the page then refuses.
      shellModuleUrl:
        workbench &&
        release.ui?.kind === "assets" &&
        shellModuleAsset(release.ui.build) !== undefined
          ? `/ui-entry/${installation.installationId}/${installation.release.releaseId}${shellModuleAssetPath}`
          : null,
      storage:
        oysterPrincipalIsOwner(principal) &&
        host.workbench !== undefined &&
        (declaration?.storage?.length ?? 0) > 0,
      appsOpen: declaration?.capabilities.includes("apps.open") === true,
      computerId: invocationCallerContext(principal, host.computerId ?? null)
        .computerId,

      authorityVersion: installation.authority.authorityVersion,
      capabilities,
      commands: declaration?.commands ?? [],
      icon: declaration?.icon ?? null,
      roles: declaration?.roles ?? [],
      installationId: installation.installationId,
      appId: installation.release.appId,
      releaseId: installation.release.releaseId,
      uiUrl,
      backendUrl: `/apps/${installation.installationId}/backend`,
      methodsUrl: `/apps/${installation.installationId}/methods/`,
    };
    if (context.req.header("Accept") === "application/json")
      return Response.json(config, {
        headers: { "Cache-Control": "no-store", Vary: "Accept" },
      });
    const head = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(installation.installationId)} · ${escapeHtml(title)}</title>${tabIcon}<link rel="stylesheet" href="${(await assets()).fonts.path}">`;
    const tail = `<script type="application/json" id="oyster-config">${JSON.stringify(config).replaceAll("<", "\\u003c")}</script><script type="module" src="${(await assets()).page.path}"></script>`;
    // The home shell is trusted: the host's page script renders it in this
    // top-level document, and it mounts each App's sandboxed frame inside
    // that App's window. Every other App page is only its one framed App;
    // desktop chrome belongs to the shell.
    return new Response(
      config.workbench
        ? `${head}<style>html,body,#oyster-shell{margin:0;height:100%}body{font-family:var(--font-sans)}</style><div id="oyster-shell"></div>${tail}`
        : `${head}<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style><iframe id="oyster-app" sandbox="${appSandbox}" src="${escapeHtml(config.uiUrl)}" title="${escapeHtml(installation.installationId)}"></iframe>${tail}`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          // worker-src would otherwise fall back to script-src 'self': trusted
          // shell code must not outlive revocation in a Worker or Service Worker.
          "Content-Security-Policy": `default-src 'none'; script-src 'self'; worker-src 'none'; style-src 'self' 'unsafe-inline'; font-src data:; frame-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        },
      },
    );
  });

  app.put("/apps/:installationId/backend", async (context) => {
    const principal = context.get("principal");
    if (oysterPrincipalIsVisitor(principal))
      return refusal(403, "Sign in to use this App");
    const installation = await enabled(context);
    if (installation === null) return refusal(404, "Not found");
    const release = await releaseOf(installation.release);
    const decision = admits(await gateFacts(installation, release, principal), {
      kind: "backend",
    });
    if (decision.kind === "refused") return refusal(403, decision.code);
    const body = await context.req.text();
    if (new TextEncoder().encode(body).byteLength > maxBackendBody)
      return refusal(413, "Request too large");
    const headers = new Headers({
      "Content-Type": "text/plain",
      [appBackendActorHeader]: oysterPrincipalId(principal),
    });
    if (host.computerId !== undefined)
      headers.set(appBackendComputerHeader, host.computerId);
    const request = new Request("https://app.internal/", {
      method: "PUT",
      headers,
      body,
    });
    const response = await host.instances
      .get(selectionOf(installation).instanceId, limits)
      .fetch(
        admittedCallerFacts(
          installation,
          release,
          invocationCallerContext(principal, host.computerId ?? null),
          decision.grants,
        ),
        request,
      );
    return appFacetResponse(response);
  });

  app.put("/apps/:installationId/gills", async (context) => {
    const caller = invocationCallerContext(
      context.get("principal"),
      host.computerId ?? null,
    );
    if (caller.actor.kind !== "member" || caller.role !== "owner")
      return refusal(403, "Owner only");
    const installation = await enabled(context);
    if (installation === null) return refusal(404, "Not found");
    const body = await context.req.text();
    if (new TextEncoder().encode(body).byteLength > maxBackendBody)
      return refusal(413, "Request too large");
    const decoded = Schema.decodeUnknownOption(
      Schema.fromJsonString(gillRequestSchema),
      { onExcessProperty: "error" },
    )(body);
    if (decoded._tag === "None") return refusal(400, "Invalid Gill request");
    const request = decoded.value;
    const release = await releaseOf(installation.release);
    const gill = release.declaration?.gills?.find(
      (item) => item.id === request.viewId,
    );
    if (gill === undefined || release.api === null || release.backend === null)
      return refusal(404, "Gill is not declared");
    if (installation.instanceId === null)
      return instanceRefusal("invalid_invocation_facts");
    const params = request.params ?? {};
    const declared = gill.params ?? [];
    if (
      Object.keys(params).some(
        (key) => !declared.some((param) => param.key === key),
      )
    )
      return refusal(400, "Undeclared Gill parameter");
    for (const param of declared) {
      if (
        param.kind === "repository" &&
        params[param.key] !== undefined &&
        !gitRepositoryNameSchema.safeParse(params[param.key]).success
      )
        return refusal(400, "Invalid repository parameter");
      if (
        param.kind === "computer" &&
        params[param.key] !== undefined &&
        params[param.key] !== host.computerId
      )
        return refusal(403, "Computer is not admitted");
    }
    const selected =
      request.options === undefined
        ? null
        : declared.find((param) => param.key === request.options);
    if (request.options !== undefined && selected === undefined)
      return refusal(400, "Undeclared Gill options");
    const source =
      selected === null || selected?.kind === "computer"
        ? gill.source
        : selected?.options;
    const method =
      source !== undefined && Object.hasOwn(release.api.methods, source)
        ? release.api.methods[source]
        : undefined;
    if (
      source === undefined ||
      method?.effect !== "read" ||
      !method.requires.every((capability) =>
        release.declaration?.capabilities.includes(capability),
      )
    )
      return refusal(403, "Gill source is not admitted");
    const current = await gateFacts(
      installation,
      release,
      context.get("principal"),
    );
    if (
      current.declaredOperations.digest !==
        installation.authority.declaredOperationsDigest ||
      current.declaredOperations.artifactDigest !==
        installation.release.artifact.artifactDigest
    )
      return refusal(403, "stale_authority");
    if (
      method.requires.some(
        (capability) =>
          grantsFor(
            {
              status: installation.status,
              authority: installation.authority,
              artifactDigest: installation.release.artifact.artifactDigest,
            },
            current.declaration,
            current.declaredOperations,
            capability,
          ) === null,
      )
    )
      return refusal(403, "requires_not_granted");
    if (selected?.kind === "computer")
      return Response.json({
        options:
          host.computerId === undefined
            ? []
            : [{ value: host.computerId, label: host.computerId }],
      });
    const missing = declared.find(
      (param) => param.required && !params[param.key],
    );
    if (request.options === undefined && missing !== undefined)
      return Response.json({
        viewId: gill.id,
        title: gill.title,
        state: "error",
        rows: [],
        reason: "params_required",
        error: `Choose a ${missing.kind}`,
      });
    const authority = invocationAuthorityOf(installation, release);
    const grants = scopedBindings(authority.grants, method, "read");
    const deadlineAt = Date.now() + APP_INVOCATION_CEILING_MS;
    const facts = invocationFacts.fromCaller(
      { ...authority, grants },
      caller,
      {
        deadlineAt,
        grantExpiresAt: deadlineAt,
      },
      { name: source, effect: "read" },
    );
    const { viewId, ...selectors } = request;
    const result = await host.instances
      .get(facts.instanceId, limits)
      .gill(facts, release.api, source, { id: viewId, ...selectors });
    if (!result.ok) return instanceRefusal(result.code, result.causeClass);
    try {
      const reply = decodeGillReply(result.value);
      return Response.json(
        "viewId" in reply ? decodeDeclaredGillResponse(reply, gill) : reply,
      );
    } catch (error) {
      return instanceRefusal("failed", causeClass(error));
    }
  });

  const executeMethod = async (
    installation: Installation,
    release: VerifiedRelease,
    principal: OysterPrincipal,
    name: string,
    request: Request,
    recheck?: () => Promise<OysterPrincipal | Response>,
  ): Promise<Response> => {
    if (recheck !== undefined) {
      const fresh = await recheck();
      if (fresh instanceof Response) return fresh;
      principal = fresh;
    }
    if (release.api === null)
      return refusal(404, "This App declares no methods");
    let input: OysterJson;
    try {
      input = await methodInput(request);
    } catch (error) {
      if (error instanceof MethodBodyTooLarge)
        return refusal(413, "Request too large");
      return refusal(400, "Method input must be JSON");
    }
    if (recheck !== undefined) {
      const fresh = await recheck();
      if (fresh instanceof Response) return fresh;
      principal = fresh;
    }
    const decision = admits(await gateFacts(installation, release, principal), {
      kind: "method",
      name: name,
      input,
      via: "ui",
    });
    if (decision.kind === "refused")
      return refusal(
        decision.code === "invalid_input" ? 400 : 403,
        decision.code,
      );
    const method = decision.method;
    if (method === undefined) return refusal(403, "not_declared");
    const result = await host.instances
      .get(selectionOf(installation).instanceId, limits)
      .call(
        await admittedMethodCallerFacts(
          host,
          installation,
          release,
          invocationCallerContext(principal, host.computerId ?? null),
          decision.grants,
          { name, effect: method.effect },
        ),
        release.api,
        name,
        input,
      );
    if (!result.ok) return instanceRefusal(result.code, result.causeClass);
    return methodResponse(result.value);
  };

  app.post("/apps/:installationId/methods/:name", async (context) => {
    const installation = await enabled(context);
    if (installation === null) return refusal(404, "Not found");
    return executeMethod(
      installation,
      await releaseOf(installation.release),
      context.get("principal"),
      context.req.param("name"),
      context.req.raw,
    );
  });

  app.post("/apps/:caller/calls/:appId/:method", async (context) => {
    const principal = context.get("principal");
    if (
      oysterPrincipalIsVisitor(principal) ||
      principal.actor.kind !== "member"
    )
      return refusal(403, "app_call_member_only");
    const caller = await host.installations.get(context.req.param("caller"));
    if (caller?.status !== "enabled") return refusal(404, "Not found");
    const appId = context.req.param("appId");
    const method = context.req.param("method");
    const allows = async (
      installation: Installation,
      member: OysterPrincipal,
    ) => {
      const release = await releaseOf(installation.release);
      if (
        !release.declaration?.calls?.some(
          (call) => call.appId === appId && call.methods.includes(method),
        )
      )
        return false;
      return (
        admits(await gateFacts(installation, release, member), {
          kind: "capability-route",
          capability: "apps.call",
          operation: appCallOperation(appId, method),
        }).kind === "admitted"
      );
    };
    if (!(await allows(caller, principal)))
      return refusal(403, "app_call_not_allowed");
    const targets = (await host.installations.list()).filter(
      (installation) =>
        installation.status === "enabled" &&
        installation.release.appId === appId,
    );
    if (targets.length !== 1)
      return refusal(
        409,
        targets.length === 0
          ? "app_call_target_unavailable"
          : "app_call_target_ambiguous",
      );
    const target = targets[0];
    if (target === undefined)
      return refusal(409, "app_call_target_unavailable");
    const release = await releaseOf(target.release);
    const admittedMember = invocationCallerContext(
      principal,
      host.computerId ?? null,
    );
    const recheck = async (): Promise<TenantPrincipal | Response> => {
      const fresh = await host.auth.resolve(admittedMember.actor);
      if (fresh === null) return refusal(403, "app_call_member_only");
      const currentMember = invocationCallerContext(
        fresh,
        host.computerId ?? null,
      );
      if (
        currentMember.actor.kind !== "member" ||
        currentMember.actor.memberId !== oysterPrincipalId(principal) ||
        currentMember.role !== admittedMember.role
      )
        return refusal(403, "app_call_member_only");
      const [currentCaller, currentTarget] = await Promise.all([
        host.installations.get(caller.installationId),
        host.installations.get(target.installationId),
      ]);
      if (
        currentCaller?.status !== "enabled" ||
        currentCaller.authority.authorityVersion !==
          caller.authority.authorityVersion ||
        currentCaller.release.artifact.artifactDigest !==
          caller.release.artifact.artifactDigest ||
        !(await allows(currentCaller, fresh))
      )
        return refusal(403, "app_call_not_allowed");
      if (
        currentTarget?.status !== "enabled" ||
        currentTarget.authority.authorityVersion !==
          target.authority.authorityVersion ||
        currentTarget.release.releaseId !== target.release.releaseId ||
        currentTarget.release.artifact.artifactDigest !==
          target.release.artifact.artifactDigest
      )
        return refusal(403, "stale_authority");
      return fresh;
    };
    return executeMethod(
      target,
      release,
      principal,
      method,
      context.req.raw,
      recheck,
    );
  });

  return app;
}
