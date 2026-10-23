import { z } from "zod";
import {
  MAX_REFERENCE_BYTES,
  MediaSettingsError,
} from "@fungi.computer/darkroom";
import { AppInstanceError } from "../index.js";
import type { FrameBindingMethods, FrameBindingProps } from "../cloudflare.js";
import type { InvocationFrame } from "../invocation.js";
import type { OysterBindingResult } from "../workers.js";
import { readMediaFailure } from "@fungi.computer/darkroom/browser";
import { appMediaGenerationResultSchema } from "@fungi.computer/darkroom/app-media-contracts";
import { mediaSlot } from "../media.js";
import { Hono } from "hono";
import * as Schema from "effect/Schema";
import { pendingSchema } from "@fungi.computer/agar/backend-definition";
import {
  mediaGenerationDescriptionSchema,
  mediaGenerationJsonRequestSchema,
  mediaGenerationReferenceSchema,
} from "@fungi.computer/agar/media-json";
import {
  createMediaService,
  mediaPendingSchema,
  mediaResultSchema,
  type MediaServiceHost,
  mediaBindingCallSchema,
  mediaBindingRequest,
  parseMediaBindingCall,
  readMediaBindingReply,
} from "@fungi.computer/darkroom/server";
import {
  createWorkersAiMediaProvider,
  type MediaAiPort,
  createImagesReferenceFitter,
  type MediaImagePort,
} from "@fungi.computer/darkroom/cloudflare";
import {
  oysterPrincipalId,
  type CapabilityEnv,
  type OysterCapability,
} from "../host.js";
import type { TenantPrincipal } from "../tenant.js";
import { normalizeFilePath } from "../files.js";
import type { FileSource } from "../files.js";

/** Bindings for Media generation into the standalone Oyster workspace. */
export type OysterMediaEnv = Readonly<{
  /** Workers AI provider, admitted by this Worker. */
  AI: MediaAiPort;
  /** Darkroom's durable operation namespace. */
  MEDIA_OPERATION: MediaServiceHost["operations"];
  /** Native image decoding and bounded reference fitting. */
  IMAGES?: MediaImagePort;
  /** The AI Gateway third-party models (GPT Image 2, Seedance, Veo) route
   * through. The background retry owner already reads this same binding
   * name for its own provider, so one var wires both doors. */
  AI_GATEWAY_ID?: string;
}>;

/** Media capability using Darkroom execution and the existing workspace FileSource. */
export function workersMedia(
  env: OysterMediaEnv,
  workspace: Readonly<{ computerId: string; files: FileSource }>,
): readonly OysterCapability[] {
  const { computerId } = workspace;
  const routes = new Hono<CapabilityEnv>();
  const service = (principal: TenantPrincipal) =>
    standaloneMediaService(env, oysterPrincipalId(principal), workspace);
  routes.get("/describe", async (context) => {
    const response = await service(context.env.principal).request(
      "http://media/models",
    );
    return context.json(
      Schema.decodeUnknownSync(mediaGenerationDescriptionSchema)({
        computerId,
        canGenerate: true,
        models: await response.json(),
      }),
    );
  });
  routes.post("/generate", async (context) => {
    const input = Schema.decodeUnknownOption(
      Schema.fromJsonString(mediaGenerationJsonRequestSchema),
      { onExcessProperty: "error" },
    )(await context.req.text());
    if (input._tag === "None") return context.json(invalidRequest());
    const path = normalizeFilePath(input.value.destination.path);
    if (path === null || path === "/") return context.json(invalidRequest());
    const references = input.value.settings.references?.map((reference) => ({
      ...reference,
      computerId,
      path: normalizeFilePath(reference.path),
    }));
    if (
      references?.some(
        (reference) => reference.path === null || reference.path === "/",
      )
    )
      return context.json(invalidRequest());
    const response = await service(context.env.principal).request(
      "http://media/generate",
      {
        method: "POST",
        signal: context.req.raw.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": input.value.requestId,
        },
        body: JSON.stringify({
          path,
          settings: { ...input.value.settings, references },
        }),
      },
    );
    if (!response.ok) {
      const failure = await readMediaFailure(response);
      const projected =
        failure === null
          ? {
              message: "Invalid media service response",
              code: "PROTOCOL",
              retryable: false,
            }
          : {
              message: failure.error,
              code: failure.code,
              stage: failure.stage,
              retryable: failure.retryable,
            };
      if (failure?.provider !== undefined)
        return context.json({
          kind: "failed",
          failure: { ...projected, provider: failure.provider },
        });
      return context.json({ kind: "failed", failure: projected });
    }
    if (response.status === 202) {
      const pending = mediaPendingSchema.parse(await response.json());
      return context.json(
        pendingSchema.parse({
          kind: "pending",
          retryAfterMs: pending.retryAfterSeconds * 1_000,
        }),
      );
    }
    const { path: destination, ...result } = mediaResultSchema.parse(
      await response.json(),
    );
    return context.json({
      kind: "succeeded",
      result: {
        ...result,
        destination: { computerId, path: destination },
      },
    });
  });
  routes.post("/cancel-attempt", async (context) => {
    const reference = Schema.decodeUnknownOption(
      Schema.fromJsonString(mediaGenerationReferenceSchema),
      { onExcessProperty: "error" },
    )(await context.req.text());
    if (reference._tag === "None" || reference.value.computerId !== computerId)
      return context.json({ error: "Invalid workspace media reference" }, 400);
    // The page aborts its active requests. Durable generation remains restorable.
    return context.json(null);
  });
  return [
    {
      ...mediaSlot,
      permission: "media.generation",
      routes,
    },
  ];
}

