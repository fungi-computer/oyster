import { appMethodReplySchema } from "@fungi.computer/agar/backend";
import { nativeGitFrameMethods } from "@fungi.computer/agar/git-rpc";
import { rpcHandleSchema, rpcMethod } from "@fungi.computer/agar/rpc";
import {
  facetInvocationModule,
  facetFrameBindingModule,
} from "./facet-invocation.js";
import {
  createFrameBindingWire,
  type FrameBindingReply,
} from "./frame-binding-wire.js";
export type {
  FrameBindingReply,
  FrameBindingWire,
} from "./frame-binding-wire.js";
import {
  backgroundSyncRefusalSchema,
  claimedJobAdmissionSchema,
  type ClaimedJobAdmission,
} from "@fungi.computer/puffball/background-replay";
export type { BackgroundFrameState } from "./invocation.js";
import { causeClass, failureDiagnostic, guestFailure } from "./cause-class.js";
import {
  appGitPushFactSchema,
  gitPushVerdictSchema,
} from "@fungi.computer/agar/git";
import { WorkerEntrypoint } from "cloudflare:workers";
import { guestLimits, type GuestLimits } from "./guest-policy.js";
export type { GuestLimits } from "./guest-policy.js";
import {
  appBackendBindingKinds,
  type AppBackendBindingName,
} from "@fungi.computer/puffball/app";
import { isAppApiMethodName } from "@fungi.computer/puffball/app-method-runtime";
import {
  createInvocationGate,
  invocationFrameIdSchema,
  type InvocationFrame,
  type InvocationGate,
} from "./invocation.js";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { z } from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  createAppInstance,
  AppInstanceError,
  instanceIdSchema,
  instanceSchema,
  appInstanceErrorCodeSchema,
  type AppInstance,
  type InstancePorts,
} from "./index.js";

const bindingWire = createFrameBindingWire(appInstanceErrorCodeSchema.literals);

/** Encode supervisor refusals before native RPC can discard Error properties. */
export async function captureFrameBindingReply<Value>(
  run: () => Promise<Value>,
): Promise<FrameBindingReply<Value>> {
  try {
    return { kind: "result", value: await run() };
  } catch (cause) {
    if (cause instanceof AppInstanceError)
      return { kind: "local_refusal", code: cause.code };
    throw cause;
  }
}

/** Retained shard reply ceiling; replies settle before the frame aborts its facet. */
export const MAX_APP_REPLY_BYTES = 240 * 1024;

type HttpBodyCeiling = Readonly<{ bytes: number; message: string }>;
// Match the retained signed shard request and reply body ceilings.
const requestBodyCeiling: HttpBodyCeiling = {
  bytes: 64 * 1024,
  message: "App request too large",
};
const replyBodyCeiling: HttpBodyCeiling = {
  bytes: MAX_APP_REPLY_BYTES,
  message: "App result too large",
};

