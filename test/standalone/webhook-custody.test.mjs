import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { workflowWebhookCustody } from "../../src/webhook-custody.ts";
import { armedWorkflowTriggerSchema } from "@fungi.computer/braid/runtime";
const { Headers, TextEncoder } = globalThis;
const capturedBinding = armedWorkflowTriggerSchema.parse({
  installationId: "trellis",
  workflowId: "hook",
  commit: "a".repeat(40),
  digest: "sha256:" + "b".repeat(64),
  triggerId: "hook",
  bindings: {},
  armedBy: "creator",
  armedVia: null,
  grantorMembershipVersion: 1,
  computerId: "computer-owner",
  installationAuthority: {
    selection: {
      instanceId: "instance-trellis",
      owner: { kind: "installation", id: "trellis" },
      appId: "app_trellis",
      releaseId: "rel_trellis",
      authorityVersion: 1,
    },
    artifactDigest: "sha256:" + "c".repeat(64),
  },
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  let now = 1_800_000_000_000;
  let failCommit = false;
  const options = {
    sql: storage.sql,
    transactionSync: (body) =>
      storage.transactionSync(() => {
        const result = body();
        if (failCommit) {
          failCommit = false;
          throw new Error("owner commit failed");
        }
        return result;
      }),
    now: () => now,
    owner: async (principal) =>
      principal === "owner"
        ? "creator"
        : principal === "successor"
          ? "next-owner"
          : null,
  };
  return {
    open: () => workflowWebhookCustody(options),
    failNextCommit: () => {
      failCommit = true;
    },
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
    close: () => database.close(),
  };
}

function signed(key, now, text = '{"action":"opened"}') {
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", Buffer.from(key, "base64url"))
    .update(timestamp + ".")
    .update(text)
    .digest("hex");
  return {
    bindingId: "binding",
    headers: new Headers({
      "x-fungi-timestamp": timestamp,
      "x-fungi-signature": "v1=" + signature,
    }),
    body: new TextEncoder().encode(text),
  };
}

test("key provisioning durably captures the admitted binding, not caller-supplied authority at intake", async () => {
  const f = fixture();
  try {
    const owner = f.open();
    const created = await owner.create(
      "owner",
      "binding",
      "fungi-v1",
      capturedBinding,
    );
    assert.equal(created.bindingId, "binding");
    assert.equal(created.installationId, capturedBinding.installationId);
    const verified = f
      .open()
      .verification.verify(signed(created.secret, f.now()));
    assert.equal(verified.status, "ok");
    assert.deepEqual(verified.binding, capturedBinding);
  } finally {
    f.close();
  }
});

test("failed owner commit leaves neither a key nor an armed binding and permits a fresh provision", async () => {
  const f = fixture();
  try {
    const owner = f.open();
    f.failNextCommit();
    await assert.rejects(
      owner.create("owner", "binding", "fungi-v1", capturedBinding),
      /owner commit failed/u,
    );
    assert.deepEqual(await f.open().list("owner"), {
      bindings: [],
      next: null,
    });
    const created = await owner.create(
      "owner",
      "binding",
      "fungi-v1",
      capturedBinding,
    );
    assert.equal(created.kind, "created");
    assert.deepEqual(
      f.open().verification.verify(signed(created.secret, f.now())).binding,
      capturedBinding,
    );
  } finally {
    f.close();
  }
});

test("owner only provisions one random key, never discloses it through projections", async () => {
  const f = fixture();
  try {
    const owner = f.open();
    assert.deepEqual(
      await owner.create("member", "binding", "fungi-v1", capturedBinding),
      {
        kind: "refused",
      },
    );
    const created = await owner.create(
      "owner",
      "binding",
      "fungi-v1",
      capturedBinding,
    );
    assert.equal(created.kind, "created");
    assert.match(created.secret, /^[A-Za-z0-9_-]{43}$/u);
    assert.deepEqual(
      await owner.create("owner", "binding", "fungi-v1", capturedBinding),
      {
        kind: "refused",
      },
    );
    const listing = await owner.list("owner");
    assert.equal(listing.bindings.length, 1);
    assert.equal(JSON.stringify(listing).includes(created.secret), false);
    assert.equal("read" in owner.verification, false);
    assert.equal("reveal" in owner, false);
    assert.equal(
      (await owner.verification.verify(signed(created.secret, f.now()))).status,
      "ok",
    );
  } finally {
    f.close();
  }
});

test("rotation overlaps current and previous for 24 hours across a store restart", async () => {
  const f = fixture();
  try {
    let owner = f.open();
    const first = await owner.create(
      "owner",
      "binding",
      "fungi-v1",
      capturedBinding,
    );
    const rotated = await owner.rotate("owner", "binding");
    assert.equal(rotated.kind, "rotated");
    assert.notEqual(first.secret, rotated.secret);
    owner = f.open();
    for (const secret of [first.secret, rotated.secret]) {
      assert.equal(
        owner.verification.verify(signed(secret, f.now())).status,
        "ok",
      );
    }
    assert.deepEqual(await owner.rotate("owner", "binding"), {
      kind: "refused",
    });
    f.advance(24 * 60 * 60 * 1000);
    assert.equal(
      owner.verification.verify(signed(first.secret, f.now())).status,
      "refused",
    );
    assert.equal(
      owner.verification.verify(signed(rotated.secret, f.now())).status,
      "ok",
    );
  } finally {
    f.close();
  }
});

test("explicit retirement rejects previous immediately and compromise revocation destroys both keys", async () => {
  const f = fixture();
  try {
    const owner = f.open();
    const first = await owner.create(
      "owner",
      "binding",
      "fungi-v1",
      capturedBinding,
    );
    const rotated = await owner.rotate("owner", "binding");
    await owner.retirePrevious("owner", "binding");
    assert.equal(
      owner.verification.verify(signed(first.secret, f.now())).status,
      "refused",
    );
    await owner.revoke("owner", "binding");
    assert.equal(
      f.open().verification.verify(signed(rotated.secret, f.now())).status,
      "refused",
    );
    assert.deepEqual(
      await owner.create("owner", "binding", "fungi-v1", capturedBinding),
      {
        kind: "refused",
      },
    );
  } finally {
    f.close();
  }
});

test("members cannot rotate, retire, revoke or list; a successor owner never receives the creator's key", async () => {
  const f = fixture();
  try {
    const owner = f.open();
    const first = await owner.create(
      "owner",
      "binding",
      "fungi-v1",
      capturedBinding,
    );
    assert.deepEqual(await owner.rotate("member", "binding"), {
      kind: "refused",
    });
    assert.deepEqual(await owner.retirePrevious("member", "binding"), {
      kind: "refused",
    });
    assert.deepEqual(await owner.revoke("member", "binding"), {
      kind: "refused",
    });
    assert.deepEqual(await owner.list("member"), { bindings: [], next: null });
    assert.equal(
      owner.verification.verify(signed(first.secret, f.now())).status,
      "ok",
    );
    assert.deepEqual(await owner.rotate("successor", "binding"), {
      kind: "rotated",
      secret: null,
    });
  } finally {
    f.close();
  }
});

test("fungi retries re-signed with a new timestamp or key retain delivery identity", async () => {
  const f = fixture();
  try {
    const owner = f.open();
    const first = await owner.create(
      "owner",
      "binding",
      "fungi-v1",
      capturedBinding,
    );
    const original = owner.verification.verify(signed(first.secret, f.now()));
    const rotated = await owner.rotate("owner", "binding");
    f.advance(30_000);
    const retry = owner.verification.verify(signed(rotated.secret, f.now()));
    assert.equal(retry.status, "ok");
    assert.equal(retry.eventId, original.eventId);
  } finally {
    f.close();
  }
});

test("GitHub delivery id plus body hash survives rotation but deliberately does not establish freshness", async () => {
  const f = fixture();
  try {
    const owner = f.open();
    const first = await owner.create(
      "owner",
      "binding",
      "github",
      capturedBinding,
    );
    const request = (secret, deliveryId, text) => ({
      bindingId: "binding",
      headers: new Headers({
        "x-github-delivery": deliveryId,
        "x-hub-signature-256":
          "sha256=" + createHmac("sha256", secret).update(text).digest("hex"),
      }),
      body: new TextEncoder().encode(text),
    });
    const original = owner.verification.verify(
      request(first.secret, "delivery-1", '{"n":1}'),
    );
    const rotated = await owner.rotate("owner", "binding");
    const retry = owner.verification.verify(
      request(rotated.secret, "delivery-1", '{"n":1}'),
    );
    assert.equal(original.status, "ok");
    assert.deepEqual(retry, original);
    const changedBody = owner.verification.verify(
      request(rotated.secret, "delivery-1", '{"n":2}'),
    );
    assert.notEqual(changedBody.eventId, original.eventId);
    // GitHub does not authenticate this ID or any timestamp: accepted policy.
    const changedUnsignedId = owner.verification.verify(
      request(rotated.secret, "delivery-2", '{"n":1}'),
    );
    assert.equal(changedUnsignedId.status, "ok");
    assert.notEqual(changedUnsignedId.eventId, original.eventId);
  } finally {
    f.close();
  }
});

test("Standard Webhooks re-signing under a new key retains the signed message identity", async () => {
  const f = fixture();
  try {
    const owner = f.open();
    const first = await owner.create(
      "owner",
      "binding",
      "standard-webhooks",
      capturedBinding,
    );
    const signedStandard = (secret) => {
      const text = '{"n":1}';
      const timestamp = String(Math.floor(f.now() / 1000));
      const signature = createHmac(
        "sha256",
        Buffer.from(secret.slice("whsec_".length), "base64"),
      )
        .update("message-1." + timestamp + "." + text)
        .digest("base64");
      return {
        bindingId: "binding",
        headers: new Headers({
          "webhook-id": "message-1",
          "webhook-timestamp": timestamp,
          "webhook-signature": "v1," + signature,
        }),
        body: new TextEncoder().encode(text),
      };
    };
    const original = owner.verification.verify(signedStandard(first.secret));
    const rotated = await owner.rotate("owner", "binding");
    f.advance(30_000);
    assert.equal(original.status, "ok");
    assert.deepEqual(
      owner.verification.verify(signedStandard(rotated.secret)),
      original,
    );
  } finally {
    f.close();
  }
});
