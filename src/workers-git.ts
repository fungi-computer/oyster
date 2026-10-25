import {
  defaultTenant,
  implicitTenancy,
  tenantScope,
  type OysterTenancy,
  type ResolvedTenant,
  type TenantScope,
} from "./tenant.js";
import { createOysterMcpOwner } from "./mcp-owner.js";
import {
  createAdmittedGit,
  createInstallationGitAdmission,
} from "./git-admission.js";
import { resolveBackend } from "./release.js";
/**
 * Cloudflare adapters for git Apps on a standalone Oyster: the GIT binding
 * over Artifacts, named keys for agents, and signed webhook delivery for App
 * events. Every credential and secret stays in these host objects.
 */
import { DurableObject } from "cloudflare:workers";
import {
  nativeGitFrameMethods,
  invokeNativeGit,
} from "@fungi.computer/agar/git-rpc";
import {
  APP_INVOCATION_CEILING_MS,
  invocationFacts,
  invocationCallerContext,
  type InvocationFrame,
} from "./invocation.js";
import { AppInstanceError, selectionOf } from "./index.js";
import { ownerOrKeyAuth } from "./auth.js";
import { causeClass } from "./cause-class.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as Schema from "effect/Schema";
import { defineIdFamily } from "@fungi.computer/cairn";
import {
  type GitCommit,
  type GitBinding,
  type GitExchangeRequest,
  type GitExchangeResponse,
  type GitRepositoryInfo,
} from "@fungi.computer/agar/git";
import {
  parseAppMethodCallContext,
  workflowAttestationSchema,
  type AppMethodCallContext,
} from "@fungi.computer/puffball/app-method-runtime";
import {
  lsRefsRequest,
  parseLsRefs,
  type GitDoorTarget,
  type StandardWebhookPayload,
} from "./git.js";
import {
  createKeyStore,
  keyWire,
  type KeyStore,
} from "@fungi.computer/ear-tag/keys";
import type { Grant } from "@fungi.computer/ear-tag/grants";
import {
  oysterKeyVocabulary,
  type LiveOysterKey,
  type OysterKeyCapability,
} from "./keys.js";
import {
  agentCapabilities,
  agentApprovalRoutes,
  agentMcpServerRoutes,
  type OysterAgents,
} from "./agents.js";
import {
  createArtifactsRestNamespace,
  type ArtifactsNamespace,
  type ArtifactsCommit,
  type ArtifactsRepositoryInfo as ProviderInfo,
} from "@fungi.computer/burrow";
import { attemptWebhook } from "./webhook-delivery.js";
import {
  createRecipientDeliveries,
  type HostEventSource,
  type HostRecipientEvent,
  type RecipientDelivery,
} from "./event-recipients.js";
export type {
  HostEventSource,
  HostRecipientEvent,
  RecipientDelivery,
} from "./event-recipients.js";
import {
  createOyster,
  oysterPrincipalIsOwner,
  type OysterAuth,
  type OysterAuthResult,
  type OysterCapability,
  type OysterEnv,
  type OysterGitHost,
  type OysterHost,
} from "./host.js";
import type { GitWriter } from "@fungi.computer/agar/git";

import {
  OysterInstance,
  oysterBindingEntrypoint,
  oysterBindings,
  oysterWorkerHost,
  r2FileSource,
  r2ArtifactStore,
  type OysterBindingContext,
  type OysterBindingRow,
  type OysterBindingTable,
  type OysterWorkspace,
  type OysterWorkerEnv,
  type OysterInvocationHost,
  serveOysterBootCapability,
} from "./workers.js";
import { registryInstallations } from "./internal/registry-installations.js";
import { refuseOlderOysterStore } from "./older-oyster-store-refusal.js";

const infoSchema = Schema.Struct({
  name: Schema.String,
  defaultBranch: Schema.String,
  remote: Schema.String,
  lastPushAt: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
});
const pageSchema = Schema.Struct({
  repos: Schema.Array(
    Schema.Struct({ name: Schema.String, status: Schema.String }),
  ),
  cursor: Schema.optional(Schema.String),
});
const plaintextSchema = Schema.Struct({ plaintext: Schema.NonEmptyString });
const tokenSchema = Schema.Struct({
  ...plaintextSchema.fields,
  expiresAt: Schema.DateFromString,
});
class CredentialRejected extends Error {}
const codeSchema = Schema.Struct({ code: Schema.String });

function errorCode(error: Error): string | null {
  const parsed = Schema.decodeUnknownOption(codeSchema)(error);
  return parsed._tag === "Some" ? parsed.value.code : null;
}

/** A provider failure as host diagnostics may name it: its code, never its text. */
function providerCause(cause: unknown): string {
  return (
    (cause instanceof Error ? errorCode(cause) : null) ?? causeClass(cause)
  );
}

function appCommit(commit: ArtifactsCommit): GitCommit {
  return {
    ...commit,
    author: { ...commit.author },
    committer: { ...commit.committer },
    parents: [...commit.parents],
  };
}

const READY_TIMEOUT_MS = 60_000;
const TOKEN_TTL_SECONDS = 600;
const TOKEN_REUSE_MS = 8 * 60_000;
const TOKEN_EXPIRY_MARGIN_MS = 30_000;
// Eviction only causes another mint; it never limits repository work.
const TOKEN_CACHE_ENTRIES = 256;
type GitCredentialCache = Map<
  string,
  Readonly<{ remote: string; token: string; until: number }>
>;
const NAME = /^[a-zA-Z0-9._-]{1,100}$/u;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The GIT binding plus the credential only the host's git door may use. */
export type ArtifactsGit = Omit<GitBinding, "cloneUrl"> &
  Readonly<{
    /** The provider remote and a credential; never given to the App. */
    credential(
      name: string,
      scope: "read" | "write",
    ): Promise<Readonly<{ remote: string; token: string }>>;
  }>;

/** The GIT binding over Artifacts for one installation (`prefix` scopes its names).
 * Credentials remain host-held and are reused until thirty seconds before the
 * provider expiry or eight minutes, whichever comes first. Every operation still
 * checks its captured grant. Provider 401/403 discards the credential for remint.
 */
export function createArtifactsGit(
  binding: ArtifactsNamespace,
  prefix: string,
  grant: Readonly<{
    operations: readonly string[];
    /** Recheck the captured host invocation immediately before provider work. */
    beforeProvider?: () => void;
  }>,
): ArtifactsGit {
  // This public adapter owns a fresh cache; only the private Instance composition
  // shares values between adapters, with a verified approval partition.
  return artifactsGit(binding, prefix, grant, new Map(), null);
}

