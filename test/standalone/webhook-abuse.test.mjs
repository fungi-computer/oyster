import { test } from "node:test";
import assert from "node:assert/strict";
import { workflowWebhookAbuse } from "../../src/webhook-abuse.ts";

test("native rate admission and bounded leases refuse without allocating per-sender state", async () => {
  const keys = [];
  let allow = true;
  const limiter = {
    limit: async ({ key }) => {
      keys.push(key);
      return { success: allow };
    },
  };
  const abuse = workflowWebhookAbuse({
    scope: { host: "hub", tenant: "team" },
    hostRate: limiter,
    bindingRate: limiter,
    concurrency: { hostConcurrency: 1, bindingConcurrency: 1 },
  });
  const release = await abuse.hostLease();
  assert.notEqual(release, null);
  assert.equal(await abuse.hostLease(), null);
  release();
  const second = await abuse.hostLease();
  assert.notEqual(second, null);
  second();
  assert.equal(await abuse.bindingAdmission("binding"), true);
  allow = false;
  assert.equal(await abuse.hostLease(), null);
  assert.equal(await abuse.bindingAdmission("binding"), false);
  assert.match(keys[0], /^[a-f0-9]{64}$/u);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.equal(keys.at(-1), keys[2]);
});

test("full admitted scope identities fit the edge's bounded key representation without losing host or binding isolation", async () => {
  const keys = [];
  const limiter = {
    limit: async ({ key }) => {
      assert.ok(key.length <= 256);
      keys.push(key);
      return { success: true };
    },
  };
  const open = (tenant) =>
    workflowWebhookAbuse({
      scope: { host: "h".repeat(256), tenant },
      hostRate: limiter,
      bindingRate: limiter,
      concurrency: { hostConcurrency: 1, bindingConcurrency: 1 },
    });
  const first = open("t".repeat(256));
  const second = open("u".repeat(256));
  (await first.hostLease())();
  (await second.hostLease())();
  await first.bindingAdmission("b".repeat(256));
  await second.bindingAdmission("b".repeat(256));
  await first.bindingAdmission("c".repeat(256));
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.equal(new Set(keys.slice(2)).size, 3);
});

test("simultaneous native successes cannot overbook the streaming lease ceiling", async () => {
  const abuse = workflowWebhookAbuse({
    scope: { host: "oyster", tenant: "library" },
    hostRate: { limit: async () => ({ success: true }) },
    bindingRate: { limit: async () => ({ success: true }) },
    concurrency: { hostConcurrency: 1, bindingConcurrency: 1 },
  });
  const leases = await Promise.all([abuse.hostLease(), abuse.hostLease()]);
  assert.equal(leases.filter((lease) => lease !== null).length, 1);
  for (const release of leases) {
    release?.();
    release?.();
  }
  const next = await abuse.hostLease();
  assert.notEqual(next, null);
  assert.equal(await abuse.hostLease(), null);
  next();
});
