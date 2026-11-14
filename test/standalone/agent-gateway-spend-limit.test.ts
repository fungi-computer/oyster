import { expect, it } from "vitest";
import { StandaloneAgentBase } from "../../src/standalone/agents.js";
import type { AgentModelChoice } from "../../src/standalone/agent-model-choice.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";

const DAILY_LIMIT_COPY =
  "Today's spending limit for this Oyster is used up. It resets at 00:00 UTC.";

class WorkersAiAgent extends StandaloneAgentBase {
  protected hostFor(): never {
    return unavailable();
  }
  override readModelChoice(): Promise<AgentModelChoice> {
    return Promise.resolve({
      keySource: "workers-ai",
      model: {
        providerId: "cloudflare-workers-ai",
        modelId: "@cf/moonshotai/kimi-k2.6",
      },
    });
  }
  model() {
    return this.modelSource();
  }
}

/** A model run whose AI Gateway answers every request with `status`. */
async function runAgainstGateway(status: number) {
  // Spreading would trip the fixture's unavailable-door getters.
  const env = Object.defineProperties(agentEnv(), {
    OYSTER_AI_GATEWAY: { value: "oyster-holders" },
    AI: {
      value: { fetch: () => Promise.resolve(new Response("{}", { status })) },
    },
  });
  const agent = new WorkersAiAgent(
    agentDurableObjectState(() => 0),
    env,
  );
  const lease = await agent.model().acquire({
    sessionId: "session-gateway-limit",
    preference: null,
    signal: new AbortController().signal,
  });
  try {
    if (lease.stream === undefined) throw new Error("Missing model stream");
    const stream = await lease.stream(lease.model, {
      messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
    });
    const result = await stream.result();
    return {
      reason: lease.failureReason?.(result),
      retryable: lease.retryable(result),
      stopReason: result.stopReason,
    };
  } finally {
    await lease.release();
  }
}

it("says the daily spending limit is used up when the gateway answers 429, and never retries it", async () => {
  expect(await runAgainstGateway(429)).toEqual({
    reason: DAILY_LIMIT_COPY,
    retryable: false,
    stopReason: "error",
  });
});

it("keeps the generic failure for other gateway rejections", async () => {
  const outcome = await runAgainstGateway(400);
  expect(outcome.reason).toBe(
    "Model request failed (provider_rejected). Retry the request.",
  );
});
