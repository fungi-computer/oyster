import type { OysterHost, OysterPrincipal } from "./host.js";
import type { VerifiedRelease } from "./release.js";
import type { Installation } from "./apps/installation.js";
import { approvedBindingGrants, type InvocationGrants } from "./apps/gate.js";
import { appToolPolicySchema } from "./apps/tools.js";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import {
  appBackendBindingKinds,
  appBackendBindingsSchema,
  appMethodCallContextSchema,
  type AppBackendBindingName,
  type AppMethodCallContext,
  type WorkflowAttestation,
} from "@fungi.computer/puffball/app";
import {
  actorLane,
  mayDefer,
  backgroundContext,
  sealBackgroundOrigin,
  type BackgroundOrigin,
  backgroundRefusalCodeSchema,
  admitClaimedOrigin,
  backgroundOriginSchema,
  type ClaimedJobAdmission,
} from "@fungi.computer/puffball/background-replay";
import {
  appApiMethodNameSchema,
  emptyAppDeclaration,
} from "@fungi.computer/puffball/app";
import {
  AppInstanceError,
  instanceIdSchema,
  selectionOf,
  selectionSchema,
  type InstanceId,
} from "./index.js";

/** One App invocation may hold authority for at most the Hub grant's lifetime. */
export const APP_INVOCATION_CEILING_MS = 60_000;

const bindingName = Schema.String.pipe(
  Schema.refine((value): value is AppBackendBindingName =>
    Object.hasOwn(appBackendBindingKinds, value),
  ),
);
const grantsSchema = Schema.Array(
  Schema.Struct({
    binding: bindingName,
    operations: Schema.Array(Schema.NonEmptyString),
  }),
).pipe(
  Schema.check(
    Schema.makeFilter((grants) =>
      Schema.is(appBackendBindingsSchema)(
        grants.map((grant) => ({
          name: grant.binding,
          operations: grant.operations,
        })),
      ),
    ),
  ),
);
/** Host-admitted facts; shape decoding does not establish host authority. */
export const invocationFactsSchema = Schema.Struct({
  instanceId: instanceIdSchema,
  selection: selectionSchema,
  artifactDigest: sha256DigestSchema,
  subject: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("call"),
      context: appMethodCallContextSchema,
      /** Originating Session supplied by capability acquisition, never App arguments. */
      sessionId: Schema.optionalKey(
        Schema.String.pipe(
          Schema.check(Schema.isMinLength(1)),
          Schema.check(Schema.isMaxLength(256)),
        ),
      ),
      /** Captured Agent approval, supplied by the host after current policy admission. */
      agentPolicy: Schema.optionalKey(
        Schema.Struct({
          policyRevision: appToolPolicySchema.fields.revision,
          grantorMemberId: appToolPolicySchema.fields.grantedBy,
        }),
      ),
      /** Verified method metadata; raw fetch frames have no declared method. */
      method: Schema.optionalKey(
        Schema.Struct({
          name: appApiMethodNameSchema,
          effect: Schema.Literals(["read", "write", "external"]),
        }),
      ),
      /** Host-marked, freshly admitted replay; never read from guest input. */
      replay: Schema.optionalKey(
        Schema.Struct({
          lane: Schema.NonEmptyString,
          epoch: Schema.Number.check(
            Schema.isInt(),
            Schema.isGreaterThan(0),
            Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
          ),
          admitted: Schema.Array(appApiMethodNameSchema).check(
            Schema.isMaxLength(256),
            Schema.makeFilter((names) => new Set(names).size === names.length),
          ),
        }),
      ),
    }),
    Schema.Struct({
      kind: Schema.Literal("lifecycle"),
      name: Schema.Literal("onGitPush"),
      eventId: Schema.NonEmptyString,
    }),
    Schema.Struct({
      kind: Schema.Literal("lifecycle"),
      name: Schema.Literal("syncRefused"),
      lane: Schema.String.check(
        Schema.makeFilter(
          (lane) =>
            lane.startsWith("member:") && lane.length > 7 && lane.length <= 263,
        ),
      ),
      code: Schema.Literals(backgroundRefusalCodeSchema.options),
    }),
  ]),
  grants: grantsSchema,
  deadlineAt: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
  ancestry: Schema.Array(instanceIdSchema),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (facts) =>
        facts.instanceId === facts.selection.instanceId &&
        (facts.subject.kind !== "lifecycle" ||
          facts.subject.name !== "syncRefused" ||
          facts.grants.length === 0) &&
        (facts.subject.kind !== "call" ||
          facts.subject.agentPolicy === undefined ||
          facts.subject.context.actor.kind === "agent") &&
        (facts.subject.kind !== "call" ||
          facts.subject.context.backgroundLane === undefined ||
          (facts.subject.method?.effect === "write" &&
            facts.subject.context.backgroundOrigin?.method ===
              facts.subject.method.name &&
            mayDefer(facts.subject.context, facts.ancestry))) &&
        facts.grants.some((grant) => grant.binding === "BACKGROUND") ===
          (facts.subject.kind === "call" &&
            facts.subject.replay !== undefined) &&
        (facts.subject.kind !== "call" ||
          facts.subject.replay === undefined ||
          (facts.subject.method?.effect === "write" &&
            facts.subject.context.backgroundLane === undefined &&
            mayDefer(facts.subject.context, facts.ancestry) &&
            facts.subject.replay.lane ===
              actorLane(facts.subject.context.actor))),
    ),
  ),
);
/** The immutable authority and attribution supplied at host admission. */
export type InvocationFacts = typeof invocationFactsSchema.Type;
/** Method name/effect taken from a verified API; raw backend requests have no method. */
export type InvocationMethod = NonNullable<
  Extract<InvocationFacts["subject"], { kind: "call" }>["method"]
