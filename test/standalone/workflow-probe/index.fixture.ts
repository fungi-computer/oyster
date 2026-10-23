import { DurableObject } from "cloudflare:workers";
import { appBackend } from "./methods.js";
import type { ProbeEnv } from "./methods.js";
class ProbeFacet extends DurableObject<ProbeEnv> {
  declare public ctx: DurableObjectState<Record<never, never>>;
  declare public readonly env: ProbeEnv;
  constructor(ctx: DurableObjectState, env: ProbeEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS probe(id TEXT PRIMARY KEY,calls INTEGER NOT NULL,keys TEXT NOT NULL) STRICT",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS stamps(id TEXT PRIMARY KEY,at TEXT NOT NULL,caller TEXT NOT NULL) STRICT",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS saves(id TEXT PRIMARY KEY,outside INTEGER,saved INTEGER) STRICT",
    );
  }
}
export const WorkflowProbe = appBackend.implement(ProbeFacet);
