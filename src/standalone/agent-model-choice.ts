import { ModelPreferenceSchema } from "@fungi.computer/shiitake/model-preference";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  isStandaloneModelKeyProvider as isStandaloneProvider,
  type StandaloneModelKeyProvider,
} from "./model-key-providers.js";
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

/** Pi's maintained catalog for each provider a key may be brought for. */
const piCatalogs = {
  "cloudflare-workers-ai": () =>
    Promise.resolve(cloudflareWorkersAIProvider().getModels()),
  anthropic: async () =>
    (await import("@earendil-works/pi-ai/providers/anthropic"))
      .anthropicProvider()
      .getModels(),
  openai: async () =>
    (await import("@earendil-works/pi-ai/providers/openai"))
      .openaiProvider()
      .getModels(),
  openrouter: async () =>
    (await import("@earendil-works/pi-ai/providers/openrouter"))
      .openrouterProvider()
      .getModels(),
  google: async () =>
    (await import("@earendil-works/pi-ai/providers/google"))
      .googleProvider()
      .getModels(),
  xai: async () =>
    (await import("@earendil-works/pi-ai/providers/xai"))
      .xaiProvider()
      .getModels(),
  groq: async () =>
    (await import("@earendil-works/pi-ai/providers/groq"))
      .groqProvider()
      .getModels(),
  mistral: async () =>
    (await import("@earendil-works/pi-ai/providers/mistral"))
      .mistralProvider()
      .getModels(),
  deepseek: async () =>
    (await import("@earendil-works/pi-ai/providers/deepseek"))
      .deepseekProvider()
      .getModels(),
  cerebras: async () =>
    (await import("@earendil-works/pi-ai/providers/cerebras"))
      .cerebrasProvider()
      .getModels(),
  together: async () =>
    (await import("@earendil-works/pi-ai/providers/together"))
      .togetherProvider()
      .getModels(),
  moonshotai: async () =>
    (await import("@earendil-works/pi-ai/providers/moonshotai"))
      .moonshotaiProvider()
      .getModels(),
} as const satisfies Readonly<
  Record<StandaloneModelKeyProvider, () => Promise<readonly Model<Api>[]>>
>;

function byokCatalog(
  provider: StandaloneModelKeyProvider,
): Promise<readonly Model<Api>[]> {
  return piCatalogs[provider]();
}

/**
 * Pi 1.3's Model/getModels contract has no tool-calling flag (reasoning and
 * supportsStrictMode are not capability flags). Until it does, keep this small
 * Agent shortlist beside the existing catalog, never copy names or prices.
 * DeepSeek passed Grove's write/read proof on 2026-11-10; Granite failed its
 * first execute call. Kimi is the existing Workers AI Agent default. The other
 * entries are the providers' tool-capable Sonnet/Luna choices:
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
 * https://platform.openai.com/docs/guides/function-calling
 * OpenRouter exposes that same Luna model. Other entries remain selectable as chat only;
 * this is an admission policy for Agents, not a claim they cannot chat.
 * Replace this fallback when Pi exposes its source's tool-calling flag.
 */
const agentToolModels = {
  "cloudflare-workers-ai": [
    "@cf/deepseek-ai/deepseek-v4-flash-0731",
    "@cf/moonshotai/kimi-k2.6",
  ],
  anthropic: ["claude-sonnet-4-6"],
  openai: ["gpt-6-luna", "openai/gpt-6-luna"],
  openrouter: ["openai/gpt-6-luna"],
  // Each is the provider's documented function-calling flagship; none has
  // had a Grove write/read proof yet, unlike DeepSeek above.
  google: ["gemini-2.5-pro"],
  xai: ["grok-4.3"],
  groq: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  mistral: ["mistral-large-latest", "mistral-medium-latest"],
  deepseek: ["deepseek-v4-pro", "deepseek-flash"],
  cerebras: ["gpt-oss-120b"],
  together: ["openai/gpt-oss-120b"],
  moonshotai: ["kimi-k3"],
} as const satisfies Readonly<
  Record<StandaloneModelKeyProvider, readonly string[]>
>;

export function agentModelSupportsTools(
  model: Pick<Model<Api>, "provider" | "id">,
): boolean {
  if (!isStandaloneProvider(model.provider)) return false;
  const admitted: readonly string[] = agentToolModels[model.provider];
  return admitted.includes(model.id);
}

/** A supported model and Pi's USD prices per million tokens, without credentials. */
export type SupportedAgentModel = Readonly<{
  id: string;
  name: string;
  input: number;
  output: number;
  tools: boolean;
}>;

/** Pi's full catalog: verified tools first, then chat only; each group by price. */
export async function supportedAgentModels(
  provider: StandaloneModelKeyProvider,
): Promise<readonly SupportedAgentModel[]> {
  return (await byokCatalog(provider))
    .map((model) => ({
      id: model.id,
      name: model.name,
      input: model.cost.input,
      output: model.cost.output,
      tools: agentModelSupportsTools(model),
    }))
    .sort(
      (a, b) =>
        Number(b.tools) - Number(a.tools) ||
        a.input + a.output - b.input - b.output ||
        a.id.localeCompare(b.id),
    );
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
    if (!isStandaloneProvider(provider)) continue;
    const catalog = (await byokCatalog(provider)).filter(
      agentModelSupportsTools,
    );
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
    // Only a catalogued provider's own models.
    if (!isStandaloneProvider(providerId))
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
