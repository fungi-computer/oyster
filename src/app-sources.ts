import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import type { Artifacts, GitExchange } from "@fungi.computer/burrow";
import type {
  CloudflareArtifactsRepositoryMetadata,
  CloudflareArtifactsRepositoryMetadataStore,
} from "@fungi.computer/burrow/cloudflare";
import {
  appIdSchema,
  sha256DigestSchema,
  sourceRevisionSchema,
} from "@fungi.computer/puffball/effect";
import {
  teamAppPublisherRegistrationSchema,
  type TeamAppPublisherRegistry,
} from "@fungi.computer/puffball/publisher";
import {
  capturedPinnedRecipeSchema,
  digestPinnedRecipe,
} from "./build-contract.js";
import {
  sameReceipt,
  seedReceiptInputSchema,
  templateRepositoryForApp,
  type PublisherTemplateSeedReceipt,
  type PublisherTemplateSeedReceipts,
} from "./source/index.js";
import {
  seedPublisherTemplate,
  type TemplateSourceTransport,
} from "./source/template-write.js";

/**
 * Oyster's own storage for App source templates, Team-owned fork
 * registrations and the recorded Artifacts repository metadata their fork
 * provenance depends on. Each factory is a pure adapter over a generic
 * synchronous SQLite port, so it is unit-testable with a Node `DatabaseSync`
 * and identically correct over a Durable Object's `ctx.storage.sql`.
 */
export function ensureAppSourceTables(sql: WatchdogSqliteOwner["sql"]): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS oyster_app_sources (
      app_id TEXT NOT NULL,
      seed_revision TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      source_tree_digest TEXT NOT NULL,
      recipe_json TEXT NOT NULL,
      build_recipe_digest TEXT NOT NULL,
      PRIMARY KEY (app_id, seed_revision)
    ) STRICT`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS oyster_app_registrations (
      app_id TEXT PRIMARY KEY,
      record TEXT NOT NULL
    ) STRICT`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS oyster_artifacts_repositories (
      repository_name TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      remote TEXT NOT NULL,
      parent_repository TEXT
    ) STRICT`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS oyster_artifacts_repositories_pending (
      repository_name TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      remote TEXT NOT NULL,
      parent_repository TEXT,
      initial_token TEXT NOT NULL
    ) STRICT`,
  );
}

const seedReceiptRowSchema = Schema.Struct({
  app_id: appIdSchema,
  seed_revision: sourceRevisionSchema,
  source_revision: sourceRevisionSchema,
  source_tree_digest: sha256DigestSchema,
  recipe_json: Schema.String,
  build_recipe_digest: sha256DigestSchema,
});

function receiptFromRow(
  row: Schema.Schema.Type<typeof seedReceiptRowSchema>,
): PublisherTemplateSeedReceipt {
  return {
    appId: row.app_id,
    repository: templateRepositoryForApp(row.app_id),
    sourceRevision: row.source_revision,
    sourceTreeDigest: row.source_tree_digest,
    seedRevision: row.seed_revision,
    recipe: Schema.decodeUnknownSync(
      Schema.fromJsonString(capturedPinnedRecipeSchema),
      { onExcessProperty: "error" },
    )(row.recipe_json),
    buildRecipeDigest: row.build_recipe_digest,
  };
}

