/* global Request, Response, URL */
import { DurableObject } from "cloudflare:workers";
import { checkBackendConstruction } from "../src/boot-construction.js";
import { guestLimits } from "../src/guest-policy.js";
import { release } from "./apps-fixture.js";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { instanceIds, instanceIdSchema } from "../src/instance-id.js";
import { createCloudflareAppTestCopies } from "../src/cloudflare.js";

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
  wake(at) {
    return Effect.tryPromise(() =>
      this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.getAlarm();
        if (current === null || at < current) await transaction.setAlarm(at);
      }),
    );
  }

  async alarm() {
    // Reconstruct the maintained adapter from native supervisor SQLite, not a
    // retained JS closure. Expiry must not need live source/artifact services.
    const copies = createCloudflareAppTestCopies(this.ctx, this.env.LOADER, {
      source: () =>
        Effect.fail(new Error("Alarm must not read source admission")),
      resolve: () => Effect.fail(new Error("Alarm must not resolve App code")),
      wake: (at) => this.wake(at),
    });
    await Effect.runPromise(copies.expire());
    const reopened = this.ctx.facets.get("test-copy", () => ({
      class: this.ctx.exports.RecoverySentinel,
    }));
    const copyValue = await reopened.read();
    this.ctx.facets.delete("test-copy");
    const live = this.ctx.facets.get("app", () => ({
      class: this.ctx.exports.RecoverySentinel,
    }));
    this.ctx.storage.sql.exec(
      "INSERT INTO native_alarm_result(copyValue,sourceValue) VALUES (?,?)",
      copyValue,
      await live.read(),
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.searchParams.get("alarm") === "status") {
      // Observation never calls inspect/expire, so lazy cleanup cannot fake
      // native alarm delivery. Only alarm() can publish this receipt.
      return Response.json(
        this.ctx.storage.sql
          .exec("SELECT copyValue,sourceValue FROM native_alarm_result")
          .toArray()[0] ?? null,
      );
    }
    if (url.pathname === "/concurrent") return await this.concurrent();
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
    const alarm = url.searchParams.get("alarm") === "start";
    if (url.searchParams.get("interactive") === "1" || alarm) {
      if (alarm)
        this.ctx.storage.sql.exec(
          "CREATE TABLE native_alarm_result(copyValue TEXT,sourceValue TEXT) STRICT",
        );
      const selection = {
        instanceId: Schema.decodeUnknownSync(instanceIdSchema)(
          this.ctx.id.name,
        ),
        owner: { kind: "installation", id: "notes" },
        appId: release.appId,
        releaseId: release.releaseId,
        authorityVersion: 1,
      };
      const authority = { selection, storeGeneration: "native-copy-store" };
      const artifact = {
        release,
        digest: release.artifact.artifactDigest,
        backend: {
          compatibilityDate: "2026-09-04",
          exportName: "NotesCopy",
          runtime: { kind: "durable-facet", stateSchema: 1 },
          code: `export class NotesCopy {
            constructor(ctx, env) { this.ctx = ctx; this.env = env; }
            async fetch(request) {
              if (request.method === "PUT") {
                this.ctx.storage.sql.exec("DELETE FROM sentinel");
                this.ctx.storage.sql.exec("INSERT INTO sentinel VALUES (?)", await request.text());
              }
              let outboundDenied = false;
              try { await fetch(${JSON.stringify(`${url.origin}/egress-probe`)}); }
              catch { outboundDenied = true; }
              return Response.json({
                value: this.ctx.storage.sql.exec("SELECT value FROM sentinel").toArray()[0]?.value ?? null,
                supervisorRows: this.ctx.storage.sql.exec("SELECT name FROM sqlite_schema WHERE name='supervisor_only'").toArray().length,
                bindings: Object.keys(this.env),
                outboundDenied
              });
            }
          }`,
        },
      };
      let currentLimits = guestLimits();
      const emittedBudgets = [];
      // Delegate to the real memoizing Loader, as the maintained guest-worker
      // fixture does. A tighter host budget must reach a new Worker config.
      const loader = {
        get: (id, configure) =>
          this.env.LOADER.get(id, () => {
            const code = configure();
            emittedBudgets.push(code.limits);
            return code;
          }),
      };
      const copies = createCloudflareAppTestCopies(this.ctx, loader, {
        limits: () => currentLimits,
        source: () =>
          Effect.succeed({
            instance: {
              ...selection,
              desiredStatus: "enabled",
              status: "active",
              stateSchema: 1,
            },
            storeGeneration: authority.storeGeneration,
          }),
        resolve: () => Effect.succeed({ ...artifact, api: null }),
        wake: (at) => (alarm ? this.wake(at) : Effect.void),
      });
      const opened = await Effect.runPromise(
        copies.open(authority, "interactive"),
      );
      if (alarm) {
        const copied = this.ctx.facets.get("test-copy", () => ({
          class: this.ctx.exports.RecoverySentinel,
        }));
        return Response.json({
          instanceId: selection.instanceId,
          expiresAt: opened.expiresAt,
          scheduledAt: await this.ctx.storage.getAlarm(),
          initial: await copied.read(),
        });
      }
      const initial = await Effect.runPromise(
        copies.fetch(
          authority,
          opened.copyId,
          new Request("https://app.internal/"),
        ),
      );
      currentLimits = guestLimits({ cpuMs: 250, subRequests: 10 });
      const changed = await Effect.runPromise(
        copies.fetch(
          authority,
          opened.copyId,
          new Request("https://app.internal/", { method: "PUT", body: "S2" }),
        ),
      );
      await Effect.runPromise(copies.discard(authority, opened.copyId));
      const afterDiscard = await Effect.runPromise(copies.inspect(authority));
      const reopened = this.ctx.facets.get("test-copy", () => ({
        class: this.ctx.exports.RecoverySentinel,
      }));
      const reopenedValue = await reopened.read();
      this.ctx.facets.delete("test-copy");
      return Response.json({
        initial: await initial.json(),
        changed: await changed.json(),
        source: await live.read(),
        afterDiscard,
        reopenedValue,
        emittedBudgets,
        supervisor: this.ctx.storage.sql
          .exec("SELECT value FROM supervisor_only")
          .toArray(),
      });
    }
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

// Staging 2026-11-09: two Teams provisioning at once sent overlapping boot
// probes to one host DO; each deleted the other's disposable facet ("Facet was
// deleted.") and both Teams lost their default Apps.
RecoverySupervisor.prototype.concurrent = async function concurrent() {
  const code = `export class SlowProbe {
    constructor(ctx) {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS boot(x)");
      ctx.blockConcurrencyWhile(() => new Promise((resolve) => setTimeout(resolve, 200)));
    }
  }`;
  const failures = await Promise.all(
    [0, 1, 2].map(async () => {
      try {
        await checkBackendConstruction(
          this.ctx,
          this.env.LOADER,
          {
            release,
            digest: release.artifact.artifactDigest,
            backend: {
              compatibilityDate: "2026-09-04",
              exportName: "SlowProbe",
              runtime: { kind: "durable-facet", stateSchema: 1 },
              code,
            },
          },
          guestLimits(),
          null,
        );
        return null;
      } catch (cause) {
        return cause.code ?? "unexpected";
      }
    }),
  );
  return Response.json({ failures });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // An ordinary caller proves this target is reachable before the candidate
    // attempts it. A failing DNS lookup is not an outbound-denial proof.
    if (url.pathname === "/egress-probe") return new Response("reachable");
    let name = url.search;
    if (
      url.searchParams.get("interactive") === "1" ||
      url.searchParams.get("alarm") === "start"
    )
      name = instanceIds.instance.generate();
    const requestedInstance = url.searchParams.get("instance");
    if (requestedInstance !== null)
      name = Schema.decodeUnknownSync(instanceIdSchema)(requestedInstance);
    const supervisor = env.SUPERVISORS.get(env.SUPERVISORS.idFromName(name));
    return await supervisor.fetch(request);
  },
};
