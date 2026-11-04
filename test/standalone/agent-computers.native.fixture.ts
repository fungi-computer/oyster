import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { z } from "zod";
import type { StandaloneModelSource } from "../../src/standalone/agents.js";
import standalone, {
  StandaloneAgent as NativeAgent,
} from "../../src/standalone/worker.js";

const userContent = z.union([
  z.string(),
  z.array(z.looseObject({ text: z.string().optional() })),
]);

export * from "../../src/standalone/worker.js";

/**
 * Only the model is deterministic. Each owner turn runs the one `execute` program
 * the proof wrote for it; attachments, admission, Files and Computer tools are
 * the production ones. The program text arrives in the user's message.
 */
export class StandaloneAgent extends NativeAgent {
  protected override modelSource(): StandaloneModelSource {
    const faux = fauxModel([]);
    const step = (context: {
      messages: readonly { role: string; content: unknown }[];
    }) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") return fauxAssistantMessage("done");
      const parsed = userContent.safeParse(last?.content);
      const text = !parsed.success
        ? ""
        : Array.isArray(parsed.data)
          ? parsed.data.map((part) => part.text ?? "").join("\n")
          : parsed.data;
      const code = /```js\n([\s\S]*?)```/u.exec(text)?.[1];
      return fauxAssistantMessage(
        fauxToolCall("execute", { code: code ?? "return 'no program'" }),
        { stopReason: "toolUse" },
      );
    };
    faux.setResponses(Array.from({ length: 64 }, () => step));
    return {
      acquire: () =>
        Promise.resolve({
          retryable: () => false,
          model: faux.model,
          stream: (model, context, options) =>
            faux.stream(model, context, options),
          release: () => Promise.resolve(),
        }),
    };
  }
}

export default standalone;
