import { Hono } from "hono";
import {
  attachedBackendId,
  hostedBackingSchema,
} from "@fungi.computer/computer/backing";
import {
  appMethodRefusalStatus,
  appMethodRefusedReplySchema,
  type AppMethodRefusedReply,
} from "@fungi.computer/agar/backend";
import * as Schema from "effect/Schema";
import {
  computerPortsSchema,
  type ComputerPorts,
} from "@fungi.computer/agar/computer";
import { verifyRelease } from "../host.js";
import { r2ArtifactStore } from "../workers.js";
import {
  createStandalonePreview,
  previewOrigins,
  previewSelectorSchema,
  PreviewRefused,
  type PreviewSelector,
} from "./preview.js";
import { standaloneTenancy, type StandaloneTenancyEnv } from "./tenancy.js";
import { Base64 } from "effect/encoding";
import * as z from "zod";
import {
  ComputerPortConflictError,
  computerByteReadReplySchema,
  computerProcessSchema,
  installationProcessScope,
  processStartInputSchema,
  processStartToolInputSchema,
  computerCapabilities,
  computerToolResultSchema,
  readOutputSchema,
} from "@fungi.computer/computer-contract";
import {
  ComputerDO as NativeComputerDO,
  ComputerOperationConflictError,
  type AttachedBackend,
  type ComputerEnv,
  type ComputerFilesRpc,
} from "@fungi.computer/computer";
import {
  patchInputSchema,
  patchOutputSchema,
} from "@fungi.computer/knapsack/files-patch";
import {
  ComputerFileConflict,
  computerExecutionRequestSchema,
  computerValueSchema,
  computerPortInputSchema,
  listInputSchema,
  listOutputSchema,
  readBytesInputSchema,
  writeInputSchema,
  replaceInputSchema,
  writeOutputSchema,
  mkdirOutputSchema,
  computerPortsOutputSchema,
  computerPortOutputSchema,
  computerPortRemovalOutputSchema,
  processListOutputSchema,
  processKillOutputSchema,
  computerOperationResultSchema,
  mintComputerRequestId,
  processIdInputSchema,
  type ComputerExecutionHostHooks,
  type ComputerValue,
} from "@fungi.computer/computer-contract";
import {
  workflowGitExecutionEnvironment,
  workflowGitPassGrantSchema,
  type WorkflowGitCredential,
  type WorkflowGitPassGrant,
} from "@fungi.computer/braid/runtime";
import {
  checkComputerGrant,
  computerActionSchema,
  computerGrantSchema,
  createFleetBacking,
  FleetGrantRefused,
  FleetLifecycle,
  type ComputerAction,
  type ComputerGrant,
} from "@fungi.computer/computer/fleet";
import { AppInstanceError, selectionOf } from "../index.js";
import { type FrameBindingMethods } from "../cloudflare.js";
import type { InvocationFrame } from "../invocation.js";
import { computerSlots } from "../computer.js";
import {
  oysterPrincipalId,
  oysterPrincipalIsOwner,
  type CapabilityEnv,
  type OysterCapability,
  type OysterPrincipal,
} from "../host.js";
import type {
  OysterBindingRow,
  OysterInvocationHost,
  OysterWorkerEnv,
  OysterWorkspace,
} from "../workers.js";
import type { OysterKeys, OysterKeysLivePort } from "../workers-git.js";
import { keyAllowsComputerUse } from "../keys.js";
import {
  oysterAppBuildTimeoutMs,
  type OysterBuildBackend,
} from "../app-builds.js";
import type { StandaloneRegistry } from "./registry.js";
import type { TenantScope } from "../tenant.js";
import {
  workflowGitStepGrant,
  type WorkflowGitStepEnv,
} from "./workflow-binding.js";

/** Native bindings selected by the standalone composition, never by an App. */
export type StandaloneComputerEnv = ComputerEnv &
  Pick<OysterWorkerEnv, "RELEASES"> &
  Readonly<{
    OYSTER_COMPUTER_ID: string;
    COMPUTER: DurableObjectNamespace<ComputerDO>;
    /** The registry owns installations and this Computer's App build jobs. */
    REGISTRY: DurableObjectNamespace<StandaloneRegistry>;
    /** This single-tenant standalone's own named keys, for the `computer.use` grant check. */
    KEYS: DurableObjectNamespace<OysterKeys>;
    OYSTER_ORIGIN?: string;
    OYSTER_PREVIEW_ORIGIN?: string;
    OYSTER_OWNER_NAME?: string;
  }>;

/** Finite native results cross the Workers RPC mapping without recursive JSON types. */
export type StandaloneComputerResult =
  | z.output<typeof listOutputSchema>
  | Readonly<{
      path: string;
      byteOffset: number;
      content: string;
      encoding: "base64";
      truncated: boolean;
    }>
  | Readonly<{ error: "conflict" }>
  | z.output<typeof writeOutputSchema>
  | z.output<typeof mkdirOutputSchema>
  | z.output<typeof computerPortsOutputSchema>
  | z.output<typeof computerPortOutputSchema>
  | z.output<typeof computerPortRemovalOutputSchema>
  | z.output<typeof processListOutputSchema>
  | z.output<typeof processKillOutputSchema>
  | z.output<typeof computerProcessSchema>
  | ComputerPorts["ports"][number]
  | z.output<typeof computerOperationResultSchema>
  | z.output<typeof readOutputSchema>
  | z.output<typeof computerToolResultSchema>;

