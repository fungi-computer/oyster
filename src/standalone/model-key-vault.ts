import * as Schema from "effect/Schema";
import {
  createCredentialSealer,
  createCredentialStore,
  CredentialError,
  type CredentialRecord,
  type CredentialSealer,
  type CredentialStorage,
} from "@fungi.computer/veil/credential-store";
import {
  isModelKeyProvider,
  modelKeyForwardedHeaders,
  modelKeyBaseUrl,
  modelKeyTarget,
  modelKeyValidationRequest,
  modelKeyValidationResult,
  type ModelKeyRecord as HostedModelKeyRecord,
} from "@fungi.computer/veil/model-keys";

/**
 * This instance's own model-key owner. Provider API keys are sealed (AES-GCM)
 * under a key derived from the instance master secret, a host secret that never
 * enters the repository, storage or a log. A key leaves the vault only inside
 * the request it is sent with; listings carry no secret.
 */

/** Why a key could not be stored or used; stable, secret-free. */
export type ModelKeyRefusal =
  | "invalid_key"
  | "key_rejected"
  | "provider_unavailable"
  | "custody_unavailable"
  | "key_removed"
  | "target_denied"
  | "limit";

export class ModelKeyRefused extends Error {
  constructor(readonly reason: ModelKeyRefusal) {
    super(reason);
    this.name = "ModelKeyRefused";
  }
}

/** Standalone custody also accepts an owner’s Cloudflare account and token. */
export type ModelKeyRecord = Omit<HostedModelKeyRecord, "provider"> & {
  readonly provider: HostedModelKeyRecord["provider"] | "cloudflare-workers-ai";
};
type Provider = ModelKeyRecord["provider"];
const isProvider = (value: string): value is Provider =>
  value === "cloudflare-workers-ai" || isModelKeyProvider(value);
const cloudflareCredentialSchema = Schema.Struct({
  apiKey: Schema.NonEmptyString,
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
});
const decodeCloudflareCredential = Schema.decodeUnknownOption(
  Schema.fromJsonString(cloudflareCredentialSchema),
);
function readCloudflareCredential(secret: string) {
  const parsed = decodeCloudflareCredential(secret);
  if (parsed._tag === "None") throw new ModelKeyRefused("custody_unavailable");
  return parsed.value;
}
const cloudflareBase = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;

function providerConfiguration(provider: Provider, secret: string) {
  if (provider === "cloudflare-workers-ai") {
    const credential = readCloudflareCredential(secret);
    return {
      apiKey: credential.apiKey,
      baseUrl: cloudflareBase(credential.accountId),
    };
  }
  return { apiKey: secret, baseUrl: modelKeyBaseUrl(provider) };
}

/** What the owner submits to seal one provider key. */
export type ModelKeySealInput = Readonly<{
  provider: string;
  label: string;
  apiKey: string;
  accountId?: string;
}>;

export type ModelKeyStorage = CredentialStorage;

const kindOf = (provider: Provider) => `model-key/${provider}`;
const providerOf = (kind: string): Provider => {
  const provider = kind.slice("model-key/".length);
  if (!isProvider(provider)) throw new ModelKeyRefused("invalid_key");
  return provider;
};
const maxKeyLength = 16_384;
const publicRecord = (record: CredentialRecord): ModelKeyRecord => ({
  keyId: record.credentialId,
  provider: providerOf(record.kind),
  label: record.label,
  createdAt: record.createdAt,
  validatedAt: record.validatedAt,
});

/** Anthropic authenticates with `x-api-key`; the others take a bearer token. */
function authenticated(
  provider: Provider,
  headers: Headers,
  apiKey: string,
): Headers {
  const next = new Headers(headers);
  if (provider === "anthropic") next.set("x-api-key", apiKey);
  else next.set("authorization", `Bearer ${apiKey}`);
  return next;
}

/**
 * The instance's one encrypted credential store. Listing and removal need no
 * key; sealing and opening refuse without one.
 */
export function createInstanceCredentialStore(options: {
  storage: CredentialStorage;
  credentialKey: string | undefined;
  now?: () => number;
}) {
  const unavailable = () => Promise.reject(new CredentialError("unavailable"));
  const sealer: CredentialSealer =
    options.credentialKey === undefined
      ? { seal: unavailable, open: unavailable }
      : createCredentialSealer(
          {
            activeKeyId: "instance",
            keys: { instance: options.credentialKey },
          },
          "fungi.oyster.credentials.v1",
        );
  const storeOptions: Parameters<typeof createCredentialStore>[0] = {
    storage: options.storage,
    sealer,
  };
  if (options.now !== undefined) storeOptions.now = options.now;
  return createCredentialStore(storeOptions);
}

