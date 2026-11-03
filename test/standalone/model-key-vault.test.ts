import { describe, expect, it } from "vitest";
import type { StoredCredential } from "@fungi.computer/veil/credential-store";
import {
  createModelKeyVault,
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
