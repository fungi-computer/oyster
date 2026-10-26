import { ModelPreferenceSchema } from "@fungi.computer/shiitake/model-preference";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";

/** A credential-source address, not credential material or a custodian locator. */
export const agentModelChoiceSchema = Schema.Struct({
  keySource: Schema.Literals(["workers-ai", "ai-gateway", "byok"]),
  model: ModelPreferenceSchema,
});
/** The Agent's model preference and source reference, never credential material. */
export type AgentModelChoice = typeof agentModelChoiceSchema.Type;

/** Stable reason for rejecting a model or credential source before a run. */
export type AgentModelRefusal =
  | "invalid_model_choice"
  | "unsupported_key_source"
  | "key_source_mismatch"
  | "model_unavailable"
  | "key_not_connected";

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

/** Read the maintained Pi catalog; never accept a model from a different egress. */
export async function selectAgentModel(
  choice: AgentModelChoice,
): Promise<Model<Api>> {
  if (choice.keySource === "byok")
    throw new AgentModelRefused("unsupported_key_source");
  const { providerId, modelId, reasoning } = choice.model;
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
  storage: Pick<DurableObjectStorage, "get" | "put">,
  admit: (choice: AgentModelChoice) => void,
) {
  return {
    async read(): Promise<AgentModelChoice> {
      const stored = await storage.get(key);
      return stored === undefined
        ? defaultChoice
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
      await selectAgentModel(choice);
      admit(choice);
      await storage.put(key, choice);
      return choice;
    },
  };
}
