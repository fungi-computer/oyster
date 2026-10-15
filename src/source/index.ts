/** App source seed receipts and the fork algorithm, owned generically here;
 * the Publisher supplies D1 adapters and the retained Git admission
 * transport. The Node-only template writer (`memfs` + `isomorphic-git`) is
 * deliberately not re-exported here: it would drag that dependency into
 * every Worker bundle that only needs the fork/provenance reads below (team
 * rail's RPC surface has no use for it). Import it from
 * `@fungi.computer/oyster/source/template-write` instead. */
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
export { forkAppSource, type AppSourceForkResult } from "./fork.js";
