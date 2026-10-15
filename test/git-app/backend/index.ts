import {
  gitPushQuestionSchema,
  type AppGitPushFact,
  type GitPushQuestion,
  type GitPushVerdict,
} from "@fungi.computer/agar/git";
import { DurableObject } from "cloudflare:workers";
import { appBackend } from "./methods.js";

/** Members may push; every other writer is refused with Git's own `ng` report. */
class GitProofFacet extends DurableObject {
  readonly sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Record<never, never>) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS pushes (event_id TEXT PRIMARY KEY, fact TEXT NOT NULL) STRICT",
    );
  }
  authorizeGitPush(raw: GitPushQuestion): Promise<GitPushVerdict> {
    const question = gitPushQuestionSchema.parse(raw);
    return Promise.resolve(
      question.writer.actor.kind === "member"
        ? { allowed: true }
        : {
            allowed: false,
            refused: question.updates.map(({ ref }) => ({
              ref,
              message: "only members push here",
            })),
          },
    );
  }
  onGitPush(fact: AppGitPushFact): Promise<void> {
    this.sql.exec(
      "INSERT OR IGNORE INTO pushes(event_id,fact) VALUES(?,?)",
      fact.eventId,
      JSON.stringify({
        eventId: fact.eventId,
        repository: fact.repository,
        refs: fact.updates.map(({ ref }) => ref),
      }),
    );
    return Promise.resolve();
  }
}
export const GitProof = appBackend.implement(GitProofFacet);
