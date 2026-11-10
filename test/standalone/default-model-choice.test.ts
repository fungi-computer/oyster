import { describe, expect, it } from "vitest";
import {
  agentModelChoice,
  resolveDefaultChoice,
} from "../../src/standalone/agent-model-choice.js";

const none = { workersAi: false, gateway: false, keys: [] } as const;

describe("resolveDefaultChoice", () => {
  it("keeps Workers AI where a Cloudflare account answers", async () => {
    const choice = await resolveDefaultChoice({
      ...none,
      workersAi: true,
      keys: [{ keyId: "k1", provider: "anthropic" }],
    });
    expect(choice.keySource).toBe("workers-ai");
  });

  it("uses the Fungi gateway before a stored key", async () => {
    const choice = await resolveDefaultChoice({
      ...none,
      gateway: true,
      keys: [{ keyId: "k1", provider: "anthropic" }],
    });
    expect(choice).toMatchObject({
      keySource: "ai-gateway",
      model: { modelId: "openai/gpt-6-luna" },
    });
  });

  it("starts on the first stored key's catalog model, so a newly added key just works", async () => {
    const choice = await resolveDefaultChoice({
      ...none,
      keys: [
        { keyId: "compatible", provider: "openai-compatible" },
        { keyId: "k2", provider: "openai" },
      ],
    });
    expect(choice).toMatchObject({
      keySource: "byok",
      keyId: "k2",
      model: { providerId: "openai" },
    });
    expect(choice.model.modelId.length).toBeGreaterThan(0);
  });

  it("uses a stored Cloudflare key in a local trial and accepts its catalog choice", async () => {
    const choice = await resolveDefaultChoice({
      ...none,
      keys: [{ keyId: "cf", provider: "cloudflare-workers-ai" }],
    });
    expect(choice).toMatchObject({
      keySource: "byok",
      keyId: "cf",
      model: { providerId: "cloudflare-workers-ai" },
    });
    const saved: unknown[] = [];
    await agentModelChoice(
      {
        get: () => Promise.resolve(undefined),
        put: (_key, value) => {
          saved.push(value);
          return Promise.resolve();
        },
      },
      () => undefined,
    ).set(choice);
    expect(saved).toEqual([choice]);
  });

  it("falls back to the unreachable Workers AI default with nothing connected", async () => {
    expect((await resolveDefaultChoice(none)).keySource).toBe("workers-ai");
  });
});

describe("agentModelChoice default", () => {
  const empty = {
    get: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
  };
  it("resolves when read, and a saved choice always wins", async () => {
    const saved = {
      keySource: "workers-ai",
      model: {
        providerId: "cloudflare-workers-ai",
        modelId: "@cf/moonshotai/kimi-k2.6",
      },
    } as const;
    const resolved = await agentModelChoice(
      empty,
      () => undefined,
      () =>
        resolveDefaultChoice({
          ...none,
          keys: [{ keyId: "k", provider: "anthropic" }],
        }),
    ).read();
    expect(resolved).toMatchObject({ keySource: "byok", keyId: "k" });
    const kept = await agentModelChoice(
      {
        ...empty,
        // The stored value arrives as JSON, the way the Durable Object returns it.
        get: () => Promise.resolve(JSON.parse(JSON.stringify(saved))),
      },
      () => undefined,
      () => resolveDefaultChoice({ ...none, gateway: true }),
    ).read();
    expect(kept).toEqual(saved);
  });
});