const missingFile = z.lazy(() => z.object({ code: z.literal("ENOENT") }));
const workspaceId = computerGrantSchema.shape.computerId;
const command = computerExecutionRequestSchema({ maximumTimeMs: 45_000 }).omit({
  requestId: true,
  backend: true,
});
const empty = z.strictObject({});
// Frame-bound callers (Agent/Workflow methods) never supply requestId or
// requestScope; the host mints both from the invoking frame's idempotency
// key and installation (see computerInvocation's "processStart" case).
const processStart = processStartInputSchema.omit({
  requestId: true,
  requestScope: true,
});
// The Oyster capability HTTP route has no per-field header mapping (the
// generic page capability handle in packages/oyster/src/page/capabilities.ts
// just JSON-encodes the whole input), so requestId travels in the body here;
// requestScope still stays host-minted, never client-supplied.
const processStartHttpBody = processStartInputSchema.omit({
  requestScope: true,
});
const processStartReply = z.lazy(() =>
  z.union([
    computerProcessSchema,
    z.strictObject({ error: z.literal("conflict") }),
  ]),
);
const bindingWrite = writeInputSchema.extend({
  expectedContent: replaceInputSchema.shape.expectedContent.optional(),
});
const allActions = new Set(computerActionSchema.options);
const terminalGrantHeader = "X-Oyster-Computer-Grant";
const terminalGrant = computerGrantSchema.extend({
  actions: z
    .array(computerActionSchema)
    .transform((actions) => new Set(actions)),
});

function grant(computerId: string, actor: string): ComputerGrant {
  return {
    computerId,
    actions: allActions,
    expiresAt: Date.now() + 60_000,
    provenance: { actor },
  };
}

/**
 * The Computer grant actor for an admitted owner or member; null for an
 * Agent or visitor. A key only when its own `computer.use` grant allows it
 * -- off by default, so an unknown, revoked, expired or suspended key, or
 * one issued with no Computer grant, is also null. `keysLive` is the one
 * owner-checked port every caller reaches a key's liveness through (the
 * same one `host.keys.live` is); a caller with none -- the Media binding's
 * own workspace selection never calls through to a principal at all --
 * fails every team-key closed rather than falling back to an unchecked read.
 */
async function computerActor(
  principal: OysterPrincipal,
  keysLive: OysterKeysLivePort | undefined,
): Promise<string | null> {
  if (principal.actor.kind === "visitor" || principal.actor.kind === "agent")
    return null;
  if (principal.actor.kind === "team-key") {
    const key =
      keysLive === undefined ? null : await keysLive(principal.actor.keyId);
    if (key === null || !keyAllowsComputerUse(key)) return null;
  }
  return JSON.stringify(principal);
}

/** Each advertised Computer tool, the grant action that accepts it, and its result. */
const computerTools = {
  read: { action: "files.read", output: readOutputSchema },
  list: { action: "files.list", output: listOutputSchema },
  write: { action: "files.write", output: writeOutputSchema },
  mkdir: { action: "mkdir", output: mkdirOutputSchema },
  bash: { action: "bash", output: computerToolResultSchema },
  exec: { action: "exec", output: computerToolResultSchema },
  start_process: { action: "processStart", output: computerProcessSchema },
  list_processes: { action: "processList", output: processListOutputSchema },
  kill_process: { action: "processKill", output: processKillOutputSchema },
} as const satisfies Record<
  string,
  Readonly<{ action: ComputerAction; output: z.ZodType }>
>;
const computerTool = z.enum([
  "read",
  "list",
  "write",
  "mkdir",
  "bash",
  "exec",
  "start_process",
  "list_processes",
  "kill_process",
]);

/**
 * A port-preview listing, or the typed refusal the owner route presents with
 * {@link appMethodRefusalStatus}. A refusal never escapes as a 500.
 */
export type ComputerPortPreviewsReply =
  Readonly<{ kind: "ok"; value: ComputerPorts }> | AppMethodRefusedReply;

const previewRefusal = appMethodRefusedReplySchema.parse({
  kind: "refused",
  code: "forbidden",
  message:
    "Port previews belong to the current owner of an enabled installation.",
});

/**
 * The Computer owner's bindings: the standalone Computer env plus the tenancy
 * registry that names the live canonical owner a port preview must belong to.
 */
export type StandaloneComputerOwnerEnv = StandaloneComputerEnv &
  StandaloneTenancyEnv &
  Readonly<{
    /** Each Workflows library's run owner issues its own Git credentials. */
    WORKFLOW_RUNS: Readonly<{
      getByName(libraryId: string): StandaloneWorkflowGitIssuer;
    }>;
  }>;

/** The library run owner's per-invocation Workflow Git credential ports. */
export type StandaloneWorkflowGitIssuer = Readonly<{
  issueWorkflowGit(
    invocationId: string,
    grant: WorkflowGitPassGrant,
  ): Promise<WorkflowGitCredential>;
  renewWorkflowGit(
    invocationId: string,
    grant: WorkflowGitPassGrant,
  ): Promise<void>;
  closeWorkflowGit(
    invocationId: string,
    grant: WorkflowGitPassGrant,
  ): Promise<void>;
}>;

