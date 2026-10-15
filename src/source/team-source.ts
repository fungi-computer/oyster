import { parseAppId } from "@fungi.computer/puffball";
import type { TeamAppPublisherRegistry } from "@fungi.computer/puffball/publisher";
import { digestPinnedRecipe } from "../build-contract.js";
import { templateRepositoryForApp } from "./template-repository.js";
import type { PublisherTemplateSeedReceipt } from "./seed-receipt.js";

export class TeamAppSourceError extends Error {
  constructor(readonly code: "denied" | "unavailable") {
    super(`Team App source ${code}`);
    this.name = "TeamAppSourceError";
  }
}

export async function readTeamAppSeedProvenance(options: {
  appId: string;
  teamId: string;
  registry: TeamAppPublisherRegistry;
  readSeedReceipt(
    appId: PublisherTemplateSeedReceipt["appId"],
    seedRevision: PublisherTemplateSeedReceipt["seedRevision"],
  ): Promise<PublisherTemplateSeedReceipt | null>;
}): Promise<
  Readonly<{
    appId: string;
    repository: string;
    templateSeed: Readonly<{ appId: string; revision: string }>;
    recipe: PublisherTemplateSeedReceipt["recipe"];
    buildRecipeDigest: PublisherTemplateSeedReceipt["buildRecipeDigest"];
  }>
> {
  const appId = parseAppId(options.appId);
  const authorization = await options.registry.authorize(appId, options.teamId);
  if (authorization.kind !== "authorized")
    throw new TeamAppSourceError("denied");
  const registration = authorization.registration;
  const templateSeed = registration.templateSeed;
  if (
    registration.source.provider !== "artifacts" ||
    templateSeed === undefined
  )
    throw new TeamAppSourceError("unavailable");
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
    appId,
    repository: registration.source.repository,
    templateSeed,
    recipe: receipt.recipe,
    buildRecipeDigest: receipt.buildRecipeDigest,
  });
}

/** A fork keeps the seed's exact builder; private UI assets use Vite's relative base. */
export function privateTeamBuildSource(
  source: Awaited<ReturnType<typeof readTeamAppSeedProvenance>>,
) {
  if (source.recipe.format !== "assets") return source;
  const recipe = { ...source.recipe, assetBase: "./" };
  return { ...source, recipe, buildRecipeDigest: digestPinnedRecipe(recipe) };
}
