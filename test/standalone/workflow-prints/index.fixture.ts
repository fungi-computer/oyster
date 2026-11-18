import { DurableObject } from "cloudflare:workers";
import { appBackend } from "./methods.js";
class PrintsFacet extends DurableObject {
  declare public ctx: DurableObjectState<Record<never, never>>;
  constructor(ctx: DurableObjectState, env: Record<never, never>) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS prints(id TEXT PRIMARY KEY,prompt TEXT NOT NULL) STRICT",
    );
  }
}
export const FakePrints = appBackend.implement(PrintsFacet);