>;
/** Captured policy identity; the Agent id remains on the canonical call actor. */
export type InvocationAgentPolicy = NonNullable<
  Extract<InvocationFacts["subject"], { kind: "call" }>["agentPolicy"]
>;
/** A live frame stays inside its Instance; host state and signals never cross RPC. */
export type InvocationFrame<Host = unknown> = Readonly<{
  frameId: string;
  facts: InvocationFacts;
  host: Host;
  signal: AbortSignal;
}>;
/** One mutable origin latch on the host state of one invocation, never shared across frames. */
export type BackgroundFrameState = {
  /** This frame's one claimed-origin decision; never carried into another frame. */
  origin: "unchecked" | "admitted" | "refused";
};

/** Block replay capability effects before job-origin admission; storage permits claiming/settling. */
export function assertBackgroundBinding(
  frame: InvocationFrame<BackgroundFrameState>,
  binding: AppBackendBindingName,
): void {
  if (
    frame.signal.aborted ||
    (frame.facts.subject.kind === "call" &&
      frame.facts.subject.replay !== undefined &&
      binding !== "BACKGROUND" &&
      binding !== "APP_STORAGE" &&
      frame.host.origin !== "admitted")
  )
    throw new AppInstanceError("revoked");
}

/** Consume this frame's one origin check before awaiting verification, then retain only its decision. */
export async function admitBackgroundFrame(
  key: CryptoKey,
  frame: InvocationFrame<BackgroundFrameState>,
  raw: unknown,
): Promise<ClaimedJobAdmission> {
  assertBackgroundBinding(frame, "BACKGROUND");
  const subject = frame.facts.subject;
  if (
    subject.kind !== "call" ||
    subject.replay === undefined ||
    frame.host.origin !== "unchecked"
  )
    return { kind: "refused", code: "access_changed" };
  frame.host.origin = "refused";
  const origin = backgroundOriginSchema.safeParse(raw);
  if (!origin.success) return { kind: "refused", code: "access_changed" };
  const decision = await admitClaimedOrigin(
    key,
    {
      instanceId: frame.facts.instanceId,
      lane: subject.replay.lane,
      admitted: subject.replay.admitted,
    },
    origin.data,
  );
  assertBackgroundBinding(frame, "BACKGROUND");
  frame.host.origin = decision.kind;
  return decision;
}
/** The host's native guest-abort and authority-close hooks. */
export type InvocationGatePorts<Host> = Readonly<{
  /** Stop the guest when the captured invocation's authority closes. */
  abortGuest: () => Promise<void>;
  /** Release the host resources belonging to this completed or revoked frame. */
  close: (frame: InvocationFrame<Host>) => Promise<void>;
  /** Host clock used to enforce the frame deadline; defaults to Date.now. */
  now?: () => number;
}>;
/** One invocation owner shared by Hub shards and standalone Instances. */
export type InvocationGate<Host> = Readonly<{
  /** Run work within one immutable frame and close its authority afterward. */
  run: <A>(
    facts: InvocationFacts,
    host: Host,
    work: (frame: InvocationFrame<Host>) => Promise<A>,
  ) => Promise<A>;
  /** Resolve the sole admitted frame, refusing outside an active invocation. */
  active: () => InvocationFrame<Host>;
  /** Close live authority, optionally restricted to frames of a selected run. */
  revoke: (
    reason?: Error,
    target?: Readonly<{ runId: string }>,
  ) => Promise<void>;
  /** Serialize supervisor metadata/erasure without opening guest authority. */
  exclusive: <A>(work: () => Promise<A>) => Promise<A>;
}>;
const frameIds = defineIdFamily({
  family: "app-invocation-frame",
  version: 1,
  kinds: { frame: { prefix: "app_frame" } },
});
/** Decode only identities minted from the invocation-frame ID family. */
export const invocationFrameIdSchema = Schema.String.check(
  Schema.makeFilter((value) => frameIds.frame.is(value)),
);

