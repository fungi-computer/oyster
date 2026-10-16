import { installationSchema, type Installation } from "./apps/installation.js";
import { registryInstallations } from "./internal/registry-installations.js";
import { approvedBindingGrants, scopedBindings } from "./apps/gate.js";
import { appMethodReplySchema } from "@fungi.computer/agar/backend";
import {
  nativeGitFrameMethods,
  nativeGitMethodNameSchema,
} from "@fungi.computer/agar/git-rpc";
import {
  backgroundOriginKey,
  actorLane,
  mayDefer,
  type BackgroundSyncRefusal,
} from "@fungi.computer/puffball/background-replay";
import {
  emptyAppDeclaration,
  appBackendBindingKinds,
} from "@fungi.computer/puffball/app";
import {
  defaultTenant,
  tenantIdSchema,
  tenantScope,
  type TenantScope,
  type TenantId,
} from "./tenant.js";

import {
  decodeGillReply,
  type GillCall,
  type GillReply,
} from "@fungi.computer/gills";
import { causeClass, failureDiagnostic } from "./cause-class.js";
import { ownerKeyAuth } from "./auth.js";
import type {
  AppGitPushFact,
  GitBinding,
  GitPushQuestion,
  GitPushVerdict,
} from "@fungi.computer/agar/git";
import {
  createOysterMcpOwner,
  remoteOysterMcp,
  type OysterMcpOwner,
} from "./mcp-owner.js";
export {
  createOysterMcpOwner,
  OysterMcpOwner,
  type OysterMcpOwnerEnv,
  type OysterMcpTenantPin,
} from "./mcp-owner.js";
import { guestLimits, type GuestLimits } from "./guest-policy.js";
import { r2FileSource } from "./r2-files.js";

import { fileCapabilities, type FileSource } from "./files.js";
import { DurableObject, type WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Release } from "@fungi.computer/puffball";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import {
  AppInstanceError,
  type AppInstance,
  type Backend,
  type Instance,
  type OwnerState,
} from "./index.js";
import {
  createCloudflareAppInstance,
  createCloudflareInvocationGate,
  decodeFrameBindingProps,
  captureFrameBindingReply,
  type FrameBindingReply,
  frameBindingEntrypoint,
  backgroundFrameMethods,
  type FrameBindingMethod,
  type FrameBindingProps,
} from "./cloudflare.js";
import {
  invocationFactsSchema,
  assertBackgroundBinding,
  admitBackgroundFrame,
  type BackgroundFrameState,
  type InvocationFacts,
  type InvocationFrame,
  type InvocationGate,
} from "./invocation.js";
import { deliverBackground, deliverGitPush } from "./internal/delivery.js";
import {
  createOyster,
  verifyRelease,
  defaultAssetPolicy,
  type InstallationCommit,
  type InstanceHandle,
  type InstanceResult,
  type OysterAuth,
  type OysterHost,
  type OysterJson,
} from "./host.js";
import { createGitPushJournal } from "./git-journal.js";
import {
  AppStorageError,
  type AppStorageResult,
  type AppStorageWrite,
  type AppStorageReset,
  type ResolvedAppStorage,
} from "@fungi.computer/agar/storage";
import type { AppStorageAdmission } from "./app-storage.js";
import { storageFrameMethods } from "./storage-frame.js";
import { catalogFrameMethods, oysterAppCatalog } from "./catalog-frame.js";
import {
  appStorageKeyNameSchema,
  appStorageWriteSchema,
  appStorageResetSchema,
} from "@fungi.computer/agar/storage";
import { createOysterRootData, type OysterRootDirectory } from "./root-data.js";
import {
  backendCache,
  resolveBackend,
  type ArtifactHeads,
  type ArtifactStore,
} from "./release.js";
import { headContentObject } from "./build/content-objects.js";
import type { AppApi } from "@fungi.computer/puffball";
import type { AppDeclaration } from "@fungi.computer/puffball/app";
import {
  ensureAppSourceTables,
  createOysterAppSourceReceipts,
  createOysterAppRegistrations,
  createOysterArtifactsRepositoryMetadataStore,
} from "./app-sources.js";

export { r2FileSource, ownerKeyAuth };

/** Native values returned by the standalone Git, event and JSON binding owners. */
export type OysterBindingResult =
  Awaited<ReturnType<GitBinding[keyof GitBinding]>> | Schema.Json | undefined;

/** Verified backend custody is captured in the frame, never in a current-context field. */
export type OysterInvocationHost = BackgroundFrameState &
  Readonly<{
    artifact: Backend;
    declaration: AppDeclaration | null;
    /** The verified declared method; opaque backend and lifecycle frames have none. */
    method?: Readonly<{ name: string }>;
  }>;

/** Existing fleet directory owner records, resolved by the host rather than App input. */
export type OysterStorageAgentDirectory = Readonly<{
  /** Resolve the host-owned fleet directory by its existing durable name. */
  getByName(name: string): Readonly<{
    /** Return the recorded creator, or null when the Agent has no owner record. */
    readCreator(agentId: string): Promise<string | null>;
  }>;
}>;

/** Bindings a standalone Oyster Worker declares in its Wrangler config. */
export type OysterWorkerEnv = Readonly<{
  /** The owner's sign-in key, at least 24 characters (a secret). */
  OYSTER_OWNER_KEY: string;
  /** The single-tenant owner's identity, also recorded by the existing fleet creator. */
  OYSTER_OWNER_NAME?: string;
  /** Optional existing fleet owner; absence grants no Agent storage authority. */
  AGENT_DIRECTORY?: OysterStorageAgentDirectory;
  /** Canonical configured origin; requests cannot choose the owner tenant. */
  OYSTER_ORIGIN: string;
  /** One tenant-scoped MCP session owner. Required when serving /mcp. */
  MCP: DurableObjectNamespace<OysterMcpOwner>;

  /** Release artifacts, keyed by artifact reference. */
  RELEASES: R2Bucket;
  /** The installation registry. */
  REGISTRY: DurableObjectNamespace<OysterRegistry>;
  /** One Durable Object per App Instance. */
  INSTANCES: DurableObjectNamespace<OysterInstance>;
  /** Worker Loader that runs App backends. */
  LOADER: WorkerLoader;
}>;

