/**
 * The APPS guest binding on the standalone Bonsai root: start a build job on
 * this Oyster's one Computer, read a job's status, and install (or switch) a
 * Release at an installation id. Every operation re-checks the caller is the
 * tenant owner; the binding carries no key and no owner secret.
 */
import { z } from "zod";
import * as Schema from "effect/Schema";
import { AppInstanceError } from "../index.js";
import type { FrameBindingMethods, FrameBindingProps } from "../cloudflare.js";
import type { InvocationFrame } from "../invocation.js";
import type { OysterBindingContext, OysterBindingResult } from "../workers.js";
import { installOrSelect, type OysterPrincipal } from "../host.js";
import { installationIdSchema } from "../apps/index.js";
import { appIdSchema, releaseSchema } from "@fungi.computer/puffball/effect";
import type { TenantScope } from "../tenant.js";
import type { StandaloneComputerEnv } from "./computer.js";

/** The calling tenant's registry owns its App builds. */
const buildRegistry = (env: StandaloneComputerEnv, scope: TenantScope) =>
  env.REGISTRY.getByName(scope.durableName("registry"));

const buildInput = z.lazy(() =>
  z.strictObject({
    appId: z.string().min(1).max(256),
    sourceRevision: z.string().min(1).max(256),
  }),
);
const buildStatusInput = z.lazy(() =>
  z.strictObject({
    jobId: z.string().min(1).max(256),
  }),
);
const selectInput = z.lazy(() =>
  z.strictObject({
    installationId: z.string().min(1).max(256),
    release: z.unknown(),
  }),
);

/** The Instance gate and native guest entrypoint share these argument codecs. */
export const appsFrameMethods = {
  APPS: {
    build: {
      decodeArgs: (raw) => z.tuple([buildInput]).parse(raw),
      decodeResult: Schema.decodeUnknownSync(Schema.Json),
      requiredOperations: () => ["build"],
    },
    buildStatus: {
      decodeArgs: (raw) => z.tuple([buildStatusInput]).parse(raw),
      decodeResult: Schema.decodeUnknownSync(Schema.Json),
      requiredOperations: () => ["buildStatus"],
    },
    select: {
      decodeArgs: (raw) => z.tuple([selectInput]).parse(raw),
      decodeResult: Schema.decodeUnknownSync(Schema.Json),
      requiredOperations: () => ["select"],
    },
  },
} satisfies FrameBindingMethods<OysterBindingResult>;

/** Only a live owner call reaches build, status or select; a key or a
 * member without the owner role is refused before any registry or host read. */
function callerOwner(frame: InvocationFrame): OysterPrincipal {
  const subject = frame.facts.subject;
  if (
    subject.kind !== "call" ||
    subject.context.actor.kind !== "member" ||
    subject.context.role !== "owner"
  )
    throw new AppInstanceError("revoked");
  return { actor: subject.context.actor, role: "owner" };
}

async function responseResult(
  response: Response,
): Promise<Readonly<{ status: number; body: unknown }>> {
  return { status: response.status, body: await response.json() };
}

/** Called only after the Instance resolves the captured frame and current grants. */
export async function dispatchAppsBuildsBinding(
  env: StandaloneComputerEnv,
  scope: TenantScope,
  frame: InvocationFrame,
  props: FrameBindingProps,
  method: string,
  args: readonly unknown[],
  backgroundHost: OysterBindingContext<StandaloneComputerEnv>["backgroundHost"],
): Promise<OysterBindingResult> {
  frame.signal.throwIfAborted();
  if (props.binding !== "APPS") throw new AppInstanceError("revoked");
  const principal = callerOwner(frame);
  const requestedBy =
    principal.actor.kind === "member" ? principal.actor.memberId : "owner";
  if (method === "build") {
    const [input] = z.tuple([buildInput]).parse(args);
    const appId = Schema.decodeUnknownSync(appIdSchema)(input.appId);
    const registry = buildRegistry(env, scope);
    let build;
    try {
      build = await registry.startBuild({
        appId,
        sourceRevision: input.sourceRevision,
        requestedBy,
      });
    } catch {
      return Schema.decodeUnknownSync(Schema.Json)({
        status: 409,
        body: { error: "App has no build source" },
      });
    }
    frame.signal.throwIfAborted();
    return Schema.decodeUnknownSync(Schema.Json)({ status: 202, body: build });
  }
  if (method === "buildStatus") {
    const [input] = z.tuple([buildStatusInput]).parse(args);
    const build = await buildRegistry(env, scope).readBuild(input.jobId);
    frame.signal.throwIfAborted();
    return Schema.decodeUnknownSync(Schema.Json)({
      status: build === null ? 404 : 200,
      body: build ?? { error: "Not found" },
    });
  }
  if (method === "select") {
    const [input] = z.tuple([selectInput]).parse(args);
    const installationId = installationIdSchema.parse(input.installationId);
    let release;
    try {
      release = Schema.decodeUnknownSync(releaseSchema)(input.release, {
        onExcessProperty: "error",
      });
    } catch {
      return Schema.decodeUnknownSync(Schema.Json)({
        status: 400,
        body: { error: "Invalid Release" },
      });
    }
    const host = await backgroundHost();
    if (host === null) throw new AppInstanceError("revoked");
    const response = await installOrSelect(
      host,
      installationId,
      release,
      principal,
    );
    frame.signal.throwIfAborted();
    return Schema.decodeUnknownSync(Schema.Json)(
      await responseResult(response),
    );
  }
  throw new AppInstanceError("revoked");
}