// Share only credential values. Every adapter retains its own admission callback
// and in-flight mint promises; neither survives its invocation frame.
function artifactsGit(
  binding: ArtifactsNamespace,
  prefix: string,
  grant: Parameters<typeof createArtifactsGit>[2],
  tokens: GitCredentialCache,
  approval: Pick<
    InvocationFrame<OysterInvocationHost>["facts"]["selection"],
    "authorityVersion" | "releaseId"
  > | null,
): ArtifactsGit {
  const credentialKey = (name: string, scope: "read" | "write") =>
    JSON.stringify(
      approval === null
        ? [prefix, name, scope]
        : [prefix, name, scope, approval.authorityVersion, approval.releaseId],
    );
  const requireOperation = (operation: string): void => {
    if (!grant.operations.includes(operation))
      throw new Error(`Git operation denied: ${operation}`);
    grant.beforeProvider?.();
  };
  const provider = (name: string) => {
    if (!NAME.test(name)) throw new Error("Invalid repository name");
    const composed = `${prefix}${name}`;
    if (composed.length > 128) throw new Error("Invalid repository name");
    return composed;
  };
  const local = (name: string) =>
    name.startsWith(prefix) ? name.slice(prefix.length) : null;
  const toInfo = (raw: ProviderInfo): GitRepositoryInfo => {
    const info = Schema.decodeUnknownSync(infoSchema)(raw);
    const source = info.source?.replace(/^artifacts:[^/]+\//u, "") ?? null;
    return {
      name: local(info.name) ?? info.name,
      defaultBranch: info.defaultBranch,
      lastPushAt: info.lastPushAt ?? null,
      source: source === null ? null : local(source),
    };
  };
  const minting = new Map<
    string,
    Promise<Readonly<{ remote: string; token: string }>>
  >();
  const retrying = async <T>(attempt: () => Promise<T>): Promise<T> => {
    for (let tries = 1; ; tries += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (
          tries >= 4 ||
          error instanceof CredentialRejected ||
          Schema.isSchemaError(error) ||
          (error instanceof Error &&
            ["NOT_FOUND", "INVALID_RESPONSE"].includes(errorCode(error) ?? ""))
        )
          throw error;
        await wait(250 * tries);
      }
    }
  };
  const status = async (name: string) => {
    let cursor: string | undefined;
    do {
      const page = Schema.decodeUnknownSync(pageSchema)(
        await binding.list(
          cursor === undefined ? { limit: 200 } : { limit: 200, cursor },
        ),
      );
      const found = page.repos.find((repo) => repo.name === name);
      if (found) return found.status;
      cursor = page.cursor;
    } while (cursor !== undefined);
    return "missing";
  };
  const whenReady = async (name: string): Promise<GitRepositoryInfo> => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await status(name)) === "ready") {
        try {
          return toInfo(await (await binding.get(name)).info());
        } catch (error) {
          const code = error instanceof Error ? errorCode(error) : null;
          if (code !== "FORK_IN_PROGRESS" && code !== "IMPORT_IN_PROGRESS")
            throw error;
        }
      }
      await wait(400);
    }
    throw new Error("Repository did not become ready");
  };
  const credential = async (name: string, scope: "read" | "write") => {
    const target = provider(name);
    grant.beforeProvider?.();
    const key = credentialKey(name, scope);
    const cached = tokens.get(key);
    if (cached && cached.until > Date.now())
      return { remote: cached.remote, token: cached.token };
    if (cached !== undefined) tokens.delete(key);
    let pending = minting.get(key);
    if (pending === undefined) {
      pending = retrying(async () => {
        grant.beforeProvider?.();
        const startedAt = Date.now();
        const repo = await binding.get(target);
        grant.beforeProvider?.();
        const info = Schema.decodeUnknownSync(infoSchema)(await repo.info());
        grant.beforeProvider?.();
        const rawToken = await repo.createToken(scope, TOKEN_TTL_SECONDS);
        grant.beforeProvider?.();
        const now = Date.now();
        let issued: typeof tokenSchema.Type;
        let until: number;
        try {
          issued = Schema.decodeUnknownSync(tokenSchema)(rawToken);
          until = Math.min(
            issued.expiresAt.getTime() - TOKEN_EXPIRY_MARGIN_MS,
            startedAt + TOKEN_REUSE_MS,
          );
          if (until <= now)
            throw new CredentialRejected(
              "Artifacts credential expires too soon",
            );
        } catch (cause) {
          const rejected = new CredentialRejected(
            "Artifacts credential rejected",
            { cause },
          );
          const returned =
            Schema.decodeUnknownOption(plaintextSchema)(rawToken);
          if (returned._tag === "Some") {
            try {
              await repo.revokeToken(returned.value.plaintext);
            } catch (cleanupCause) {
              // Best effort: keep only safe cause classes, never provider text/token data.
              rejected.cause = {
                rejection: causeClass(cause),
                cleanup: causeClass(cleanupCause),
              };
              throw rejected;
            }
          }
          throw rejected;
        }
        for (const [cachedKey, value] of tokens)
          if (value.until <= now) tokens.delete(cachedKey);
        if (!tokens.has(key) && tokens.size >= TOKEN_CACHE_ENTRIES) {
          const oldest = tokens.keys().next();
          if (!oldest.done) tokens.delete(oldest.value);
        }
        tokens.set(key, {
          remote: info.remote,
          token: issued.plaintext,
          until,
        });
        return { remote: info.remote, token: issued.plaintext };
      });
      minting.set(key, pending);
    }
    try {
      const result = await pending;
      grant.beforeProvider?.();
      return result;
    } finally {
      if (minting.get(key) === pending) minting.delete(key);
    }
  };
  const exchange = async (
    name: string,
    request: GitExchangeRequest,
  ): Promise<GitExchangeResponse> => {
    let access: Awaited<ReturnType<typeof credential>>;
    try {
      access = await credential(
        name,
        request.service === "receive-pack" ? "write" : "read",
      );
    } catch (error) {
      if (error instanceof Error && errorCode(error) === "NOT_FOUND")
        return {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: new TextEncoder().encode("Repository not found"),
        };
      throw error;
    }
    const { remote, token } = access;
    const key = credentialKey(
      name,
      request.service === "receive-pack" ? "write" : "read",
    );
    const target =
      request.phase === "advertise"
        ? `${remote}/info/refs?service=git-${request.service}`
        : `${remote}/git-${request.service}`;
    const incoming = new Headers(request.headers);
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    for (const header of ["content-type", "accept", "git-protocol"]) {
      const value = incoming.get(header);
      if (value !== null) headers.set(header, value);
    }
    grant.beforeProvider?.();
    const response = await fetch(target, {
      method: request.phase === "advertise" ? "GET" : "POST",
      headers,
      body: request.body === null ? null : new Uint8Array(request.body),
      redirect: "manual",
    });
    if (
      (response.status === 401 || response.status === 403) &&
      tokens.get(key)?.token === token
    )
      tokens.delete(key);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Artifacts Git redirect refused");
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: new Uint8Array(await response.arrayBuffer()),
    };
  };
  const finishCreated = async (name: string, initialToken: string) => {
    try {
      await (await binding.get(name)).revokeToken(initialToken);
    } catch (revokeCause) {
      // Provider codes are a closed provider vocabulary; never copy provider text.
      const revoke = providerCause(revokeCause);
      try {
        await binding.delete(name);
      } catch (deleteCause) {
        console.error("Artifacts repository activation cleanup failed", {
          repository: name,
          revoke,
          delete: providerCause(deleteCause),
        });
        throw new Error(
          `Artifacts initial token cleanup refused repository activation (revoke ${revoke}, delete ${providerCause(deleteCause)})`,
          { cause: deleteCause },
        );
      }
      throw new Error(
        `Artifacts initial token cleanup refused repository activation (revoke ${revoke})`,
        { cause: revokeCause },
      );
    }
  };
  return {
    async create(name, opts) {
      requireOperation("create");
      const target = provider(name);
      const created = await binding.create(target, {
        description: opts?.description ?? "",
        readOnly: false,
        setDefaultBranch: opts?.defaultBranch ?? "main",
      });
      await finishCreated(target, created.token);
      return toInfo(created);
    },
    async fork(source, target, opts) {
      requireOperation("fork");
      const destination = provider(target);
      const repo = await binding.get(provider(source));
      grant.beforeProvider?.();
      let created: Readonly<{ token: string }>;
      try {
        created = await repo.fork(destination, {
          description: opts?.description ?? "",
          readOnly: false,
          defaultBranchOnly: false,
        });
      } catch (forkCause) {
        // A destination that already exists (an earlier attempt may have
        // created it before failing) answers once ready; its `source` tells
        // the caller whether it is the fork it asked for.
        if ((await status(destination)) === "missing") throw forkCause;
        const existing = await whenReady(destination);
        console.warn("Artifacts fork destination already exists", {
          repository: destination,
          source: existing.source,
          fork: providerCause(forkCause),
        });
        return existing;
      }
      // Artifacts forks asynchronously: the destination refuses token and
      // read operations until the copy is ready, so wait before cleanup.
      const ready = await whenReady(destination);
      await finishCreated(destination, created.token);
      return ready;
    },
    async info(name) {
      requireOperation("read");
      try {
        const repo = await binding.get(provider(name));
        grant.beforeProvider?.();
        return toInfo(await repo.info());
      } catch (error) {
        if (error instanceof Error && errorCode(error) === "NOT_FOUND")
          return null;
        throw error;
      }
    },
    async delete(name) {
      requireOperation("write");
      tokens.delete(credentialKey(name, "read"));
      tokens.delete(credentialKey(name, "write"));
      return binding.delete(provider(name));
    },
    async log(name, opts) {
      requireOperation("read");
      const repo = await binding.get(provider(name));
      grant.beforeProvider?.();
      const commits = await repo.log({
        ref: opts.ref,
        limit: opts.limit ?? 50,
        offset: opts.offset ?? 0,
      });
      return commits.map(appCommit);
    },
    async readCommit(name, hash) {
      requireOperation("read");
      const repo = await binding.get(provider(name));
      grant.beforeProvider?.();
      const commit = await repo.readCommit(hash);
      return commit === null ? null : appCommit(commit);
    },
    async readTree(name, hash) {
      requireOperation("read");
      const repo = await binding.get(provider(name));
      grant.beforeProvider?.();
      const entries = await repo.readTree(hash);
      return entries === null ? null : [...entries];
    },
    async readBlob(name, hash) {
      requireOperation("read");
      const repo = await binding.get(provider(name));
      grant.beforeProvider?.();
      const blob = await repo.readBlob(hash);
      return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
    },
    async refs(name) {
      requireOperation("read");
      const response = await exchange(name, {
        service: "upload-pack",
        phase: "exchange",
        headers: {
          "content-type": "application/x-git-upload-pack-request",
          "git-protocol": "version=2",
        },
        body: lsRefsRequest(),
      });
      if (response.status !== 200)
        throw new Error(`ls-refs failed (${String(response.status)})`);
      return parseLsRefs(response.body);
    },
    async exchange(name, request) {
      requireOperation("exchange");
      return exchange(name, request);
    },
    async credential(name, scope) {
      requireOperation(scope);
      return credential(name, scope);
    },
  };
}

