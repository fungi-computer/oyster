import { DurableObject } from "cloudflare:workers";
import { backend } from "./gill-app.fixture.js";
type GillEnv = Record<string, never>;
class GillFacet extends DurableObject<GillEnv> {
  readonly rows: SqlStorage;
  constructor(ctx: DurableObjectState, env: GillEnv) {
    super(ctx, env);
    this.rows = ctx.storage.sql;
    this.rows.exec(
      "CREATE TABLE IF NOT EXISTS saved_rows (title TEXT PRIMARY KEY)",
    );
    this.rows.exec(
      "INSERT OR IGNORE INTO saved_rows VALUES ('Saved App data')",
    );
  }
}
export const SavedRows = backend.implement(GillFacet);