/** The non-secret context a native command carries for its admitted Git step. */
const workflowGitExecutionContextSchema = z.lazy(() =>
  z.strictObject({ workflowGit: workflowGitPassGrantSchema }),
);

/** The Worker's terminal route reaches this native fetch through the stub. */
export type ComputerFetch = {
  fetch(request: Request): Promise<Response>;
};

/** The additional native doors an attached Agent may use on this Computer. */
export type StandaloneAgentComputerRpc = ComputerFilesRpc &
  Readonly<{
    tool(
      authority: ComputerGrant,
      capabilityId: string,
      input: ComputerValue,
    ): Promise<StandaloneComputerResult>;
    filePatch(
      authority: ComputerGrant,
      input: z.output<typeof patchInputSchema>,
    ): Promise<z.output<typeof patchOutputSchema>>;
  }>;

/** Durable workspace and existing backings, with fleet checks at native acceptance. */
export class ComputerDO
  extends NativeComputerDO
  implements ComputerFetch, StandaloneAgentComputerRpc
{
  #backends: readonly AttachedBackend[] | undefined;
  #preview: ReturnType<typeof createStandalonePreview> | undefined;
  #lifecycle: FleetLifecycle | undefined;

  constructor(
    state: DurableObjectState,
    private readonly previewBindings: StandaloneComputerOwnerEnv,
  ) {
    // The Computer's HTTP(S) egress goes only through the gateway the
    // standalone Worker exports beside this object.
    super(state, {
      ...previewBindings,
      COMPUTER_EGRESS: (options) =>
        state.exports.OysterComputerEgress({ props: options.props }),
    });
  }

  #fleetLifecycle(): FleetLifecycle {
    if (this.#lifecycle !== undefined) return this.#lifecycle;
    this.#lifecycle = new FleetLifecycle({
      storage: this.state.storage,
      alarm: this.state,
      computerId: this.#id(),
      runtimeWatchMs: undefined,
      backend: {
        state: this.state,
        onBoxVmHost: (hostId) => this.onBoxVmHost(hostId),
        hostedContainerHost: (backing) => this.hostedContainerHost(backing),
        readyWorkspace: () => this.readyWorkspace(),
        workspace: () => this.workspace(),
        syncRecycledWorkspace: async (backing) => {
          const workspace = await this.readyWorkspace();
          const id = attachedBackendId(backing);
          await workspace.push(id);
          await workspace.pull(id);
        },
        attachedBackends: () => this.attachedBackends(),
        describeBackends: () => this.describeBackends(),
        requireHostedRoute: () => this.requireHostedRoute(),
        containerRunning: (backing) => this.containerRunning(backing),
        // Standalone boots use the native host directly, not Hub's admission queue.
        vmQueuePosition: () => Promise.resolve(null),
      },
    });
    return this.#lifecycle;
  }

  /** Install the fleet's creation projection before exposing its new identity. */
  initializeFleetBackings(backings: readonly AttachedBackend[]): void {
    const owner = createFleetBacking(this.state.storage);
    owner.ensure();
    this.#backends = owner.computerCreated(
      this.#id(),
      z.array(hostedBackingSchema).parse(backings),
    ).backends;
  }

  /** An admitted fleet control starts exactly this Computer's hosted backend. */
  async startHostedComputer(authority: ComputerGrant) {
    this.#accept(authority, "start");
    return this.#fleetLifecycle().startHostedComputer(async (_backing, run) => {
      this.#accept(authority, "start");
      await run();
    });
  }

  /** Observe an admitted fleet Computer without starting its backend. */
  readHostedComputerState(authority: ComputerGrant) {
    this.#accept(authority, "start");
    return this.#fleetLifecycle().readComputerState();
  }

  #previewGrant(ownerId: string): ComputerGrant {
    return {
      computerId: this.#id(),
      actions: new Set(["listPorts"]),
      expiresAt: Date.now() + 60_000,
      provenance: { actor: `owner:${ownerId}` },
    };
  }

  /**
   * A preview selector names the owner by tenant member ID. The configured
   * OYSTER_OWNER_NAME is only the owner's sign-in subject, so the selector is
   * compared against the live canonical owner membership on every check.
   */
  async #previewInstallation(selector: PreviewSelector) {
    const owner = await (await standaloneTenancy(this.previewBindings)).owner();
    if (selector.ownerId !== owner?.actor.memberId) throw new PreviewRefused();
    const current = await this.previewBindings.REGISTRY.getByName(
      "registry",
    ).get(selector.installationId);
    if (
      current === null ||
      "kind" in current ||
      current.status !== "enabled" ||
      JSON.stringify(selectionOf(current)) !==
        JSON.stringify(selector.selection) ||
      current.release.artifact.artifactDigest !== selector.artifactDigest
    )
      throw new PreviewRefused();
    return current;
  }

  async #currentPreview(selector: PreviewSelector): Promise<void> {
    const current = await this.#previewInstallation(selector);
    const verified = await verifyRelease(
      r2ArtifactStore(this.previewBindings.RELEASES),
      current.release,
      undefined,
      false,
    );
    if (!verified.declaration?.capabilities.includes("computer.execute"))
      throw new PreviewRefused();
    await this.#previewInstallation(selector);
  }

  #previewOwner() {
    if (this.#preview !== undefined) return this.#preview;
    const origins = previewOrigins(this.previewBindings);
    if (origins === null) throw new PreviewRefused();
    this.#preview = createStandalonePreview(
      this.state.storage,
      this.#id(),
      origins.preview,
      {
        current: (selector) => this.#currentPreview(selector),
        accept: (selector) => {
          this.#accept(this.#previewGrant(selector.ownerId), "listPorts");
        },
        list: (accept) => this.listPortsAfterAcceptance(accept),
        forward: (port, request, accept) =>
          this.portPreviewAfterAcceptance(port, request, accept),
      },
    );
    return this.#preview;
  }

  /** A read-only preflight over the maintained hosted-route selector. */
  buildBackend(): OysterBuildBackend {
    return this.hostedRoute() === undefined
      ? { kind: "no_backend" }
      : { kind: "hosted" };
  }

  /**
   * Run one App build job's fixed command, under the build budget. The
   * registry that minted the job re-admits it for this Computer first.
   */
  async runBuild(input: {
    jobId: string;
    command: string;
    timeoutMs: number;
  }): Promise<
    Readonly<{ output: { exitCode: number | null; stderr: string } | null }>
  > {
    const admitted = await this.previewBindings.REGISTRY.getByName(
      "registry",
    ).admitBuildExecution(input.jobId, this.state.id.toString());
    if (!admitted) throw new AppInstanceError("revoked");
    const result = await this.executeOperationAfterAcceptance(
      {
        command: input.command,
        cwd: "/workspace",
        timeoutMs: input.timeoutMs,
        requestId: mintComputerRequestId(),
      },
      () => undefined,
      "hosted",
      { maximumTimeMs: oysterAppBuildTimeoutMs },
    );
    const output = z
      .object({ exitCode: z.number().nullable(), stderr: z.string() })
      .safeParse(result.output);
    return { output: output.success ? output.data : null };
  }

  /** Issue preview tickets for every exposed port, or refuse typed. */
  async portPreviews(
    authority: ComputerGrant,
    selectorInput: PreviewSelector,
  ): Promise<ComputerPortPreviewsReply> {
    try {
      return {
        kind: "ok",
        value: await this.#portPreviews(authority, selectorInput),
      };
    } catch (cause) {
      if (cause instanceof PreviewRefused) return previewRefusal;
      throw cause;
    }
  }

  async #portPreviews(
    authority: ComputerGrant,
    selectorInput: PreviewSelector,
  ): Promise<ComputerPorts> {
    const selector = Schema.decodeUnknownSync(previewSelectorSchema)(
      selectorInput,
    );
    if (authority.provenance.actor !== `owner:${selector.ownerId}`)
      throw new PreviewRefused();
    this.#accept(authority, "listPorts");
    await this.#currentPreview(selector);
    const ports = await this.listPortsAfterAcceptance(() => {
      this.#accept(authority, "listPorts");
    });
    const projected: ComputerPorts["ports"][number][] = [];
    for (const port of ports.ports) {
      projected.push({
        port,
        ...(await this.#previewOwner().issue(selector, port)),
        openMode: "external-only",
      });
    }
    return Schema.decodeUnknownSync(computerPortsSchema)({ ports: projected });
  }

  async portPreview(
    signature: string,
    port: number,
    request: Request,
  ): Promise<Response> {
    return this.#previewOwner().fetch(signature, port, request);
  }

  #id(): string {
    return workspaceId.parse(this.state.id.name);
  }

  /**
   * The host side of native execution (Computer ABI 0edb0e4a): the grant's
   * library run owner issues one credential for the invocation and the
   * Computer hands it only to that command's Git environment.
   */
  protected override executionHooks(): ComputerExecutionHostHooks {
    const issuer = (context: ComputerValue) => {
      const grant =
        workflowGitExecutionContextSchema.parse(context).workflowGit;
      return {
        grant,
        runs: this.previewBindings.WORKFLOW_RUNS.getByName(grant.teamId),
      };
    };
    return {
      async open(invocation, context) {
        const { grant, runs } = issuer(context);
        return {
          env: workflowGitExecutionEnvironment(
            await runs.issueWorkflowGit(invocation.id, grant),
          ),
        };
      },
      async renew(invocation, context) {
        const { grant, runs } = issuer(context);
        await runs.renewWorkflowGit(invocation.id, grant);
      },
      async close(invocation, context) {
        const { grant, runs } = issuer(context);
        await runs.closeWorkflowGit(invocation.id, grant);
      },
    };
  }

  protected override attachedBackends(): readonly AttachedBackend[] {
    if (this.#backends !== undefined) return this.#backends;
    const owner = createFleetBacking(this.state.storage);
    owner.ensure();
    const hostId = this.bindings.COMPUTER_VM_DEFAULT_HOST;
    this.#backends = owner.computerCreated(this.#id(), [
      hostId === undefined
        ? { kind: "platform-container" }
        : { kind: "on-box-vm", hostId },
    ]).backends;
    return this.#backends;
  }

  #accept(authority: ComputerGrant, action: ComputerAction): void {
    if (
      checkComputerGrant(authority, {
        computerId: this.#id(),
        action,
        now: Date.now(),
      }).kind !== "admitted"
    )
      throw new FleetGrantRefused();
  }

  /** One advertised Computer tool, accepted against the host-issued grant. */
  async tool(
    authority: ComputerGrant,
    capabilityId: string,
    input: ComputerValue,
  ): Promise<StandaloneComputerResult> {
    const tool = computerTool.parse(capabilityId);
    const { action, output } = computerTools[tool];
    const accept = () => {
      this.#accept(authority, action);
    };
    if (tool === "start_process")
      return this.startProcessAfterAcceptance(
        computerValueSchema.parse({
          ...processStartToolInputSchema.parse(input),
          requestId: mintComputerRequestId(),
          requestScope: `tool:${authority.provenance.actor}`,
        }),
        accept,
      );
    return output.parse(await this.callAfterAcceptance(tool, input, accept));
  }

  /** JSON operations keep the Computer's maintained parsers and execution engine. */
  async value(
    authority: ComputerGrant,
    action: ComputerAction,
    input: ComputerValue,
    executionContext?: ComputerValue,
  ): Promise<StandaloneComputerResult> {
    // Only an exact public grant rides along, and only on a native command.
    if (
      executionContext !== undefined &&
      ((action !== "exec" && action !== "processStart") ||
        !workflowGitExecutionContextSchema.safeParse(executionContext).success)
    )
      throw new AppInstanceError("binding_unavailable");
    const accept = () => {
      this.#accept(authority, action);
    };
    switch (action) {
      case "listPorts":
        return this.listPortsAfterAcceptance(accept);
      case "exposePort":
        return this.exposePortAfterAcceptance(
          computerPortInputSchema.parse(input),
          accept,
        );
      case "unexposePort":
        return this.unexposePortAfterAcceptance(
          computerPortInputSchema.parse(input),
          accept,
        );
      case "processList":
        return this.listProcessesAfterAcceptance(accept);
      case "processStart":
        try {
          return await this.startProcessAfterAcceptance(
            input,
            accept,
            executionContext,
          );
        } catch (cause) {
          if (
            cause instanceof ComputerOperationConflictError ||
            cause instanceof ComputerPortConflictError
          )
            return { error: "conflict" };
          throw cause;
        }
      case "processKill":
        return this.killProcessAfterAcceptance(
          processIdInputSchema.parse(input),
          accept,
        );
      case "exec":
        return this.executeOperationAfterAcceptance(
          { ...command.parse(input), requestId: mintComputerRequestId() },
          accept,
          "bash",
          { maximumTimeMs: 45_000 },
          undefined,
          executionContext,
        );
      case "files.list":
        return listOutputSchema.parse(
          await this.callAfterAcceptance("list", input, accept),
        );
      case "files.readBytes": {
        const parsed = readBytesInputSchema.parse(input);
        const file = await this.readFileAfterAcceptance(parsed, accept);
        const bytes = new Uint8Array(
          await new Response(file.body).arrayBuffer(),
        );
        return {
          path: parsed.path,
          byteOffset: file.offset,
          content: Base64.encode(bytes),
          encoding: "base64",
          truncated:
            (parsed.byteOffset !== undefined ||
              parsed.byteLength !== undefined) &&
            file.length > 0,
        };
      }
      case "files.edit":
        try {
          return await this.replaceFileIfUnchangedAfterAcceptance(
            replaceInputSchema.parse(input),
            accept,
          );
        } catch (error) {
          if (error instanceof ComputerFileConflict)
            return { error: "conflict" };
          throw error;
        }
      case "files.write":
        return writeOutputSchema.parse(
          await this.callAfterAcceptance("write", input, accept),
        );
      case "mkdir":
        return mkdirOutputSchema.parse(
          await this.callAfterAcceptance("mkdir", input, accept),
        );
      default:
        throw new Error(
          `Computer action is not exposed by this adapter: ${action}`,
        );
    }
  }

  async fileList(
    authority: ComputerGrant,
    path: string,
    limit: number,
    offset: number,
  ) {
    try {
      return listOutputSchema.parse(
        await this.callAfterAcceptance(
          "list",
          { path, limit: Math.min(limit, 256), offset },
          () => {
            this.#accept(authority, "files.list");
          },
        ),
      );
    } catch (error) {
      if (missingFile.safeParse(error).success) return null;
      throw error;
    }
  }

  /** Binary files share the same native filesystem as commands and PTYs. */
  async fileRead(
    authority: ComputerGrant,
    path: string,
  ): Promise<Uint8Array | null> {
    try {
      const file = await this.readFileAfterAcceptance(
        { path },
        () => {
          this.#accept(authority, "files.readBytes");
        },
        25 * 1024 * 1024,
      );
      return new Uint8Array(await new Response(file.body).arrayBuffer());
    } catch (error) {
      if (missingFile.safeParse(error).success) return null;
      throw error;
    }
  }

  async fileWrite(
    authority: ComputerGrant,
    path: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.writeFileAfterAcceptance(
      { path },
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      () => {
        this.#accept(authority, "files.writeBytes");
      },
    );
  }

  /** Patch is handled by the Computer's pinned native engine, not by the Agent. */
  async filePatch(
    authority: ComputerGrant,
    input: z.output<typeof patchInputSchema>,
  ): Promise<z.output<typeof patchOutputSchema>> {
    return this.applyPatchAfterAcceptance(input, () => {
      this.#accept(authority, "files.edit");
    });
  }

  async fileReplace(
    authority: ComputerGrant,
    path: string,
    expectedContent: string,
    content: string,
  ) {
    try {
      const result = await this.replaceFileIfUnchangedAfterAcceptance(
        { path, expectedContent, content },
        () => {
          this.#accept(authority, "files.edit");
        },
      );
      return { kind: "replaced" as const, ...result };
    } catch (error) {
      if (error instanceof ComputerFileConflict)
        return { kind: "conflict" as const };
      throw error;
    }
  }

  /** WebSocket upgrades use native Fetch, which can return a 101 response. */
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/_oyster/terminal")
      return super.fetch(request);
    let authority: ComputerGrant;
    try {
      authority = terminalGrant.parse(
        JSON.parse(request.headers.get(terminalGrantHeader) ?? "null"),
      );
      this.#accept(authority, "terminal");
    } catch (cause) {
      if (
        cause instanceof SyntaxError ||
        cause instanceof z.ZodError ||
        cause instanceof FleetGrantRefused
      )
        return new Response("Computer grant refused", { status: 403 });
      throw cause;
    }
    return this.terminalAfterAcceptance(
      request,
      authority.provenance.actor,
      () => {
        this.#accept(authority, "terminal");
      },
    );
  }
}

