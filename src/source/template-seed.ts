import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Artifacts } from "@fungi.computer/burrow";
import { parseAppId } from "@fungi.computer/puffball";
import {
  appIdSchema,
  sha256DigestSchema,
  sourceRevisionSchema,
} from "@fungi.computer/puffball/effect";
import {
  capturedPinnedRecipeSchema,
  digestPinnedRecipe,
} from "../build-contract.js";
import { templateRepositoryForApp } from "./template-repository.js";
import type { PublisherTemplateSeedReceipts } from "./seed-receipt.js";

/** A seed claim is a few fields and one pinned recipe; the source itself
 * arrived by `git push`. */
export const TEMPLATE_SEED_CLAIM_MAX_BYTES = 64 * 1024;

/** The operator's claim after pushing a projected source commit to the App's
 * template: that `seedRevision` is that commit, projected from
 * `sourceRevision`, and builds with `recipe`. */
export const templateSeedClaimSchema = Schema.Struct({
  appId: appIdSchema,
  sourceRevision: sourceRevisionSchema,
  sourceTreeDigest: sha256DigestSchema,
  seedRevision: sourceRevisionSchema,
  recipe: capturedPinnedRecipeSchema,
});
export type TemplateSeedClaim = Schema.Schema.Type<
  typeof templateSeedClaimSchema
>;

/** Decode one claim body at its I/O boundary, strictly; null when it is not
 * exactly a seed claim. */
export function parseTemplateSeedClaim(body: string): TemplateSeedClaim | null {
  const decoded = Schema.decodeUnknownOption(
    Schema.fromJsonString(templateSeedClaimSchema),
    { onExcessProperty: "error" },
  )(body);
  return Option.isSome(decoded) ? decoded.value : null;
}

function logEvent(operation: string, cause: unknown): void {
  console.error(
    JSON.stringify({
      source: "app-source",
      operation,
      failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
    }),
  );
}

/**
 * Record the seed receipt for a template the operator already pushed. The
 * template's current `main` must be exactly the claimed seed commit, whose
 * hash pins its tree and history; the recipe digest is computed here; an
 * existing receipt for that commit must carry the same provenance.
 */
export async function recordTemplateSeed(
  receipts: PublisherTemplateSeedReceipts,
  artifacts: Pick<Artifacts, "readDefaultBranchHead">,
  rawAppId: string,
  claim: TemplateSeedClaim,
) {
  try {
    const appId = parseAppId(rawAppId);
    if (claim.appId !== appId) return { kind: "conflict" } as const;
    const repository = templateRepositoryForApp(appId);
    const head = await artifacts.readDefaultBranchHead(repository);
    if (head === null || `git:${head}` !== claim.seedRevision)
      return { kind: "conflict" } as const;
    const receipt = {
      appId,
      sourceRevision: claim.sourceRevision,
      sourceTreeDigest: claim.sourceTreeDigest,
      seedRevision: claim.seedRevision,
      recipe: claim.recipe,
      buildRecipeDigest: digestPinnedRecipe(claim.recipe),
    };
    const existing = await receipts.read(appId, claim.seedRevision);
    if (
      existing !== null &&
      (existing.sourceRevision !== receipt.sourceRevision ||
        existing.sourceTreeDigest !== receipt.sourceTreeDigest ||
        existing.buildRecipeDigest !== receipt.buildRecipeDigest)
    )
      return { kind: "conflict" } as const;
    // The write-once, digest-checked receipt owner records it.
    await receipts.record(receipt);
    return {
      kind: existing === null ? "recorded" : "existing",
      receipt: {
        appId,
        repository,
        sourceRevision: receipt.sourceRevision,
        sourceTreeDigest: receipt.sourceTreeDigest,
        seedRevision: receipt.seedRevision,
        buildRecipeDigest: receipt.buildRecipeDigest,
      },
    } as const;
  } catch (cause) {
    logEvent("operator.template.record", cause);
    return { kind: "unavailable" } as const;
  }
}
