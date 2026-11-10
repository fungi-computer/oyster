import { describe, expect, it } from "vitest";
import { normalizeModel, streamModel } from "@fungi.computer/mule/effect";
import { selectAgentModel } from "../../src/standalone/agent-model-choice.js";
import type { StoredCredential } from "@fungi.computer/veil/credential-store";
import {
  createModelKeyVault,
  createInstanceCredentialStore,
  ModelKeyRefused,
  type ModelKeyStorage,
} from "../../src/standalone/model-key-vault.js";

const credentialKey = "A".repeat(43);
const apiKey = `sk-test-${"x".repeat(16)}`;

function memory(): ModelKeyStorage & { dump(): string } {
  const rows = new Map<string, StoredCredential>();
  return {
    get: (key) => Promise.resolve(rows.get(key)),
    put: (key, value) => {
      rows.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(rows.delete(key)),
    list: (prefix) =>
      Promise.resolve(
        new Map([...rows].filter(([key]) => key.startsWith(prefix))),
      ),
    dump: () => JSON.stringify([...rows]),
  };
}

type Call = Readonly<{ url: string; headers: Headers; body: string | null }>;
function provider(status: number) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      headers: request.headers,
      body: request.body === null ? null : await request.text(),
    });
    return new Response('{"ok":true}', { status });
  };
  return { calls, fetch };
}

const openai = { provider: "openai", label: "Work key", apiKey } as const;