const webhookIds = defineIdFamily({
  family: "oyster-webhooks",
  version: 1,
  kinds: { subscription: { prefix: "whk" } },
});

/**
 * Named keys an owner issues directly: an Ear Tag key store scoped to this
 * tenant. A key's id is the name the owner chose for it, so forks and other
 * name-derived identities (`service.ts:95`) stay stable across a reissue.
 * Plaintext keys are never stored.
 */
export class OysterKeys extends DurableObject<OysterKeysEnv> {
  readonly #store: KeyStore<OysterKeyCapability>;

  constructor(ctx: DurableObjectState, env: OysterKeysEnv) {
    super(ctx, env);
    this.#store = createKeyStore({
      sql: ctx.storage.sql,
      commit: (body) => Promise.resolve(ctx.storage.transactionSync(body)),
      vocabulary: oysterKeyVocabulary,
      prefix: "oyk",
      // The DO trusts only its Worker caller, which checks the owner on
      // every path (gitAdminRoutes, ownerOrKeyAuth) before it ever calls
      // here, so every actor this store admits is already the owner.
      authorizeIssuer: () => Promise.resolve({ kind: "unrestricted" }),
    });
  }

  /**
   * Issue a key named `name`, its id too. Refuses `conflict` once a name has
   * been used, including by a now-revoked key: a name is never reused.
   */
  issue(
    owner: string,
    input: Readonly<{
      name: string;
      grants: readonly Grant<OysterKeyCapability>[];
      expiresAt?: number;
    }>,
  ): ReturnType<KeyStore<OysterKeyCapability>["issue"]> {
    return this.#store.issue(owner, {
      name: input.name,
      keyId: input.name,
      grants: input.grants,
      expiresAt: input.expiresAt,
    });
  }

  /** Revoke a key by id; idempotent on repeat. */
  revoke(
    owner: string,
    requestId: string,
    keyId: string,
  ): ReturnType<KeyStore<OysterKeyCapability>["revoke"]> {
    return this.#store.revoke(owner, { requestId, keyId });
  }

  /** Every key this tenant has issued, newest first. */
  list(owner: string): ReturnType<KeyStore<OysterKeyCapability>["list"]> {
    return this.#store.list(owner);
  }

  /** Verify a bearer secret and return its current principal. */
  verify(secret: string): ReturnType<KeyStore<OysterKeyCapability>["verify"]> {
    return this.#store.verify(secret);
  }

  /** The live facts behind one key id, for the host's `keys.live` port; `null` for an unknown, revoked, expired or suspended key. */
  async live(keyId: string): Promise<LiveOysterKey | null> {
    const result = await this.#store.live({ keyId });
    if (result.kind !== "ok") return null;
    return {
      keyId: result.value.keyId,
      owner: result.value.owner,
      grantVersion: result.value.grantVersion,
      grants: result.value.scope.grants,
    };
  }
}

/** Bindings the keys and webhook objects need: none of their own. */
export type OysterKeysEnv = Readonly<Record<never, never>>;

/** One webhook subscription for an installation's events. */
export type WebhookSubscription = Readonly<{
  id: string;
  installationId: string;
  url: string;
  /** Event types delivered; empty means every type. */
  types: readonly string[];
  createdAt: number;
}>;

/** A new subscription and its signing secret, shown once. */
export type SubscriptionCreated = Readonly<{
  subscription: WebhookSubscription;
  secret: string;
}>;

/** One delivery attempt record. */
export type WebhookDelivery = Readonly<{
  id: string;
  subscription: string;
  type: string;
  state: "pending" | "delivered" | "failed";
  attempts: number;
  lastStatus: number | null;
  updatedAt: number;
}>;

const RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];
const subscriptionRow = Schema.Struct({
  id: Schema.String,
  installation_id: Schema.String,
  url: Schema.String,
  types: Schema.String,
  created_at: Schema.Number,
});
const deliveryRow = Schema.Struct({
  id: Schema.String,
  subscription: Schema.String,
  type: Schema.String,
  state: Schema.Literals(["pending", "delivered", "failed"]),
  attempts: Schema.Number,
  last_status: Schema.NullOr(Schema.Number),
  updated_at: Schema.Number,
});
const typesSchema = Schema.fromJsonString(Schema.Array(Schema.String));

function toSubscription(row: unknown): WebhookSubscription {
  const decoded = Schema.decodeUnknownSync(subscriptionRow)(row);
  return {
    id: decoded.id,
    installationId: decoded.installation_id,
    url: decoded.url,
    types: Schema.decodeUnknownSync(typesSchema)(decoded.types),
    createdAt: decoded.created_at,
  };
}

