import * as Schema from "effect/Schema";
import {
  createOwnerCredentialSealer,
  createOwnerCredentialStore,
  CredentialError,
  type CredentialRecord,
  type CredentialStorage,
  type CredentialKeyring,
} from "@fungi.computer/veil/credential-store";
import type { SqlStore } from "@fungi.computer/veil/connections";
import {
  modelKeyAuthenticated,
  modelKeyForwardedHeaders,
  modelKeyBaseUrl,
  modelKeyTarget,
  modelKeyValidationRequest,
  modelKeyValidationResult,
} from "@fungi.computer/veil/model-keys";
import {
  isStandaloneModelKeyProvider,
  type StandaloneModelKeyProvider,
} from "./model-key-providers.js";

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

/** A stored key as the owner sees it: no secret, no custody locator. */
export type ModelKeyRecord = Readonly<{
  keyId: string;
  provider: StandaloneModelKeyProvider;
  label: string;
  createdAt: number;
  validatedAt: number;
}>;
type Provider = StandaloneModelKeyProvider;
const isProvider = isStandaloneModelKeyProvider;
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
/** Deployment-owned wrapping keys. No implicit `instance` key id remains. */
export function instanceCredentialKeyring(env: {
  OYSTER_CREDENTIAL_KEY?: string;
  OYSTER_CREDENTIAL_KEY_ID?: string;
  OYSTER_CREDENTIAL_PREVIOUS_KEYS?: string;
}): CredentialKeyring | undefined {
  const key = env.OYSTER_CREDENTIAL_KEY;
  // A deployment that never named its key keeps the id its rows were sealed under.
  const id =
    env.OYSTER_CREDENTIAL_KEY_ID ??
    (key === undefined ? undefined : "instance");
  const retained = env.OYSTER_CREDENTIAL_PREVIOUS_KEYS;
  if (key === undefined && id === undefined && retained === undefined)
    return undefined;
  if (key === undefined || id === undefined)
    throw new CredentialError("unavailable");
  try {
    const previous =
      retained === undefined
        ? {}
        : Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
          )(retained);
    if (Object.hasOwn(previous, id)) throw new CredentialError("unavailable");
    return { activeKeyId: id, keys: { ...previous, [id]: key } };
  } catch {
    throw new CredentialError("unavailable");
  }
}

const publicRecord = (record: CredentialRecord): ModelKeyRecord => ({
  keyId: record.credentialId,
  provider: providerOf(record.kind),
  label: record.label,
  createdAt: record.createdAt,
  validatedAt: record.validatedAt,
});

/** Cloudflare takes a bearer token; a catalog provider names its own header. */
function authenticated(
  provider: Provider,
  headers: Headers,
  apiKey: string,
): Headers {
  if (provider === "cloudflare-workers-ai") {
    const next = new Headers(headers);
    next.set("authorization", `Bearer ${apiKey}`);
    return next;
  }
  return modelKeyAuthenticated(provider, headers, apiKey);
}

const instanceDomain = "fungi.oyster.credentials.v1";

/**
 * The instance's envelope for one object's own secrets beside its credential
 * rows: webhook, subscription and Discord reply secrets. Without a keyring
 * there is no sealer; a malformed keyring refuses each use as unavailable.
 */
export function instanceSecretSealer(options: {
  owner: SqlStore;
  ownerId: string;
  env: Parameters<typeof instanceCredentialKeyring>[0];
}): SecretSealer | undefined {
  const { env } = options;
  if (
    env.OYSTER_CREDENTIAL_KEY === undefined &&
    env.OYSTER_CREDENTIAL_KEY_ID === undefined &&
    env.OYSTER_CREDENTIAL_PREVIOUS_KEYS === undefined
  )
    return undefined;
  // Resolved per use, so a malformed keyring rejects that use, never composition.
  const current = () => {
    const keyring = instanceCredentialKeyring(env);
    if (keyring === undefined) throw new CredentialError("unavailable");
    return createOwnerCredentialSealer({
      storage: options.owner,
      ownerId: options.ownerId,
      keyring,
      domain: instanceDomain,
    });
  };
  return {
    seal: async (context, credential) => current().seal(context, credential),
    open: async (context, sealed) => current().open(context, sealed),
  };
}

/** One object's sealer and the migration 002 its own tables need. */
export function instanceSecretCustody(
  options: Parameters<typeof instanceSecretSealer>[0] & {
    tables: readonly SealedTable002[];
  },
) {
  const sealer = instanceSecretSealer(options);
  return {
    sealer,
    ready: credentialMigration002({
      store: options.owner,
      sealer,
      tables: options.tables,
    }),
  };
}

/**
 * The instance's one encrypted credential store. Listing and removal need no
 * key; sealing and opening refuse without one.
 */
export function createInstanceCredentialStore(options: {
  storage: CredentialStorage;
  owner: SqlStore;
  ownerId: string;
  keyring: CredentialKeyring | undefined;
  now?: () => number;
}) {
  return createOwnerCredentialStore({
    ...options,
    domain: instanceDomain,
    migrate: () => migrateCredentialRows001(options),
  });
}

export function createModelKeyVault(options: {
  storage: ModelKeyStorage;
  owner: SqlStore;
  ownerId: string;
  /** Active and retained wrapping keys; absent means no custody. */
  keyring: CredentialKeyring | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}) {
  const send: typeof globalThis.fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const keyring = options.keyring;
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
        label.length === 0 ||
        label.length > 64 ||
        apiKey.length === 0 ||
        apiKey.length > maxKeyLength
      )
        throw new ModelKeyRefused("invalid_key");
      if (keyring === undefined)
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
import { migrateCredentialRows001 } from "../credential-migration-001.js";
import {
  credentialMigration002,
  type SealedTable002,
  type SecretSealer,
} from "../credential-migration-002.js";