/** Store Release artifacts in an R2 bucket. */
export function r2ArtifactStore(
  bucket: R2Bucket,
): ArtifactStore & ArtifactHeads {
  return {
    head: (artifactRef) => headContentObject(bucket, artifactRef),
    async get(artifactRef) {
      const object = await bucket.get(artifactRef);
      return object === null
        ? null
        : new Uint8Array(await object.arrayBuffer());
    },
    async put(artifactRef, bytes) {
      await bucket.put(artifactRef, bytes);
    },
  };
}

const recordRow = Schema.Struct({
  installation_id: Schema.String,
  record: Schema.String,
});

/** The installation registry: one SQLite-backed Durable Object per Oyster. */
export class OysterRegistry extends DurableObject<OysterWorkerEnv> {
  readonly #rootData: ReturnType<typeof createOysterRootData>;
  /** Append-only App source seed receipts; a Git-capable subclass forks over these. */
  protected readonly appSourceReceipts: ReturnType<
    typeof createOysterAppSourceReceipts
  >;
  /** Team-owned fork registrations, one App publisher record per App. */
  protected readonly appRegistrations: ReturnType<
    typeof createOysterAppRegistrations
  >;
  /** Durable Artifacts repository provenance for this Oyster's own fork compositions. */
  protected readonly artifactsRepositories: ReturnType<
    typeof createOysterArtifactsRepositoryMetadataStore
  >;
  constructor(ctx: DurableObjectState, env: OysterWorkerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS installations (installation_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT",
    );
    ensureAppSourceTables(ctx.storage.sql);
    this.appSourceReceipts = createOysterAppSourceReceipts(ctx.storage.sql);
    this.appRegistrations = createOysterAppRegistrations(ctx.storage.sql);
    this.artifactsRepositories = createOysterArtifactsRepositoryMetadataStore(
      ctx.storage.sql,
    );
    this.#rootData = createOysterRootData({
      sql: ctx.storage.sql,
      commit: (body) =>
        Effect.try({
          try: () => ctx.storage.transactionSync(body),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error("Registry commit failed", { cause }),
        }),
      installations: {
        list: () => Promise.resolve(this.list()),
      },
      resolveRelease: (release) =>
        verifyRelease(
          r2ArtifactStore(env.RELEASES),
          release,
          defaultAssetPolicy,
          false,
        ),
    });
  }
  /** Current desktop metadata; roles are the ADR's derived default, never Hub's stored choice. */
  directory(): Promise<OysterRootDirectory> {
    return this.#rootData.directory();
  }
  /** Read one key for the authenticated root owner, under fresh App admission. */
  storageRead(
    installationId: string,
    ownerId: string,
    key: string,
  ): Promise<AppStorageResult<ResolvedAppStorage>> {
    return this.storageResult(
      this.storageView(installationId, () => Promise.resolve(ownerId)).read(
        key,
      ),
    );
  }
  /** Write one declared key for the authenticated root owner. */
  storageWrite(
    installationId: string,
    ownerId: string,
    input: AppStorageWrite,
  ): Promise<AppStorageResult<{ revision: number }>> {
    return this.storageResult(
      this.storageView(installationId, () => Promise.resolve(ownerId)).write(
        input,
      ),
    );
  }
  /** Reset one declared layer for the authenticated root owner. */
  storageReset(
    installationId: string,
    ownerId: string,
    input: AppStorageReset,
  ): Promise<AppStorageResult<{ revision: number }>> {
    return this.storageResult(
      this.storageView(installationId, () => Promise.resolve(ownerId)).reset(
        input,
      ),
    );
  }
  /** Storage for a live owner method frame; no guest-selected installation or member. */
  storageBackend(
    raw: InvocationFacts,
    method: string,
    args: readonly unknown[],
    tenantId: TenantId,
  ): Promise<OysterBindingResult> {
    const facts = Schema.decodeUnknownSync(invocationFactsSchema, {
      onExcessProperty: "error",
    })(raw);
    const tenant = Schema.decodeUnknownSync(tenantIdSchema)(tenantId);
    const view = this.storageView(
      facts.selection.owner.id,
      () => this.storageOwner(facts, tenant),
      facts,
    );
    switch (method) {
      case "read":
        return this.storageResult(
          view.read(
            Schema.decodeUnknownSync(Schema.Tuple([appStorageKeyNameSchema]), {
              onExcessProperty: "error",
            })(args)[0],
          ),
        );
      case "write":
        return this.storageResult(
          view.write(
            Schema.decodeUnknownSync(Schema.Tuple([appStorageWriteSchema]), {
              onExcessProperty: "error",
            })(args)[0],
          ),
        );
      case "reset":
        return this.storageResult(
          view.reset(
            Schema.decodeUnknownSync(Schema.Tuple([appStorageResetSchema]), {
              onExcessProperty: "error",
            })(args)[0],
          ),
        );
      default:
        return Promise.resolve({ kind: "rejected", code: "invalid" });
    }
  }
  /** Open the existing App-storage invalidation stream under fresh owner admission. */
  async storageEvents(
    installationId: string,
    ownerId: string,
    key: string,
  ): Promise<Response> {
    const view = this.storageView(installationId, () =>
      Promise.resolve(ownerId),
    );
    const admitted = await this.storageResult(view.read(key));
    if (admitted.kind === "rejected")
      return Response.json(admitted, { status: 403 });
    return new Response(
      Stream.toReadableStream(
        view
          .events(key)
          .pipe(
            Stream.map((event) =>
              new TextEncoder().encode(
                event === null
                  ? "event: ready\ndata: {}\n\n"
                  : `event: changed\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            ),
          ),
      ),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  private storageResult<A>(
    program: Effect.Effect<A, AppStorageError>,
  ): Promise<AppStorageResult<A>> {
    return Effect.runPromise(
      Effect.match(program, {
        onSuccess: (value) => ({ kind: "accepted" as const, value }),
        onFailure: (error) => ({ kind: "rejected" as const, code: error.code }),
      }),
    );
  }
  private async storageOwner(
    facts: InvocationFacts,
    tenantId: TenantId,
  ): Promise<string | null> {
    const subject = facts.subject;
    if (subject.kind !== "call") return null;
    const { actor, role } = subject.context;
    if (actor.kind === "member")
      return role === "owner" ? actor.memberId : null;
    if (
      actor.kind !== "agent" ||
      tenantId !== defaultTenant ||
      this.env.AGENT_DIRECTORY === undefined
    )
      return null;
    const creator = await this.env.AGENT_DIRECTORY.getByName(
      "agents",
    ).readCreator(actor.agentId);
    return creator === null ? null : this.currentOwner(creator, tenantId);
  }
  /**
   * Resolve a stored creator against the live owner. The single-owner root's
   * owner is the identity its owner key admits; tenant roots override this
   * with their canonical membership.
   */
  protected currentOwner(
    memberId: string,
    tenantId: TenantId,
  ): Promise<string | null> {
    return Promise.resolve(
      tenantId === defaultTenant &&
        memberId === (this.env.OYSTER_OWNER_NAME ?? "owner")
        ? memberId
        : null,
    );
  }
  private storageView(
    installationId: string,
    owner: () => Promise<string | null>,
    expected?: InvocationFacts,
  ) {
    return this.#rootData.storage.open(() =>
      Effect.tryPromise({
        try: async (): Promise<AppStorageAdmission> => {
          const installation = this.get(installationId);
          if (
            installation?.status !== "enabled" ||
            (expected !== undefined &&
              (expected.selection.owner.kind !== "installation" ||
                installation.instanceId !== expected.instanceId ||
                installation.authorityVersion !==
                  expected.selection.authorityVersion ||
                installation.release.releaseId !==
                  expected.selection.releaseId ||
                installation.release.appId !== expected.selection.appId))
          )
            throw new AppStorageError("unavailable");
          const resolved = await verifyRelease(
            r2ArtifactStore(this.env.RELEASES),
            installation.release,
            defaultAssetPolicy,
            false,
          );
          if (
            expected !== undefined &&
            resolved.backend?.digest !== expected.artifactDigest
          )
            throw new AppStorageError("unavailable");
          const ownerId = await owner();
          if (ownerId === null) throw new AppStorageError("owner_required");
          const assertCurrent = () => {
            if (expected !== undefined && Date.now() >= expected.deadlineAt)
              throw new AppStorageError("unavailable");
            const current = this.get(installationId);
            if (
              current?.status !== "enabled" ||
              current.authorityVersion !== installation.authorityVersion ||
              current.release.releaseId !== installation.release.releaseId ||
              current.release.artifact.artifactDigest !==
                installation.release.artifact.artifactDigest
            )
              throw new AppStorageError("unavailable");
          };
          assertCurrent();
          return {
            address: `installation:${installationId}`,
            appId: installation.release.appId,
            memberId: ownerId,
            membershipVersion: 1,
            isOwner: true,
            keys: resolved.declaration?.storage ?? [],
            assertCurrent,
          };
        },
        catch: (cause) =>
          cause instanceof AppStorageError
            ? cause
            : new AppStorageError("unavailable", { cause }),
      }),
    );
  }
  /** Every installation record. */
  list(): Installation[] {
    return this.ctx.storage.sql
      .exec(
        "SELECT installation_id, record FROM installations ORDER BY installation_id",
      )
      .toArray()
      .map((row) => this.decode(row));
  }
  /** One installation record, or `null`. */
  get(installationId: string): Installation | null {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT installation_id, record FROM installations WHERE installation_id=?",
        installationId,
      )
      .toArray()[0];
    return row === undefined ? null : this.decode(row);
  }
  /** Create or replace one installation record. */
  async put(
    installation: Installation,
    tenantId: TenantId = defaultTenant,
  ): Promise<void> {
    await this.writeInstallation(installation, tenantId);
  }
  /** Native RPC returns a closed result; callers never classify a transported Error. */
  async compareAndPut(
    installation: Installation,
    expectedAuthorityVersion: number,
    tenantId: TenantId = defaultTenant,
  ): Promise<InstallationCommit> {
    try {
      await this.writeInstallation(
        installation,
        tenantId,
        expectedAuthorityVersion,
      );
      return { ok: true };
    } catch (cause) {
      if (cause instanceof AppInstanceError && cause.code === "stale_authority")
        return { ok: false, code: "stale_authority" };
      throw cause;
    }
  }
  private async writeInstallation(
    installation: Installation,
    tenantId: TenantId,
    expectedAuthorityVersion?: number,
  ): Promise<void> {
    const previous = this.get(installation.installationId);
    if (
      expectedAuthorityVersion !== undefined &&
      previous?.authorityVersion !== expectedAuthorityVersion
    )
      throw new AppInstanceError("stale_authority");
    const encode = (value: Installation) =>
      JSON.stringify(installationSchema.parse(value));
    const record = encode(installation);
    const previousRecord = previous === null ? null : encode(previous);
    if (
      previous !== null &&
      previous.instanceId !== null &&
      (previous.instanceId !== installation.instanceId ||
        previous.authorityVersion !== installation.authorityVersion ||
        previous.status !== installation.status ||
        previous.release.artifact.artifactDigest !==
          installation.release.artifact.artifactDigest)
    )
      if (
        (await resolveBackend(
          r2ArtifactStore(this.env.RELEASES),
          previous.release,
        )) !== null
      ) {
        if (
          expectedAuthorityVersion !== undefined &&
          this.get(installation.installationId)?.authorityVersion !==
            expectedAuthorityVersion
        )
          throw new AppInstanceError("stale_authority");
        await this.env.INSTANCES.getByName(previous.instanceId).revoke(
          previous.installationId,
          undefined,
          tenantId,
        );
      }
    this.ctx.storage.transactionSync(() => {
      const current = this.get(installation.installationId);
      if (
        expectedAuthorityVersion !== undefined &&
        current?.authorityVersion !== expectedAuthorityVersion
      )
        throw new AppInstanceError("stale_authority");
      if ((current === null ? null : encode(current)) !== previousRecord)
        throw new AppInstanceError("stale_authority");
      this.ctx.storage.sql.exec(
        "INSERT INTO installations(installation_id, record) VALUES(?,?) ON CONFLICT(installation_id) DO UPDATE SET record=excluded.record",
        installation.installationId,
        record,
      );
      if (installation.status === "deleted")
        this.#rootData.storage.purgeInstallation(
          `installation:${installation.installationId}`,
        );
    });
  }
  private decode(row: unknown): Installation {
    const { record } = Schema.decodeUnknownSync(recordRow)(row);
    return installationSchema.parse(JSON.parse(record));
  }
}

const releaseRow = Schema.Struct({ release: Schema.String });

/**
 * Settle one Instance operation for its host. An unexpected failure is logged
 * here, beside the error object, because only its closed class crosses RPC.
 */
function result<T>(run: Effect.Effect<T, Error>): Promise<InstanceResult<T>> {
  return Effect.runPromise(
    Effect.match(run, {
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (error) => {
        if (error instanceof AppInstanceError)
          return {
            ok: false as const,
            causeClass: causeClass(error),
            code: error.code,
          };
        const diagnostic = failureDiagnostic(error);
        console.error("AppInstance failure", {
          stage: "instance_operation",
          code: "failed",
          ...diagnostic,
        });
        return {
          ok: false as const,
          causeClass: diagnostic.causeClass,
          code: "failed" as const,
        };
      },
    }),
  );
}

/** What a binding row may read from the Instance that owns the frame. */
export type OysterBindingContext<Env> = Readonly<{
  env: Env;
  /** The tenant this Instance's host pinned at its first apply. */
  scope(): TenantScope;
  /** The root host that readmits background work, or `null` where it is refused. */
  backgroundHost(): Promise<OysterHost | null>;
}>;

/**
 * One guest binding: the frame codecs both sides of the RPC share, and the
 * host owner that serves a decoded, granted packet under its captured frame.
 */
export type OysterBindingRow<Env> = Readonly<{
  methods: Readonly<Record<string, FrameBindingMethod<OysterBindingResult>>>;
  /** Serve one decoded packet; the Instance has already admitted its frame and grant. */
  dispatch(
    context: OysterBindingContext<Env>,
    frame: InvocationFrame<OysterInvocationHost>,
    props: FrameBindingProps,
    method: string,
    args: readonly unknown[],
  ): Promise<OysterBindingResult>;
}>;

/**
 * The bindings an Instance serves, keyed by the closed App binding vocabulary;
 * a missing row is `binding_unavailable`.
 */
export type OysterBindingTable<Env> = Readonly<{
  APP_STORAGE?: OysterBindingRow<Env>;
  APPS?: OysterBindingRow<Env>;
  BACKGROUND?: OysterBindingRow<Env>;
  GIT?: OysterBindingRow<Env>;
  EVENTS?: OysterBindingRow<Env>;
  INBOX?: OysterBindingRow<Env>;
  AGENTS?: OysterBindingRow<Env>;
  COMPUTER?: OysterBindingRow<Env>;
  MEDIA?: OysterBindingRow<Env>;
  WORKFLOWS?: OysterBindingRow<Env>;
}>;

/**
 * The one guest binding entrypoint over `table`. Every binding in a frame is
 * this export with its own props; each packet returns to its originating
 * Instance, which serves it from the same table.
 */
export function oysterBindingEntrypoint<Env extends OysterWorkerEnv>(
  table: OysterBindingTable<Env>,
): typeof WorkerEntrypoint<Env, FrameBindingProps> {
  return frameBindingEntrypoint<Env, OysterBindingResult>(
    Object.fromEntries(
      Object.values(appBackendBindingKinds).flatMap(({ name }) => {
        const row = table[name];
        return row === undefined ? [] : [[name, row.methods]];
      }),
    ),
    (env, props, method, args) =>
      env.INSTANCES.getByName(props.instanceId).bindingCall(
        props,
        method,
        args,
      ),
  );
}

const registryOf = (context: OysterBindingContext<OysterWorkerEnv>) =>
  context.env.REGISTRY.getByName(context.scope().durableName("registry"));

/** The plain Oyster host's bindings: App storage, the read-only catalog and replay admission. */
export const oysterBindings: OysterBindingTable<OysterWorkerEnv> = {
  APP_STORAGE: {
    methods: storageFrameMethods.APP_STORAGE,
    dispatch: (context, frame, _props, method, args) =>
      registryOf(context).storageBackend(
        frame.facts,
        method,
        args,
        context.scope().tenantId,
      ),
  },
  APPS: {
    methods: catalogFrameMethods.APPS,
    async dispatch(context, frame) {
      if (
        frame.host.declaration?.capabilities.includes("team.workbenchHost") !==
        true
      )
        throw new AppInstanceError("revoked");
      const catalog = oysterAppCatalog(await registryOf(context).directory());
      frame.signal.throwIfAborted();
      return catalog;
    },
  },
  BACKGROUND: {
    methods: backgroundFrameMethods.BACKGROUND,
    async dispatch(context, frame, _props, _method, [origin]) {
      const host = await context.backgroundHost();
      frame.signal.throwIfAborted();
      if (host?.backgroundOriginKey === undefined)
        return { kind: "refused", code: "access_changed" };
      const key = await host.backgroundOriginKey();
      frame.signal.throwIfAborted();
      const decision = await admitBackgroundFrame(key, frame, origin);
      frame.signal.throwIfAborted();
      return decision;
    },
  },
};

/** The plain Oyster Worker's guest binding entrypoint. */
export class OysterBinding extends oysterBindingEntrypoint(oysterBindings) {}

/** The Instance surface a host reaches, in-process or over its RPC stub. */
type InstanceTarget = Readonly<{
  apply(
    ...args: Parameters<OysterInstance["apply"]>
  ): Promise<InstanceResult<Instance>>;
  backend(...args: Parameters<OysterInstance["backend"]>): Promise<Response>;
  call(
    ...args: Parameters<OysterInstance["call"]>
  ): Promise<InstanceResult<unknown>>;
  gill(
    ...args: Parameters<OysterInstance["gill"]>
  ): Promise<InstanceResult<unknown>>;
  authorizeGitPush(
    ...args: Parameters<OysterInstance["authorizeGitPush"]>
  ): Promise<GitPushVerdict>;
  onGitPush(...args: Parameters<OysterInstance["onGitPush"]>): Promise<void>;
  syncRefused(
    ...args: Parameters<OysterInstance["syncRefused"]>
  ): Promise<void>;
}>;

/** One host-facing handle over an Instance, pinned to `scope` and `budget`. */
function instanceHandle(
  target: InstanceTarget,
  scope: TenantScope,
  budget: GuestLimits | undefined,
): InstanceHandle {
  const { tenantId, origin } = scope;
  return {
    apply: (state, release) =>
      target.apply(state, release, budget, { tenantId, origin }),
    fetch: (facts, request) => target.backend(facts, request, budget, tenantId),
    call: async (facts, api, name, input) => {
      const reply = await target.call(
        facts,
        api,
        name,
        input,
        budget,
        tenantId,
      );
      return reply.ok
        ? { ok: true, value: appMethodReplySchema.parse(reply.value) }
        : reply;
    },
    gill: async (facts, api, source, input) => {
      const reply = await target.gill(
        facts,
        api,
        source,
        input,
        budget,
        tenantId,
      );
      return reply.ok
        ? { ok: true, value: decodeGillReply(reply.value) }
        : reply;
    },
    authorizeGitPush: (facts, question) =>
      target.authorizeGitPush(facts, question, budget, tenantId),
    onGitPush: (facts, fact) => target.onGitPush(facts, fact, budget, tenantId),
    syncRefused: (facts, refusal) =>
      target.syncRefused(facts, refusal, budget, tenantId),
  };
}

/**
 * One App Instance: Oyster's lifecycle supervisor in this Durable Object's
 * SQLite and the App backend in its `app` facet.
 */
export class OysterInstance<
  Env extends OysterWorkerEnv = OysterWorkerEnv,
> extends DurableObject<Env> {
  declare protected ctx: DurableObjectState<Record<never, never>> &
    Readonly<{
      exports: Readonly<{
        /** The root's one guest binding entrypoint; every binding name maps to it. */
        OysterBinding(input: { props: FrameBindingProps }): object;
      }>;
    }>;
  /** The bindings this Instance serves; a root's Instance names its own table. */
  protected readonly bindings: OysterBindingTable<Env> = oysterBindings;
  /** Stable per Instance; binding rows read the env, pin and root host through it. */
  readonly #bindingContext: OysterBindingContext<Env>;
  private runtime: AppInstance<OysterInvocationHost>;
  private limits = guestLimits();
  private readonly frames: InvocationGate<OysterInvocationHost>;
  /** Content-addressed backends are verified once per Instance, not per call. */
  private readonly backends: ReturnType<typeof backendCache>;
  private readonly gitJournal: Promise<
    Awaited<ReturnType<typeof createGitPushJournal>>
  >;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS oyster_releases (release_id TEXT PRIMARY KEY, release TEXT NOT NULL) STRICT",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS oyster_owner (id INTEGER PRIMARY KEY CHECK (id = 1), installation_id TEXT NOT NULL) STRICT",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS oyster_tenant (id INTEGER PRIMARY KEY CHECK (id = 1), tenant_id TEXT NOT NULL, origin TEXT NOT NULL) STRICT",
    );
    this.#bindingContext = {
      env,
      scope: () => this.scope(),
      backgroundHost: () => this.backgroundHost(),
    };
    this.backends = backendCache(r2ArtifactStore(env.RELEASES));
    this.runtime = this.createRuntime(this.limits);
    this.frames = createCloudflareInvocationGate(ctx, (frame) =>
      this.closeBackground(frame),
    );
    // Local delivery avoids calling this Instance's own RPC stub from its alarm.
    const instances = {
      get: (instanceId: string) => this.localInstance(instanceId),
    };
    this.gitJournal = ctx.blockConcurrencyWhile(() =>
      createGitPushJournal({
        owner: ctx.storage,
        deliver: (installationId, fact) =>
          deliverGitPush(
            {
              artifacts: r2ArtifactStore(env.RELEASES),
              installations: registryInstallations(env, this.scope()),
              guestLimits: this.limits,
              instances,
            },
            installationId,
            fact,
          ),
        deliverSync: async (wake) => {
          const host = await this.backgroundHost();
          if (host === null) return "refused";
          const result = await deliverBackground({ ...host, instances }, wake);
          if (result.more) {
            const { installationId, actor, lane, originMethod, observed } =
              wake;
            await (
              await this.gitJournal
            ).armSync({
              installationId,
              actor,
              lane,
              originMethod,
              observed,
            });
          }
          return {
            status: result.status,
            receipt: { lane: wake.lane, epoch: wake.epoch },
          };
        },
        scheduleWake: (at) =>
          ctx.storage.transaction(async (transaction) => {
            const current = await transaction.getAlarm();
            if (current === null || at < current)
              await transaction.setAlarm(at);
          }),
      }),
    );
  }
  /** The deployable root's host for one pinned tenant; this plain root is the single owner key. */
  protected hostFor(scope: TenantScope): OysterHost {
    return ownerKeyRootHost(this.env, { scope });
  }
  /** Reconstruct current host admission for each wake; non-default tenants get no wakes. */
  protected backgroundHost(): Promise<OysterHost | null> {
    if (!Schema.is(Schema.NonEmptyString)(this.env.OYSTER_OWNER_KEY))
      return Promise.resolve(null);
    const scope = this.scope();
    if (scope.tenantId !== defaultTenant) return Promise.resolve(null);
    return Promise.resolve(this.hostFor(scope));
  }
  private localInstance(instanceId: string): InstanceHandle {
    if (instanceId !== this.ctx.id.name)
      throw new AppInstanceError("instance_identity_mismatch");
    return instanceHandle(this, this.scope(), undefined);
  }
  private async closeBackground(
    frame: InvocationFrame<OysterInvocationHost>,
  ): Promise<void> {
    const { subject } = frame.facts;
    if (
      subject.kind !== "call" ||
      subject.replay !== undefined ||
      subject.method?.effect !== "write" ||
      subject.context.backgroundLane === undefined ||
      !mayDefer(subject.context, frame.facts.ancestry) ||
      frame.host.declaration?.backend?.sync === undefined
    )
      return;
    if (
      subject.context.actor.kind !== "member" ||
      subject.context.backgroundLane !== actorLane(subject.context.actor)
    )
      throw new AppInstanceError("invalid_invocation_facts");
    await (
      await this.gitJournal
    ).armSync({
      installationId: frame.facts.selection.owner.id,
      actor: subject.context.actor,
      lane: subject.context.backgroundLane,
      originMethod: subject.method.name,
      observed: {
        authorityVersion: frame.facts.selection.authorityVersion,
        artifactDigest: frame.facts.artifactDigest,
      },
    });
  }
  private createRuntime(
    limits: GuestLimits,
  ): AppInstance<OysterInvocationHost> {
    return createCloudflareAppInstance<
      DurableObjectClass,
      OysterInvocationHost
    >(
      this.ctx,
      this.env.LOADER,
      (releaseId, scope) =>
        Effect.tryPromise({
          try: async () => {
            if (scope.kind === "invocation") return scope.frame.host.artifact;
            const release = this.release(releaseId);
            const resolved = await this.backends(release);
            if (resolved === null) throw new Error("Release has no backend");
            return { release, ...resolved };
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Release unavailable"),
        }),
      (frame) => this.guestEnv(frame),
      limits,
    );
  }
  private runtimeFor(input?: GuestLimits): AppInstance<OysterInvocationHost> {
    const limits = guestLimits(input);
    if (
      limits.cpuMs !== this.limits.cpuMs ||
      limits.subRequests !== this.limits.subRequests
    ) {
      // Supervisor/frame admission owns the permit here. The previous frame's
      // facet is already aborted before a new budget can select its runtime.
      this.runtime = this.createRuntime(limits);
      this.limits = limits;
    }
    return this.runtime;
  }
  /** The tenant this Instance's host pinned at its first apply; never its guest frame. */
  protected scope(): TenantScope {
    const row = this.ctx.storage.sql
      .exec("SELECT tenant_id, origin FROM oyster_tenant WHERE id = 1")
      .toArray()[0];
    if (row === undefined)
      throw new AppInstanceError("installation_tenant_mismatch");
    const pin = Schema.decodeUnknownSync(
      Schema.Struct({ tenant_id: tenantIdSchema, origin: Schema.String }),
    )(row);
    return tenantScope(pin.tenant_id, pin.origin);
  }

  private requireTenant(tenantId: TenantId): void {
    if (this.scope().tenantId !== tenantId)
      throw new AppInstanceError("installation_tenant_mismatch");
  }

  /** The installation this Instance serves, once an owner state named it. */
  protected installationId(): string | null {
    const row = this.ctx.storage.sql
      .exec<{ installation_id: string }>(
        "SELECT installation_id FROM oyster_owner WHERE id = 1",
      )
      .toArray()[0];
    return row?.installation_id ?? null;
  }
  /** Every binding name is the one entrypoint, routed by props; authority is checked per packet. */
  private guestEnv(frame: InvocationFrame<OysterInvocationHost>): object {
    if (frame.facts.instanceId !== this.ctx.id.name)
      throw new AppInstanceError("instance_identity_mismatch");
    return Object.fromEntries(
      Object.values(appBackendBindingKinds).map(({ name: binding }) => [
        binding,
        this.ctx.exports.OysterBinding({
          props: {
            instanceId: frame.facts.instanceId,
            binding,
            frameId: frame.frameId,
          },
        }),
      ]),
    );
  }
  /** Resolve each guest packet against its immutable frame before any host effect. */
  async bindingCall(
    raw: FrameBindingProps,
    method: string,
    input: readonly unknown[],
  ): Promise<FrameBindingReply<OysterBindingResult>> {
    return captureFrameBindingReply(() =>
      this.executeBindingCall(raw, method, input),
    );
  }

  private async executeBindingCall(
    raw: FrameBindingProps,
    method: string,
    input: readonly unknown[],
  ): Promise<OysterBindingResult> {
    const props = decodeFrameBindingProps(raw);
    const frame = this.frames.active();
    if (
      props.instanceId !== frame.facts.instanceId ||
      props.frameId !== frame.frameId
    )
      throw new AppInstanceError("revoked");
    assertBackgroundBinding(frame, props.binding);
    // A guest packet is its own entry: exactly one registry read re-admits it.
    await this.assertCurrent(frame);
    const row = this.bindings[props.binding];
    const descriptor = row?.methods[method];
    // Operations declared by the verified Release; absent bindings grant nothing.
    const granted =
      frame.facts.grants.find((grant) => grant.binding === props.binding)
        ?.operations ?? [];
    if (granted.length === 0) throw new AppInstanceError("binding_not_granted");
    if (row === undefined || descriptor === undefined) {
      const nativeGitMethod =
        props.binding === "GIT"
          ? nativeGitMethodNameSchema.safeParse(method)
          : null;
      const required = nativeGitMethod?.success
        ? nativeGitFrameMethods[nativeGitMethod.data].requiredOperations(input)
        : [method];
      if (!required.every((operation) => granted.includes(operation)))
        throw new AppInstanceError("binding_not_granted");
      throw new AppInstanceError("binding_unavailable");
    }
    const args = descriptor.decodeArgs(input);
    if (
      !descriptor
        .requiredOperations(args)
        .every((operation) => granted.includes(operation))
    )
      throw new AppInstanceError("binding_not_granted");
    const result = await row.dispatch(
      this.#bindingContext,
      frame,
      props,
      method,
      args,
    );
    if (this.frames.active() !== frame) throw new AppInstanceError("revoked");
    assertBackgroundBinding(frame, props.binding);
    return descriptor.decodeResult(result);
  }
  /** Last provider-accepted ref recorded by this installation's journal. */
  async gitTip(
    installationId: string,
    repository: string,
    ref: string,
    tenantId: TenantId = defaultTenant,
  ): Promise<string | null> {
    this.requireTenant(tenantId);
    if (installationId !== this.installationId())
      throw new AppInstanceError("instance_owner_mismatch");
    return (await this.gitJournal).tip(installationId, repository, ref);
  }
  /** Join accepted fact identity and Carrier delivery in one local transaction. */
  async recordGitPush(
    installationId: string,
    fact: AppGitPushFact,
    tenantId: TenantId = defaultTenant,
  ): Promise<"recorded" | "duplicate"> {
    this.requireTenant(tenantId);
    if (installationId !== this.installationId())
      throw new AppInstanceError("instance_owner_mismatch");
    return (await this.gitJournal).accept(installationId, fact);
  }
  /** Carrier owns retries, dead letters and retained delivery receipts. */
  async alarm(): Promise<void> {
    await (await this.gitJournal).alarm();
  }
  /** Installation changes end guest work; a Workflow cancel targets only its run. */
  async revoke(
    installationId: string,
    runId?: string,
    tenantId: TenantId = defaultTenant,
  ): Promise<void> {
    this.requireTenant(tenantId);
    if (installationId !== this.installationId())
      throw new AppInstanceError("instance_owner_mismatch");
    await this.frames.revoke(
      new AppInstanceError("revoked"),
      runId === undefined ? undefined : { runId },
    );
  }
  /** One registry read re-admits a guest binding packet against its frame. */
  private async assertCurrent(
    frame: InvocationFrame<OysterInvocationHost>,
  ): Promise<void> {
    frame.signal.throwIfAborted();
    const selected = frame.facts.selection;
    const current = await this.env.REGISTRY.getByName(
      this.scope().durableName("registry"),
    ).get(selected.owner.id);
    frame.signal.throwIfAborted();
    if (
      current === null ||
      "kind" in current ||
      current.status !== "enabled" ||
      current.instanceId !== selected.instanceId ||
      current.authorityVersion !== selected.authorityVersion ||
      current.release.releaseId !== selected.releaseId ||
      current.release.artifact.artifactDigest !==
        frame.host.artifact.release.artifact.artifactDigest
    )
      throw new AppInstanceError("revoked");
    const approved = approvedBindingGrants(
      current,
      frame.host.declaration ?? emptyAppDeclaration,
    );
    if (
      frame.facts.grants.some(
        (grant) =>
          grant.binding !== "BACKGROUND" &&
          grant.operations.some(
            (operation) =>
              approved
                .find((currentGrant) => currentGrant.binding === grant.binding)
                ?.operations.includes(operation) !== true,
          ),
      )
    )
      throw new AppInstanceError("revoked");
  }
  private async withFrame<A>(
    raw: InvocationFacts,
    limits: GuestLimits | undefined,
    work: (
      runtime: AppInstance<OysterInvocationHost>,
      frame: InvocationFrame<OysterInvocationHost>,
    ) => Promise<A>,
    tenantId: TenantId = defaultTenant,
    methodName?: string,
  ): Promise<A> {
    this.requireTenant(tenantId);
    const facts = Schema.decodeUnknownSync(invocationFactsSchema, {
      onExcessProperty: "error",
    })(raw);
    if (
      facts.instanceId !== this.ctx.id.name ||
      facts.selection.owner.kind !== "installation" ||
      facts.selection.owner.id !== this.installationId()
    )
      throw new AppInstanceError("instance_identity_mismatch");
    const release = this.release(facts.selection.releaseId);
    const resolved = await this.backends(release);
    if (resolved?.digest !== facts.artifactDigest)
      throw new AppInstanceError("invalid_invocation_facts");
    if (
      facts.subject.kind === "call" &&
      facts.subject.method !== undefined &&
      resolved.declaration?.api?.methods[facts.subject.method.name]?.effect !==
        facts.subject.method.effect
    )
      throw new AppInstanceError("invalid_invocation_facts");
    const bindings = resolved.declaration?.backend?.bindings ?? [];
    if (
      facts.grants.some((grant) => {
        if (grant.binding === "BACKGROUND") return false;
        const declared = bindings.find(
          (binding) => binding.name === grant.binding,
        );
        return (
          declared === undefined ||
          grant.operations.some(
            (operation) => !declared.operations.includes(operation),
          )
        );
      })
    )
      throw new AppInstanceError("invalid_invocation_facts");
    let scoped = facts;
    if (methodName !== undefined) {
      const api = resolved.declaration?.api;
      if (
        facts.subject.kind !== "call" ||
        !api ||
        !Object.hasOwn(api.methods, methodName)
      )
        throw new AppInstanceError("invalid_invocation_facts");
      const method = api.methods[methodName];
      if (method === undefined)
        throw new AppInstanceError("invalid_invocation_facts");
      scoped = {
        ...facts,
        grants: [
          ...scopedBindings(
            facts.grants.filter((grant) => grant.binding !== "BACKGROUND"),
            method,
          ),
          ...facts.grants.filter((grant) => grant.binding === "BACKGROUND"),
        ],
      };
    }
    let host: OysterInvocationHost = {
      artifact: { release, ...resolved },
      declaration: resolved.declaration,
      origin: "unchecked",
    };
    if (methodName !== undefined)
      host = { ...host, method: Object.freeze({ name: methodName }) };
    // Facts carry the authority admitted at the request's top. The Instance
    // checks them against the owner state the host applied to it, never by
    // calling back up to the registry.
    return this.frames.run(scoped, host, (frame) =>
      work(this.runtimeFor(limits), frame),
    );
  }
  private release(releaseId: string): Release {
    const row = this.ctx.storage.sql
      .exec("SELECT release FROM oyster_releases WHERE release_id=?", releaseId)
      .toArray()[0];
    if (row === undefined) throw new Error("Release unknown to this Instance");
    return Schema.decodeUnknownSync(Schema.fromJsonString(releaseSchema))(
      Schema.decodeUnknownSync(releaseRow)(row).release,
    );
  }
  /** Remember `release`, then apply the owner state under the host's tenant pin. */
  async apply(
    state: OwnerState,
    release: Release,
    limits: GuestLimits | undefined,
    tenant: Pick<TenantScope, "tenantId" | "origin">,
  ): Promise<InstanceResult<Instance>> {
    const selected = tenantScope(
      Schema.decodeUnknownSync(tenantIdSchema)(tenant.tenantId),
      tenant.origin,
    );
    const checkTenant = () => {
      const stored = this.ctx.storage.sql
        .exec("SELECT tenant_id, origin FROM oyster_tenant WHERE id = 1")
        .toArray()[0];
      if (stored === undefined) {
        if (this.installationId() !== null)
          throw new AppInstanceError("installation_tenant_mismatch");
        return;
      }
      const pin = this.scope();
      if (pin.tenantId !== selected.tenantId || pin.origin !== selected.origin)
        throw new AppInstanceError("installation_tenant_mismatch");
    };
    checkTenant();
    await this.frames.revoke();
    return this.frames.exclusive(async () => {
      checkTenant();
      this.ctx.storage.sql.exec(
        "INSERT INTO oyster_releases(release_id, release) VALUES(?,?) ON CONFLICT(release_id) DO NOTHING",
        release.releaseId,
        Schema.encodeUnknownSync(Schema.fromJsonString(releaseSchema))(release),
      );
      const applied = await result(this.runtimeFor(limits).apply(state));
      if (applied.ok) {
        this.ctx.storage.sql.exec(
          "INSERT INTO oyster_tenant (id, tenant_id, origin) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING",
          selected.tenantId,
          selected.origin,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO oyster_owner (id, installation_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id",
          state.owner.id,
        );
      }
      return applied;
    });
  }
  /** Forward an admitted HTTP request to the App backend. */
  async backend(
    facts: InvocationFacts,
    request: Request,
    limits?: GuestLimits,
    tenantId: TenantId = defaultTenant,
  ): Promise<Response> {
    try {
      return await this.withFrame(
        facts,
        limits,
        (runtime, frame) => Effect.runPromise(runtime.fetch(frame, request)),
        tenantId,
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof AppInstanceError ? error.code : "failed" },
        { status: error instanceof AppInstanceError ? 403 : 502 },
      );
    }
  }
  /** Deliver a Git push through the same selected-Instance admission as methods. */
  onGitPush(
    facts: InvocationFacts,
    fact: AppGitPushFact,
    limits?: GuestLimits,
    tenantId: TenantId = defaultTenant,
  ): Promise<void> {
    return this.withFrame(
      facts,
      limits,
      (runtime, frame) => Effect.runPromise(runtime.onGitPush(frame, fact)),
      tenantId,
    );
  }
  /** Ask the App's declared authorizer through the same frame-bound connection. */
  authorizeGitPush(
    facts: InvocationFacts,
    question: GitPushQuestion,
    limits?: GuestLimits,
    tenantId: TenantId = defaultTenant,
  ): Promise<GitPushVerdict> {
    return this.withFrame(
      facts,
      limits,
      (runtime, frame) =>
        Effect.runPromise(runtime.authorizeGitPush(frame, question)),
      tenantId,
    );
  }
  /** An available lane settles a refusal under an active frame with no binding grants. */
  syncRefused(
    facts: InvocationFacts,
    refusal: BackgroundSyncRefusal,
    limits?: GuestLimits,
    tenantId: TenantId = defaultTenant,
  ): Promise<void> {
    return this.withFrame(
      facts,
      limits,
      (runtime, frame) =>
        Effect.runPromise(runtime.syncRefused(frame, refusal)),
      tenantId,
    );
  }
  /** Invoke a Release-declared Gill in a fresh immutable frame. */
  gill(
    facts: InvocationFacts,
    _api: AppApi,
    source: string,
    input: GillCall,
    limits?: GuestLimits,
    tenantId: TenantId = defaultTenant,
  ): Promise<InstanceResult<GillReply>> {
    return result(
      Effect.tryPromise({
        try: () =>
          this.withFrame(
            facts,
            limits,
            (runtime, frame) => {
              const api = frame.host.declaration?.api;
              if (!api || api.methods[source]?.effect !== "read")
                throw new AppInstanceError("invalid_invocation_facts");
              return Effect.runPromise(runtime.gill(frame, api, source, input));
            },
            tenantId,
            source,
          ),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("Gill invocation failed", { cause }),
      }),
    );
  }
  /** Invoke one declared App method; the value is its AppMethodReply wire,
   * which the host handle decodes. */
  call(
    facts: InvocationFacts,
    _api: AppApi,
    name: string,
    input: OysterJson,
    limits?: GuestLimits,
    tenantId: TenantId = defaultTenant,
  ): Promise<InstanceResult<OysterJson>> {
    return result(
      Effect.tryPromise({
        try: () =>
          this.withFrame(
            facts,
            limits,
            (runtime, frame) => {
              const api = frame.host.declaration?.api;
              if (!api) throw new AppInstanceError("invalid_invocation_facts");
              return Effect.runPromise(runtime.call(frame, api, name, input));
            },
            tenantId,
            name,
          ),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("App invocation failed", { cause }),
      }),
    );
  }
}

/** One host-selected workspace shared by App context and capability adapters. */
export type OysterWorkspace = Readonly<{
  computerId: string;
  files: FileSource;
  /** Caller-scoped Computer calls; file-only workspaces omit it. */
  computer?: OysterHost["computer"];
}>;

/** Host adapters for a standalone Oyster Worker over its own bindings. */
export function oysterWorkerHost(
  env: OysterWorkerEnv,
  auth: OysterAuth,
  options: Pick<OysterHost, "guestLimits" | "appToolPolicy"> &
    Readonly<{ workspace?: OysterWorkspace; scope?: TenantScope }> = {},
): OysterHost {
  const scope = options.scope ?? tenantScope(defaultTenant, env.OYSTER_ORIGIN);
  const registry = () => env.REGISTRY.getByName(scope.durableName("registry"));
  const installations = registryInstallations(env, scope);
  const originSecret = Schema.decodeUnknownOption(Schema.NonEmptyString)(
    env.OYSTER_OWNER_KEY,
  );
  let host: OysterHost = {
    auth,
    workbench: {
      directory: async () => {
        await installations.list();
        return registry().directory();
      },
      storage: (installationId, ownerId) => ({
        read: (key) => registry().storageRead(installationId, ownerId, key),
        write: (input) =>
          registry().storageWrite(installationId, ownerId, input),
        reset: (input) =>
          registry().storageReset(installationId, ownerId, input),
        events: (key) => registry().storageEvents(installationId, ownerId, key),
      }),
    },
    guestLimits: guestLimits(options.guestLimits),
    artifacts: r2ArtifactStore(env.RELEASES),
    // File-only hosts may keep workspace files beside their Release artifacts.
    capabilities: fileCapabilities(
      options.workspace?.files ??
        r2FileSource(env.RELEASES, scope.workspacePrefix),
    ),
    installations,
    instances: {
      get: (instanceId, limits) =>
        instanceHandle(
          env.INSTANCES.getByName(instanceId),
          scope,
          guestLimits(limits),
        ),
    },
  };
  if (originSecret._tag === "Some")
    host = {
      ...host,
      backgroundOriginKey: () => backgroundOriginKey(originSecret.value),
    };
  if (options.workspace !== undefined)
    host = { ...host, computerId: options.workspace.computerId };
  if (options.workspace?.computer !== undefined)
    host = { ...host, computer: options.workspace.computer };
  if (options.appToolPolicy !== undefined)
    host = { ...host, appToolPolicy: options.appToolPolicy };
  return {
    ...host,
    mcp: {
      handleRequest: (request) =>
        remoteOysterMcp(env.MCP, scope).handleRequest(request),
    },
  };
}

/**
 * The non-git standalone root: the single owner key over the default tenant's
 * stores. Its HTTP Worker, MCP owner and background wakes all compose here.
 */
function ownerKeyRootHost(
  env: OysterWorkerEnv,
  options: Pick<OysterHost, "guestLimits"> & Readonly<{ scope?: TenantScope }>,
): OysterHost {
  return oysterWorkerHost(env, ownerKeyAuth(env.OYSTER_OWNER_KEY), options);
}

/** The non-git standalone root's MCP owner. */
export class OysterMcp extends createOysterMcpOwner<OysterWorkerEnv>(
  (env, scope) => ownerKeyRootHost(env, { scope }),
) {}

/**
 * The standalone Worker's `fetch` handler; frontend hosts are cached per env.
 * MCP transports belong to the tenant Durable Object, independent of that cache.
 */
export function createOysterWorker(
  options: Pick<OysterHost, "guestLimits"> = {},
): ExportedHandler<OysterWorkerEnv> {
  const limits = guestLimits(options.guestLimits);
  const apps = new WeakMap<OysterWorkerEnv, ReturnType<typeof createOyster>>();
  return {
    fetch(request, env) {
      let app = apps.get(env);
      if (app === undefined) {
        app = createOyster(ownerKeyRootHost(env, { guestLimits: limits }));
        apps.set(env, app);
      }
      return app.fetch(request);
    },
  };
}
