import * as Schema from "effect/Schema";
import type { AppApi, AppDeclaration } from "@fungi.computer/puffball/app";
import type { Installation, DeclaredOperations } from "./installation.js";

/**
 * One App-tool access level, with its own freshness pin. An Agent's comes
 * from the owner's stored direct approval; a key's is computed fresh from
 * its own Ear Tag grants (`keyAppAccess`), never stored as this shape --
 * only read through it, for one call or one installation at a time.
 */
export const appToolPolicySchema = Schema.Struct({
  level: Schema.Literals(["read", "write"]),
  revision: Schema.NonEmptyString,
  grantedBy: Schema.NonEmptyString,
});
/** The authenticated attaching member is recorded when this policy is approved. */
export type AppToolPolicy = typeof appToolPolicySchema.Type;
/** One installation's binding under the captured host approval. */
export const appToolAccessSchema = Schema.Struct({
  ...appToolPolicySchema.fields,
  bindingName: Schema.NonEmptyString,
});
/** One installation binding constrained by an authenticated tool-policy approval. */
export type AppToolAccess = typeof appToolAccessSchema.Type;
/** Pre-read entries: the catalog never resolves installations or calls back into a host. */
export type AppToolEntry = Readonly<{
  installation: Installation;
  declaration: AppDeclaration;
  declaredOperations: DeclaredOperations;
  api: AppApi | null;
  access: AppToolAccess | null;
}>;