async function readHttpBody(
  body: ReadableStream<unknown> | null,
  ceiling: HttpBodyCeiling,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = z.instanceof(Uint8Array).parse(next.value);
      if (chunk.byteLength === 0) continue;
      size += chunk.byteLength;
      if (size > ceiling.bytes) throw new Error(ceiling.message);
      chunks.push(chunk);
    }
  } catch (cause) {
    await reader.cancel(cause);
    throw cause;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Host-minted caller-frame routing props; never supplied by the App. */
export type FrameBindingProps = Readonly<{
  instanceId: string;
  binding: AppBackendBindingName;
  frameId: string;
}>;

/** The host's maintained positional argument/result codecs and operation policy. */
export type FrameBindingMethod<Result> = Readonly<{
  /** Decode the guest's positional arguments with the maintained method grammar. */
  decodeArgs: (raw: readonly unknown[]) => readonly unknown[];
  decodeResult: z.ZodType<Result>["parse"];
  /** Determine the declared operations needed for these decoded arguments. */
  requiredOperations: (args: readonly unknown[]) => readonly string[];
}>;

/** Method descriptors for the closed App binding vocabulary. */
export type FrameBindingMethods<Result> = Readonly<
  Partial<
    Record<
      AppBackendBindingName,
      Readonly<Record<string, FrameBindingMethod<Result>>>
    >
  >
>;

/** Shared replay-only port codecs. Origin input is verified by the host and fails with a typed refusal. */
export const backgroundFrameMethods = {
  BACKGROUND: {
    admit: {
      /** Malformed arity supplies invalid origin evidence for the host's typed refusal. */
      decodeArgs: (raw: readonly unknown[]) => {
        const parsed = z.tuple([z.unknown()]).safeParse(raw);
        return parsed.success ? parsed.data : [undefined];
      },
      /** Preserve the host's closed admitted/refused result. */
      decodeResult: (raw: unknown) => claimedJobAdmissionSchema.parse(raw),
      /** Only the host-minted replay grant supplies this operation. */
      requiredOperations: () => ["admit"],
    },
  },
} satisfies FrameBindingMethods<ClaimedJobAdmission>;

/** The shared RPC boundary decoder for host-minted invocation binding props. */
export const frameBindingPropsSchema = Schema.Struct({
  instanceId: instanceIdSchema,
  frameId: invocationFrameIdSchema,
  binding: Schema.String.pipe(
    Schema.refine((value): value is AppBackendBindingName =>
      Object.hasOwn(appBackendBindingKinds, value),
    ),
  ),
});

/** Decode a host routing packet or refuse it before any Instance lookup. */
export function decodeFrameBindingProps(raw: unknown): FrameBindingProps {
  try {
    return Schema.decodeUnknownSync(frameBindingPropsSchema, {
      onExcessProperty: "error",
    })(raw);
  } catch (cause) {
    throw new AppInstanceError("revoked", { cause });
  }
}

/** One native binding factory for both Hub and standalone, preserving RPC values. */
export function frameBindingEntrypoint<Env, Result>(
  methods: FrameBindingMethods<Result>,
  dispatch: (
    env: Env,
    props: FrameBindingProps,
    method: string,
    args: readonly unknown[],
  ) => Promise<FrameBindingReply<unknown>>,
): typeof WorkerEntrypoint<Env, FrameBindingProps> {
  return class FrameBinding extends WorkerEntrypoint<Env, FrameBindingProps> {
    static {
      const names = new Set([
        ...Object.values(methods).flatMap((binding) => Object.keys(binding)),
        ...Object.values(appBackendBindingKinds).flatMap((binding) =>
          Object.keys(binding.operations),
        ),
        ...Object.keys(nativeGitFrameMethods),
      ]);
      for (const method of names) {
        Object.defineProperty(this.prototype, method, {
          value: async function (
            this: FrameBinding,
            ...raw: readonly unknown[]
          ): Promise<FrameBindingReply<Result>> {
            const checked = await captureFrameBindingReply(async () => {
              const props = decodeFrameBindingProps(this.ctx.props);
              const descriptor = methods[props.binding]?.[method];
              let args: readonly unknown[];
              try {
                args =
                  descriptor === undefined ? raw : descriptor.decodeArgs(raw);
              } catch (cause) {
                throw new AppInstanceError("invalid_invocation_facts", {
                  cause,
                });
              }
              return {
                descriptor,
                reply: await dispatch(this.env, props, method, args),
              };
            });
            if (checked.kind === "local_refusal") return checked;
            const { descriptor, reply } = checked.value;
            const decoded = bindingWire.decode(reply);
            if (decoded.kind === "local_refusal") return decoded;
            if (descriptor === undefined)
              throw new AppInstanceError("invalid_invocation_facts");
            return {
              kind: "result",
              value: descriptor.decodeResult(decoded.value),
            };
          },
        });
      }
    }
  };
}

/** Native facet handle; method RPCs are decoded at the invocation boundary. */
export type AppFacetStub = Readonly<{
  /** Issue an HTTP request through the native facet handle. */
  fetch: (request: Request) => Promise<Response>;
}>;

const facetHttpReplySchema = z.strictObject({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.instanceof(ReadableStream).nullable(),
});
// App methods return JSON; HTTP carries binary bytes and lifecycle hooks return void.
// Binding operation results keep their separate, operation-specific decoders.
const facetHttpInputSchema = z.strictObject({
  url: z.string(),
  method: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.instanceof(Uint8Array).nullable(),
});
const facetInvocationSchema = rpcHandleSchema({
  invoke: rpcMethod(z.union([z.json(), z.undefined()])).input(
    z.tuple([z.string(), z.array(z.unknown()), z.unknown()]),
  ),
  http: rpcMethod(facetHttpReplySchema).input(
    z.tuple([facetHttpInputSchema, z.unknown()]),
  ),
});

/**
 * Only the native storage and facet capabilities used by an App Instance.
 * `FacetClass` is the host's Durable Object class type (`DurableObjectClass`
 * on workerd, celld and Cloudflare); Oyster passes it through unopened.
 */
export type AppInstanceContext<FacetClass> = Readonly<{
  /** The Durable Object's ID; its `name` is the Instance ID. */
  id: Readonly<{ name?: string | undefined }>;
  /** The Durable Object's SQLite storage, used for supervisor state only. */
  storage: WatchdogSqliteOwner;
  /** The Durable Object's facets; the App backend runs in the `app` facet. */
  facets: Readonly<{
    /** Get or create the named facet from the class `prepare` returns. */
    get: (name: string, prepare: () => { class: FacetClass }) => AppFacetStub;
    /** Abort the named facet's in-flight work with `reason`. */
    abort: (name: string, reason: Error) => void;
    /** Delete the named facet and its storage. */
    delete: (name: string) => void;
  }>;
}>;

/** The module set the Worker Loader runs for one App backend. */
export type AppWorkerCode = Readonly<{
  compatibilityDate: string;
  mainModule: string;
  modules: Readonly<Record<string, string>>;
  env: object;
  globalOutbound: null;
  /** Per-invocation guest budgets, enforced by the Worker Loader. */
  limits: GuestLimits;
}>;

/** Loader memoization and class lookup; entrypoint access is not required. */
export type AppInstanceLoader<FacetClass> = Readonly<{
  /** Get or load the Worker for `id`, calling `configure` only on a cache miss. */
  get: (
    id: string,
    configure: () => AppWorkerCode,
  ) => Readonly<{
    /** Look up the Durable Object class the backend exports as `exportName`. */
    getDurableObjectClass: (exportName: string) => FacetClass;
  }>;
}>;

/** End the native App facet before shared frame admission releases its permit. */
export function createCloudflareInvocationGate<Host, FacetClass>(
  ctx: Pick<AppInstanceContext<FacetClass>, "facets">,
  close: (frame: InvocationFrame<Host>) => Promise<void>,
): InvocationGate<Host> {
  return createInvocationGate({
    abortGuest: () => {
      ctx.facets.abort("app", new AppInstanceError("revoked"));
      return Promise.resolve();
    },
    close,
  });
}

/**
 * Run an App Instance inside a SQLite-backed Durable Object on workerd, celld
 * or Cloudflare. Supervisor state lives in the Durable Object's own SQLite; the
 * App backend runs in a named `app` facet loaded through the Worker Loader, so
 * its database survives Release replacement and stays separate from the
 * supervisor. Guest code gets only host gatekeeper bindings and no ambient outbound access.
 *
 * @param ctx - The Durable Object's name, storage and facets.
 * @param loader - The Worker Loader binding; without it backend execution is unavailable.
 * @param resolve - Resolves a Release ID to its verified durable backend.
 * @param guestEnv - Mints loopbacks bound to the captured invocation frame.
 * @param limits - Guest CPU and subrequest budgets; omitted fields use safe defaults.
 */
export function createCloudflareAppInstance<FacetClass, Host>(
  ctx: AppInstanceContext<FacetClass>,
  loader: AppInstanceLoader<FacetClass> | undefined,
  resolve: InstancePorts<Host>["resolve"],
  guestEnv: (frame: InvocationFrame<Host>) => object,
  limits?: Partial<GuestLimits>,
): AppInstance<Host> {
  const budget = guestLimits(limits);
  const sql = ctx.storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS app_instance (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL)",
  );
  const attempt = <A>(run: () => A) =>
    Effect.try({
      try: run,
      catch: (error) =>
        error instanceof Error ? error : new Error("Instance storage failure"),
    });
  const instanceId = ctx.id.name;
  if (!instanceId) throw new Error("Named Instance required");
  // A guest isolate whose invocation failed (or whose earlier frame was
  // canceled mid-call) may stay unusable inside the Loader's per-isolate memo.
  // Each such failure retires the guest: the facet is aborted and the next
  // frame loads a fresh isolate under a loader id named by the retiring frame.
  // Empty until a failure: a healthy Instance keeps its original loader id.
  let retiredBy = "";
  const retireGuest = (frame: InvocationFrame<Host>) => {
    retiredBy = `:${frame.frameId}`;
    ctx.facets.abort("app", new AppInstanceError("revoked"));
  };
  /**
   * A failure that came back through the App facet keeps its identity, retires
   * the guest, and its possibly guest-authored text never reaches host logs.
   * Host refusal codes stay host-owned and keep the guest.
   */
  const facetFailure = (
    frame: InvocationFrame<Host>,
    stage: "backend_execution" | "git_push" | "background_refusal",
    cause: unknown,
    fallback: () => Error,
  ): Error => {
    if (cause instanceof AppInstanceError) {
      if (stage === "backend_execution")
        console.error("AppInstance failure", {
          stage,
          code: cause.code,
          causeClass: causeClass(cause),
        });
      return cause;
    }
    const failure = cause instanceof Error ? guestFailure(cause) : fallback();
    retireGuest(frame);
    console.error("AppInstance failure", {
      stage,
      code: "failed",
      ...failureDiagnostic(cause),
      recycled: true,
    });
    return failure;
  };
  return createAppInstance<Host>({
    instanceId,
    read: () =>
      attempt(() => {
        const stored = sql
          .exec("SELECT record FROM app_instance WHERE id=1")
          .toArray()[0];
        const row =
          stored === undefined
            ? null
            : Schema.decodeUnknownSync(
                Schema.Struct({ record: Schema.String }),
              )(stored);
        return row
          ? Schema.decodeUnknownSync(Schema.fromJsonString(instanceSchema))(
              row.record,
            )
          : null;
      }),
    write: (value) =>
      attempt(() => {
        sql.exec(
          "INSERT INTO app_instance(id,record) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
          Schema.encodeUnknownSync(Schema.fromJsonString(instanceSchema))(
            value,
          ),
        );
      }),
    resolve,
    abort: () =>
      attempt(() => {
        ctx.facets.abort("app", new Error("Instance authority changed"));
      }),
    purge: () =>
      attempt(() => {
        ctx.facets.delete("app");
      }),
    connect: (artifact, frame) =>
      attempt(() => {
        if (!loader) throw new Error("App backend execution unavailable");
        let stub: z.infer<typeof facetInvocationSchema>;
        try {
          // The suffix retires a failed guest isolate (see retireGuest).
          const key = `${String(budget.cpuMs)}:${String(budget.subRequests)}${retiredBy}`;
          const loaderId = `${instanceId}:${artifact.digest}:${key}`;
          stub = facetInvocationSchema.parse(
            ctx.facets.get("app", () => ({
              // Worker Loader memoizes `get(id)` per host isolate, and Instances
              // of every Team share host isolates. A digest-only id would hand
              // one Instance's guest module scope to another Instance of the
              // same Release, so the id is scoped to this Instance.
              class: loader
                .get(loaderId, () => ({
                  compatibilityDate: artifact.backend.compatibilityDate,
                  mainModule: "invocation.js",
                  modules: {
                    "backend.js": artifact.backend.code,
                    "invocation.js": facetInvocationModule(
                      artifact.backend.exportName,
                    ),
                    "frame-binding-wire.js": facetFrameBindingModule,
                  },
                  env: {},
                  globalOutbound: null,
                  limits: budget,
                }))
                .getDurableObjectClass("AppInvocation"),
            })),
          );
        } catch (error) {
          // The Loader and facet are host platform: their text is host-owned.
          retireGuest(frame);
          console.error("AppInstance failure", {
            stage: "artifact_resolve",
            code: "failed",
            ...failureDiagnostic(error),
            recycled: true,
          });
          throw error;
        }
        // A host that cannot mint its binding stubs refuses the frame by code;
        // it never hands the guest a partial env or an untyped failure.
        let bindings: object;
        try {
          bindings = guestEnv(frame);
        } catch (cause) {
          if (cause instanceof AppInstanceError) throw cause;
          throw new AppInstanceError("binding_unavailable", { cause });
        }
        // A Gill enters through its one reserved generated entry; every
        // other entry is a declared method answering with an AppMethodReply.
        const invokeEntry = (entry: string, input: Schema.Json) =>
          Effect.tryPromise({
            try: async () => {
              if (frame.facts.subject.kind !== "call")
                throw new AppInstanceError("invalid_invocation_facts");
              if (entry !== "gill" && !isAppApiMethodName(entry))
                throw new AppInstanceError("invalid_invocation_facts");
              const result = Schema.decodeUnknownSync(Schema.Json)(
                await stub.invoke(
                  entry,
                  [input, frame.facts.subject.context],
                  bindings,
                ),
              );
              if (
                new TextEncoder().encode(JSON.stringify(result)).byteLength >
                MAX_APP_REPLY_BYTES
              )
                throw new Error("App result too large");
              if (frame.signal.aborted) throw new AppInstanceError("revoked");
              return result;
            },
            catch: (cause) =>
              facetFailure(
                frame,
                "backend_execution",
                cause,
                () => new Error("App method failed"),
              ),
          });
        return {
          fetch: (request: Request) =>
            Effect.tryPromise({
              try: async () => {
                const reply = facetHttpReplySchema.parse(
                  await stub.http(
                    {
                      url: request.url,
                      method: request.method,
                      headers: [...request.headers],
                      body: await readHttpBody(
                        request.body,
                        requestBodyCeiling,
                      ),
                    },
                    bindings,
                  ),
                );
                const body = await readHttpBody(reply.body, replyBodyCeiling);
                if (frame.signal.aborted) throw new AppInstanceError("revoked");
                return new Response(body, {
                  status: reply.status,
                  statusText: reply.statusText,
                  headers: reply.headers,
                });
              },
              catch: (error) =>
                facetFailure(
                  frame,
                  "backend_execution",
                  error,
                  () => new Error("App execution failed"),
                ),
            }),
          authorizeGitPush: (question) =>
            Effect.tryPromise({
              try: async () => {
                const verdict = gitPushVerdictSchema.parse(
                  await stub.invoke("authorizeGitPush", [question], bindings),
                );
                if (frame.signal.aborted) throw new AppInstanceError("revoked");
                return verdict;
              },
              catch: (cause) =>
                facetFailure(
                  frame,
                  "git_push",
                  cause,
                  () =>
                    new Error("App Git push authorization failed", { cause }),
                ),
            }),
          syncRefused: (refusal) =>
            Effect.tryPromise({
              try: async () => {
                z.void().parse(
                  await stub.invoke(
                    "syncRefused",
                    [backgroundSyncRefusalSchema.parse(refusal)],
                    bindings,
                  ),
                );
                if (frame.signal.aborted) throw new AppInstanceError("revoked");
              },
              catch: (cause) =>
                facetFailure(
                  frame,
                  "background_refusal",
                  cause,
                  () =>
                    new Error("App background refusal handler failed", {
                      cause,
                    }),
                ),
            }),
          onGitPush: (fact) =>
            Effect.tryPromise({
              try: async () => {
                z.void().parse(
                  await stub.invoke(
                    "onGitPush",
                    [appGitPushFactSchema.parse(fact)],
                    bindings,
                  ),
                );
                if (frame.signal.aborted) throw new AppInstanceError("revoked");
              },
              catch: (cause) =>
                facetFailure(
                  frame,
                  "git_push",
                  cause,
                  () => new Error("App Git push handler failed", { cause }),
                ),
            }),
          call: (name: string, input: Schema.Json) =>
            invokeEntry(name, input).pipe(
              Effect.flatMap((raw) =>
                Effect.try({
                  try: () => appMethodReplySchema.parse(raw),
                  catch: (cause) =>
                    new Error("App method reply invalid", { cause }),
                }),
              ),
            ),
          gill: (cargo: Schema.Json) => invokeEntry("gill", cargo),
        };
      }),
  });
}
