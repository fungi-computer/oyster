/* global URL, Response */
import { OysterRegistry } from "../dist/workers.js";
import {
  ApprovalLedger,
  ApprovalRecordSchema,
} from "@fungi.computer/approvals";
import * as Schema from "effect/Schema";

const pin = { tenantId: "default", origin: "https://oyster.test" };
const actor = { kind: "member", memberId: "owner" };
const decodeStored = Schema.decodeUnknownSync(
  Schema.fromJsonString(ApprovalRecordSchema),
);

/** Native admission/expiry proof only; no App dispatch or Session delivery stand-in. */
export class NativeApprovalRegistry extends OysterRegistry {
  constructor(ctx, env) {
    super(ctx, env);
    // The native transaction really commits/rolls back SQL and alarms. Inject
    // one post-body failure, not a fake storage result or an App exception.
    const transaction = ctx.storage.transaction.bind(ctx.storage);
    ctx.storage.transaction = (callback) =>
      transaction(async (tx) => {
        const result = await callback(tx);
        if (this.failCommit) throw new Error("native-admission-commit-failure");
        return result;
      });
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS proof_boots (id INTEGER PRIMARY KEY, boots INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "INSERT INTO proof_boots VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET boots=boots+1",
    );
  }
  async admit(rollback = false) {
    await this.approvalSetAutoApprove(pin, actor, {
      scope: { agentId: null },
      family: { module: null, access: "write" },
      enabled: false,
    });
    this.failCommit = rollback;
    try {
      const result = await this.approvalSubmit(pin, {
        actor,
        installationId: "revoked-notes",
        sessionId: null,
        operation: "saveNote",
        access: "write",
        authorityFence: "previously-admitted-native-target",
        idempotencyKey: "native-admission-wake",
        input: { text: "pending intent only" },
      });
      if (result.kind !== "pending_approval")
        throw Error("Expected native pending admission");
      return {
        result,
        record: this.ledger().get(result.recordId),
        alarm: await this.ctx.storage.getAlarm(),
      };
    } finally {
      this.failCommit = false;
    }
  }
  async prepareExpiry() {
    const admitted = await this.admit();
    const deadline = Date.now() + 50;
    // An accelerated historical deadline exercises the real alarm's expiry
    // owner. This is not a claim of a configurable native expiry producer.
    this.ctx.storage.sql.exec(
      "UPDATE approval_records SET record_json=json_set(record_json, '$.expiresAt', ?) WHERE record_id=?",
      deadline,
      admitted.result.recordId,
    );
    await this.ctx.storage.setAlarm(deadline);
    return { recordId: admitted.result.recordId, deadline };
  }
  expiryState(recordId) {
    // Deliberately do not call ledger.get: that would lazily expire the record
    // and conceal a missing native expiry wake.
    const row = this.ctx.storage.sql
      .exec(
        "SELECT record_json FROM approval_records WHERE record_id=?",
        recordId,
      )
      .one();
    return decodeStored(row.record_json);
  }
  async storedState() {
    return {
      records: this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM approval_records")
        .one().count,
      targets: this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM oyster_approval_targets")
        .one().count,
      payloads: this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM approval_payloads")
        .one().count,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  async admissionState(recordId) {
    return {
      record: this.ledger().get(recordId),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  boots() {
    return this.ctx.storage.sql
      .exec("SELECT boots FROM proof_boots WHERE id=1")
      .one().boots;
  }
  ledger() {
    return new ApprovalLedger({
      owner: {
        sql: this.ctx.storage.sql,
        transactionSync: (body) => this.ctx.storage.transactionSync(body),
      },
      home: { kind: "oyster", id: "default" },
      now: Date.now,
    });
  }
}

const routes = new Map([
  ["/ready", async (stub) => ({ boots: await stub.boots() })],
  ["/admit", (stub) => stub.admit()],
  [
    "/rollback",
    async (stub) => {
      try {
        return await stub.admit(true);
      } catch (cause) {
        return Response.json({ error: cause.message }, { status: 500 });
      }
    },
  ],
  ["/stored-state", (stub) => stub.storedState()],
  [
    "/admission-state",
    (stub, url) => stub.admissionState(url.searchParams.get("record")),
  ],
  ["/prepare-expiry", (stub) => stub.prepareExpiry()],
  [
    "/expiry-state",
    (stub, url) => stub.expiryState(url.searchParams.get("record")),
  ],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = routes.get(url.pathname);
    if (route === undefined) return new Response("Not found", { status: 404 });
    const result = await route(env.REGISTRY.getByName("registry"), url);
    return result instanceof Response ? result : Response.json(result);
  },
};