const parseFacts = Schema.decodeUnknownSync(invocationFactsSchema, {
  onExcessProperty: "error",
});

function immutableFacts(facts: InvocationFacts): InvocationFacts {
  Object.freeze(facts.selection.owner);
  Object.freeze(facts.selection);
  if (facts.subject.kind === "call") {
    Object.freeze(facts.subject.context.actor);
    if (facts.subject.context.workflow) {
      Object.freeze(facts.subject.context.workflow.armedBy);
      Object.freeze(facts.subject.context.workflow);
    }
    Object.freeze(facts.subject.context);
    if (facts.subject.agentPolicy) Object.freeze(facts.subject.agentPolicy);
    if (facts.subject.method) Object.freeze(facts.subject.method);
    if (facts.subject.replay) Object.freeze(facts.subject.replay);
  }
  Object.freeze(facts.subject);
  for (const grant of facts.grants) {
    Object.freeze(grant.operations);
    Object.freeze(grant);
  }
  Object.freeze(facts.grants);
  Object.freeze(facts.ancestry);
  return Object.freeze(facts);
}

/** Serialize authority, preempt replay only for verified writes, and close each guest before admission. */
export function createInvocationGate<Host>(
  ports: InvocationGatePorts<Host>,
): InvocationGate<Host> {
  const permit = Semaphore.makeUnsafe(1);
  const now = ports.now ?? Date.now;
  let foregroundWaiting = 0;
  let active:
    | {
        frame: InvocationFrame<Host>;
        controller: AbortController;
        closing?: Promise<void>;
      }
    | undefined;
  const close = (
    state: NonNullable<typeof active>,
    reason: Error,
  ): Promise<void> => {
    if (state.closing) return state.closing;
    if (active === state) active = undefined;
    state.controller.abort(reason);
    state.closing = (async () => {
      try {
        await ports.abortGuest();
      } finally {
        await ports.close(state.frame);
      }
    })();
    return state.closing;
  };
  const run = async <A>(
    input: InvocationFacts,
    host: Host,
    work: (frame: InvocationFrame<Host>) => Promise<A>,
  ): Promise<A> => {
    let facts: InvocationFacts;
    try {
      facts = immutableFacts(structuredClone(parseFacts(input)));
    } catch (cause) {
      throw new AppInstanceError("invalid_invocation_facts", { cause });
    }
    // This must happen before waiting: self-invocation already holds the permit.
    if (facts.ancestry.includes(facts.instanceId))
      throw new AppInstanceError("reentrant");
    let queuedForeground =
      facts.subject.kind === "call" && facts.subject.replay === undefined;
    if (queuedForeground) foregroundWaiting += 1;
    try {
      if (facts.deadlineAt <= now()) throw new AppInstanceError("expired");
      // Reads wait for the current replay step under the same permit. Only a
      // verified write closes replay; Watchdog recovers its retained claim.
      if (
        queuedForeground &&
        facts.subject.kind === "call" &&
        facts.subject.method?.effect === "write" &&
        active?.frame.facts.subject.kind === "call" &&
        active.frame.facts.subject.replay !== undefined
      )
        await close(active, new AppInstanceError("revoked"));
      return await Effect.runPromise(
        permit.withPermits(1)(
          Effect.tryPromise({
            try: async () => {
              if (
                facts.subject.kind === "call" &&
                facts.subject.replay !== undefined &&
                foregroundWaiting > 0
              )
                throw new AppInstanceError("revoked");
              if (queuedForeground) {
                foregroundWaiting -= 1;
                queuedForeground = false;
              }
              const { deadlineAt } = facts;
              if (deadlineAt <= now()) throw new AppInstanceError("expired");
              const frameId = frameIds.frame.generate();
              const controller = new AbortController();
              const frame = Object.freeze({
                frameId,
                facts,
                host,
                signal: controller.signal,
              });
              const state = { frame, controller };
              active = state;
              let timer: ReturnType<typeof setTimeout> | undefined;
              let stop: () => void = () => undefined;
              const revoked = new Promise<never>((_resolve, reject) => {
                const onAbort = () => {
                  const reason: unknown = controller.signal.reason;
                  reject(
                    reason instanceof Error
                      ? reason
                      : new AppInstanceError("revoked"),
                  );
                };
                controller.signal.addEventListener("abort", onAbort, {
                  once: true,
                });
                stop = () => {
                  controller.signal.removeEventListener("abort", onAbort);
                };
                timer = setTimeout(
                  () => {
                    controller.abort(new AppInstanceError("expired"));
                  },
                  Math.max(0, deadlineAt - now()),
                );
              });
              try {
                return await Promise.race([work(frame), revoked]);
              } finally {
                clearTimeout(timer);
                stop();
                await close(state, new AppInstanceError("revoked"));
              }
            },
            catch: (cause) =>
              cause instanceof Error
                ? cause
                : new Error("App invocation failed", { cause }),
          }),
        ),
      );
    } finally {
      if (queuedForeground) foregroundWaiting -= 1;
    }
  };
  return {
    run,
    exclusive: (work) =>
      Effect.runPromise(
        permit.withPermits(1)(
          Effect.tryPromise({
            try: work,
            catch: (cause) =>
              cause instanceof Error
                ? cause
                : new Error("Instance supervisor operation failed", { cause }),
          }),
        ),
      ),
    active: () => {
      if (
        active === undefined ||
        active.controller.signal.aborted ||
        active.frame.facts.deadlineAt <= now()
      )
        throw new AppInstanceError("revoked");
      return active.frame;
    },
    revoke: (reason = new AppInstanceError("revoked"), target) => {
      if (active === undefined) return Promise.resolve();
      if (
        target !== undefined &&
        (active.frame.facts.subject.kind !== "call" ||
          active.frame.facts.subject.context.workflow?.runId !== target.runId)
      )
        return Promise.resolve();
      return close(active, reason);
    },
  };
}