/**
 * Select the fixed native Computer once for the HTTP/MCP host and its
 * adapters. `keysLive` is the host's own owner-checked `host.keys.live`
 * port, threaded in by `oysterGitWorkerHost` before this workspace exists;
 * a caller that only needs `.files` (the Media binding's own dispatch) may
 * omit it, since a team-key principal then simply never reaches the
 * Computer, rather than reading `env.KEYS` directly and skipping the check.
 */
export function standaloneWorkspace(
  env: StandaloneComputerEnv,
  keysLive?: OysterKeysLivePort,
  selectedComputerId: string = env.OYSTER_COMPUTER_ID,
): OysterWorkspace {
  const computerId = workspaceId.parse(selectedComputerId);
  const computer = () => env.COMPUTER.getByName(computerId);
  const authority = () => grant(computerId, "oyster-workspace");
  return {
    computerId,
    computer: async (principal) => {
      const actor = await computerActor(principal, keysLive);
      if (actor === null) return null;
      return {
        // Every Computer advertises the same static operations.
        getCapabilities: () =>
          Promise.resolve(computerValueSchema.parse(computerCapabilities())),
        call: async (capabilityId, input) =>
          computerValueSchema.parse(
            await computer().tool(
              grant(computerId, actor),
              capabilityId,
              input,
            ),
          ),
      };
    },
    files: {
      list: (path, limit, offset) =>
        computer().fileList(authority(), path, limit, offset),
      read: (path) => computer().fileRead(authority(), path),
      write: (path, bytes) => computer().fileWrite(authority(), path, bytes),
      mkdir: async (path) => {
        await computer().value(authority(), "mkdir", { path, recursive: true });
      },
      replace: (path, expected, content) =>
        computer().fileReplace(authority(), path, expected, content),
    },
  };
}

