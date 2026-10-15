import {
  backgroundSyncRefusalSchema,
  type BackgroundSyncRefusal,
} from "@fungi.computer/puffball/background-replay";
import {
  appGitPushFactSchema,
  gitPushQuestionSchema,
  gitPushVerdictSchema,
  type AppGitPushFact,
  type GitPushQuestion,
  type GitPushVerdict,
} from "@fungi.computer/agar/git";
import * as Semaphore from "effect/Semaphore";
import { defineIdFamily, type CairnId } from "@fungi.computer/cairn/id";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { releaseIdSchema, appIdSchema } from "@fungi.computer/puffball/effect";
import type { DurableBackend } from "@fungi.computer/puffball/backend";
import type { Release, Sha256Digest } from "@fungi.computer/puffball";
import type { AppMethodReply } from "@fungi.computer/agar/backend";
import { appFacetRequest, appFacetResponse } from "./backend-request.js";
import { appApiSchema } from "@fungi.computer/puffball/app";
import type { AppApi } from "@fungi.computer/puffball";
import type { InvocationFrame } from "./invocation.js";
import type { Installation } from "./apps/installation.js";
import {
  gillCallSchema,
  gillReplySchema,
  type GillCall,
  type GillReply,
} from "@fungi.computer/gills";

/** The Cairn ID family that mints and recognizes App Instance IDs (`instance_…`). */
export const instanceIds = defineIdFamily({
  family: "app-instance",
  version: 1,
  kinds: { instance: { prefix: "instance" } },
});
/** A stable App Instance ID minted by {@link instanceIds}. */
export type InstanceId = CairnId<"app-instance", "instance">;
/** Decodes a string into an {@link InstanceId}, rejecting any other ID family. */
export const instanceIdSchema: Schema.Codec<InstanceId, string> =
  Schema.String.pipe(
    Schema.refine((value): value is InstanceId =>
      instanceIds.instance.is(value),
    ),
  );

/**
 * The owner that issues authority for an Instance: an `installation` of an App
 * or a `deployment`. Owner identity never changes for the life of an Instance.
 */
export const ownerSchema = Schema.Struct({
  kind: Schema.Literals(["installation", "deployment"]),
  id: Schema.NonEmptyString,
});
/**
 * An owner-issued selection: which Instance, owner, App and Release a request
 * runs against, at a positive authority version.
 */
export const selectionSchema = Schema.Struct({
  instanceId: instanceIdSchema,
  owner: ownerSchema,
  appId: appIdSchema,
  releaseId: releaseIdSchema,
  authorityVersion: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
});
/** A complete owner-issued state: a selection plus `enabled`, `disabled` or `deleted`. */
export const ownerStateSchema = Schema.Struct({
  ...selectionSchema.fields,
  status: Schema.Literals(["enabled", "disabled", "deleted"]),
});
/** A decoded {@link ownerStateSchema} value, the input to `apply`. */
export type OwnerState = Schema.Schema.Type<typeof ownerStateSchema>;
/**
 * The persisted Instance record: the last applied selection, its state-schema
 * version, the owner's desired status and the runtime's own status.
 */
export const instanceSchema = Schema.Struct({
  ...selectionSchema.fields,
  stateSchema: Schema.NullOr(Schema.Number),
  desiredStatus: ownerStateSchema.fields.status,
  status: Schema.Literals(["active", "disabled", "deleting", "deleted"]),
});
/** A decoded {@link selectionSchema} value, the authority for `fetch` and `call`. */
export type Selection = Schema.Schema.Type<typeof selectionSchema>;

