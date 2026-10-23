import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import {
  installOnOyster,
  installationObservationSignal,
  completedInstallationResponse,
  type InstallationObservationBudget,
} from "./installation-client.js";
import {
  parseArtifactRef,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  type ArtifactRef,
  type Release,
  type Sha256Digest,
} from "@fungi.computer/puffball";
import {
  commitPreparedCandidate,
  createAppCandidatePreparer,
  createArtifactsSourceCapture,
  createFirstPartyAppSourceDistribution,
  createLocalArtifactWriter,
  createLocalBuildExecutor,
  createLocalCommitSourceCapture,
  normalizeAppPublisherRecipe,
  type AppPublisherCoreConfigInput,
  type SourceCapture,
} from "./build.js";
import {
  templateSeedClaimSchema,
  type TemplateSeedClaim,
} from "./source/template-seed.js";
import { pushTemplateSource } from "./source/template-push.js";
import { sha256 } from "./release.js";
import type { InstallationOperation } from "./installation-operations.js";
export { InstallationObservationError } from "./installation-client.js";

/** One committed repository and its canonical App build recipe. */
export type PackOptions = Readonly<{
  /** The App's ID, `app_<name>`. */
  appId: string;
  /** The Release ID; defaults to `rel_<commit prefix>`. */
  releaseId?: string;
  /** Repository root; all recipe paths are relative to this captured root. */
  sourceDirectory: string;
  /** Exact committed source, `git:<full commit SHA>`; dirty files are not inputs. */
  sourceRevision: string;
  /** The same pinned recipe input accepted by `oyster/build`. */
  recipe: AppPublisherCoreConfigInput["recipe"];
  /** Optional local pnpm content store used by the captured source compiler. */
  packageStoreDirectory?: string;
  /** Where to write `release.json` and the immutable `artifacts/` directory. */
  outDirectory: string;
}>;

/** A packed Release on disk. */
export type PackedRelease = Readonly<{
  release: Release;
  /** Every artifact file by reference. */
  artifacts: readonly Readonly<{ artifactRef: ArtifactRef; path: string }>[];
}>;

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function packCapturedSource(
  options: Omit<PackOptions, "sourceDirectory">,
  sourceCapture: SourceCapture,
): Promise<PackedRelease> {
  const revision = parseSourceRevision(options.sourceRevision);
  const out = resolve(options.outDirectory);
  const artifactsDirectory = join(out, "artifacts");
  const preparer = createAppCandidatePreparer({
    config: { appId: options.appId, recipe: options.recipe },
    sourceCapture,
    buildExecutor: createLocalBuildExecutor(
      options.packageStoreDirectory === undefined
        ? {}
        : { packageStoreDirectory: options.packageStoreDirectory },
    ),
  });
  const prepared = await Effect.runPromise(
    Effect.scoped(
      preparer.prepareCandidate(
        parseReleaseId(
          options.releaseId ??
            `rel_${revision.slice("git:".length, "git:".length + 12)}`,
        ),
      ),
    ),
  );
  const release = await Effect.runPromise(
    commitPreparedCandidate(prepared, {
      artifactWriter: createLocalArtifactWriter(
        artifactsDirectory,
        options.recipe.assets,
      ),
      releaseCatalog: { createRelease: (value) => Promise.resolve(value) },
    }),
  );
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "release.json"),
    `${Schema.encodeUnknownSync(Schema.fromJsonString(releaseSchema))(release)}\n`,
  );
  const artifacts = (await filesUnder(artifactsDirectory)).map((path) => ({
    artifactRef: parseArtifactRef(
      `artifact:${relative(artifactsDirectory, path)}`,
    ),
    path,
  }));
  return { release, artifacts };
}

/** Build an exact local Git commit with the canonical compiler and artifact writer. */
export async function packRelease(
  options: PackOptions,
): Promise<PackedRelease> {
  return packCapturedSource(
    options,
    createLocalCommitSourceCapture(
      resolve(options.sourceDirectory),
      parseSourceRevision(options.sourceRevision),
    ),
  );
}

/**
 * Capture an Artifacts Git commit, build its Release, upload it to an Oyster,
 * and install it, or switch an existing installation to it
 * ({@link installRelease}).
 * `waitMs` starts with the upload/observation phase after packing; a supplied
 * caller signal retains its original lifetime through that phase.
 */