function invalidRequest() {
  return {
    kind: "failed",
    failure: {
      message: "Invalid workspace media request",
      stage: "settings",
      code: "INVALID_ARGUMENT",
      retryable: false,
    },
  };
}

function workspacePath(path: string): string {
  const normalized = normalizeFilePath(path);
  if (normalized === null || normalized === "/")
    throw new Error(
      "Media destination must be an absolute workspace file path",
    );
  return normalized;
}

/** Both the HTTP capability and guest binding construct the existing Darkroom service. */
function standaloneMediaService(
  env: OysterMediaEnv,
  actorId: string,
  workspace: Readonly<{ computerId: string; files: FileSource }>,
  owner = "owner",
  libraryPath?: string,
) {
  const { computerId, files } = workspace;
  const fit =
    env.IMAGES === undefined
      ? undefined
      : createImagesReferenceFitter(env.IMAGES);
  const destination = {
    authorize: async (path: string) => {
      workspacePath(path);
      if (libraryPath !== undefined)
        await files.mkdir(workspacePath(libraryPath));
    },
    write: (path: string, bytes: Uint8Array) =>
      files.write(workspacePath(path), bytes),
  };
  const admittedDestination: MediaServiceHost["destination"] =
    fit === undefined
      ? destination
      : {
          ...destination,
          readReference: async (reference) => {
            if (reference.computerId !== computerId)
              throw new MediaSettingsError(
                "reference Computer is not selected",
              );
            const bytes = await files.read(workspacePath(reference.path));
            if (
              bytes === null ||
              bytes.byteLength === 0 ||
              bytes.byteLength > MAX_REFERENCE_BYTES
            )
              throw new MediaSettingsError(
                "reference image is unavailable or exceeds the byte limit",
              );
            return {
              ...(await fit(bytes)),
              filename: reference.path.split("/").at(-1) ?? "reference",
            };
          },
        };
  return createMediaService({
    scope: { actorId, namespace: "oyster", owner, destinationId: computerId },
    operations: env.MEDIA_OPERATION,
    provider: createWorkersAiMediaProvider(
      env.AI,
      env.AI_GATEWAY_ID === undefined
        ? undefined
        : { gateway: { id: env.AI_GATEWAY_ID } },
    ),
    metering: "unmetered",
    destination: admittedDestination,
  });
}

/** The Instance gate and native guest entrypoint share these argument codecs. */
export const mediaFrameMethods = {
  MEDIA: Object.fromEntries(
    ["models", "generate"].map((method) => [
      method,
      {
        decodeArgs: (raw: readonly unknown[]) =>
          z
            .tuple([
              mediaBindingCallSchema.options[method === "models" ? 0 : 1].shape
                .input,
            ])
            .parse(raw),
        decodeResult: Schema.decodeUnknownSync(Schema.Json),
        requiredOperations: () => [method],
      },
    ]),
  ),
} satisfies FrameBindingMethods<OysterBindingResult>;

/** Called only after the Instance resolves the captured frame and current grants. */
export async function dispatchMediaBinding(
  env: OysterMediaEnv,
  frame: InvocationFrame,
  props: FrameBindingProps,
  method: string,
  args: readonly unknown[],
  workspace: Readonly<{ computerId: string; files: FileSource }>,
): Promise<OysterBindingResult> {
  frame.signal.throwIfAborted();
  if (
    props.binding !== "MEDIA" ||
    frame.facts.subject.kind !== "call" ||
    frame.facts.selection.owner.kind !== "installation"
  )
    throw new AppInstanceError("revoked");
  const caller = frame.facts.subject.context;
  if (
    caller.computerId !== workspace.computerId ||
    caller.actor.kind === "team-key"
  )
    throw new AppInstanceError("revoked");
  const parsed = parseMediaBindingCall(
    z.json().parse({
      operation: method,
      input: args[0],
    }),
  );
  if (parsed.kind === "refused")
    return Schema.decodeUnknownSync(Schema.Json)(parsed.result);
  const actorId =
    caller.actor.kind === "member"
      ? caller.actor.memberId
      : caller.actor.agentId;
  const input = parsed.call;
  const service = standaloneMediaService(
    env,
    actorId,
    workspace,
    frame.facts.selection.owner.id,
    input.operation === "generate" ? input.input.libraryPath : undefined,
  );
  let response: Response;
  if (input.operation === "models") response = await service.request("/models");
  else {
    const body = mediaBindingRequest(input.input, workspace.computerId);
    const generated = await service.request("/generate", {
      method: "POST",
      signal: frame.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": input.input.requestId,
      },
      body: JSON.stringify(body),
    });
    if (generated.ok && generated.status !== 202) {
      const result = mediaResultSchema.parse(await generated.json());
      const { path, ...saved } = result;
      response = Response.json(
        appMediaGenerationResultSchema.parse({
          ...saved,
          destination: { computerId: workspace.computerId, path },
        }),
      );
    } else response = generated;
  }
  frame.signal.throwIfAborted();
  return Schema.decodeUnknownSync(Schema.Json)(
    await readMediaBindingReply(input, workspace.computerId, response),
  );
}