export function createModelKeyVault(options: {
  storage: ModelKeyStorage;
  /** The instance credential key (32 bytes, base64url); absent means no custody. */
  credentialKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}) {
  const send: typeof globalThis.fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const credentialKey = options.credentialKey;
  const credentials = createInstanceCredentialStore(options);
  const store = () => credentials;
  const custody = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof CredentialError)
        throw new ModelKeyRefused(
          cause.code === "absent"
            ? "key_removed"
            : cause.code === "limit"
              ? "limit"
              : "custody_unavailable",
        );
      throw cause;
    }
  };

  return {
    /** Validate with one cheap authenticated read, then store only the sealed key. */
    async seal(input: ModelKeySealInput): Promise<ModelKeyRecord> {
      const { provider, label, apiKey } = input;
      if (
        !isProvider(provider) ||
        provider === "openai-compatible" ||
        label.length === 0 ||
        label.length > 64 ||
        apiKey.length === 0 ||
        apiKey.length > maxKeyLength
      )
        throw new ModelKeyRefused("invalid_key");
      if (credentialKey === undefined)
        throw new ModelKeyRefused("custody_unavailable");
      let secret = apiKey;
      let probe: Request;
      if (provider === "cloudflare-workers-ai") {
        const credential = Schema.decodeUnknownOption(
          cloudflareCredentialSchema,
        )({
          apiKey,
          accountId: input.accountId,
        });
        if (credential._tag === "None")
          throw new ModelKeyRefused("invalid_key");
        secret = JSON.stringify(credential.value);
        // Cloudflare’s authenticated model search spends no inference tokens.
        probe = new Request(
          `https://api.cloudflare.com/client/v4/accounts/${credential.value.accountId}/ai/models/search?per_page=1`,
          {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(15_000),
          },
        );
      } else {
        if (input.accountId !== undefined)
          throw new ModelKeyRefused("invalid_key");
        probe = modelKeyValidationRequest(
          { provider, baseUrl: modelKeyBaseUrl(provider) },
          AbortSignal.timeout(15_000),
        );
      }
      let status: number;
      try {
        const response = await send(
          new Request(probe, {
            headers: authenticated(provider, probe.headers, apiKey),
          }),
        );
        status = response.status;
        await response.body?.cancel();
      } catch {
        // Transport text can echo request headers; surface only the typed cause.
        throw new ModelKeyRefused("provider_unavailable");
      }
      const verdict = modelKeyValidationResult(status);
      if (verdict === "rejected") throw new ModelKeyRefused("key_rejected");
      if (verdict === "unavailable")
        throw new ModelKeyRefused("provider_unavailable");
      return publicRecord(
        await custody(() =>
          credentials.put({ kind: kindOf(provider), label, secret }),
        ),
      );
    },

    async list(): Promise<readonly ModelKeyRecord[]> {
      return (await custody(() => store().list()))
        .filter((record) => record.kind.startsWith("model-key/"))
        .map(publicRecord);
    },

    async get(keyId: string): Promise<ModelKeyRecord | null> {
      const record = await custody(() => store().get(keyId));
      return record === null ? null : publicRecord(record);
    },

    /** Host-only model configuration; the token never leaves its sealed callback. */
    baseUrl(keyId: string): Promise<string> {
      return custody(() =>
        store().withSecret(keyId, (secret, record) => {
          const provider = providerOf(record.kind);
          return Promise.resolve(
            providerConfiguration(provider, secret).baseUrl,
          );
        }),
      );
    },

    remove(keyId: string): Promise<"deleted" | "absent"> {
      return custody(() => store().remove(keyId));
    },

    /** Send one provider request with the key attached; the caller's auth is dropped. */
    send(keyId: string, request: Request): Promise<Response> {
      return custody(() =>
        store().withSecret(keyId, (secret, record) => {
          const provider = providerOf(record.kind);
          const credential = providerConfiguration(provider, secret);
          let target: URL;
          try {
            target = modelKeyTarget({ baseUrl: credential.baseUrl }, request);
          } catch {
            throw new ModelKeyRefused("target_denied");
          }
          // `duplex` is a Node/Workers extension lib.dom's RequestInit omits.
          const init: RequestInit & { duplex: "half" } = {
            method: request.method,
            headers: authenticated(
              provider,
              modelKeyForwardedHeaders(request),
              credential.apiKey,
            ),
            body: request.method === "GET" ? null : request.body,
            signal: request.signal,
            duplex: "half",
          };
          return send(new Request(target, init));
        }),
      );
    },
  };
}
