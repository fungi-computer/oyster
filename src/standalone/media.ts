import { z } from "zod";
import {
  MAX_REFERENCE_BYTES,
  MediaSettingsError,
  type MediaReference,
} from "@fungi.computer/darkroom";
import { AppInstanceError } from "../index.js";
import type { FrameBindingMethods, FrameBindingProps } from "../cloudflare.js";
import type { InvocationFrame } from "../invocation.js";
import type { OysterBindingResult } from "../workers.js";
import { readMediaFailure } from "@fungi.computer/darkroom/browser";
import {
  appMediaGenerationResultSchema,
  mediaModelsSchema,
} from "@fungi.computer/darkroom/app-media-contracts";
import { mediaSlot } from "../media.js";
import { computer, routes as routeTable } from "../authorization.js";
import * as Schema from "effect/Schema";
import { pendingSchema } from "@fungi.computer/agar/backend-definition";
import {
  mediaGenerationDescriptionSchema,
  mediaGenerationJsonRequestSchema,
  mediaGenerationQuoteRequestSchema,
  mediaGenerationReferenceSchema,
} from "@fungi.computer/agar/media-json";
import {
  createDailyMediaMetering,
  type DailyMediaMeterPort,
  createMediaService,
  estimateMediaModel,
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
import { cloudflareAccountReady } from "./cloudflare-account.js";
import type { FileSource } from "../files.js";

/** Bindings for Media generation into the standalone Oyster workspace. */
export type OysterMediaEnv = Readonly<{
  /** Workers AI provider, admitted by this Worker. */
  AI: MediaAiPort;
  /** This Worker's own origin; a loopback origin has no Cloudflare account. */
  OYSTER_ORIGIN?: string | undefined;
  /** Darkroom's durable operation namespace; the named daily-meter object lives here too. */
  MEDIA_OPERATION: Readonly<{
    getByName(
      name: string,
    ): ReturnType<MediaServiceHost["operations"]["getByName"]> &
      Partial<DailyMediaMeterPort>;
  }>;
  /** Hard stop on one UTC day's media spend, in US dollars (for example `100`).
   * Unset leaves media unmetered. A set but invalid value refuses all media. */
  OYSTER_DAILY_MEDIA_LIMIT_USD?: string | undefined;
  /** Native image decoding and bounded reference fitting. */
  IMAGES?: MediaImagePort;
  /** The AI Gateway third-party models (GPT Image 2, Seedance, Veo) route
   * through. The background retry owner already reads this same binding
   * name for its own provider, so one var wires both doors. */
  AI_GATEWAY_ID?: string;
}>;

/** One Durable Object holds the whole Oyster's UTC-day media total. */
const DAILY_METER_NAME = "oyster-daily-media-meter";

/** $1 is 100,000 milliunits (1 cent is 1,000). */
const MILLIUNITS_PER_USD = 100_000;

const dailyLimitUsdSchema = z
  .string()
  .trim()
  .min(1)
  .transform(Number)
  .pipe(z.number().nonnegative());

/** Customer copy for the daily limit; the Oyster-wide limit is not holder-specific. */
const DAILY_LIMIT_COPY =
  "Today's spending limit for this Oyster is used up. It resets at 00:00 UTC.";

/** The daily limit in milliunits, or undefined when the var is unset. A set but invalid
 * value fails closed with a zero limit, so a typo never silently removes the cap. */
function dailyLimitMilliunits(env: OysterMediaEnv): number | undefined {
  const raw = env.OYSTER_DAILY_MEDIA_LIMIT_USD;
  if (raw === undefined) return undefined;
  const parsed = dailyLimitUsdSchema.safeParse(raw);
  return parsed.success ? Math.floor(parsed.data * MILLIUNITS_PER_USD) : 0;
}

/** The service's provider-cost quote for one exact request. */
const mediaQuoteSchema = z.object({
  providerCostMilliunits: z.number().int().nonnegative(),
});

/** Media capability using Darkroom execution and the existing workspace FileSource. */
export function workersMedia(
  env: OysterMediaEnv,
  workspace: Readonly<{ computerId: string; files: FileSource }>,
): readonly OysterCapability[] {
  const { computerId } = workspace;
  // Media reads and writes the Computer's workspace: a key needs `computer.use`.
  const routes = routeTable<CapabilityEnv>();
  const service = (principal: TenantPrincipal) =>
    standaloneMediaService(env, oysterPrincipalId(principal), workspace);
  routes.get("/describe", computer(), async (context, { principal }) => {
    const response = await service(principal).request("http://media/models");
    return context.json(
      Schema.decodeUnknownSync(mediaGenerationDescriptionSchema)({
        computerId,
        canGenerate: cloudflareAccountReady(env),
        models: await response.json(),
      }),
    );
  });
  routes.post("/generate", computer(), async (context, { principal }) => {
    const input = Schema.decodeUnknownOption(
      Schema.fromJsonString(mediaGenerationJsonRequestSchema),
      { onExcessProperty: "error" },
    )(await context.req.text());
    if (input._tag === "None") return context.json(invalidRequest());
    const path = normalizeFilePath(input.value.destination.path);
    if (path === null || path === "/") return context.json(invalidRequest());
    const references = input.value.settings.references?.map((reference) => ({
      computerId,
      ...reference,
      path: normalizeFilePath(reference.path),
    }));
    if (
      references?.some(
        (reference) => reference.path === null || reference.path === "/",
      )
    )
      return context.json(invalidRequest());
    if (!cloudflareAccountReady(env)) return context.json(setupRequired());
    const response = await service(principal).request("http://media/generate", {
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
    });
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
  routes.post("/quote", computer(), async (context, { principal }) => {
    const input = Schema.decodeUnknownOption(
      Schema.fromJsonString(mediaGenerationQuoteRequestSchema),
      { onExcessProperty: "error" },
    )(await context.req.text());
    if (input._tag === "None") return context.json(invalidRequest(), 400);
    const references = input.value.settings.references?.map((reference) => ({
      computerId,
      ...reference,
      path: normalizeFilePath(reference.path),
    }));
    if (
      references?.some(
        (reference) => reference.path === null || reference.path === "/",
      )
    )
      return context.json(invalidRequest(), 400);
    const response = await service(principal).request("http://media/quote", {
      method: "POST",
      signal: context.req.raw.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: { ...input.value.settings, references },
      }),
    });
    if (!response.ok)
      return context.json({ error: "These settings cannot be priced" }, 400);
    // A self-hosted Oyster is unmetered: the price is the provider's cost.
    const { providerCostMilliunits } = mediaQuoteSchema.parse(
      await response.json(),
    );
    return context.json({ costMilliunits: providerCostMilliunits });
  });
  routes.post("/cancel-attempt", computer(), async (context) => {
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

/** A missing provider or account is setup, not a failed generation. */
function setupRequired() {
  return {
    kind: "failed",
    failure: {
      message: "Media generation needs an image provider",
      stage: "admission",
      code: "SETUP_REQUIRED",
      need: "an image provider",
      retryable: false,
    },
  };
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
    readAudioReference: async (reference: MediaReference) => {
      if (reference.computerId !== computerId)
        throw new MediaSettingsError("reference Computer is not selected");
      const bytes = await files.read(workspacePath(reference.path));
      if (bytes === null)
        throw new MediaSettingsError("audio reference is unavailable");
      return bytes;
    },
  };
  const admittedDestination: MediaServiceHost["destination"] =
    fit === undefined
      ? destination
      : {
          ...destination,
          readReference: async (reference, model) => {
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
              ...(await fit(bytes, model)),
              filename: reference.path.split("/").at(-1) ?? "reference",
            };
          },
        };
  const provider = createWorkersAiMediaProvider(
    env.AI,
    env.AI_GATEWAY_ID === undefined
      ? undefined
      : { gateway: { id: env.AI_GATEWAY_ID } },
  );
  const limit = dailyLimitMilliunits(env);
  const host = {
    scope: { actorId, namespace: "oyster", owner, destinationId: computerId },
    operations: env.MEDIA_OPERATION,
    provider,
    destination: admittedDestination,
  };
  if (limit === undefined)
    return createMediaService({ ...host, metering: "unmetered" });
  const meter = env.MEDIA_OPERATION.getByName(DAILY_METER_NAME);
  const { dailyAdmit, dailySettle } = meter;
  if (dailyAdmit === undefined || dailySettle === undefined)
    throw new Error(
      "OYSTER_DAILY_MEDIA_LIMIT_USD needs a MEDIA_OPERATION object that serves the daily meter.",
    );
  return createMediaService({
    ...host,
    metering: createDailyMediaMetering(
      {
        dailyAdmit: (input) => dailyAdmit.call(meter, input),
        dailySettle: (input) => dailySettle.call(meter, input),
      },
      limit,
    ),
    refusalMessages: {
      insufficient_credits: DAILY_LIMIT_COPY,
      denied: DAILY_LIMIT_COPY,
      daily_limit_reached: DAILY_LIMIT_COPY,
    },
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
  if (input.operation === "models") {
    const catalog = await service.request("/models");
    response = Response.json(
      mediaModelsSchema.parse(await catalog.json()).map((model) => ({
        ...model,
        priceEstimate: estimateMediaModel(model),
      })),
    );
  } else {
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