/** The admitted selection for an installation's Instance. */
export function selectionOf(installation: Installation): Selection {
  if (installation.instanceId === null)
    throw new Error("Installation has no Instance");
  return {
    instanceId: installation.instanceId,
    owner: { kind: "installation", id: installation.installationId },
    appId: installation.release.appId,
    releaseId: installation.release.releaseId,
    authorityVersion: installation.authorityVersion,
  };
}
/** A decoded {@link instanceSchema} record, as returned by `apply` and `inspect`. */
export type Instance = Schema.Schema.Type<typeof instanceSchema>;
/** A resolved, verified durable backend: its Release, artifact digest and code. */
export type Backend = Readonly<{
  release: Release;
  digest: Sha256Digest;
  backend: DurableBackend;
}>;
/** The runtime owns the bounded rejection grammar, including across RPC. */
export const appInstanceErrorCodeSchema = Schema.Literals([
  "invalid_owner_state",
  "invalid_invocation_facts",
  "revoked",
  "binding_not_granted",
  "binding_unavailable",
  "expired",
  "reentrant",
  "instance_identity_mismatch",
  "instance_owner_mismatch",
  "conflicting_owner_state",
  "stale_authority",
  "instance_deleted",
  "release_app_mismatch",
  "state_schema_migration_unsupported",
  "instance_inactive",
  "instance_authority_version_mismatch",
  "release_no_longer_matches_instance",
  "instance_release_mismatch",
  "installation_tenant_mismatch",
]);
/** One of the bounded {@link appInstanceErrorCodeSchema} rejection codes. */
export type AppInstanceErrorCode = typeof appInstanceErrorCodeSchema.Type;

const APP_INSTANCE_ERROR_MESSAGES = {
  invalid_owner_state: "Invalid owner state",
  invalid_invocation_facts: "Invalid invocation facts",
  revoked: "Invocation authority revoked",
  binding_not_granted: "Binding operation not granted",
  binding_unavailable: "Binding operation unavailable on this host",
  expired: "Invocation deadline exceeded",
  reentrant: "Invocation would re-enter an active Instance",
  instance_identity_mismatch: "Instance identity mismatch",
  instance_owner_mismatch: "Instance owner mismatch",
  conflicting_owner_state: "Conflicting owner state",
  stale_authority: "Stale authority",
  instance_deleted: "Instance deleted",
  release_app_mismatch: "Release belongs to another App",
  state_schema_migration_unsupported: "State schema migration not supported",
  instance_inactive: "Instance inactive",
  instance_authority_version_mismatch: "Instance authority version mismatch",
  release_no_longer_matches_instance: "Release no longer matches Instance",
  instance_release_mismatch: "Instance release mismatch",
  installation_tenant_mismatch: "Installation tenant mismatch",
} satisfies Record<AppInstanceErrorCode, string>;

/** Stable runtime failure identity; message remains presentation only. */
export class AppInstanceError extends Error {
  override readonly name = "AppInstanceError";
  constructor(
    readonly code: AppInstanceErrorCode,
    options?: ErrorOptions,
  ) {
    super(APP_INSTANCE_ERROR_MESSAGES[code], options);
  }
}

/** Supervisor schema checks do not open guest authority; execution carries a frame. */
export type BackendResolution<Host> =
  | Readonly<{ kind: "metadata" }>
  | Readonly<{ kind: "invocation"; frame: InvocationFrame<Host> }>;

/** Host storage, verified artifact resolution, and frame-bound execution ports. */
export type InstancePorts<Host> = Readonly<{
  /** The stable ID every owner state and selection must name. */
  instanceId: string;
  /** Read the persisted Instance record, or `null` before the first apply. */
  read: () => Effect.Effect<Instance | null, Error>;
  /** Persist the Instance record. */
  write: (instance: Instance) => Effect.Effect<void, Error>;
  /** Resolve a Release ID to its verified durable backend. */
  resolve: (
    release: Selection["releaseId"],
    scope: BackendResolution<Host>,
  ) => Effect.Effect<Backend, Error>;
  /** Abort in-flight backend work and invalidate existing connections. */
  abort: () => Effect.Effect<void, Error>;
  /** Delete the backend's own state. */
  purge: () => Effect.Effect<void, Error>;
  /**
   * Acquire a connection to the backend under admission. A later `abort` must
   * invalidate connections acquired before it.
   */
  connect: (
    backend: Backend,
    frame: InvocationFrame<Host>,
  ) => Effect.Effect<AppBackendConnection, Error>;
}>;
/** One admitted connection to a running App backend. */
export type AppBackendConnection = Readonly<{
  /** Ask the App about the whole external push under this admitted connection. */
  authorizeGitPush?: (
    question: GitPushQuestion,
  ) => Effect.Effect<GitPushVerdict, Error>;
  /** Handle an accepted Git push under the same selected Instance authority. */
  onGitPush?: (fact: AppGitPushFact) => Effect.Effect<void, Error>;
  /** Settle the refused member lane, without binding authority. */
  syncRefused?: (refusal: BackgroundSyncRefusal) => Effect.Effect<void, Error>;
  /** Send an HTTP request to the backend. */
  fetch: (request: Request) => Effect.Effect<Response, Error>;
  /** Invoke a declared backend method under the connection's immutable frame;
   * the App's typed refusal is a reply, not a failure. */
  call: (
    name: string,
    input: Schema.Json,
  ) => Effect.Effect<AppMethodReply, Error>;
  /** Invoke the generated Gill entry under the connection's immutable frame. */
  gill: (cargo: Schema.Json) => Effect.Effect<Schema.Json, Error>;
}>;
const failure = (code: AppInstanceErrorCode) =>
  Effect.fail(new AppInstanceError(code));