/**
 * The tenant's App event delivery owner: webhook subscriptions with signed,
 * retried deliveries, and host recipients with durable per-recipient records.
 * An emit commits here and returns; every delivery happens on the alarm.
 */
export class OysterWebhooks<
  Env extends OysterKeysEnv = OysterKeysEnv,
> extends DurableObject<Env> {
  readonly #recipients: ReturnType<typeof createRecipientDeliveries>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS oyster_subscriptions (
        id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
        types TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS oyster_deliveries (
        id TEXT PRIMARY KEY, subscription TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL,
        last_status INTEGER, updated_at INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS oyster_deliveries_due ON oyster_deliveries(state, next_at);
    `);
    this.#recipients = createRecipientDeliveries({
      sql: ctx.storage.sql,
      now: () => Date.now(),
      wake: (at) => this.wakeBy(at),
      deliver: (recipient, event) =>
        this.deliverToRecipient({ recipient, event }),
    });
  }
  /**
   * A root that names host recipients delivers to them here. This host has
   * none, so a row that names one fails rather than claiming delivery.
   */
  protected deliverToRecipient(
    delivery: Readonly<{ recipient: string; event: HostRecipientEvent }>,
  ): Promise<void> {
    return Promise.reject(
      new Error(`This host has no event recipient ${delivery.recipient}`),
    );
  }
  /** Arm the one alarm no later than `at`; webhooks and recipients share it. */
  private async wakeBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }
  /** Recent deliveries to one host recipient, newest first. */
  recipientDeliveries(recipient: string): RecipientDelivery[] {
    return this.#recipients.deliveries(recipient);
  }
  /** Subscribe `url` to an installation's events; returns the secret once. */
  subscribe(input: {
    installationId: string;
    url: string;
    types: readonly string[];
    secret?: string | undefined;
  }): SubscriptionCreated {
    const secret =
      input.secret ??
      `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))}`;
    const subscription: WebhookSubscription = {
      id: webhookIds.subscription.generate(),
      installationId: input.installationId,
      url: input.url,
      types: [...input.types],
      createdAt: Date.now(),
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO oyster_subscriptions (id, installation_id, url, secret, types, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      subscription.id,
      subscription.installationId,
      subscription.url,
      secret,
      JSON.stringify(subscription.types),
      subscription.createdAt,
    );
    return { subscription, secret };
  }
  /** Every subscription. */
  subscriptions(): WebhookSubscription[] {
    return this.ctx.storage.sql
      .exec(
        "SELECT id, installation_id, url, types, created_at FROM oyster_subscriptions ORDER BY created_at",
      )
      .toArray()
      .map(toSubscription);
  }
  /** Remove a subscription and its deliveries. */
  unsubscribe(id: string): boolean {
    const removed =
      this.ctx.storage.sql.exec(
        "DELETE FROM oyster_subscriptions WHERE id = ?",
        id,
      ).rowsWritten > 0;
    this.ctx.storage.sql.exec(
      "DELETE FROM oyster_deliveries WHERE subscription = ?",
      id,
    );
    return removed;
  }
  /** Recent deliveries for one subscription, newest first. */
  deliveries(subscription: string): WebhookDelivery[] {
    return this.ctx.storage.sql
      .exec(
        "SELECT id, subscription, type, state, attempts, last_status, updated_at FROM oyster_deliveries WHERE subscription = ? ORDER BY updated_at DESC LIMIT 50",
        subscription,
      )
      .toArray()
      .map((row) => {
        const decoded = Schema.decodeUnknownSync(deliveryRow)(row);
        return {
          id: decoded.id,
          subscription: decoded.subscription,
          type: decoded.type,
          state: decoded.state,
          attempts: decoded.attempts,
          lastStatus: decoded.last_status,
          updatedAt: decoded.updated_at,
        };
      });
  }
  /**
   * Accept an emitted event: queue it for every matching subscription and
   * every named host recipient (idempotent per event id). Nothing is delivered
   * before this returns, so no recipient can fail the emitter's write.
   */
  async enqueue(
    source: HostEventSource,
    payload: StandardWebhookPayload,
    eventId: string,
    recipients: readonly string[],
  ): Promise<number> {
    const { installationId } = source;
    const now = Date.now();
    let queued = this.#recipients.enqueue(
      { source, type: payload.type, eventId, payload },
      recipients,
    );
    for (const subscription of this.subscriptions()) {
      if (subscription.installationId !== installationId) continue;
      if (
        subscription.types.length > 0 &&
        !subscription.types.includes(payload.type)
      )
        continue;
      queued += this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO oyster_deliveries (id, subscription, type, body, state, attempts, next_at, last_status, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?)",
        `${subscription.id}.${eventId}`,
        subscription.id,
        payload.type,
        JSON.stringify(payload),
        now,
        now,
      ).rowsWritten;
    }
    if (queued > 0) await this.wakeBy(now);
    return queued;
  }
  /** Deliver due webhooks and recipient rows, then schedule the next retry. */
  override async alarm(): Promise<void> {
    await this.#recipients.drain();
    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec<{
        id: string;
        subscription: string;
        type: string;
        body: string;
        attempts: number;
      }>(
        "SELECT id, subscription, type, body, attempts FROM oyster_deliveries WHERE state = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 25",
        now,
      )
      .toArray();
    await Promise.all(
      due.map(async (delivery) => {
        const target = this.ctx.storage.sql
          .exec<{ url: string; secret: string }>(
            "SELECT url, secret FROM oyster_subscriptions WHERE id = ?",
            delivery.subscription,
          )
          .toArray()[0];
        let status: number | null = null;
        if (target !== undefined) {
          const attempt = await attemptWebhook(target, delivery);
          status = attempt.kind === "response" ? attempt.status : null;
        }
        const attempts = delivery.attempts + 1;
        const delivered = status !== null && status >= 200 && status < 300;
        this.ctx.storage.sql.exec(
          "UPDATE oyster_deliveries SET state = ?, attempts = ?, next_at = ?, last_status = ?, updated_at = ? WHERE id = ?",
          delivered
            ? "delivered"
            : target === undefined || attempts > RETRY_DELAYS_MS.length
              ? "failed"
              : "pending",
          attempts,
          now + (RETRY_DELAYS_MS[attempts - 1] ?? 0),
          status,
          Date.now(),
          delivery.id,
        );
      }),
    );
    const next = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        "SELECT MIN(next_at) AS at FROM oyster_deliveries WHERE state = 'pending'",
      )
      .one().at;
    if (next !== null) await this.wakeBy(Math.max(next, Date.now() + 250));
  }
}

/** Bindings the git adapters read from a standalone Oyster Worker. */
export type OysterGitEnv = Readonly<{
  /** The Artifacts Workers binding, where the runtime has one (Cloudflare). */
  ARTIFACTS?: ArtifactsNamespace;
  /**
   * Otherwise Artifacts is reached over its REST API (celld, Node): the
   * account, the namespace, and an API token secret with Artifacts access.
   */
  ARTIFACTS_ACCOUNT_ID?: string;
  ARTIFACTS_NAMESPACE?: string;
  ARTIFACTS_API_TOKEN?: string;
  KEYS: DurableObjectNamespace<OysterKeys>;
  WEBHOOKS: DurableObjectNamespace<OysterWebhooks>;
}>;

/** The Artifacts namespace: the binding when present, else the REST API. */
export function artifactsOf(env: OysterGitEnv): ArtifactsNamespace {
  if (env.ARTIFACTS !== undefined) return env.ARTIFACTS;
  if (
    env.ARTIFACTS_ACCOUNT_ID === undefined ||
    env.ARTIFACTS_NAMESPACE === undefined ||
    env.ARTIFACTS_API_TOKEN === undefined
  )
    throw new Error(
      "Configure the ARTIFACTS binding or ARTIFACTS_ACCOUNT_ID, ARTIFACTS_NAMESPACE and ARTIFACTS_API_TOKEN",
    );
  return createArtifactsRestNamespace({
    accountId: env.ARTIFACTS_ACCOUNT_ID,
    namespace: env.ARTIFACTS_NAMESPACE,
    apiToken: env.ARTIFACTS_API_TOKEN,
  });
}

const eventArgs = Schema.Tuple([
  Schema.String,
  Schema.Struct({
    type: Schema.String,
    timestamp: Schema.String,
    data: Schema.Json,
  }),
  Schema.String,
]);
const emitMethod = {
  decodeArgs: Schema.decodeUnknownSync(eventArgs, {
    onExcessProperty: "error",
  }),
  decodeResult: Schema.decodeUnknownSync(Schema.Undefined),
  requiredOperations: () => ["emit"],
};

// Admission and in-flight provider work remain frame-local.
const gitSessions = new WeakMap<
  InvocationFrame<OysterInvocationHost>,
  ArtifactsGit
>();
// Keyed by the Instance's stable binding context, so physical credentials span
// frames only within one Instance. Values are host-held, expiry-bounded and
// partitioned by tenant/installation prefix, repository, read/write scope,
// authority version and Release; every frame keeps its own admission.
const gitCredentials = new WeakMap<object, GitCredentialCache>();

/**
 * EVENTS: commit the emit to this tenant's delivery owner and return. Webhook
 * subscribers and the host recipients a root names are delivered afterwards,
 * so a subscriber outage never fails the emitting App's write.
 */
export function eventsBindingFor<Env extends OysterGitWorkerEnv>(
  recipients: (
    context: OysterBindingContext<Env>,
    frame: InvocationFrame<OysterInvocationHost>,
  ) => Promise<readonly string[]>,
): OysterBindingRow<Env> {
  return {
    methods: { emit: emitMethod },
    async dispatch(context, frame, _props, _method, args) {
      frame.signal.throwIfAborted();
      const [type, payload, eventId] = emitMethod.decodeArgs(args);
      if (payload.type !== type)
        throw new Error("Event type does not match its payload");
      const { owner, appId, releaseId } = frame.facts.selection;
      const named = await recipients(context, frame);
      frame.signal.throwIfAborted();
      await context.env.WEBHOOKS.getByName(
        context.scope().durableName("webhooks"),
      ).enqueue(
        { installationId: owner.id, appId, releaseId },
        payload,
        eventId,
        named,
      );
      frame.signal.throwIfAborted();
      return undefined;
    },
  };
}

/** EVENTS for a host with webhook subscribers only. */
export const eventsBinding: OysterBindingRow<OysterGitWorkerEnv> =
  eventsBindingFor(() => Promise.resolve([]));

/** The plain host's bindings plus native GIT over Artifacts and signed EVENTS. */
export const gitBindings: OysterBindingTable<OysterGitWorkerEnv> = {
  ...oysterBindings,
  GIT: {
    methods: nativeGitFrameMethods,
    async dispatch(context, frame, _props, method, args) {
      frame.signal.throwIfAborted();
      const scope = context.scope();
      let credentials = gitCredentials.get(context);
      if (credentials === undefined) {
        credentials = new Map();
        gitCredentials.set(context, credentials);
      }
      let gitStore = gitSessions.get(frame);
      if (gitStore === undefined) {
        gitStore = artifactsGit(
          artifactsOf(context.env),
          scope.repositoryPrefix(frame.facts.selection.owner.id),
          {
            operations: ["create", "fork", "read", "write", "exchange"],
            beforeProvider: () => {
              frame.signal.throwIfAborted();
            },
          },
          credentials,
          frame.facts.selection,
        );
        gitSessions.set(frame, gitStore);
        frame.signal.addEventListener(
          "abort",
          () => gitSessions.delete(frame),
          { once: true },
        );
      }
      const installation = await registryInstallations(context.env, scope).get(
        frame.facts.selection.owner.id,
      );
      frame.signal.throwIfAborted();
      if (installation === null) throw new AppInstanceError("revoked");
      const git = await oysterWorkerGit(
        context.env,
        { scope },
        { invocation: frame, store: gitStore },
      ).git(installation);
      frame.signal.throwIfAborted();
      const result = await invokeNativeGit(
        git.binding(
          frame.facts.subject.kind === "call"
            ? frame.facts.subject.context.actor
            : null,
        ),
        method,
        args,
      );
      frame.signal.throwIfAborted();
      return result;
    },
  },
  EVENTS: eventsBinding,
};

/** A git Worker's one guest binding entrypoint, over `gitBindings`. */
export class OysterBinding extends oysterBindingEntrypoint(gitBindings) {}

const subscribeSchema = Schema.Struct({
  installationId: Schema.String,
  url: Schema.String.check(Schema.isStartingWith("https://")),
  types: Schema.optional(Schema.Array(Schema.String)),
  secret: Schema.optional(Schema.String.check(Schema.isMinLength(16))),
});
const keyNamePattern = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** `invocation.ts:486` uses `team-key:visitor` for anonymous readers; a key can never claim that name. */
const reservedKeyName = "visitor";
const keysWire = keyWire(oysterKeyVocabulary);

/** Owner routes for keys and webhooks; `createOyster` mounts them owner-only. */
export function gitAdminRoutes(
  env: OysterGitEnv,
  scope: TenantScope,
): Hono<OysterEnv> {
  const routes = new Hono<OysterEnv>();
  const keys = () => env.KEYS.getByName(scope.durableName("keys"));
  routes.get("/api/keys", async (context) => {
    const owner = context.get("principal");
    if (!oysterPrincipalIsOwner(owner))
      return Response.json({ error: "Owner only" }, { status: 403 });
    const listed = await keys().list(owner.actor.memberId);
    if (listed.kind === "error")
      return Response.json({ error: listed.error.code }, { status: 500 });
    return Response.json({ keys: listed.value.map(keysWire.toSummary) });
  });
  routes.post("/api/keys", async (context) => {
    const body = keysWire.issue.safeParse(await context.req.json());
    if (!body.success)
      return Response.json({ error: "Invalid key" }, { status: 400 });
    // Named identities and rate policy belong to this host, not the wire grammar.
    if (
      !keyNamePattern.test(body.data.name) ||
      body.data.name === reservedKeyName ||
      body.data.keyId !== undefined ||
      body.data.rateLimit !== undefined
    )
      return Response.json({ error: "Invalid key name" }, { status: 400 });
    const owner = context.get("principal");
    if (!oysterPrincipalIsOwner(owner))
      return Response.json({ error: "Owner only" }, { status: 403 });
    const issued = await keys().issue(owner.actor.memberId, {
      name: body.data.name,
      grants: body.data.grants,
      expiresAt: body.data.expiresAt,
    });
    if (issued.kind === "error")
      return Response.json(
        { error: issued.error.code },
        { status: issued.error.code === "conflict" ? 409 : 400 },
      );
    return Response.json(
      {
        plaintext: issued.value.key,
        key: keysWire.toSummary(issued.value.record),
      },
      { status: 201 },
    );
  });
  routes.post("/api/keys/revoke", async (context) => {
    const body = keysWire.revoke.safeParse(await context.req.json());
    if (!body.success)
      return Response.json({ error: "Invalid request" }, { status: 400 });
    const owner = context.get("principal");
    if (!oysterPrincipalIsOwner(owner))
      return Response.json({ error: "Owner only" }, { status: 403 });
    const revoked = await keys().revoke(
      owner.actor.memberId,
      body.data.requestId,
      body.data.keyId,
    );
    if (revoked.kind === "error")
      return Response.json(
        { error: revoked.error.code },
        { status: revoked.error.code === "denied" ? 404 : 400 },
      );
    return Response.json({ key: keysWire.toSummary(revoked.value) });
  });
  routes.post("/api/webhooks", async (context) => {
    const body = Schema.decodeUnknownOption(subscribeSchema)(
      await context.req.json(),
    );
    if (body._tag === "None")
      return Response.json({ error: "Invalid subscription" }, { status: 400 });
    return Response.json(
      await env.WEBHOOKS.getByName(scope.durableName("webhooks")).subscribe({
        ...body.value,
        types: body.value.types ?? [],
      }),
      { status: 201 },
    );
  });
  routes.get("/api/webhooks", async () =>
    Response.json(
      await env.WEBHOOKS.getByName(
        scope.durableName("webhooks"),
      ).subscriptions(),
    ),
  );
  routes.get("/api/webhooks/:id/deliveries", async (context) =>
    Response.json(
      await env.WEBHOOKS.getByName(scope.durableName("webhooks")).deliveries(
        context.req.param("id"),
      ),
    ),
  );
  routes.delete("/api/webhooks/:id", async (context) =>
    (await env.WEBHOOKS.getByName(scope.durableName("webhooks")).unsubscribe(
      context.req.param("id"),
    ))
      ? new Response(null, { status: 204 })
      : Response.json({ error: "Not found" }, { status: 404 }),
  );
  return routes;
}

/** A standalone Oyster Worker that also hosts git Apps. */
export type OysterGitWorkerEnv = OysterWorkerEnv &
  OysterGitEnv &
  Readonly<{
    /** This Oyster's public origin, for clone URLs (e.g. https://oyster.example). */
    OYSTER_ORIGIN: string;
    /** The owner's display name, used as their actor id (default "owner"). */
    OYSTER_OWNER_NAME?: string;
  }>;

/**
 * An App Instance whose backend may also receive declared Git and Events
 * bindings. Background wakes readmit members through the deployable root's
 * `hostFor`, the same composition HTTP and MCP use.
 */
export abstract class OysterGitInstance<
  Env extends OysterGitWorkerEnv = OysterGitWorkerEnv,
> extends OysterInstance<Env> {
  protected override readonly bindings: OysterBindingTable<Env> = gitBindings;

  /** The deployable root's host for one pinned tenant: `root.hostFor(this.env, scope)`. */
  protected abstract override hostFor(scope: TenantScope): Promise<OysterHost>;
}

/**
 * One deployable Git root's options. Every door (HTTP, MCP, Agents, Workflows,
 * background wakes) composes its tenant host from this one value through
 * `oysterGitRoot(options).hostFor`.
 */
export type OysterGitWorkerOptions<Env extends OysterGitWorkerEnv> = Readonly<{
  /** Workflow controls supplied by the host's existing run owner. */
  workflows?: (
    env: Env,
    host: OysterGitWorkerHost,
  ) => NonNullable<OysterHost["workflows"]>;
  /** Resolve one host-selected tenant before authentication; unknown origins refuse.
   * A single-owner root passes `ownerOrKeyTenancy`. */
  tenancy: (env: Env) => OysterTenancy;
  /** Select the installed home App in the deployable root, independently of core. */
  homeInstallationId?: (env: Env) => string;
  /** Host browser composition; core imports no dashboard App. */
  pageScript?: string;
  /** Connect this Worker’s Agent directory and transports. */
  agents?: (env: Env, scope: TenantScope) => OysterAgents;
  /**
   * Select this host's workspace once, before constructing its HTTP and MCP
   * host. `keysLive` is the same owner-checked port `host.keys.live` uses
   * below: a key's own `computer.use`-style grant check belongs to the
   * workspace, but whether that key's owner is still this tenant's live
   * owner is this one port's job, never reimplemented against `env.KEYS`.
   */
  workspace?: (
    env: Env,
    keysLive: OysterKeysLivePort,
    scope: TenantScope,
    request?: Readonly<{ request: Request; auth: OysterAuth }>,
  ) => OysterWorkspace | Promise<OysterWorkspace>;
  /** Additional capabilities share the exact workspace selected for the base host. */
  capabilities?: (
    env: Env,
    workspace: OysterWorkspace,
    keysLive: OysterKeysLivePort,
  ) => readonly OysterCapability[];
  /** Admit a presented Workflow Git credential for one repository and scope;
   * omit when this host issues no Workflow Git credentials. */
  workflowGitPass?: (
    env: Env,
    scope: TenantScope,
    pass: string,
    target: GitDoorTarget,
  ) => Promise<Extract<GitWriter, { kind: "actor" }> | null>;
  /** Admit a host-minted build job clone pass; omit when this host builds no Apps. */
  buildGitPass?: (
    env: Env,
    scope: TenantScope,
    pass: string,
    target: GitDoorTarget,
  ) => Promise<Extract<GitWriter, { kind: "actor" }> | null>;
  /** Further owner-only routes this host serves, after the owner guard. */
  ownerRoutes?: (env: Env, scope: TenantScope) => Hono<OysterEnv>;
}>;

/** A tenant's whole Git host: the App server, `host.git` and the owner routes. */
export type OysterGitWorkerHost = OysterHost & Readonly<{ git: OysterGitHost }>;

/**
 * `host.keys.live`'s own shape: the live facts behind a key id, re-checked
 * against the tenant's current owner on every read; null for an unknown,
 * revoked, expired, suspended key, or one a since-reassigned tenant's
 * former owner held. The one path every caller -- the HTTP/MCP host, a
 * workspace's own Computer admission -- reaches a key's liveness through.
 */
export type OysterKeysLivePort = (
  keyId: string,
) => Promise<LiveOysterKey | null>;

/** The one composition root of a Git Worker; build it once from its options. */
export type OysterGitRoot<Env extends OysterGitWorkerEnv> = Readonly<{
  /** Select a request's tenant once; `hostFor` reuses that admission for the same request. */
  admit(env: Env, request: Request): Promise<ResolvedTenant | null>;
  /** One pinned tenant's host. HTTP, MCP, Agents, Workflows and background wakes all reach it here. */
  hostFor(
    env: Env,
    scope: TenantScope,
    request?: Request,
  ): Promise<OysterGitWorkerHost>;
}>;

/** Compose a Git Worker's root from its one options value. */
export function oysterGitRoot<Env extends OysterGitWorkerEnv>(
  options: OysterGitWorkerOptions<Env>,
): OysterGitRoot<Env> {
  const environments = new WeakMap<
    Env,
    Readonly<{
      tenancy: OysterTenancy;
      /** Each request's one admission, taken at its top and consumed below. */
      admissions: WeakMap<Request, ResolvedTenant>;
      authentications: WeakMap<Request, Promise<OysterAuthResult>>;
    }>
  >();
  const stateOf = (env: Env) => {
    let state = environments.get(env);
    if (state === undefined) {
      state = {
        tenancy: options.tenancy(env),
        admissions: new WeakMap(),
        authentications: new WeakMap(),
      };
      environments.set(env, state);
    }
    return state;
  };
  return {
    async admit(env, request) {
      const state = stateOf(env);
      const resolved = await state.tenancy.resolve(request);
      if (resolved !== null) state.admissions.set(request, resolved);
      return resolved;
    },
    hostFor(env, scope, request) {
      const state = stateOf(env);
      return oysterGitWorkerHost(
        env,
        options,
        {
          scope,
          auth: pinnedTenantAuth(
            state.tenancy,
            scope,
            state.admissions,
            state.authentications,
          ),
        },
        request,
      );
    },
  };
}

/** The single-owner root's tenancy: the owner key or a named key, at the configured origin only. */
export function ownerOrKeyTenancy(env: OysterGitWorkerEnv): OysterTenancy {
  const scope = tenantScope(defaultTenant, env.OYSTER_ORIGIN);
  return implicitTenancy(
    scope.origin,
    ownerOrKeyAuth(env.OYSTER_OWNER_KEY, env.OYSTER_OWNER_NAME ?? "owner", () =>
      env.KEYS.getByName(scope.durableName("keys")),
    ),
  );
}

/** The standalone Worker's `fetch` handler with the git door and owner routes. */
export function createOysterGitWorker<Env extends OysterGitWorkerEnv>(
  root: OysterGitRoot<Env>,
): ExportedHandler<Env> {
  // Bound frontend host state; SDK sessions belong to the tenant MCP owner.
  const maxCachedHosts = 32;
  type CachedHost = {
    app: ReturnType<typeof createOyster>;
    active: number;
  };
  const environments = new WeakMap<Env, Map<string, CachedHost>>();
  return {
    async fetch(request, env, ctx) {
      let hosts = environments.get(env);
      if (hosts === undefined) {
        hosts = new Map();
        environments.set(env, hosts);
      }
      let resolved: ResolvedTenant | null;
      try {
        resolved = await root.admit(env, request);
      } catch (error) {
        if (error instanceof HTTPException) return error.getResponse();
        throw error;
      }
      if (resolved === null) return new Response("Not found", { status: 404 });
      const { scope } = resolved;
      const refused = await refuseOlderOysterStore(request, env, scope);
      if (refused !== null) return refused;
      const boot = await serveOysterBootCapability(request, env, scope);
      if (boot !== null) return boot;
      let host: OysterGitWorkerHost;
      try {
        host = await root.hostFor(env, scope, request);
      } catch (error) {
        if (error instanceof HTTPException) return error.getResponse();
        throw error;
      }
      const key = `${scope.tenantId}:${scope.origin}:${host.computerId ?? ""}`;
      let entry = hosts.get(key);
      let cache = true;
      if (entry === undefined) {
        if (hosts.size >= maxCachedHosts) {
          const idle = [...hosts].find(([, item]) => item.active === 0);
          if (idle === undefined) cache = false;
          else {
            hosts.delete(idle[0]);
          }
        }
        entry = { app: createOyster(host), active: 0 };
        if (cache) hosts.set(key, entry);
      } else {
        hosts.delete(key);
        hosts.set(key, entry);
      }
      entry.active += 1;
      try {
        return await entry.app.fetch(request, env, ctx);
      } finally {
        entry.active -= 1;
      }
    },
  };
}

/** What `oysterWorkerGit` needs beyond the Worker's bindings. */
export type OysterWorkerGitOptions<Env extends OysterGitWorkerEnv> = Pick<
  OysterGitWorkerOptions<Env>,
  "workflowGitPass" | "buildGitPass"
> &
  Readonly<{
    /** The tenant whose registry and repositories Git reaches. */
    scope: TenantScope;
  }>;

/** One live guest frame's Git custody; never a guest argument. */
export type OysterGitFrame = Readonly<{
  /** Verified backend custody of the host's live frame; its abort stops provider work. */
  invocation: InvocationFrame<OysterInvocationHost>;
  /** Host-owned physical adapter for this frame; admission stays packet-local. */
  store?: ArtifactsGit;
}>;

/**
 * `host.git` for an Oyster Worker: the git door's writer projection and the
 * admitted, installation-scoped Artifacts path with the App's push policy and
 * the Instance journal. Set it on your own `createOyster` host; the full
 * standalone composition (`oysterGitWorkerHost`) uses this same builder.
 */
export function oysterWorkerGit<Env extends OysterGitWorkerEnv>(
  env: Env,
  options: OysterWorkerGitOptions<Env>,
  frame?: OysterGitFrame,
): OysterGitHost {
  const { scope } = options;
  const installations = registryInstallations(env, scope);
  const git: OysterGitHost = {
    writerOf: (who) => {
      const context = invocationCallerContext(who, null);
      return context.actor.kind === "member" && context.role !== undefined
        ? { kind: "actor", actor: context.actor, role: context.role }
        : { kind: "actor", actor: context.actor };
    },
    git: (installation) => {
      if (installation.instanceId === null)
        throw new AppInstanceError("instance_inactive");
      const stub = env.INSTANCES.getByName(installation.instanceId);
      const invocation = frame?.invocation;
      const beforeProvider = () => {
        invocation?.signal.throwIfAborted();
      };
      const backendFor = async (current: typeof installation) => {
        beforeProvider();
        if (invocation !== undefined) {
          const selected = invocation.facts.selection;
          const captured = invocation.host.artifact;
          if (
            selected.owner.kind !== "installation" ||
            selected.owner.id !== current.installationId ||
            selected.instanceId !== current.instanceId ||
            selected.authorityVersion !== current.authority.authorityVersion ||
            selected.appId !== current.release.appId ||
            selected.releaseId !== current.release.releaseId ||
            captured.release.appId !== current.release.appId ||
            captured.release.releaseId !== current.release.releaseId ||
            captured.release.artifact.artifactRef !==
              current.release.artifact.artifactRef ||
            captured.release.artifact.artifactDigest !==
              current.release.artifact.artifactDigest ||
            captured.digest !== invocation.facts.artifactDigest
          )
            throw new AppInstanceError("revoked");
          return { ...captured, declaration: invocation.host.declaration };
        }
        return resolveBackend(r2ArtifactStore(env.RELEASES), current.release);
      };
      const currentInstallation = async () => {
        beforeProvider();
        const current = await installations.get(installation.installationId);
        beforeProvider();
        if (
          current?.status !== "enabled" ||
          current.instanceId !== installation.instanceId ||
          current.authority.authorityVersion !==
            installation.authority.authorityVersion ||
          current.release.appId !== installation.release.appId ||
          current.release.releaseId !== installation.release.releaseId ||
          current.release.artifact.artifactRef !==
            installation.release.artifact.artifactRef ||
          current.release.artifact.artifactDigest !==
            installation.release.artifact.artifactDigest
        )
          return null;
        return current;
      };
      const raw =
        frame?.store ??
        createArtifactsGit(
          artifactsOf(env),
          scope.repositoryPrefix(installation.installationId),
          {
            operations: ["create", "fork", "read", "write", "exchange"],
            beforeProvider,
          },
        );
      return Promise.resolve(
        createAdmittedGit({
          installationId: installation.installationId,
          beforeProvider,
          store: {
            ...raw,
            cloneUrl: (name) =>
              Promise.resolve(
                `${scope.origin}/git/${installation.installationId}/${name}.git`,
              ),
          },
          grants: {
            admits: createInstallationGitAdmission({
              currentInstallation,
              declaration: async (current) =>
                (await backendFor(current))?.declaration ?? null,
            }),
          },
          policy: {
            authorize: async (question) => {
              const current = await currentInstallation();
              if (current?.instanceId == null)
                throw new AppInstanceError("revoked");
              const backend = await backendFor(current);
              if (backend === null) throw new AppInstanceError("revoked");
              const deadlineAt = Math.min(
                Date.now() + APP_INVOCATION_CEILING_MS,
                invocation?.facts.deadlineAt ?? Infinity,
              );
              const context: AppMethodCallContext = {
                computerId: null,
                actor: question.writer.actor,
              };
              if (question.writer.role !== undefined)
                context.role = question.writer.role;
              if (question.writer.workflow !== undefined)
                context.workflow = workflowAttestationSchema.parse(
                  question.writer.workflow,
                );
              const facts = invocationFacts.fromCaller(
                {
                  instanceId: current.instanceId,
                  selection: selectionOf(current),
                  artifactDigest: backend.digest,
                  grants: [],
                  ancestry: [],
                },
                parseAppMethodCallContext(context),
                { deadlineAt, grantExpiresAt: deadlineAt },
              );
              return stub.authorizeGitPush(
                facts,
                question,
                undefined,
                scope.tenantId,
              );
            },
          },
          journal: {
            tip: (name, ref) =>
              stub.gitTip(
                installation.installationId,
                name,
                ref,
                scope.tenantId,
              ),
            record: async (fact) => {
              await stub.recordGitPush(
                installation.installationId,
                fact,
                scope.tenantId,
              );
            },
          },
        }),
      );
    },
  };
  const { workflowGitPass, buildGitPass } = options;
  let admitted: OysterGitHost = git;
  if (workflowGitPass !== undefined)
    admitted = {
      ...admitted,
      workflowPass: (pass, target) => workflowGitPass(env, scope, pass, target),
    };
  if (buildGitPass !== undefined)
    admitted = {
      ...admitted,
      buildPass: (pass, target) => buildGitPass(env, scope, pass, target),
    };
  return admitted;
}

/**
 * One selected tenant's whole host from a root's options. Roots reach it through
 * `oysterGitRoot(options).hostFor`; a cold directory passes its own resolved tenant.
 */
export async function oysterGitWorkerHost<Env extends OysterGitWorkerEnv>(
  env: Env,
  options: OysterGitWorkerOptions<Env>,
  selected: ResolvedTenant,
  request?: Request,
): Promise<OysterGitWorkerHost> {
  const { scope, auth } = selected;
  // The one path to a key's liveness: the stored owner id is re-checked
  // against the live, current owner on every read (S3 inherits this port,
  // so this is the one place that check needs to live), the same discipline
  // ownerOrKeyAuth already applies at authentication. `host.keys.live` below
  // and the workspace/capabilities callbacks above it both reach a key only
  // through this one closure, never `env.KEYS` directly.
  const keysLive: OysterKeysLivePort = async (keyId) => {
    const key = await env.KEYS.getByName(scope.durableName("keys")).live(keyId);
    if (key === null) return null;
    const current = await auth.resolve({
      kind: "member",
      memberId: key.owner,
    });
    return current !== null && oysterPrincipalIsOwner(current) ? key : null;
  };
  const workspace = (await options.workspace?.(
    env,
    keysLive,
    scope,
    request === undefined ? undefined : { request, auth },
  )) ?? {
    computerId: scope.computerName("workspace"),
    files: r2FileSource(env.RELEASES, scope.workspacePrefix),
  };
  const agents = options.agents?.(env, scope);
  let policyOptions: Parameters<typeof oysterWorkerHost>[2] = {
    workspace,
    scope,
  };
  if (agents !== undefined)
    policyOptions = {
      ...policyOptions,
      appToolPolicy: (principal) => agents.appToolPolicy(principal),
    };
  const base = oysterWorkerHost(env, auth, policyOptions);
  const capabilities = [
    ...(base.capabilities ?? []),
    ...(agents === undefined ? [] : agentCapabilities(agents)),
    ...(options.capabilities?.(env, workspace, keysLive) ?? []),
  ];
  let gitOptions: OysterWorkerGitOptions<Env> = { scope };
  if (options.workflowGitPass !== undefined)
    gitOptions = { ...gitOptions, workflowGitPass: options.workflowGitPass };
  if (options.buildGitPass !== undefined)
    gitOptions = { ...gitOptions, buildGitPass: options.buildGitPass };
  const git = oysterWorkerGit(env, gitOptions);
  const ownerRoutes = gitAdminRoutes(env, scope);
  const hostOwnerRoutes = options.ownerRoutes?.(env, scope);
  if (hostOwnerRoutes !== undefined) ownerRoutes.route("/", hostOwnerRoutes);
  if (agents !== undefined) {
    ownerRoutes.route("/", agentApprovalRoutes(agents));
    ownerRoutes.route("/", agentMcpServerRoutes(agents));
  }
  let host: OysterGitWorkerHost = {
    ...base,
    capabilities,
    git,
    ownerRoutes,
    keys: { live: keysLive },
  };
  if (options.pageScript !== undefined)
    host = { ...host, pageScript: options.pageScript };
  if (options.workflows !== undefined)
    host = { ...host, workflows: options.workflows(env, host) };
  if (options.homeInstallationId !== undefined)
    host = { ...host, homeInstallationId: options.homeInstallationId(env) };
  return host;
}

/**
 * Authenticate against the pinned tenant. A request admitted at the Worker's
 * top reuses that one admission; any other entry resolves its own.
 */
function pinnedTenantAuth(
  tenancy: OysterTenancy,
  scope: TenantScope,
  admissions: WeakMap<Request, ResolvedTenant>,
  authentications: WeakMap<Request, Promise<OysterAuthResult>>,
): OysterAuth {
  const admitted = async (incoming: Request) =>
    admissions.get(incoming) ?? (await tenancy.resolve(incoming));
  return {
    resolve: async (actor) => {
      const current = await tenancy.resolve(new Request(scope.origin));
      if (
        current?.scope.tenantId !== scope.tenantId ||
        current.scope.origin !== scope.origin
      )
        return null;
      return current.auth.resolve(actor);
    },
    authenticate: async (incoming) => {
      const current = await admitted(incoming);
      if (
        current?.scope.tenantId !== scope.tenantId ||
        current.scope.origin !== scope.origin
      )
        return { kind: "refused", status: 404 };
      let authenticated = authentications.get(incoming);
      if (authenticated === undefined) {
        authenticated = current.auth.authenticate(incoming);
        authentications.set(incoming, authenticated);
      }
      return authenticated;
    },
    login: async (incoming) => {
      const current = await admitted(incoming);
      if (
        current?.scope.tenantId !== scope.tenantId ||
        current.scope.origin !== scope.origin
      )
        return new Response("Not found", { status: 404 });
      return (
        current.auth.login?.(incoming) ??
        new Response("Sign-in is not available", { status: 404 })
      );
    },
  };
}

/** Deploy the MCP owner from the same root as createOysterGitWorker. */
export function createOysterGitMcpOwner<Env extends OysterGitWorkerEnv>(
  root: OysterGitRoot<Env>,
) {
  return createOysterMcpOwner<Env>((env, scope) => root.hostFor(env, scope));
}