/** Append-only App source seed receipts, owned by one Oyster's registry. */
export function createOysterAppSourceReceipts(
  sql: WatchdogSqliteOwner["sql"],
): PublisherTemplateSeedReceipts {
  const read: PublisherTemplateSeedReceipts["read"] = (appId, seedRevision) => {
    const row = sql
      .exec(
        `SELECT app_id, seed_revision, source_revision, source_tree_digest,
                recipe_json, build_recipe_digest
         FROM oyster_app_sources WHERE app_id = ? AND seed_revision = ?`,
        appId,
        seedRevision,
      )
      .toArray()[0];
    if (row === undefined) return Promise.resolve(null);
    const receipt = receiptFromRow(
      Schema.decodeUnknownSync(seedReceiptRowSchema, {
        onExcessProperty: "error",
      })(row),
    );
    if (digestPinnedRecipe(receipt.recipe) !== receipt.buildRecipeDigest)
      throw new Error("Oyster App source seed receipt recipe conflicts");
    return Promise.resolve(receipt);
  };
  const record: PublisherTemplateSeedReceipts["record"] = async (untrusted) => {
    const input = Schema.decodeUnknownSync(seedReceiptInputSchema, {
      onExcessProperty: "error",
    })(untrusted);
    const receipt: PublisherTemplateSeedReceipt = {
      ...input,
      repository: templateRepositoryForApp(input.appId),
    };
    if (digestPinnedRecipe(receipt.recipe) !== receipt.buildRecipeDigest)
      throw new Error("Oyster App source seed recipe digest conflicts");
    sql.exec(
      `INSERT OR IGNORE INTO oyster_app_sources (
        app_id, seed_revision, source_revision, source_tree_digest,
        recipe_json, build_recipe_digest
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      receipt.appId,
      receipt.seedRevision,
      receipt.sourceRevision,
      receipt.sourceTreeDigest,
      JSON.stringify(receipt.recipe),
      receipt.buildRecipeDigest,
    );
    const stored = await read(receipt.appId, receipt.seedRevision);
    if (stored === null || !sameReceipt(stored, receipt))
      throw new Error("Oyster App source seed receipt conflicts");
    return stored;
  };
  return Object.freeze({ read, record });
}

const registrationRowSchema = Schema.Struct({
  app_id: Schema.String,
  record: Schema.String,
});

/** Team-owned App publisher registrations (fork destinations), one per App. */
export function createOysterAppRegistrations(
  sql: WatchdogSqliteOwner["sql"],
): TeamAppPublisherRegistry {
  const read: TeamAppPublisherRegistry["read"] = (appId) => {
    const row = sql
      .exec(
        "SELECT app_id, record FROM oyster_app_registrations WHERE app_id = ?",
        appId,
      )
      .toArray()[0];
    if (row === undefined) return Promise.resolve({ kind: "absent" });
    const parsed = Schema.decodeUnknownSync(registrationRowSchema, {
      onExcessProperty: "error",
    })(row);
    return Promise.resolve({
      kind: "found",
      registration: Schema.decodeUnknownSync(
        teamAppPublisherRegistrationSchema,
        { onExcessProperty: "error" },
      )(JSON.parse(parsed.record)),
    });
  };
  return {
    read,
    register: async (registration) => {
      const record = JSON.stringify(registration);
      const inserted = sql
        .exec(
          `INSERT INTO oyster_app_registrations (app_id, record) VALUES (?, ?)
           ON CONFLICT (app_id) DO NOTHING
           RETURNING app_id`,
          registration.appId,
          record,
        )
        .toArray();
      const current = await read(registration.appId);
      if (current.kind === "absent")
        throw new Error("Oyster App registration was not retained");
      const matches = JSON.stringify(current.registration) === record;
      if (!matches) return { kind: "conflict" };
      return {
        kind: inserted.length > 0 ? "created" : "existing",
        registration: current.registration,
      };
    },
    authorize: async (appId, teamId) => {
      const current = await read(appId);
      if (current.kind === "absent") return current;
      return current.registration.teamId === teamId
        ? { kind: "authorized", registration: current.registration }
        : { kind: "denied" };
    },
  };
}

const repositoryMetadataSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  name: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(128)),
  ),
  defaultBranch: Schema.Literal("main"),
  remote: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  parentRepository: Schema.NullOr(
    Schema.String.pipe(
      Schema.check(Schema.isMinLength(1)),
      Schema.check(Schema.isMaxLength(128)),
    ),
  ),
});
const repositoryRowSchema = Schema.Struct({
  repository_name: Schema.String,
  provider_id: Schema.String,
  default_branch: Schema.String,
  remote: Schema.String,
  parent_repository: Schema.NullOr(Schema.String),
});
const pendingRepositoryRowSchema = Schema.Struct({
  repository_name: Schema.String,
  provider_id: Schema.String,
  default_branch: Schema.String,
  remote: Schema.String,
  parent_repository: Schema.NullOr(Schema.String),
  initial_token: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

function metadataFromRow(
  row: Schema.Schema.Type<typeof repositoryRowSchema>,
): CloudflareArtifactsRepositoryMetadata {
  return Schema.decodeUnknownSync(repositoryMetadataSchema, {
    onExcessProperty: "error",
  })({
    id: row.provider_id,
    name: row.repository_name,
    defaultBranch: row.default_branch,
    remote: row.remote,
    parentRepository: row.parent_repository,
  });
}

function sameMetadata(
  left: CloudflareArtifactsRepositoryMetadata,
  right: CloudflareArtifactsRepositoryMetadata,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.defaultBranch === right.defaultBranch &&
    left.remote === right.remote &&
    left.parentRepository === right.parentRepository
  );
}

/** Durable repository provenance for Oyster's own `createCloudflareArtifacts`. */
export function createOysterArtifactsRepositoryMetadataStore(
  sql: WatchdogSqliteOwner["sql"],
): CloudflareArtifactsRepositoryMetadataStore {
  const readPending = (name: string) => {
    const row = sql
      .exec(
        `SELECT repository_name, provider_id, default_branch, remote,
                parent_repository, initial_token
         FROM oyster_artifacts_repositories_pending WHERE repository_name = ?`,
        name,
      )
      .toArray()[0];
    if (row === undefined) return Promise.resolve(null);
    const decoded = Schema.decodeUnknownSync(pendingRepositoryRowSchema, {
      onExcessProperty: "error",
    })(row);
    return Promise.resolve(
      Object.freeze({
        metadata: metadataFromRow(decoded),
        initialToken: decoded.initial_token,
      }),
    );
  };
  const read = async (
    name: string,
  ): Promise<CloudflareArtifactsRepositoryMetadata | null> => {
    if ((await readPending(name)) !== null) return null;
    const row = sql
      .exec(
        `SELECT repository_name, provider_id, default_branch, remote,
                parent_repository
         FROM oyster_artifacts_repositories WHERE repository_name = ?`,
        name,
      )
      .toArray()[0];
    return row === undefined
      ? null
      : metadataFromRow(
          Schema.decodeUnknownSync(repositoryRowSchema, {
            onExcessProperty: "error",
          })(row),
        );
  };
  return Object.freeze({
    read,
    readPending,
    recordPending: async (untrusted, initialToken) => {
      const metadata = Schema.decodeUnknownSync(repositoryMetadataSchema, {
        onExcessProperty: "error",
      })(untrusted);
      sql.exec(
        `INSERT OR IGNORE INTO oyster_artifacts_repositories_pending (
          repository_name, provider_id, default_branch, remote,
          parent_repository, initial_token
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        metadata.name,
        metadata.id,
        metadata.defaultBranch,
        metadata.remote,
        metadata.parentRepository,
        initialToken,
      );
      const pending = await readPending(metadata.name);
      if (pending !== null) {
        if (
          !sameMetadata(pending.metadata, metadata) ||
          pending.initialToken !== initialToken
        )
          throw new Error("Oyster Artifacts recovery state conflicts");
        return;
      }
      const stored = await read(metadata.name);
      if (stored === null || !sameMetadata(stored, metadata))
        throw new Error("Oyster Artifacts recovery state was not saved");
    },
    activate: async (untrusted, initialToken) => {
      const metadata = Schema.decodeUnknownSync(repositoryMetadataSchema, {
        onExcessProperty: "error",
      })(untrusted);
      sql.exec(
        `INSERT OR IGNORE INTO oyster_artifacts_repositories (
          repository_name, provider_id, default_branch, remote, parent_repository
        ) SELECT repository_name, provider_id, default_branch, remote, parent_repository
          FROM oyster_artifacts_repositories_pending
          WHERE repository_name = ? AND provider_id = ? AND default_branch = ?
            AND remote = ? AND parent_repository IS ? AND initial_token = ?`,
        metadata.name,
        metadata.id,
        metadata.defaultBranch,
        metadata.remote,
        metadata.parentRepository,
        initialToken,
      );
      const active = await read(metadata.name);
      if (active === null || !sameMetadata(active, metadata))
        throw new Error("Oyster Artifacts metadata conflicts");
      sql.exec(
        `DELETE FROM oyster_artifacts_repositories_pending
         WHERE repository_name = ? AND provider_id = ? AND default_branch = ?
           AND remote = ? AND parent_repository IS ? AND initial_token = ?`,
        metadata.name,
        metadata.id,
        metadata.defaultBranch,
        metadata.remote,
        metadata.parentRepository,
        initialToken,
      );
    },
  });
}