/**
 * Owner/key capability routes over the selected Computer's native
 * namespace. `keysLive` is the same owner-checked port `standaloneWorkspace`
 * takes; a caller with none fails every team-key request closed.
 */
export function standaloneComputerCapabilities(
  env: StandaloneComputerEnv,
  workspace: OysterWorkspace,
  keysLive?: OysterKeysLivePort,
): readonly OysterCapability[] {
  const routes = new Hono<
    CapabilityEnv & { Variables: { authority: ComputerGrant } }
  >();
  routes.use("*", async (context, next) => {
    const actor = await computerActor(context.env.principal, keysLive);
    if (actor === null)
      return context.json(
        { error: "Computer access requires an owner or key" },
        403,
      );
    context.set("authority", grant(workspace.computerId, actor));
    return next();
  });
  const computer = () => env.COMPUTER.getByName(workspace.computerId);
  routes.get("/ports", async (context) => {
    if (previewOrigins(env) === null)
      return context.json({ error: "port_previews_not_configured" });
    const { principal, installation } = context.env;
    if (!oysterPrincipalIsOwner(principal))
      return context.json({ error: "Owner preview access required" }, 403);
    const ownerId = oysterPrincipalId(principal);
    const authority = context.get("authority");
    const reply = await computer().portPreviews(
      {
        ...authority,
        provenance: { ...authority.provenance, actor: `owner:${ownerId}` },
      },
      {
        ownerId,
        installationId: installation.installationId,
        selection: selectionOf(installation),
        artifactDigest: installation.release.artifact.artifactDigest,
      },
    );
    return reply.kind === "ok"
      ? context.json(reply.value)
      : context.json(
          { error: reply.code, message: reply.message },
          appMethodRefusalStatus[reply.code],
        );
  });
  // The host wire body is `{ port }`, as on Hub; it is parsed here.
  routes.post("/ports/expose", async (context) => {
    const input = computerPortInputSchema.safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    return Response.json(
      await computer().value(
        context.get("authority"),
        "exposePort",
        input.data,
      ),
    );
  });
  // The host wire body is `{ port }`, as on Hub; it is parsed here.
  routes.post("/ports/unexpose", async (context) => {
    const input = computerPortInputSchema.safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    return Response.json(
      await computer().value(
        context.get("authority"),
        "unexposePort",
        input.data,
      ),
    );
  });
  routes.get("/processes", async (context) =>
    Response.json(
      await computer().value(context.get("authority"), "processList", {}),
    ),
  );
  routes.post("/processes/start", async (context) => {
    const input = processStartHttpBody.safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    const result = processStartReply.parse(
      await computer().value(
        context.get("authority"),
        "processStart",
        computerValueSchema.parse({
          ...input.data,
          requestScope: `owner:${env.OYSTER_OWNER_NAME ?? "owner"}`,
        }),
      ),
    );
    return Response.json(result, { status: "error" in result ? 409 : 200 });
  });
  // The host wire body is `{ id }`, as on Hub; it is parsed here.
  routes.post("/processes/kill", async (context) => {
    const input = processIdInputSchema.safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    return Response.json(
      await computer().value(
        context.get("authority"),
        "processKill",
        input.data,
      ),
    );
  });
  routes.get("/terminal", async (context) => {
    const authority = context.get("authority");
    const url = new URL(context.req.url);
    url.pathname = "/_oyster/terminal";
    return computer().fetch(
      new Request(url, {
        headers: {
          Upgrade: "websocket",
          [terminalGrantHeader]: JSON.stringify({
            ...authority,
            actions: [...authority.actions],
          }),
        },
      }),
    );
  });
  return Object.values(computerSlots).map((slot) => ({
    ...slot,
    permission: "computer.execute",
    routes: new Hono<CapabilityEnv>().route("/", routes),
  }));
}