describe("instance model-key vault", () => {
  it("validates with one cheap call, stores only sealed bytes and lists without secrets", async () => {
    const storage = memory();
    const upstream = provider(200);
    const vault = createModelKeyVault({
      storage,
      credentialKey,
      fetch: upstream.fetch,
      now: () => 1_000,
    });
    const record = await vault.seal(openai);
    expect(record).toMatchObject({
      provider: "openai",
      label: "Work key",
      createdAt: 1_000,
      validatedAt: 1_000,
    });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(upstream.calls[0]?.headers.get("authorization")).toBe(
      `Bearer ${apiKey}`,
    );
    expect(storage.dump()).not.toContain(apiKey);
    const listed = await vault.list();
    expect(listed).toEqual([record]);
    expect(JSON.stringify(listed)).not.toContain(apiKey);
  });

  it("requires Cloudflare’s account, seals both fields and confines requests to that account", async () => {
    const storage = memory();
    const upstream = provider(200);
    const vault = createModelKeyVault({
      storage,
      credentialKey,
      fetch: upstream.fetch,
    });
    const accountId = "a".repeat(32);
    const cloudflare = {
      provider: "cloudflare-workers-ai",
      label: "My Cloudflare",
      apiKey,
    };
    await expect(vault.seal(cloudflare)).rejects.toMatchObject({
      reason: "invalid_key",
    });
    await expect(
      vault.seal({ ...cloudflare, accountId: "../other" }),
    ).rejects.toMatchObject({ reason: "invalid_key" });
    expect(upstream.calls).toHaveLength(0);
    const record = await vault.seal({ ...cloudflare, accountId });
    const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
    expect(upstream.calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`,
    );
    expect(storage.dump()).not.toContain(apiKey);
    expect(storage.dump()).not.toContain(accountId);
    expect(JSON.stringify(await vault.list())).not.toContain(accountId);
    expect(await vault.baseUrl(record.keyId)).toBe(baseUrl);
    await vault.send(
      record.keyId,
      new Request(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer caller-key" },
        body: "{}",
      }),
    );
    expect(upstream.calls[1]?.headers.get("authorization")).toBe(
      `Bearer ${apiKey}`,
    );
    await expect(
      vault.send(
        record.keyId,
        new Request(
          `https://api.cloudflare.com/client/v4/accounts/${"b".repeat(32)}/ai/v1/chat/completions`,
          { method: "POST", body: "{}" },
        ),
      ),
    ).rejects.toMatchObject({ reason: "target_denied" });
    expect(upstream.calls).toHaveLength(2);
    await vault.remove(record.keyId);
    await expect(vault.baseUrl(record.keyId)).rejects.toMatchObject({
      reason: "key_removed",
    });
  });

  it("streams a Pi Cloudflare catalog model through the account-confined vault", async () => {
    const accountId = "a".repeat(32);
    const requests: Request[] = [];
    const vault = createModelKeyVault({
      storage: memory(),
      credentialKey,
      fetch: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET")
          return Promise.resolve(new Response("{}", { status: 200 }));
        return Promise.resolve(
          new Response(
            'data: {"id":"reply","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      },
    });
    const key = await vault.seal({
      provider: "cloudflare-workers-ai",
      label: "Cloudflare",
      accountId,
      apiKey,
    });
    const model = await selectAgentModel({
      keySource: "byok",
      keyId: key.keyId,
      model: {
        providerId: "cloudflare-workers-ai",
        modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      },
    });
    const source = { ...model, baseUrl: await vault.baseUrl(key.keyId) };
    const stream = await streamModel(
      normalizeModel(source),
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      {
        apiKey: "oyster-model-key",
        fetch: (input, init) => vault.send(key.keyId, new Request(input, init)),
      },
    );
    const reply = await stream.result();
    expect(reply.stopReason).toBe("stop");
    expect(reply.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "Hello" }),
    );
    expect(requests[1]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
    );
    expect(requests[1]?.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  });

  it("does not expose a malformed sealed configuration through decoding errors", async () => {
    const storage = memory();
    const credentials = createInstanceCredentialStore({
      storage,
      credentialKey,
    });
    const record = await credentials.put({
      kind: "model-key/cloudflare-workers-ai",
      label: "Broken",
      secret: `malformed-${apiKey}`,
    });
    const vault = createModelKeyVault({ storage, credentialKey });
    await expect(vault.baseUrl(record.credentialId)).rejects.toMatchObject({
      reason: "custody_unavailable",
      message: "custody_unavailable",
    });
  });

  it("refuses a rejected key and stores nothing", async () => {
    const storage = memory();
    const vault = createModelKeyVault({
      storage,
      credentialKey,
      fetch: provider(401).fetch,
    });
    await expect(vault.seal(openai)).rejects.toMatchObject({
      reason: "key_rejected",
    });
    expect(await vault.list()).toEqual([]);
  });

  it("reports an unreachable provider as unavailable, not as a bad key", async () => {
    const vault = createModelKeyVault({
      storage: memory(),
      credentialKey,
      fetch: provider(503).fetch,
    });
    await expect(vault.seal(openai)).rejects.toMatchObject({
      reason: "provider_unavailable",
    });
  });

  it("refuses custody without an instance master secret", async () => {
    const vault = createModelKeyVault({
      storage: memory(),
      credentialKey: undefined,
      fetch: provider(200).fetch,
    });
    await expect(vault.seal(openai)).rejects.toMatchObject({
      reason: "custody_unavailable",
    });
  });

  it("lists and removes without a master secret but cannot open a key", async () => {
    const storage = memory();
    const keyed = createModelKeyVault({
      storage,
      credentialKey,
      fetch: provider(200).fetch,
    });
    const { keyId } = await keyed.seal(openai);
    const bare = createModelKeyVault({
      storage,
      credentialKey: undefined,
      fetch: provider(200).fetch,
    });
    expect(await bare.list()).toHaveLength(1);
    await expect(
      bare.send(keyId, new Request("https://api.openai.com/v1/models")),
    ).rejects.toMatchObject({ reason: "custody_unavailable" });
    expect(await bare.remove(keyId)).toBe("deleted");
  });

  it("attaches the key only at egress and confines the target to the provider", async () => {
    const upstream = provider(200);
    const vault = createModelKeyVault({
      storage: memory(),
      credentialKey,
      fetch: upstream.fetch,
    });
    const { keyId } = await vault.seal({
      provider: "anthropic",
      label: "Claude",
      apiKey,
    });
    upstream.calls.length = 0;
    const response = await vault.send(
      keyId,
      new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": "placeholder",
          authorization: "Bearer placeholder",
          "content-type": "application/json",
        },
        body: '{"m":1}',
      }),
    );
    expect(response.status).toBe(200);
    expect(upstream.calls[0]?.headers.get("x-api-key")).toBe(apiKey);
    expect(upstream.calls[0]?.headers.get("authorization")).toBeNull();
    expect(upstream.calls[0]?.body).toBe('{"m":1}');
    await expect(
      vault.send(keyId, new Request("https://evil.example/v1/messages")),
    ).rejects.toMatchObject({ reason: "target_denied" });
    expect(upstream.calls).toHaveLength(1);
  });

  it("fails explicitly once a key is removed or never existed", async () => {
    const vault = createModelKeyVault({
      storage: memory(),
      credentialKey,
      fetch: provider(200).fetch,
    });
    const { keyId } = await vault.seal(openai);
    expect(await vault.remove(keyId)).toBe("deleted");
    expect(await vault.remove(keyId)).toBe("absent");
    expect(await vault.get(keyId)).toBeNull();
    await expect(
      vault.send(keyId, new Request("https://api.openai.com/v1/models")),
    ).rejects.toBeInstanceOf(ModelKeyRefused);
    await expect(
      vault.send(keyId, new Request("https://api.openai.com/v1/models")),
    ).rejects.toMatchObject({ reason: "key_removed" });
  });

  it("will not open a record under a different master secret", async () => {
    const storage = memory();
    const one = createModelKeyVault({
      storage,
      credentialKey,
      fetch: provider(200).fetch,
    });
    const { keyId } = await one.seal(openai);
    const two = createModelKeyVault({
      storage,
      credentialKey: "C".repeat(43),
      fetch: provider(200).fetch,
    });
    await expect(
      two.send(keyId, new Request("https://api.openai.com/v1/models")),
    ).rejects.toMatchObject({ reason: "custody_unavailable" });
  });
});
