import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  parseAppId,
  parseSha256Digest,
  parseSourceRevision,
  type AppId,
} from "@fungi.computer/puffball";
import type { Artifacts, ArtifactsForkResult } from "@fungi.computer/burrow";
import { normalizeAppPublisherRecipe } from "@fungi.computer/oyster/build-contract";
import {
  forkAppSource,
  parseTemplateSeedClaim,
  recordTemplateSeed,
  type TemplateSeedClaim,
  templateRepositoryForApp,
} from "@fungi.computer/oyster/source";
import {
  ensureAppSourceTables,
  createOysterAppSourceReceipts,
  createOysterAppRegistrations,
  createOysterArtifactsRepositoryMetadataStore,
} from "../src/app-sources.js";

const platformAppId: AppId = parseAppId("app_shedproof");
const teamId = "team_orchid";
const seedHead = "a".repeat(40);

/** An in-memory stand-in for the Artifacts provider, exercising exactly the
 * fork surface `forkAppSource` depends on: a named repository either exists
 * with a recorded main head, or it does not. */
function fakeArtifacts(): Pick<
  Artifacts,
  "recoverForkRepository" | "readDefaultBranchHead" | "forkRepository"
> & { seed(name: string, mainHead: string): void } {
  const repos = new Map<string, string>();
  const info = (name: string, mainHead: string): ArtifactsForkResult => ({
    repository: { id: name, name, defaultBranch: "main" },
    mainHead,
    disposition: repos.has(name) ? "existing" : "created",
  });
  return {
    seed(name, mainHead) {
      repos.set(name, mainHead);
    },
    readDefaultBranchHead(name: string): Promise<string | null> {
      return Promise.resolve(repos.get(name) ?? null);
    },
    recoverForkRepository({
      repository,
    }: {
      template: string;
      repository: string;
    }): Promise<ArtifactsForkResult | null> {
      const mainHead = repos.get(repository);
      return Promise.resolve(
        mainHead === undefined ? null : info(repository, mainHead),
      );
    },
    forkRepository({
      repository,
      expectedMainHead,
    }: {
      template: string;
      repository: string;
      expectedMainHead: string;
    }): Promise<ArtifactsForkResult> {
      const existing = repos.get(repository);
      if (existing !== undefined)
        return Promise.resolve(info(repository, existing));
      repos.set(repository, expectedMainHead);
      return Promise.resolve(info(repository, expectedMainHead));
    },
  };
}

/** A fresh registry/receipts/artifacts fixture with the platform App already
 * published and self-registered, as `StandaloneRegistry.publishSource` does. */
function fixture() {
  const database = new DatabaseSync(":memory:");
  const sql = fromNodeSqlite(database).sql;
  ensureAppSourceTables(sql);
  const receipts = createOysterAppSourceReceipts(sql);
  const registry = createOysterAppRegistrations(sql);
  const artifacts = fakeArtifacts();
  artifacts.seed(templateRepositoryForApp(platformAppId), seedHead);
  return { database, receipts, registry, artifacts };
}

async function seedPlatform(fixtures: ReturnType<typeof fixture>) {
  const { recipe, buildRecipeDigest } = normalizeAppPublisherRecipe({
    appId: platformAppId,
    recipe: {
      entry: "apps/shed/index.html",
      backend: null,
      maxOutputBytes: 100_000,
    },
  });
  await fixtures.receipts.record({
    appId: platformAppId,
    sourceRevision: parseSourceRevision(`git:${"0".repeat(40)}`),
    sourceTreeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
    seedRevision: parseSourceRevision(`git:${seedHead}`),
    recipe,
    buildRecipeDigest,
  });
  const registered = await fixtures.registry.register({
    appId: platformAppId,
    teamId,
    source: {
      provider: "artifacts",
      repository: templateRepositoryForApp(platformAppId),
      branch: "main",
    },
  });
  expect(registered.kind).toBe("created");
}

it("registers a fork as its own App bound to its own repository", async () => {
  const fixtures = fixture();
  try {
    await seedPlatform(fixtures);
    const forkAppId = parseAppId("app_forkone");
    const result = await forkAppSource(
      { teamId, platformAppId, appId: forkAppId, repository: "bonsai--my-app" },
      fixtures,
    );
    // The host names the destination repository; the App id stays the fork's own.
    expect(result).toMatchObject({
      kind: "forked",
      appId: forkAppId,
      repository: "bonsai--my-app",
    });
    const registration = await fixtures.registry.read(forkAppId);
    expect(registration).toMatchObject({
      kind: "found",
      registration: {
        appId: forkAppId,
        teamId,
        source: { provider: "artifacts", repository: "bonsai--my-app" },
        templateSeed: { appId: platformAppId },
      },
    });
  } finally {
    fixtures.database.close();
  }
});

it("a second fork of the same App is idempotent on the recorded receipt", async () => {
  const fixtures = fixture();
  try {
    await seedPlatform(fixtures);
    const forkAppId = parseAppId("app_forktwo");
    const input = {
      teamId,
      platformAppId,
      appId: forkAppId,
      repository: forkAppId,
    };
    const first = await forkAppSource(input, fixtures);
    const second = await forkAppSource(input, fixtures);
    expect(first).toMatchObject({ kind: "forked", appId: forkAppId });
    expect(second).toMatchObject({ kind: "forked", appId: forkAppId });
  } finally {
    fixtures.database.close();
  }
});

