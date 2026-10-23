import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { URL } from "node:url";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { ApprovalLedger } from "@fungi.computer/approvals";
import { createOyster } from "../dist/host.js";
import { ownerKeyAuth } from "../dist/auth.js";
import { OysterApprovalHome } from "../dist/approval-home.js";
import { defaultTenant, tenantScope } from "../dist/tenant.js";
import { computerHost } from "./computer-host.fixture.mjs";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: new URL("../dist/testing/workers-runtime.js", import.meta.url)
          .href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { OysterRegistry, oysterWorkerHost } = await import("../dist/workers.js");
hooks.deregister();

test("native Oyster HTTP controls persist owner policy through the real registry and recheck the owner", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const key = "native-control-owner-secret-123456789";
  const env = {
    OYSTER_OWNER_KEY: key,
    OYSTER_ORIGIN: "https://oyster.test",
    RELEASES: {},
    REGISTRY: { getByName: () => registry },
  };
  let liveAuth = ownerKeyAuth(key);
  class CurrentRegistry extends OysterRegistry {
    hostFor(scope) {
      return Promise.resolve(oysterWorkerHost(env, liveAuth, { scope }));
    }
  }
  let registry = new CurrentRegistry(
    { id: { name: "registry" }, storage: fromNodeSqlite(database) },
    env,
  );
  const native = oysterWorkerHost(env, ownerKeyAuth(key));
  const base = await computerHost(
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    null,
    { capabilities: ["approvals"] },
    native.capabilities,
  );
  const app = createOyster({ ...base, auth: native.auth });
  const request = (path, body, headers = {}) =>
    app.request("https://oyster.test/approvals/" + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "X-Oyster-Installation": "context-probe",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const listed = await request("list", { limit: 1 });
  assert.equal(
    listed.status,
    200,
    "the native host must mount its real approvals route",
  );
  assert.deepEqual(await listed.json(), { items: [], nextCursor: null });
  const rule = {
    scope: { agentId: null },
    family: { module: null, access: "write" },
    enabled: false,
  };
  const updated = await request("set-auto-approve", rule);
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { kind: "updated", rule });
  assert.equal(
    database.prepare("SELECT enabled FROM approval_rules").get().enabled,
    0,
  );
  registry = new CurrentRegistry(
    { id: { name: "registry" }, storage: fromNodeSqlite(database) },
    env,
  );
  assert.equal((await request("list", {})).status, 200);
  assert.equal(
    database.prepare("SELECT enabled FROM approval_rules").get().enabled,
    0,
  );
  assert.equal(
    (
      await request("set-auto-approve", {
        ...rule,
        actor: { kind: "member", memberId: "owner" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("list", {}, { Authorization: "Bearer wrong" })).status,
    401,
  );
  // A cold registry must retain the same home seal as a warm registry. The
  // native sender owns its scope; no request-body field can choose this pin.
  registry = new CurrentRegistry(
    { id: { name: "registry" }, storage: fromNodeSqlite(database) },
    env,
  );
  await assert.rejects(
    async () =>
      registry.approvalList(
        { tenantId: "default", origin: "https://different-oyster.test" },
        { kind: "member", memberId: "owner" },
        {},
      ),
    /Approval home cannot change tenant/,
    "a registry restart must not permit rebinding persisted consent to another origin",
  );
  liveAuth = ownerKeyAuth(key, "replacement-owner");
  // The page host still admits the old owner. The durable home must resolve the
  // current owner independently, rather than trust that earlier admission.
  assert.deepEqual(
    await (
      await request("set-auto-approve", { ...rule, enabled: true })
    ).json(),
    { kind: "refused", reason: "not-eligible" },
  );
  assert.equal(
    database.prepare("SELECT enabled FROM approval_rules").get().enabled,
    0,
  );
});

test("a cold native Registry alarm settles historical approved work using current requester authority", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const storage = fromNodeSqlite(database);
  const context = { id: { name: "registry" }, storage };
  let dispatches = 0;
  const env = {
    OYSTER_OWNER_KEY: "native-recovery-owner-secret-123456789",
    OYSTER_ORIGIN: "https://oyster.test",
    RELEASES: {},
    REGISTRY: { getByName: () => registry },
    INSTANCES: {
      getByName: () => {
        dispatches++;
        assert.fail("Revoked work must not acquire an Instance");
      },
    },
  };
  let registry = new OysterRegistry(context, env);
  const pin = { tenantId: "default", origin: env.OYSTER_ORIGIN };
  const actor = { kind: "member", memberId: "owner" };
  await registry.approvalSetAutoApprove(pin, actor, {
    scope: { agentId: null },
    family: { module: null, access: "write" },
    enabled: false,
  });
  // This Node Worker-class adapter supplies SQLite, not a Cloudflare storage
  // transaction/alarm service. Stage historical data through its real home;
  // actual native admission and atomic wake are covered by approval-wake.native.
  const staging = new OysterApprovalHome({
    owner: storage,
    scope: tenantScope(defaultTenant, env.OYSTER_ORIGIN),
    current: () =>
      Promise.resolve(
        oysterWorkerHost(env, ownerKeyAuth(env.OYSTER_OWNER_KEY)),
      ),
    commit: (write) => write(),
  });
  const staged = await staging.submit({
    actor,
    installationId: "revoked-notes",
    sessionId: null,
    operation: "saveNote",
    access: "write",
    authorityFence: "historically-admitted-generation",
    idempotencyKey: "approved-before-claim",
    input: { text: "never dispatch revoked target" },
  });
  assert.equal(staged.kind, "pending_approval");
  const ledger = new ApprovalLedger({
    owner: storage,
    home: { kind: "oyster", id: "default" },
    now: Date.now,
  });
  const record = ledger.get(staged.recordId);
  // Historical eligibility is fixture state. The current installation is absent;
  // recovery must perform the real host check rather than trusting this answer.
  const answered = ledger.answer(
    {
      recordId: record.recordId,
      expectedRevision: record.revision,
      decision: "approve",
    },
    {
      kind: "human",
      memberId: "owner",
      role: "owner",
      actingForAgent: false,
      mayUseOperation: true,
    },
  );
  assert.equal(answered.kind, "answered");
  assert.equal(ledger.get(record.recordId).state, "approved");
  registry = new OysterRegistry(context, env);
  await registry.alarm();
  assert.equal(ledger.get(record.recordId).state, "denied");
  assert.equal(ledger.get(record.recordId).reason, "not-granted");
  assert.equal(dispatches, 0);
  await registry.alarm();
  assert.equal(dispatches, 0);
});

test("a retried Oyster request after a member approval never claims or answers inline", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const storage = fromNodeSqlite(database);
  const env = {
    OYSTER_OWNER_KEY: "native-retry-owner-secret-123456789",
    OYSTER_ORIGIN: "https://oyster.test",
    RELEASES: {},
    INSTANCES: {
      getByName: () => assert.fail("A retried request must not dispatch"),
    },
  };
  const actor = { kind: "member", memberId: "owner" };
  const home = new OysterApprovalHome({
    owner: storage,
    scope: tenantScope(defaultTenant, env.OYSTER_ORIGIN),
    current: () =>
      Promise.resolve(
        oysterWorkerHost(env, ownerKeyAuth(env.OYSTER_OWNER_KEY)),
      ),
    commit: (write) => write(),
  });
  const ledger = new ApprovalLedger({
    owner: storage,
    home: { kind: "oyster", id: "default" },
    now: Date.now,
  });
  ledger.setAutoApprove(
    {
      scope: { agentId: null },
      family: { module: null, access: "write" },
      enabled: false,
    },
    {
      kind: "human",
      memberId: "owner",
      role: "owner",
      actingForAgent: false,
      mayUseOperation: true,
    },
  );
  const call = {
    actor,
    installationId: "notes",
    sessionId: null,
    operation: "saveNote",
    access: "write",
    authorityFence: "generation-1",
    idempotencyKey: "retry-after-approval",
    input: { text: "approved once" },
  };
  const pending = await home.submit(call);
  assert.equal(pending.kind, "pending_approval");
  const record = ledger.get(pending.recordId);
  assert.equal(
    ledger.answer(
      {
        recordId: record.recordId,
        expectedRevision: record.revision,
        decision: "approve",
      },
      {
        kind: "human",
        memberId: "owner",
        role: "owner",
        actingForAgent: false,
        mayUseOperation: true,
      },
    ).kind,
    "answered",
  );
  // The home's work loop owns this apply; the retry only reports status.
  assert.deepEqual(await home.submit(call), pending);
  assert.equal(ledger.get(pending.recordId).state, "approved");
});