/** The COMPUTER row's codecs, as the standalone Instance joins them. */
export type ComputerFrameMethods = Readonly<{
  COMPUTER: OysterBindingRow<OysterWorkerEnv>["methods"];
}>;

/** Closed COMPUTER binding codecs, joined into the standalone Instance. */
export const computerFrameMethods: ComputerFrameMethods = {
  COMPUTER: {
    list: {
      decodeArgs: (args) => z.tuple([listInputSchema]).parse(args),
      decodeResult: (value) => listOutputSchema.parse(value),
      requiredOperations: () => ["list"],
    },
    read: {
      decodeArgs: (args) => z.tuple([readBytesInputSchema]).parse(args),
      decodeResult: (value) => computerByteReadReplySchema.parse(value),
      requiredOperations: () => ["read"],
    },
    write: {
      decodeArgs: (args) => z.tuple([bindingWrite]).parse(args),
      decodeResult: (value) =>
        z
          .union([
            writeOutputSchema,
            z.strictObject({ error: z.literal("conflict") }),
          ])
          .parse(value),
      requiredOperations: () => ["write"],
    },
    ports: {
      decodeArgs: (args) => z.tuple([empty]).parse(args),
      decodeResult: (value) => computerPortsOutputSchema.parse(value),
      requiredOperations: () => ["ports"],
    },
    processes: {
      decodeArgs: (args) => z.tuple([empty]).parse(args),
      decodeResult: (value) => processListOutputSchema.parse(value),
      requiredOperations: () => ["processes"],
    },
    exec: {
      decodeArgs: (args) => z.tuple([command]).parse(args),
      decodeResult: (value) => computerOperationResultSchema.parse(value),
      requiredOperations: () => ["exec"],
    },
    processStart: {
      decodeArgs: (args) => z.tuple([processStart]).parse(args),
      decodeResult: (value) => processStartReply.parse(value),
      requiredOperations: () => ["processStart"],
    },
    processKill: {
      decodeArgs: (args) => z.tuple([processIdInputSchema]).parse(args),
      decodeResult: (value) => processKillOutputSchema.parse(value),
      requiredOperations: () => ["processKill"],
    },
    preview: {
      decodeArgs: (args) => z.tuple([computerPortInputSchema]).parse(args),
      decodeResult: (value) => {
        const ports = Schema.decodeUnknownSync(computerPortsSchema, {
          onExcessProperty: "error",
        })({ ports: [value] });
        const preview = ports.ports[0];
        if (preview === undefined) throw new AppInstanceError("revoked");
        return preview;
      },
      requiredOperations: () => ["preview"],
    },
  },
} satisfies FrameBindingMethods<StandaloneComputerResult>;