/** Verified selection, artifact and binding grants before caller attribution. */
export type InvocationAuthority = Omit<
  InvocationFacts,
  "subject" | "deadlineAt"
>;
/** The host supplies both deadlines; the frame cannot outlive either. */
export type InvocationDeadline = Readonly<{
  deadlineAt: number;
  grantExpiresAt: number;
}>;
/**
 * Project an admitted principal into App attribution; only the host chooses
 * the fixed Computer context. The App caller grammar has no visitor actor, so
 * the anonymous public reader is attributed as the reserved `visitor` key
 * without a Computer. Host admission reads the principal, never this projection.
 */
export function invocationCallerContext(
  principal: OysterPrincipal,
  computerId: string | null,
): AppMethodCallContext {
  const { actor } = principal;
  if (actor.kind === "visitor")
    return { computerId: null, actor: { kind: "team-key", keyId: "visitor" } };
  if (!("role" in principal)) return { computerId, actor };
  return principal.soleMember === true
    ? { computerId, actor, role: principal.role, soleMember: true }
    : { computerId, actor, role: principal.role };
}
/** Shared host-held caller/Workflow fact builders, never guest argument decoders. */
export const invocationFacts = {
  /** Combine host-admitted caller facts with the invocation and grant deadlines. */
  fromCaller: (
    authority: InvocationAuthority,
    context: AppMethodCallContext,
    deadline: InvocationDeadline,
    method?: InvocationMethod,
    sessionId?: string,
    agentPolicy?: InvocationAgentPolicy,
  ): InvocationFacts => {
    let subject: Extract<InvocationFacts["subject"], { kind: "call" }> = {
      kind: "call",
      context,
    };
    if (method !== undefined) subject = { ...subject, method };
    if (sessionId !== undefined) subject = { ...subject, sessionId };
    if (agentPolicy !== undefined) subject = { ...subject, agentPolicy };
    return parseFacts({
      ...authority,
      subject,
      deadlineAt: Math.min(deadline.deadlineAt, deadline.grantExpiresAt),
    });
  },
  /** Attribute an already host-admitted published node to its retained arming actor. */
  fromWorkflowNode: (
    authority: InvocationAuthority,
    input: Readonly<{
      workflow: WorkflowAttestation;
      computerId: string | null;
      role?: AppMethodCallContext["role"];
      idempotencyKey: string;
    }>,
    deadline: InvocationDeadline,
  ): InvocationFacts => {
    const context: AppMethodCallContext = {
      actor: input.workflow.armedBy,
      computerId: input.computerId,
      idempotencyKey: input.idempotencyKey,
      workflow: input.workflow,
    };
    if (input.role !== undefined) context.role = input.role;
    return invocationFacts.fromCaller(authority, context, deadline);
  },
};