export async function installFromSource(
  input: Readonly<{
    appId: string;
    releaseId?: string;
    recipe: PackOptions["recipe"];
    /** Credential-free trusted Artifacts Git URL and its exact committed source. */
    source: Readonly<{ remote: string; token: string; sourceRevision: string }>;
    packageStoreDirectory?: string;
    /** Destination Oyster origin. */
    url: string;
    /** Destination Oyster owner key; distinct from the source Git credential. */
    key: string;
    installationId: string;
  }> &
    InstallationObservationBudget,
): Promise<Response> {
  const outDirectory = await mkdtemp(join(tmpdir(), "oyster-source-release-"));
  try {
    let options: Omit<PackOptions, "sourceDirectory"> = {
      appId: input.appId,
      recipe: input.recipe,
      sourceRevision: input.source.sourceRevision,
      outDirectory,
    };
    if (input.releaseId !== undefined)
      options = { ...options, releaseId: input.releaseId };
    if (input.packageStoreDirectory !== undefined)
      options = {
        ...options,
        packageStoreDirectory: input.packageStoreDirectory,
      };
    await packCapturedSource(
      options,
      createArtifactsSourceCapture({
        ...input.source,
        sourceRevision: parseSourceRevision(input.source.sourceRevision),
      }),
    );
    let installation: Parameters<typeof installRelease>[0] = {
      directory: outDirectory,
      url: input.url,
      key: input.key,
      installationId: input.installationId,
    };
    if (input.waitMs !== undefined)
      installation = { ...installation, waitMs: input.waitMs };
    if (input.signal !== undefined)
      installation = { ...installation, signal: input.signal };
    return await installRelease(installation);
  } finally {
    await rm(outDirectory, { recursive: true, force: true });
  }
}

/**
 * Upload a packed Release to an Oyster and install it. The host installs a
 * new installation (201) or switches an existing one to this Release (200),
 * keeping its state. Uploads precede admission; this helper then waits for the
 * correlated terminal owner receipt, not merely the HTTP acknowledgement.
 * Uploads and observation share the caller signal or explicit `waitMs`; absent
 * either, the installer owns a twenty-minute default. Expiry does not cancel
 * admitted work and is reported as an unconfirmed observation, not refusal.
 */
export async function installRelease(
  input: Readonly<{
    directory: string;
    url: string;
    /** The Oyster owner key. */
    key: string;
    installationId?: string;
    /** Report owner-correlated admission without shortening the completion wait. */
    onAdmitted?: (operation: InstallationOperation) => void;
  }> &
    InstallationObservationBudget,
): Promise<Response> {
  // One installer budget for uploads + observation, not an App authority grant.
  const signal = installationObservationSignal(input);
  signal.throwIfAborted();
  const directory = resolve(input.directory);
  const release = Schema.decodeUnknownSync(
    Schema.fromJsonString(releaseSchema),
  )(await readFile(join(directory, "release.json"), "utf8"));
  const authorization = { Authorization: `Bearer ${input.key}` };
  for (const file of await filesUnder(join(directory, "artifacts"))) {
    const bytes = new Uint8Array(await readFile(file));
    const artifactRef = `artifact:${relative(join(directory, "artifacts"), file)}`;
    const digest: Sha256Digest = parseSha256Digest(await sha256(bytes));
    const response = await fetch(
      new URL(
        `/api/artifacts/${encodeURIComponent(artifactRef)}?digest=${digest}`,
        input.url,
      ),
      { method: "PUT", headers: authorization, body: bytes, signal },
    );
    if (!response.ok)
      throw new Error(
        `Artifact upload failed (${String(response.status)}): ${artifactRef}`,
      );
  }
  let installation: Parameters<typeof installOnOyster>[0] = {
    url: input.url,
    key: input.key,
    release,
    installationId: input.installationId ?? release.appId.replaceAll("_", "-"),
    signal,
  };
  if (input.onAdmitted !== undefined)
    installation = { ...installation, onAdmitted: input.onAdmitted };
  const operation = await installOnOyster(installation);
  return completedInstallationResponse(operation);
}

/** Project one exact first-party commit's editable source, `git push` it to
 * an Oyster's own template for that App, and claim the pushed head, so
 * `APPS.fork` and Computer builds can later read it. The operator owner key
 * authenticates both; it reaches Git only through its config environment and
 * no provider credential ever leaves the Oyster. Answers the claim response:
 * `{ kind: "recorded" | "existing", receipt }` on success. */
export async function publishSource(
  input: Readonly<{
    appId: string;
    entry: string;
    repositoryPath: string;
    sourceRevision: string;
    recipe: PackOptions["recipe"];
    url: string;
    key: string;
  }>,
): Promise<Response> {
  const revision = parseSourceRevision(input.sourceRevision);
  const distribution = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* createLocalCommitSourceCapture(
          resolve(input.repositoryPath),
          revision,
        ).capture();
        return yield* createFirstPartyAppSourceDistribution({
          appId: input.appId,
          entry: input.entry,
          source,
        });
      }),
    ),
  );
  const app = encodeURIComponent(input.appId);
  const authorization = `Bearer ${input.key}`;
  const { seedRevision } = await pushTemplateSource({
    appId: input.appId,
    sourceRevision: revision,
    files: distribution.files,
    remote: new URL(`/api/apps/${app}/source.git`, input.url).href,
    headers: { Authorization: authorization },
  });
  const claim: TemplateSeedClaim = {
    appId: distribution.appId,
    sourceRevision: revision,
    sourceTreeDigest: distribution.sourceTreeDigest,
    seedRevision,
    // The template pins the same captured recipe its forks build with.
    recipe: normalizeAppPublisherRecipe({
      appId: input.appId,
      recipe: input.recipe,
    }).recipe,
  };
  return fetch(new URL(`/api/apps/${app}/source`, input.url), {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      Schema.encodeUnknownSync(templateSeedClaimSchema)(claim),
    ),
  });
}