/** Owner-only preview tickets carry the verified frame's Installation selection. */
async function computerPreviewInvocation(
  env: StandaloneComputerEnv,
  frame: InvocationFrame<OysterInvocationHost>,
  args: readonly unknown[],
): Promise<ComputerPorts["ports"][number]> {
  const subject = frame.facts.subject;
  const owner = frame.facts.selection.owner;
  if (
    subject.kind !== "call" ||
    subject.context.actor.kind !== "member" ||
    subject.context.role !== "owner" ||
    owner.kind !== "installation"
  )
    throw new AppInstanceError("revoked");
  const computerId = workspaceId.parse(subject.context.computerId);
  // The admitted owner's member ID; the Computer owner proves it is still
  // the live canonical owner before issuing any ticket.
  const ownerId = subject.context.actor.memberId;
  const [parsed] = z.tuple([computerPortInputSchema]).parse(args);
  const native = env.COMPUTER.getByName(computerId);
  frame.signal.throwIfAborted();
  const result = await native.portPreviews(
    {
      computerId,
      actions: new Set(["listPorts"]),
      expiresAt: Math.min(frame.facts.deadlineAt, Date.now() + 60_000),
      provenance: { actor: `owner:${ownerId}` },
    },
    {
      ownerId,
      installationId: owner.id,
      selection: frame.facts.selection,
      artifactDigest: frame.host.artifact.release.artifact.artifactDigest,
    },
  );
  if (result.kind === "refused") throw new AppInstanceError("revoked");
  const preview = result.value.ports.find((row) => row.port === parsed.port);
  if (preview === undefined) throw new AppInstanceError("revoked");
  return preview;
}