/** Translate one local Git smart-HTTP request into an admitted Artifacts
 * exchange; the identical shape Hub's Publisher keeps for its own template
 * writes (`services/app-publisher/src/source-git.ts`), scoped to Oyster's own
 * Artifacts composition since a package cannot depend on that service. */
export async function exchangeOysterTemplateGit(
  artifacts: Pick<Artifacts, "exchangeGit">,
  remote: string,
  repository: string,
  request: Request,
  permission: "read" | "write" = "write",
): Promise<Response> {
  const url = new URL(request.url);
  const registered = new URL(remote);
  const internal = url.origin === "https://git.team.internal";
  const base = internal ? `/${repository}.git` : registered.pathname;
  if (
    url.username ||
    url.password ||
    url.hash ||
    (!internal && url.origin !== registered.origin)
  )
    return new Response(null, { status: 403 });
  const protocol = request.headers.get("Git-Protocol");
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(120_000),
  ]);
  const common = { repository, signal };
  let input: GitExchange;
  if (request.method === "GET" && url.pathname === `${base}/info/refs`) {
    if (url.search === "?service=git-upload-pack")
      input = { ...common, operation: "upload-pack-advertisement" };
    else if (url.search === "?service=git-receive-pack")
      input = { ...common, operation: "receive-pack-advertisement" };
    else return new Response(null, { status: 403 });
  } else if (request.method === "POST" && url.search === "") {
    const raw = request.body;
    if (raw === null) return new Response(null, { status: 403 });
    // A real identity passthrough, not a type assertion: the ambient
    // `Request.body` resolves to `ReadableStream<any>` in this workspace's
    // merged lib types, so this pipes it through a stream genuinely typed
    // `ReadableStream<Uint8Array>` for `GitExchange`'s own `body` field.
    const body: ReadableStream<Uint8Array> = raw.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>(),
    );
    if (url.pathname === `${base}/git-upload-pack`)
      input = { ...common, operation: "upload-pack", body };
    else if (url.pathname === `${base}/git-receive-pack`)
      input = { ...common, operation: "receive-pack", body };
    else return new Response(null, { status: 403 });
  } else return new Response(null, { status: 403 });
  if (protocol !== null) input = { ...input, protocol };
  if (permission === "read" && input.operation.startsWith("receive-pack"))
    return new Response(null, { status: 403 });
  const response = await Effect.runPromise(
    Effect.tryPromise(() => artifacts.exchangeGit(input)),
    { signal },
  );
  const type = `application/x-git-${input.operation.startsWith("upload-pack") ? "upload-pack" : "receive-pack"}-${input.operation.endsWith("advertisement") ? "advertisement" : "result"}`;
  if (!response.ok || response.headers.get("content-type") !== type) {
    await response.body?.cancel();
    return new Response(null, { status: 503 });
  }
  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": type, "Cache-Control": "no-store" },
  });
}

/** Seed Oyster's own template source from the operator owner route, over the
 * durable receipts and the Artifacts composition for this Oyster. */
export function publishOysterAppSource(
  receipts: PublisherTemplateSeedReceipts,
  artifacts: Pick<Artifacts, "ensureRepository" | "exchangeGit">,
  rawAppId: string,
  request: Request,
) {
  const transport: TemplateSourceTransport = {
    ensureRepository: (name) => artifacts.ensureRepository(name),
    exchangeTemplateGit: (repository, templateRequest) =>
      exchangeOysterTemplateGit(
        artifacts,
        `https://git.team.internal/${repository}.git`,
        repository,
        templateRequest,
        "write",
      ),
  };
  return seedPublisherTemplate(receipts, transport, rawAppId, request);
}
