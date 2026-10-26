/* global URL, fetch, AbortSignal */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  nativeArtifactBucket,
  nativeFixtureWorkspace,
  nativeWorkflowHost,
} from "./workflow-native.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("native Oyster owner choices survive Workerd restart and edit without new credential custody", async () => {
  const { work, config } = await nativeFixtureWorkspace(
    root,
    "agent-model-choice-",
  );
  config.main = `${root}test/standalone/agent-model-choice.fixture.ts`;
  nativeArtifactBucket(config, "native-agent-model-choice");
  config.ai = { binding: "AI" };
  config.durable_objects.bindings.push({
    name: "MODEL_PROOF",
    class_name: "StandaloneAgent",
  });
  config.vars = {
    ...config.vars,
    AI_GATEWAY_AUTH_TOKEN: "proof-gateway-credential",
    AI_GATEWAY_ACCOUNT_ID: "proof-account",
    AI_GATEWAY_ID: "proof-gateway",
  };
  const host = await nativeWorkflowHost({
    root,
    work,
    config,
    oysterOrigin: "https://oyster.test",
  });
  try {
    await host.ready();
    const call = (path, options = {}) =>
      fetch(`${host.origin}${path}`, {
        ...options,
        headers: {
          ...host.auth,
          "Content-Type": "application/json",
          ...options.headers,
        },
        signal: AbortSignal.timeout(20_000),
      });
    const agent = async (name) => {
      const response = await call(`/model-proof-create?name=${name}`, {
        method: "POST",
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).agentId;
    };
    const first = await agent("First");
    const second = await agent("Second");
    const workers = {
      keySource: "workers-ai",
      model: {
        providerId: "cloudflare-workers-ai",
        modelId: "@cf/moonshotai/kimi-k2.6",
      },
    };
    const gateway = {
      keySource: "ai-gateway",
      model: { providerId: "openai", modelId: "openai/gpt-6-luna" },
    };
    const choice = (id, method = "GET", value) =>
      call(`/api/agent-models/${id}`, {
        method,
        body: value === undefined ? undefined : JSON.stringify(value),
      });
    const put = async (id, value, status, error) => {
      const response = await choice(id, "PUT", value);
      assert.equal(response.status, status, await response.clone().text());
      assert.deepEqual(await response.json(), error ?? value);
    };
    const read = async (id, value) => {
      const response = await choice(id);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), value);
    };
    const probe = async (id, provider, model) => {
      const response = await call(`/model-proof/${id}`);
      assert.equal(response.status, 200, await response.clone().text());
      const selected = await response.json();
      assert.deepEqual(
        { provider: selected.provider, model: selected.model },
        { provider, model },
      );
      assert.equal(
        JSON.stringify(selected).includes("proof-gateway-credential"),
        false,
      );
      return selected;
    };
    await read(first, workers);
    await probe(first, "cloudflare-workers-ai", workers.model.modelId);
    await put(first, workers, 200);
    await put(second, gateway, 200);
    await host.restart();
    await read(first, workers);
    await read(second, gateway);
    await probe(first, "cloudflare-workers-ai", workers.model.modelId);
    await probe(second, "openai", "openai/gpt-6-luna");
    const edited = {
      ...workers,
      model: {
        ...workers.model,
        modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      },
    };
    await put(first, edited, 200);
    await read(second, gateway);
    await probe(first, "cloudflare-workers-ai", edited.model.modelId);
    await put(second, { keySource: "byok", model: gateway.model }, 409, {
      error: "unsupported_key_source",
    });
    await put(second, { keySource: "workers-ai", model: gateway.model }, 409, {
      error: "key_source_mismatch",
    });
    await put(
      first,
      { ...workers, model: { ...workers.model, modelId: "missing" } },
      409,
      {
        error: "model_unavailable",
      },
    );
    await read(second, gateway);
    delete config.vars.AI_GATEWAY_AUTH_TOKEN;
    await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
    await host.restart();
    await read(second, gateway);
    const refused = await call(`/model-proof/${second}`);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "key_not_connected" });
  } finally {
    await host.close();
  }
});
