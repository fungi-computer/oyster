import { DurableObject } from "cloudflare:workers";
import { appBackend, type BackgroundContext } from "./methods.js";
class BackgroundFacet extends DurableObject<BackgroundContext["env"]> {
  readonly sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: BackgroundContext["env"]) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }
}
export const BackgroundProof = appBackend.implement(BackgroundFacet);
