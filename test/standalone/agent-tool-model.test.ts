import { expect, it } from "vitest";
import { StandaloneAgentBase } from "../../src/standalone/agents.js";
import type { AgentModelChoice } from "../../src/standalone/agent-model-choice.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";

class SavedGraniteAgent extends StandaloneAgentBase {
  protected hostFor(): never {
    return unavailable();
  }
  override readModelChoice(): Promise<AgentModelChoice> {
    return Promise.resolve({
      keySource: "workers-ai",
      model: {
        providerId: "cloudflare-workers-ai",
        modelId: "@cf/ibm-granite/granite-4.0-h-micro",
      },
    });
  }
  model() {
    return this.modelSource();
  }
}

it("ends a saved Granite run with tool guidance before opening any provider door", async () => {
  const agent = new SavedGraniteAgent(
    agentDurableObjectState(() => 0),
    agentEnv(),
  );
  const lease = await agent.model().acquire({
    sessionId: "session-tool-model",
    preference: null,
    signal: new AbortController().signal,
  });
  try {
    if (lease.stream === undefined) throw new Error("Missing model stream");
    const stream = await lease.stream(lease.model, {
      messages: [
        {
          role: "user",
          content: "Create a file and read it back",
          timestamp: 1,
        },
      ],
    });
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(lease.failureReason?.(result)).toBe(
      "Model request failed (tools_unsupported). Pick a model marked tools.",
    );
    expect(lease.retryable(result)).toBe(false);
    expect(result.content).toEqual([]);
  } finally {
    await lease.release();
  }
});