/** Re-admit the Computer captured by this invocation, never the current UI selection. */
async function frameComputerId(
  env: StandaloneComputerEnv,
  scope: TenantScope,
  frame: InvocationFrame<OysterInvocationHost>,
): Promise<string> {
  frame.signal.throwIfAborted();
  const subject = frame.facts.subject;
  if (subject.kind !== "call" || subject.context.computerId === null)
    throw new AppInstanceError("revoked");
  const computerId = workspaceId.parse(subject.context.computerId);
  if (
    !(await env.REGISTRY.getByName(scope.durableName("registry")).ownsComputer(
      computerId,
    ))
  )
    throw new AppInstanceError("revoked");
  frame.signal.throwIfAborted();
  return computerId;
}

/** Media and Computer bindings capture the same inventory-admitted workspace. */
export async function standaloneFrameWorkspace(
  env: StandaloneComputerEnv,
  scope: TenantScope,
  frame: InvocationFrame<OysterInvocationHost>,
): Promise<OysterWorkspace> {
  return standaloneWorkspace(
    env,
    undefined,
    await frameComputerId(env, scope, frame),
  );
}

/** Dispatch one admitted COMPUTER operation under its captured frame. */
export async function computerInvocation(
  env: StandaloneComputerEnv & WorkflowGitStepEnv,
  scope: TenantScope,
  frame: InvocationFrame<OysterInvocationHost>,
  method: string,
  args: readonly unknown[],
): Promise<StandaloneComputerResult> {
  const computerId = await frameComputerId(env, scope, frame);
  const subject = frame.facts.subject;
  if (subject.kind !== "call") throw new AppInstanceError("revoked");
  const actor = subject.context.actor;
  if (method === "preview") return computerPreviewInvocation(env, frame, args);
  const actorId =
    actor.kind === "member"
      ? actor.memberId
      : actor.kind === "agent"
        ? actor.agentId
        : actor.keyId;
  let action: ComputerAction;
  let input: ComputerValue;
  switch (method) {
    case "list":
      action = "files.list";
      [input] = z.tuple([listInputSchema]).parse(args);
      break;
    case "read":
      action = "files.readBytes";
      [input] = z.tuple([computerValueSchema]).parse(args);
      break;
    case "write": {
      const [parsed] = z.tuple([bindingWrite]).parse(args);
      action =
        parsed.expectedContent === undefined ? "files.write" : "files.edit";
      input =
        parsed.expectedContent === undefined
          ? { path: parsed.path, content: parsed.content }
          : {
              path: parsed.path,
              content: parsed.content,
              expectedContent: parsed.expectedContent,
            };
      break;
    }
    case "ports":
      action = "listPorts";
      [input] = z.tuple([empty]).parse(args);
      break;
    case "processes":
      action = "processList";
      [input] = z.tuple([empty]).parse(args);
      break;
    case "exec":
      action = "exec";
      [input] = z.tuple([computerValueSchema]).parse(args);
      break;
    case "processStart": {
      const [parsed] = z.tuple([processStart]).parse(args);
      const requestId = subject.context.idempotencyKey;
      const owner = frame.facts.selection.owner;
      const methodName = frame.host.method?.name;
      if (
        requestId === undefined ||
        actor.kind !== "member" ||
        owner.kind !== "installation" ||
        methodName === undefined
      )
        throw new AppInstanceError("revoked");
      action = "processStart";
      input = computerValueSchema.parse({
        ...parsed,
        requestId,
        requestScope: installationProcessScope(owner.id, methodName, {
          kind: actor.kind,
          id: actorId,
        }),
      });
      break;
    }
    case "processKill":
      action = "processKill";
      [input] = z.tuple([processIdInputSchema]).parse(args);
      break;
    default:
      throw new AppInstanceError("revoked");
  }
  // A Workflow Git step's native commands carry only its public grant.
  const grant =
    action === "exec" || action === "processStart"
      ? await workflowGitStepGrant(
          env,
          env.REGISTRY.getByName(scope.durableName("registry")),
          frame,
        )
      : null;
  const native = env.COMPUTER.getByName(computerId);
  frame.signal.throwIfAborted();
  return native.value(
    {
      computerId,
      actions: new Set([action]),
      expiresAt: Math.min(frame.facts.deadlineAt, Date.now() + 60_000),
      provenance: { actor: `${actor.kind}:${actorId}` },
    },
    action,
    input,
    grant === null
      ? undefined
      : computerValueSchema.parse(
          JSON.parse(JSON.stringify({ workflowGit: grant })),
        ),
  );
}
