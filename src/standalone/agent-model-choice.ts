import { ModelPreferenceSchema } from "@fungi.computer/shiitake/model-preference";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isModelKeyProvider } from "@fungi.computer/veil/model-keys";
import * as Schema from "effect/Schema";

/**
 * A credential-source address, not credential material. `byok` names one of the
 * instance's sealed model keys by id; no other source carries a key id.
 */
export const agentModelChoiceSchema = Schema.Struct({
  keySource: Schema.Literals(["workers-ai", "ai-gateway", "byok"]),
  model: ModelPreferenceSchema,
  keyId: Schema.optional(Schema.NonEmptyString),
});
/** The Agent's model preference and source reference, never credential material. */
export type AgentModelChoice = typeof agentModelChoiceSchema.Type;

/** Stable reason for rejecting a model or credential source before a run. */
export type AgentModelRefusal =
  | "invalid_model_choice"
  | "unsupported_key_source"
  | "key_source_mismatch"
  | "model_unavailable"
  | "key_not_connected"
  | "key_removed";

export class AgentModelRefused extends Error {
  constructor(readonly reason: AgentModelRefusal) {
    super(reason);
    this.name = "AgentModelRefused";
  }
}

const key = "agent-model-choice";
const defaultChoice: AgentModelChoice = {
  keySource: "workers-ai",
  model: {
    providerId: "cloudflare-workers-ai",
    modelId: "@cf/moonshotai/kimi-k2.6",
  },
};

/** Pi's maintained catalog for a provider a key may be brought for. */
async function byokCatalog(
  provider: "anthropic" | "openai" | "openrouter" | "cloudflare-workers-ai",
): Promise<readonly Model<Api>[]> {
  if (provider === "cloudflare-workers-ai")
    return cloudflareWorkersAIProvider().getModels();
  if (provider === "anthropic")
    return (await import("@earendil-works/pi-ai/providers/anthropic"))
      .anthropicProvider()
      .getModels();
  if (provider === "openai")
    return (await import("@earendil-works/pi-ai/providers/openai"))
      .openaiProvider()
      .getModels();
  return (await import("@earendil-works/pi-ai/providers/openrouter"))
    .openrouterProvider()
    .getModels();
}

/**
 * An Agent with no saved choice runs on a model its host can reach, chosen when
 * it runs: Workers AI where a Cloudflare account answers, then the Fungi
 * gateway, then the first stored provider key's catalog default. A key added
 * later just works; one removed moves the default on. Nothing is saved, so an
 * Agent's own choice always wins.
 */
export async function resolveDefaultChoice(
  ready: Readonly<{
    workersAi: boolean;
    gateway: boolean;
    keys: readonly Readonly<{ keyId: string; provider: string }>[];
  }>,
): Promise<AgentModelChoice> {
  if (ready.workersAi) return defaultChoice;
  if (ready.gateway)
    return {
      keySource: "ai-gateway",
      model: { providerId: "openai", modelId: "openai/gpt-6-luna" },
    };
  for (const { keyId, provider } of ready.keys) {
    if (
      provider !== "anthropic" &&
      provider !== "openai" &&
      provider !== "openrouter" &&
      provider !== "cloudflare-workers-ai"
    )
      continue;
    const catalog = await byokCatalog(provider);
    const model =
      catalog.find((entry) => "default" in entry && entry.default === true) ??
      catalog[0];
    if (model !== undefined)
      return {
        keySource: "byok",
        keyId,
        model: { providerId: provider, modelId: model.id },
      };
  }
  return defaultChoice;
}

/** Read the maintained Pi catalog; never accept a model from a different egress. */
export async function selectAgentModel(
  choice: AgentModelChoice,
): Promise<Model<Api>> {
  const { providerId, modelId, reasoning } = choice.model;
  if (choice.keySource === "byok") {
    // Only a catalogued provider's own models; an OpenAI-compatible base has none.
    if (
      providerId !== "cloudflare-workers-ai" &&
      (!isModelKeyProvider(providerId) || providerId === "openai-compatible")
    )
      throw new AgentModelRefused("unsupported_key_source");
    const found = (await byokCatalog(providerId)).find(
      (item) => item.id === modelId,
    );
    if (found === undefined || (reasoning !== undefined && !found.reasoning))
      throw new AgentModelRefused("model_unavailable");
    return found;
  }
  if (
    (choice.keySource === "workers-ai" &&
      providerId !== "cloudflare-workers-ai") ||
    (choice.keySource === "ai-gateway" &&
      (providerId !== "openai" || modelId !== "openai/gpt-6-luna"))
  )
    throw new AgentModelRefused("key_source_mismatch");
  // Pi's OpenAI provider is needed only when Luna is selected, not at boot.
  const model =
    choice.keySource === "workers-ai"
      ? cloudflareWorkersAIProvider()
          .getModels()
          .find((item) => item.id === modelId)
      : (await import("@earendil-works/pi-ai/providers/openai"))
          .openaiProvider()
          .getModels()
          .find((item) => item.id === "gpt-6-luna");
  if (model === undefined || (reasoning !== undefined && !model.reasoning))
    throw new AgentModelRefused("model_unavailable");
  return model;
}

/** The Agent DO is the only durable owner. Absence is a new-format default, not an old-env reader. */
export function agentModelChoice(
  storage: Readonly<{
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: AgentModelChoice): Promise<void>;
  }>,
  admit: (choice: AgentModelChoice) => void | Promise<void>,
  fallback: () => Promise<AgentModelChoice> = () =>
    Promise.resolve(defaultChoice),
) {
  return {
    async read(): Promise<AgentModelChoice> {
      const stored = await storage.get(key);
      return stored === undefined
        ? fallback()
        : Schema.decodeUnknownSync(agentModelChoiceSchema, {
            onExcessProperty: "error",
          })(stored);
    },
    async set(input: AgentModelChoice): Promise<AgentModelChoice> {
      const parsed = Schema.decodeUnknownOption(agentModelChoiceSchema, {
        onExcessProperty: "error",
      })(input);
      if (parsed._tag === "None")
        throw new AgentModelRefused("invalid_model_choice");
      const choice = parsed.value;
      // A key id belongs to byok alone, and byok cannot run without one.
      if ((choice.keySource === "byok") !== (choice.keyId !== undefined))
        throw new AgentModelRefused("invalid_model_choice");
      await selectAgentModel(choice);
      await admit(choice);
      await storage.put(key, choice);
      return choice;
    },
  };
}