it("refuses a fork name already claimed by an unrelated repository, typed", async () => {
  const fixtures = fixture();
  try {
    await seedPlatform(fixtures);
    const forkAppId = parseAppId("app_forkthree");
    // An unrelated repository already occupies this exact fork name, with a
    // main head that was never seeded from this platform App.
    fixtures.artifacts.seed(forkAppId, "f".repeat(40));
    const result = await forkAppSource(
      { teamId, platformAppId, appId: forkAppId, repository: forkAppId },
      fixtures,
    );
    expect(result).toEqual({ kind: "conflict" });
    expect(await fixtures.registry.read(forkAppId)).toEqual({
      kind: "absent",
    });
  } finally {
    fixtures.database.close();
  }
});

it("refuses a fork for a platform App that was never published", async () => {
  const fixtures = fixture();
  try {
    const forkAppId = parseAppId("app_forkfour");
    const result = await forkAppSource(
      {
        teamId,
        platformAppId: parseAppId("app_unknown"),
        appId: forkAppId,
        repository: forkAppId,
      },
      fixtures,
    );
    expect(result).toEqual({ kind: "unauthorized" });
  } finally {
    fixtures.database.close();
  }
});

function seedClaim(
  overrides: Partial<TemplateSeedClaim> = {},
): TemplateSeedClaim {
  return {
    appId: platformAppId,
    sourceRevision: parseSourceRevision(`git:${"0".repeat(40)}`),
    sourceTreeDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`),
    seedRevision: parseSourceRevision(`git:${seedHead}`),
    recipe: normalizeAppPublisherRecipe({
      appId: platformAppId,
      recipe: {
        entry: "apps/shed/index.html",
        backend: null,
        maxOutputBytes: 100_000,
      },
    }).recipe,
    ...overrides,
  };
}

it("parses a seed claim body strictly at its boundary", () => {
  const claim = seedClaim();
  expect(parseTemplateSeedClaim(JSON.stringify(claim))).toEqual(claim);
  for (const malformed of [
    { ...claim, buildRecipeDigest: `sha256:${"d".repeat(64)}` },
    { ...claim, seedRevision: "main" },
    { ...claim, files: [] },
    null,
  ])
    expect(parseTemplateSeedClaim(JSON.stringify(malformed))).toBeNull();
  expect(parseTemplateSeedClaim("{")).toBeNull();
});

it("records a pushed seed only when the template's main is that commit", async () => {
  const fixtures = fixture();
  try {
    const { receipts, artifacts } = fixtures;
    const recorded = await recordTemplateSeed(
      receipts,
      artifacts,
      platformAppId,
      seedClaim(),
    );
    expect(recorded).toMatchObject({
      kind: "recorded",
      receipt: {
        appId: platformAppId,
        repository: templateRepositoryForApp(platformAppId),
        seedRevision: `git:${seedHead}`,
      },
    });
    // The recipe digest is the Oyster's own, never the claim's.
    const stored = await receipts.read(
      platformAppId,
      parseSourceRevision(`git:${seedHead}`),
    );
    expect(stored?.buildRecipeDigest).toBe(
      recorded.kind === "recorded" ? recorded.receipt.buildRecipeDigest : null,
    );
    expect(
      await recordTemplateSeed(receipts, artifacts, platformAppId, seedClaim()),
    ).toMatchObject({ kind: "existing" });
    // Another provenance for the same seed commit is a conflict, write-once.
    expect(
      await recordTemplateSeed(
        receipts,
        artifacts,
        platformAppId,
        seedClaim({
          sourceRevision: parseSourceRevision(`git:${"9".repeat(40)}`),
        }),
      ),
    ).toEqual({ kind: "conflict" });
    // A claim for any commit but the current head is refused.
    expect(
      await recordTemplateSeed(
        receipts,
        artifacts,
        platformAppId,
        seedClaim({
          seedRevision: parseSourceRevision(`git:${"b".repeat(40)}`),
        }),
      ),
    ).toEqual({ kind: "conflict" });
    // The claim names the routed App, exactly.
    expect(
      await recordTemplateSeed(receipts, artifacts, "app_other", seedClaim()),
    ).toEqual({ kind: "conflict" });
  } finally {
    fixtures.database.close();
  }
});

it("refuses a seed claim for a template with no main head", async () => {
  const fixtures = fixture();
  try {
    const unseeded = parseAppId("app_unseeded");
    expect(
      await recordTemplateSeed(
        fixtures.receipts,
        fixtures.artifacts,
        unseeded,
        seedClaim({ appId: unseeded }),
      ),
    ).toEqual({ kind: "conflict" });
  } finally {
    fixtures.database.close();
  }
});

it("activates a pending repository record and keeps recovery facts on mismatch", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const sql = fromNodeSqlite(database).sql;
    ensureAppSourceTables(sql);
    const store = createOysterArtifactsRepositoryMetadataStore(sql);
    const metadata = {
      id: "repo-template",
      name: "template-shedproof",
      defaultBranch: "main",
      remote:
        "https://account.artifacts.cloudflare.net/git/templates/template-shedproof.git",
      parentRepository: null,
    } as const;
    await store.recordPending(metadata, "initial-token");
    // Public reads hide a repository until its initial token is retired.
    expect(await store.read(metadata.name)).toBeNull();
    await expect(store.activate(metadata, "other-token")).rejects.toThrow();
    await expect(
      store.activate({ ...metadata, id: "repo-other" }, "initial-token"),
    ).rejects.toThrow();
    expect(await store.readPending(metadata.name)).toEqual({
      metadata,
      initialToken: "initial-token",
    });
    expect(await store.read(metadata.name)).toBeNull();
    await store.activate(metadata, "initial-token");
    expect(await store.readPending(metadata.name)).toBeNull();
    expect(await store.read(metadata.name)).toEqual(metadata);
    // A replayed activation of the recorded repository is idempotent.
    await store.activate(metadata, "initial-token");
    expect(await store.read(metadata.name)).toEqual(metadata);
  } finally {
    database.close();
  }
});
