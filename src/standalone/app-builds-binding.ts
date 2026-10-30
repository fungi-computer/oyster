/**
 * The APPS guest binding on the standalone Bonsai root: register an App from
 * its repository's committed root manifest, start a build job on
 * this Oyster's one Computer, read a job's status, and install (or switch) a
 * Release at an installation id. Every operation re-checks the caller is the
 * tenant owner; the binding carries no key and no owner secret.
 */
import { z } from "zod";
import { buildStartFailureReply } from "./builds.js";
import * as Schema from "effect/Schema";
import { AppInstanceError } from "../index.js";
import type { FrameBindingMethods, FrameBindingProps } from "../cloudflare.js";
import type { InvocationFrame } from "../invocation.js";
import type { OysterBindingContext, OysterBindingResult } from "../workers.js";
import { installOrSelect, verifyRelease } from "../host.js";
import { repositoryWorkflowSourceSchema } from "@fungi.computer/workflows-wire";
import { installationIdSchema } from "../apps/index.js";
import { appIdSchema, releaseSchema } from "@fungi.computer/puffball/effect";
import { gitRepositoryNameSchema } from "@fungi.computer/puffball/git-representation";
import type { TenantPrincipal, TenantScope } from "../tenant.js";
import type { StandaloneComputerEnv } from "./computer.js";

/** The calling tenant's registry owns its App builds. */
const buildRegistry = (env: StandaloneComputerEnv, scope: TenantScope) =>
  env.REGISTRY.getByName(scope.durableName("registry"));

const repositoryName = Schema.String.check(
  Schema.makeFilter((name) => gitRepositoryNameSchema.safeParse(name).success),
);
const registrationArgs = Schema.decodeUnknownSync(
  Schema.Tuple([Schema.Struct({ repo: repositoryName })]),
  { onExcessProperty: "error" },
);

const buildInput = z.lazy(() =>
  z.strictObject({
    appId: z.string().min(1).max(256),
    sourceRevision: z.string().min(1).max(256),
    installationId: z.string().min(1).max(256).optional(),
  }),
);
// Workflows wait for their particular job; Settings discovers the latest
// job for its captured installation's repository after reload.
const buildStatusArgs = Schema.decodeUnknownSync(
  Schema.Tuple([
    Schema.Union([
      Schema.Struct({
        jobId: Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(256),
        ),
      }),
      Schema.Struct({ repo: repositoryName }),
    ]),
  ]),
  { onExcessProperty: "error" },
);
const selectInput = z.lazy(() =>
  z.strictObject({
    installationId: z.string().min(1).max(256),
    jobId: z.string().min(1).max(256),
    release: z.unknown(),
  }),
);