/** Authority comes from the admitted installation and its verified backend bytes. */
export function invocationAuthorityOf(
  installation: Installation,
  release: VerifiedRelease,
  ancestry: readonly InstanceId[] = [],
): InvocationAuthority {
  if (release.backend === null) throw new Error("Release has no backend");
  if (
    installation.status !== "enabled" ||
    installation.release.releaseId !== release.release.releaseId ||
    installation.release.artifact.artifactDigest !==
      release.release.artifact.artifactDigest
  )
    throw new Error("Invocation installation changed");
  return {
    instanceId: selectionOf(installation).instanceId,
    selection: selectionOf(installation),
    artifactDigest: release.backend.digest,
    grants: approvedBindingGrants(
      installation,
      release.declaration ?? emptyAppDeclaration,
    ),
    ancestry,
  };
}

/** Mint standalone facts only after host caller and Release admission. */
export function admittedCallerFacts(
  installation: Installation,
  release: VerifiedRelease,
  context: AppMethodCallContext,
  grants: InvocationGrants,
  ancestry: readonly InstanceId[] = [],
  sessionId?: string,
  agentPolicy?: InvocationAgentPolicy,
  method?: InvocationMethod,
  origin?: BackgroundOrigin,
): InvocationFacts {
  const deadlineAt = Date.now() + APP_INVOCATION_CEILING_MS;
  return invocationFacts.fromCaller(
    { ...invocationAuthorityOf(installation, release, ancestry), grants },
    method === undefined
      ? context
      : backgroundContext(context, ancestry, method, origin),
    { deadlineAt, grantExpiresAt: deadlineAt },
    method,
    sessionId,
    agentPolicy,
  );
}

/** Seal the host-verified named method after its current admission checks. */
export async function admittedMethodCallerFacts(
  host: Pick<OysterHost, "backgroundOriginKey">,
  installation: Installation,
  release: VerifiedRelease,
  context: AppMethodCallContext,
  grants: InvocationGrants,
  method: InvocationMethod,
  ancestry: readonly InstanceId[] = [],
  sessionId?: string,
  agentPolicy?: InvocationAgentPolicy,
): Promise<InvocationFacts> {
  if (release.api?.methods[method.name]?.effect !== method.effect)
    throw new Error("Invocation method is not verified by the Release");
  let origin: BackgroundOrigin | undefined;
  if (method.effect === "write" && mayDefer(context, ancestry)) {
    if (host.backgroundOriginKey === undefined)
      throw new Error("Background origin key is not configured");
    origin = await sealBackgroundOrigin(await host.backgroundOriginKey(), {
      instanceId: selectionOf(installation).instanceId,
      lane: actorLane(context.actor),
      method: method.name,
    });
  }
  return admittedCallerFacts(
    installation,
    release,
    context,
    grants,
    ancestry,
    sessionId,
    agentPolicy,
    method,
    origin,
  );
}