const sameOwner = (a: Selection, b: Selection) =>
  a.instanceId === b.instanceId &&
  a.owner.kind === b.owner.kind &&
  a.owner.id === b.owner.id &&
  a.appId === b.appId;

/** The lifecycle and admission operations of one App Instance. */
export type AppInstance<Host> = Readonly<{
  /**
   * Apply a complete owner state. Exact retries return the recorded result;
   * changed input at the same version conflicts and older versions are stale.
   */
  apply: (input: OwnerState) => Effect.Effect<Instance, Error>;
  /** Admit the frame's selection and forward an HTTP request to the active backend. */
  fetch: (
    frame: InvocationFrame<Host>,
    request: Request,
  ) => Effect.Effect<Response, Error>;
  /** Admit the frame and invoke a method declared by the Release's App API. */
  call: (
    frame: InvocationFrame<Host>,
    api: AppApi,
    name: string,
    input: Schema.Json,
  ) => Effect.Effect<AppMethodReply, Error>;
  /** Invoke a Gill's generated entry under its declared source read's frame. */
  gill: (
    frame: InvocationFrame<Host>,
    api: AppApi,
    source: string,
    input: GillCall,
  ) => Effect.Effect<GillReply, Error>;
  /** Authorize a whole external push through the same frame-bound connection. */
  authorizeGitPush: (
    frame: InvocationFrame<Host>,
    question: GitPushQuestion,
  ) => Effect.Effect<GitPushVerdict, Error>;
  /** Deliver a host-admitted Git push under exact live Instance selection. */
  onGitPush: (
    frame: InvocationFrame<Host>,
    fact: AppGitPushFact,
  ) => Effect.Effect<void, Error>;
  /** Deliver a zero-grant refusal to an active, freshly selected backend. */
  syncRefused: (
    frame: InvocationFrame<Host>,
    refusal: BackgroundSyncRefusal,
  ) => Effect.Effect<void, Error>;
  /** Read the current Instance record, resuming an interrupted purge. */
  inspect: () => Effect.Effect<Instance | null, Error>;
}>;

/**
 * Create the resource-local lifecycle for one App Instance over host ports.
 * This is not admission: the host must obtain real authority from its owner
 * before calling `apply`, `fetch` or `call`.
 */