/** The Instance gate and native guest entrypoint share these argument codecs. */
export const appsFrameMethods = {
  APPS: {
    repository: {
      decodeArgs: registrationArgs,
      decodeResult: Schema.decodeUnknownSync(Schema.Json),
      requiredOperations: () => ["repository"],
    },
    register: {
      decodeArgs: registrationArgs,
      decodeResult: Schema.decodeUnknownSync(Schema.Json),
      requiredOperations: () => ["register"],
    },
    build: {
      decodeArgs: (raw) => z.tuple([buildInput]).parse(raw),
      decodeResult: Schema.decodeUnknownSync(Schema.Json),
      requiredOperations: () => ["build"],
    },
    buildStatus: {
      decodeArgs: buildStatusArgs,
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

/** Only a live owner call reaches registration, build, status or select; a key or a
 * member without the owner role is refused before any registry or host read. */
function callerOwner(frame: InvocationFrame): TenantPrincipal {
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
  if (method === "repository") {
    const subject = frame.facts.subject;
    if (frame.facts.selection.owner.kind !== "installation")
      throw new AppInstanceError("revoked");
    if (subject.kind === "call") callerOwner(frame);
    else if (subject.name !== "onGitPush")
      throw new AppInstanceError("revoked");
    const [input] = registrationArgs(args);
    const installationId = frame.facts.selection.owner.id;
    const source = await buildRegistry(env, scope).repositoryBuildSource(
      installationId,
      input.repo,
    );
    if (source === null) return null;
    const host = await backgroundHost();
    if (host === null) throw new AppInstanceError("revoked");
    const installation = await host.installations.get(installationId);
    if (
      installation?.status !== "enabled" ||
      installation.instanceId !== frame.facts.instanceId ||
      installation.authority.authorityVersion !==
        frame.facts.selection.authorityVersion ||
      installation.release.appId !== frame.facts.selection.appId ||
      installation.release.releaseId !== frame.facts.selection.releaseId
    )
      throw new AppInstanceError("revoked");
    const verified = await verifyRelease(
      host.artifacts,
      installation.release,
      undefined,
      false,
    );
    frame.signal.throwIfAborted();
    // invocationAuthorityOf pins executable backend bytes, not the App descriptor.
    if (verified.backend?.digest !== frame.facts.artifactDigest)
      throw new AppInstanceError("revoked");
    return Schema.decodeUnknownSync(Schema.Json)(
      Schema.decodeUnknownSync(repositoryWorkflowSourceSchema)({
        appId: source.appId,
        installationId,
        callerAppId: verified.release.appId,
        callerSourceRevision:
          verified.release.artifact.provenance.sourceRevision,
      }),
    );
  }
  const principal = callerOwner(frame);
  const requestedBy =
    principal.actor.kind === "member" ? principal.actor.memberId : "owner";
  if (method === "register") {
    const [input] = registrationArgs(args);
    let result;
    try {
      result = await buildRegistry(env, scope).registerRepositoryApp({
        memberId: requestedBy,
        installationId: frame.facts.selection.owner.id,
        repository: input.repo,
      });
    } catch {
      frame.signal.throwIfAborted();
      return { status: 503, body: { error: "App registration unavailable" } };
    }
    frame.signal.throwIfAborted();
    if (result.kind === "registered")
      return {
        status: 200,
        body: { appId: result.appId, sourceRevision: result.sourceRevision },
      };
    switch (result.kind) {
      case "unauthorized":
        return { status: 403, body: { error: "Owner only" } };
      case "invalid_app":
        return {
          status: 400,
          body: { error: "Repository has no valid root App manifest" },
        };
      case "conflict":
        return {
          status: 409,
          body: {
            error: "App identity is already registered to another source",
          },
        };
    }
  }
  if (method === "build") {
    const [input] = z.tuple([buildInput]).parse(args);
    const appId = Schema.decodeUnknownSync(appIdSchema)(input.appId);
    const registry = buildRegistry(env, scope);
    const context =
      frame.facts.subject.kind === "call"
        ? frame.facts.subject.context
        : undefined;
    const workflowRequestId =
      context?.workflow === undefined ? undefined : context.idempotencyKey;
    if (context?.workflow !== undefined && workflowRequestId === undefined)
      throw new AppInstanceError("revoked");
    const request: Parameters<typeof registry.startBuild>[0] = {
      appId,
      sourceRevision: input.sourceRevision,
      requestedBy,
    };
    if (input.installationId !== undefined && workflowRequestId === undefined)
      throw new AppInstanceError("revoked");
    if (workflowRequestId !== undefined) {
      request.workflow = {
        requestId: workflowRequestId,
        callerInstallationId: frame.facts.selection.owner.id,
      };
      if (input.installationId !== undefined)
        request.workflow.installationId = input.installationId;
    }
    let result;
    try {
      result = await registry.startBuild(request);
    } catch {
      return Schema.decodeUnknownSync(Schema.Json)(
        buildStartFailureReply("unavailable"),
      );
    }
    frame.signal.throwIfAborted();
    return Schema.decodeUnknownSync(Schema.Json)(
      result.kind === "started"
        ? { status: 202, body: result.build }
        : buildStartFailureReply(result.reason),
    );
  }
  if (method === "buildStatus") {
    const [input] = buildStatusArgs(args);
    const registry = buildRegistry(env, scope);
    const build =
      "repo" in input
        ? await registry.readRepositoryBuild(
            frame.facts.selection.owner.id,
            input.repo,
          )
        : await registry.readInstallationBuild(
            frame.facts.selection.owner.id,
            input.jobId,
          );
    frame.signal.throwIfAborted();
    const missingJob = build === null && "jobId" in input;
    return Schema.decodeUnknownSync(Schema.Json)({
      status: missingJob ? 404 : 200,
      body: missingJob ? { error: "Not found" } : build,
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
    if (
      frame.facts.subject.kind === "call" &&
      frame.facts.subject.context.workflow !== undefined
    ) {
      const result = await buildRegistry(env, scope).installWorkflowBuild(
        input.jobId,
        installationId,
        release,
        requestedBy,
        frame.facts.selection.owner.id,
      );
      frame.signal.throwIfAborted();
      return Schema.decodeUnknownSync(Schema.Json)(result);
    }
    const host = await backgroundHost();
    if (host === null) throw new AppInstanceError("revoked");
    const response = await installOrSelect(
      host,
      installationId,
      release,
      principal,
      "install-or-select",
      "app",
    );
    frame.signal.throwIfAborted();
    return Schema.decodeUnknownSync(Schema.Json)(
      await responseResult(response),
    );
  }
  throw new AppInstanceError("revoked");
}
