import {
  appIdSchema,
  sha256DigestSchema,
  sourceRevisionSchema,
} from "@fungi.computer/puffball/effect";
import * as Schema from "effect/Schema";
import {
  capturedPinnedRecipeSchema,
  type PinnedRecipe,
} from "../build-contract.js";

export const seedReceiptInputSchema = Schema.Struct({
  appId: appIdSchema,
  sourceRevision: sourceRevisionSchema,
  sourceTreeDigest: sha256DigestSchema,
  seedRevision: sourceRevisionSchema,
  recipe: capturedPinnedRecipeSchema,
  buildRecipeDigest: sha256DigestSchema,
});

export type PublisherTemplateSeedReceipt = Readonly<{
  appId: Schema.Schema.Type<typeof appIdSchema>;
  repository: string;
  sourceRevision: Schema.Schema.Type<typeof sourceRevisionSchema>;
  sourceTreeDigest: Schema.Schema.Type<typeof sha256DigestSchema>;
  seedRevision: Schema.Schema.Type<typeof sourceRevisionSchema>;
  recipe: PinnedRecipe;
  buildRecipeDigest: Schema.Schema.Type<typeof sha256DigestSchema>;
}>;

/** Append-only proof that an exact projected template was seeded, keyed by
 * the template's repository and recorded seed revision. The Publisher's D1
 * adapter is the only durable implementation; this is the port it fulfills. */
export type PublisherTemplateSeedReceipts = Readonly<{
  read(
    appId: PublisherTemplateSeedReceipt["appId"],
    seedRevision: PublisherTemplateSeedReceipt["seedRevision"],
  ): Promise<PublisherTemplateSeedReceipt | null>;
  record(
    input: Schema.Schema.Type<typeof seedReceiptInputSchema>,
  ): Promise<PublisherTemplateSeedReceipt>;
}>;

export const sameReceipt = (
  left: PublisherTemplateSeedReceipt,
  right: PublisherTemplateSeedReceipt,
) =>
  left.appId === right.appId &&
  left.repository === right.repository &&
  left.sourceRevision === right.sourceRevision &&
  left.sourceTreeDigest === right.sourceTreeDigest &&
  left.seedRevision === right.seedRevision &&
  JSON.stringify(left.recipe) === JSON.stringify(right.recipe) &&
  left.buildRecipeDigest === right.buildRecipeDigest;
