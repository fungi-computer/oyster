/** App source seed receipts, seed claims and the fork algorithm, owned
 * generically here; the Publisher supplies D1 adapters and the retained Git
 * admission transport. The operator's Node-only template push (it runs the
 * `git` executable) is deliberately not re-exported here, so Worker bundles
 * never import it: use `@fungi.computer/oyster/source/template-push`. */
export { templateRepositoryForApp } from "./template-repository.js";
export {
  seedReceiptInputSchema,
  sameReceipt,
  type PublisherTemplateSeedReceipt,
  type PublisherTemplateSeedReceipts,
} from "./seed-receipt.js";
export {
  readTeamAppSeedProvenance,
  privateTeamBuildSource,
  TeamAppSourceError,
} from "./team-source.js";
export {
  parseTemplateSeedClaim,
  recordTemplateSeed,
  templateSeedClaimSchema,
  TEMPLATE_SEED_CLAIM_MAX_BYTES,
  type TemplateSeedClaim,
} from "./template-seed.js";
export { forkAppSource, type AppSourceForkResult } from "./fork.js";
