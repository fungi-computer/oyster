/* global Response, URL */
import { DurableObject } from "cloudflare:workers";
import { checkBackendConstruction } from "../src/boot-construction.js";
import { guestLimits } from "../src/guest-policy.js";
import { release } from "./apps-fixture.js";

export class RecoverySentinel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS sentinel(value TEXT)");
  }

  seed() {
    this.ctx.storage.sql.exec("DELETE FROM sentinel");
    this.ctx.storage.sql.exec("INSERT INTO sentinel VALUES ('S1')");
  }

  read() {
    return (
      this.ctx.storage.sql.exec("SELECT value FROM sentinel").toArray()[0]
        ?.value ?? null
    );
  }
}

export class RecoverySupervisor extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const fail = url.searchParams.get("fail") === "1";
    const syncFailure = url.searchParams.get("sync") === "1";
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS supervisor_only(value TEXT)",
    );
    this.ctx.storage.sql.exec("DELETE FROM supervisor_only");
    this.ctx.storage.sql.exec(
      "INSERT INTO supervisor_only VALUES ('selected')",
    );
    const live = this.ctx.facets.get("app", () => ({
      class: this.ctx.exports.RecoverySentinel,
    }));
    await live.seed();
    const code = `export class CopyProbe {
      constructor(ctx, env) {
        const row = ctx.storage.sql.exec("SELECT value FROM sentinel").toArray()[0];
        if (row?.value !== "S1") throw new Error("Copy did not seed App data");
        if (ctx.storage.sql.exec("SELECT name FROM sqlite_schema WHERE name='supervisor_only'").toArray().length)
          throw new Error("Supervisor storage crossed the copy boundary");
        ctx.storage.sql.exec("DELETE FROM sentinel");
        ctx.storage.sql.exec("INSERT INTO sentinel VALUES ('S2')");
        for (const operation of ["read", "write", "reset"]) {
          let denied = false;
          try { env.APP_STORAGE[operation](); } catch { denied = true; }
          if (!denied) throw new Error("A live storage binding reached the candidate");
        }
        if (${JSON.stringify(syncFailure)}) throw new Error("Deliberate synchronous candidate failure");
        ctx.blockConcurrencyWhile(async () => {
          let denied = false;
          try {
            await fetch(${JSON.stringify(`${url.origin}/egress-probe`)});
          } catch { denied = true; }
          if (!denied) throw new Error("Candidate outbound access was admitted");
          if (${JSON.stringify(fail)}) throw new Error("Deliberate candidate failure");
        });
      }
    }`;
    let failure = null;
    try {
      await checkBackendConstruction(
        this.ctx,
        this.env.LOADER,
        {
          release,
          digest: release.artifact.artifactDigest,
          backend: {
            compatibilityDate: "2026-09-04",
            exportName: "CopyProbe",
            runtime: { kind: "durable-facet", stateSchema: 1 },
            code,
          },
        },
        guestLimits(),
        1,
      );
    } catch (cause) {
      // A diagnostic code only; the Node caller asserts the expected outcome.
      failure = cause.code ?? "unexpected";
    }
    const liveAfter = await live.read();
    // Native get-after-delete must open empty storage, not the copied S2.
    // This does not claim physical file/replicated-stream deletion.
    const reopened = this.ctx.facets.get("candidate", () => ({
      class: this.ctx.exports.RecoverySentinel,
    }));
    const candidateAfterCleanup = await reopened.read();
    this.ctx.facets.delete("candidate");
    return Response.json({
      requestedFail: fail,
      requestedSyncFailure: syncFailure,
      failure,
      liveAfter,
      candidateAfterCleanup,
      supervisor: this.ctx.storage.sql
        .exec("SELECT value FROM supervisor_only")
        .toArray(),
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // An ordinary caller proves this target is reachable before the candidate
    // attempts it. A failing DNS lookup is not an outbound-denial proof.
    if (url.pathname === "/egress-probe") return new Response("reachable");
    const supervisor = env.SUPERVISORS.get(
      env.SUPERVISORS.idFromName(url.search),
    );
    return await supervisor.fetch(request);
  },
};
