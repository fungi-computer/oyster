import { parseAppId, parseSourceRevision } from "@fungi.computer/puffball";
import type {
  TeamAppPublisherRegistration,
  TeamAppPublisherRegistry,
} from "@fungi.computer/puffball/publisher";
import { digestPinnedRecipe } from "../build-contract.js";
import { templateRepositoryForApp } from "./template-repository.js";
import type { PublisherTemplateSeedReceipt } from "./seed-receipt.js";

export class TeamAppSourceError extends Error {
  constructor(readonly code: "denied" | "unavailable") {
    super(`Team App source ${code}`);
    this.name = "TeamAppSourceError";
  }
}

/** What a Team build runs: the App's source repository and the seed receipt
 * whose recipe builds it. */
export type TeamAppSeedProvenance = Readonly<{
  appId: string;
  repository: string;
  templateSeed: Readonly<{ appId: string; revision: string }>;
  recipe: PublisherTemplateSeedReceipt["recipe"];
  buildRecipeDigest: PublisherTemplateSeedReceipt["buildRecipeDigest"];
}>;

/**
 * A first-party template App builds its own template, so each seeded commit
 * carries its own recipe. A fork builds its own repository with the recipe of
 * the seed it was forked from.
 */
function seedKind(
  registration: TeamAppPublisherRegistration,
  templateSeed: NonNullable<TeamAppPublisherRegistration["templateSeed"]>,
): "template" | "fork" {
  return templateSeed.appId === registration.appId &&
    registration.source.repository ===
      templateRepositoryForApp(registration.appId)
    ? "template"
    : "fork";
}

/**
 * Read the source revision a Team build runs and the seed receipt that builds
 * it. A template App uses the receipt of the exact commit it builds, failing
 * closed when that commit was never seeded; a fork uses its pinned seed.
 */
export async function readTeamAppSeedProvenance(options: {
  appId: string;
  teamId: string;
  registry: TeamAppPublisherRegistry;
  readSeedReceipt(
    appId: PublisherTemplateSeedReceipt["appId"],
    seedRevision: PublisherTemplateSeedReceipt["seedRevision"],
  ): Promise<PublisherTemplateSeedReceipt | null>;
  readDefaultBranchHead(repository: string): Promise<string | null>;
}): Promise<
  Readonly<{
    source: TeamAppSeedProvenance;
    sourceRevision: PublisherTemplateSeedReceipt["seedRevision"];
  }>
> {
  const appId = parseAppId(options.appId);
  const authorization = await options.registry.authorize(appId, options.teamId);
  if (authorization.kind !== "authorized")
    throw new TeamAppSourceError("denied");
  const registration = authorization.registration;
  const pinned = registration.templateSeed;
  if (registration.source.provider !== "artifacts" || pinned === undefined)
    throw new TeamAppSourceError("unavailable");
  const head = await options.readDefaultBranchHead(
    registration.source.repository,
  );
  if (head === null) throw new TeamAppSourceError("unavailable");
  const sourceRevision = parseSourceRevision(`git:${head}`);
  const templateSeed = {
    appId: pinned.appId,
    revision:
      seedKind(registration, pinned) === "template"
        ? sourceRevision
        : pinned.revision,
  };
  const receipt = await options.readSeedReceipt(
    parseAppId(templateSeed.appId),
    templateSeed.revision,
  );
  if (
    receipt?.appId !== templateSeed.appId ||
    receipt.seedRevision !== templateSeed.revision ||
    receipt.repository !== templateRepositoryForApp(templateSeed.appId) ||
    digestPinnedRecipe(receipt.recipe) !== receipt.buildRecipeDigest
  )
    throw new TeamAppSourceError("unavailable");
  return Object.freeze({
    source: Object.freeze({
      appId,
      repository: registration.source.repository,
      templateSeed: Object.freeze(templateSeed),
      recipe: receipt.recipe,
      buildRecipeDigest: receipt.buildRecipeDigest,
    }),
    sourceRevision,
  });
}

/** A Team build keeps the seed's exact builder; private UI assets use Vite's relative base. */
export function privateTeamBuildSource(source: TeamAppSeedProvenance) {
  if (source.recipe.format !== "assets") return source;
  const recipe = { ...source.recipe, assetBase: "./" };
  return { ...source, recipe, buildRecipeDigest: digestPinnedRecipe(recipe) };
}