export function createAppInstance<Host>(
  ports: InstancePorts<Host>,
): AppInstance<Host> {
  const lock = Semaphore.makeUnsafe(1);
  const read = Effect.gen(function* () {
    const current = yield* ports.read();
    if (current?.status === "deleting") {
      yield* ports.purge();
      const deleted = { ...current, status: "deleted" as const };
      yield* ports.write(deleted);
      return deleted;
    }
    return current;
  });
  const apply = (input: OwnerState) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const desired = yield* Schema.decodeUnknownEffect(ownerStateSchema)(
          input,
        ).pipe(
          Effect.mapError(() => new AppInstanceError("invalid_owner_state")),
        );
        if (desired.instanceId !== ports.instanceId)
          return yield* failure("instance_identity_mismatch");
        const current = yield* read;
        if (current && !sameOwner(current, desired))
          return yield* failure("instance_owner_mismatch");
        const retry =
          current !== null &&
          current.authorityVersion === desired.authorityVersion;
        if (
          retry &&
          (current.releaseId !== desired.releaseId ||
            current.desiredStatus !== desired.status)
        )
          return yield* failure("conflicting_owner_state");
        if (current && desired.authorityVersion < current.authorityVersion)
          return yield* failure("stale_authority");
        if (current?.status === "deleted") {
          if (retry && desired.status === "deleted") return current;
          return yield* failure("instance_deleted");
        }
        if (retry && current.status === "active") return current;
        let stateSchema = current?.stateSchema ?? null;
        if (desired.status === "enabled") {
          const resolved = yield* ports.resolve(desired.releaseId, {
            kind: "metadata",
          });
          if (resolved.release.appId !== desired.appId)
            return yield* failure("release_app_mismatch");
          if (
            stateSchema !== null &&
            stateSchema !== resolved.backend.runtime.stateSchema
          )
            return yield* failure("state_schema_migration_unsupported");
          stateSchema = resolved.backend.runtime.stateSchema;
        }
        const next = {
          ...desired,
          desiredStatus: desired.status,
          stateSchema,
          status:
            desired.status === "deleted"
              ? ("deleting" as const)
              : ("disabled" as const),
        };
        // Persist the exact owner fact before stopping runtime; no resource-issued version.
        yield* ports.write(next);
        yield* ports.abort();
        if (desired.status === "deleted") yield* ports.purge();
        const receipt = {
          ...next,
          status:
            desired.status === "enabled"
              ? ("active" as const)
              : desired.status === "deleted"
                ? ("deleted" as const)
                : ("disabled" as const),
        };
        yield* ports.write(receipt);
        return receipt;
      }),
    );
  const connect = (frame: InvocationFrame<Host>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            frame.signal.throwIfAborted();
          },
          catch: () => new AppInstanceError("revoked"),
        });
        if (frame.facts.deadlineAt <= Date.now())
          return yield* failure("expired");
        const authority = frame.facts.selection;
        if (frame.facts.instanceId !== ports.instanceId)
          return yield* failure("instance_identity_mismatch");
        const current = yield* read;
        if (current?.status !== "active")
          return yield* failure("instance_inactive");
        if (!sameOwner(current, authority))
          return yield* failure("instance_owner_mismatch");
        if (current.authorityVersion !== authority.authorityVersion)
          return yield* failure("instance_authority_version_mismatch");
        const scope: BackendResolution<Host> = { kind: "invocation", frame };
        const storedBackend = yield* ports.resolve(current.releaseId, scope);
        if (
          storedBackend.release.appId !== current.appId ||
          storedBackend.backend.runtime.stateSchema !== current.stateSchema
        )
          return yield* failure("release_no_longer_matches_instance");
        const backend =
          authority.releaseId === current.releaseId
            ? storedBackend
            : yield* ports.resolve(authority.releaseId, scope);
        if (
          backend.release.appId !== authority.appId ||
          backend.backend.runtime.stateSchema !== current.stateSchema
        )
          return yield* failure("release_no_longer_matches_instance");
        if (backend.digest !== storedBackend.digest)
          return yield* failure("instance_release_mismatch");
        if (backend.digest !== frame.facts.artifactDigest)
          return yield* failure("instance_release_mismatch");
        yield* Effect.try({
          try: () => {
            frame.signal.throwIfAborted();
          },
          catch: () => new AppInstanceError("revoked"),
        });
        if (frame.facts.deadlineAt <= Date.now())
          return yield* failure("expired");
        return yield* ports.connect(backend, frame);
      }),
    );
  const fetch = (frame: InvocationFrame<Host>, request: Request) =>
    connect(frame).pipe(
      Effect.flatMap((connection) =>
        connection
          .fetch(appFacetRequest(request))
          .pipe(Effect.map(appFacetResponse)),
      ),
    );
  const call = (
    frame: InvocationFrame<Host>,
    api: AppApi,
    name: string,
    input: Schema.Json,
  ) =>
    frame.facts.subject.kind !== "call"
      ? failure("invalid_invocation_facts")
      : Schema.decodeUnknownEffect(appApiSchema)(api).pipe(
          Effect.mapError(
            (cause) => new Error("App method declaration invalid", { cause }),
          ),
          Effect.flatMap((declaration) => {
            if (!Object.hasOwn(declaration.methods, name))
              return Effect.fail(new Error("App method not declared"));
            const subject = frame.facts.subject;
            if (
              subject.kind !== "call" ||
              (subject.method !== undefined &&
                (subject.method.name !== name ||
                  subject.method.effect !== declaration.methods[name]?.effect))
            )
              return failure("invalid_invocation_facts");
            return connect(frame).pipe(
              Effect.flatMap((connection) => connection.call(name, input)),
            );
          }),
          Effect.mapError((cause) =>
            cause instanceof Error
              ? cause
              : new Error("App method context invalid", { cause }),
          ),
        );
  const gill = (
    frame: InvocationFrame<Host>,
    api: AppApi,
    source: string,
    input: GillCall,
  ) =>
    Effect.gen(function* () {
      if (frame.facts.subject.kind !== "call")
        return yield* failure("invalid_invocation_facts");
      const declaration = yield* Schema.decodeUnknownEffect(appApiSchema)(api);
      if (
        !Object.hasOwn(declaration.methods, source) ||
        declaration.methods[source]?.effect !== "read"
      )
        return yield* Effect.fail(
          new Error("Gill source must be a declared read method"),
        );
      const selected = yield* Schema.decodeUnknownEffect(gillCallSchema)(
        input,
        { onExcessProperty: "error" },
      );
      const cargo = yield* Schema.decodeUnknownEffect(Schema.Json)(selected);
      const connection = yield* connect(frame);
      const result = yield* connection.gill(cargo);
      return yield* Schema.decodeUnknownEffect(gillReplySchema)(result, {
        onExcessProperty: "error",
      });
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error
          ? cause
          : new Error("App Gill context invalid", { cause }),
      ),
    );
  const authorizeGitPush = (
    frame: InvocationFrame<Host>,
    raw: GitPushQuestion,
  ) =>
    Effect.try({
      try: () => gitPushQuestionSchema.parse(raw),
      catch: (cause) => new Error("Git push question invalid", { cause }),
    }).pipe(
      Effect.flatMap((question) =>
        connect(frame).pipe(
          Effect.flatMap((connection) =>
            connection.authorizeGitPush === undefined
              ? Effect.fail(new Error("App Git push authorizer unavailable"))
              : connection.authorizeGitPush(question),
          ),
        ),
      ),
      Effect.flatMap((verdict) =>
        Effect.try({
          try: () => gitPushVerdictSchema.parse(verdict),
          catch: (cause) => new Error("Git push verdict invalid", { cause }),
        }),
      ),
    );
  const onGitPush = (frame: InvocationFrame<Host>, raw: AppGitPushFact) =>
    Effect.try({
      try: () => appGitPushFactSchema.parse(raw),
      catch: (cause) => new Error("Git push fact invalid", { cause }),
    }).pipe(
      Effect.flatMap((fact) =>
        frame.facts.subject.kind !== "lifecycle" ||
        frame.facts.subject.name !== "onGitPush" ||
        frame.facts.subject.eventId !== fact.eventId
          ? failure("invalid_invocation_facts")
          : connect(frame).pipe(
              Effect.flatMap((connection) =>
                connection.onGitPush === undefined
                  ? Effect.fail(new Error("App Git push handler unavailable"))
                  : connection.onGitPush(fact),
              ),
            ),
      ),
    );
  const syncRefused = (
    frame: InvocationFrame<Host>,
    raw: BackgroundSyncRefusal,
  ) =>
    Effect.try({
      try: () => backgroundSyncRefusalSchema.parse(raw),
      catch: (cause) => new Error("Background refusal invalid", { cause }),
    }).pipe(
      Effect.flatMap((refusal) => {
        const subject = frame.facts.subject;
        if (
          subject.kind !== "lifecycle" ||
          subject.name !== "syncRefused" ||
          frame.facts.grants.length !== 0 ||
          subject.lane !== refusal.lane ||
          subject.code !== refusal.code
        )
          return failure("invalid_invocation_facts");
        return connect(frame).pipe(
          Effect.flatMap((connection) =>
            connection.syncRefused === undefined
              ? Effect.fail(
                  new Error("App background refusal handler unavailable"),
                )
              : connection.syncRefused(refusal),
          ),
        );
      }),
    );
  return {
    syncRefused,
    apply,
    fetch,
    call,
    gill,
    authorizeGitPush,
    onGitPush,
    inspect: () => lock.withPermits(1)(read),
  };
}
