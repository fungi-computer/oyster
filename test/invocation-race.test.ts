import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  AppInstanceError,
  createAppInstance,
  instanceIds,
  type Instance,
} from "../src/index.js";
import {
  createInvocationGate,
  type InvocationFacts,
  invocationFactsSchema,
  invocationFacts,
} from "../src/invocation.js";
import * as Invocation from "../src/invocation.js";
import {
  backgroundOriginKey,
  sealBackgroundOrigin,
} from "@fungi.computer/puffball/background-replay";

await test("disable fences authority before cancelling a held frame without waiting for its guest", async () => {
  const instanceId = instanceIds.instance.generate();
  const facts = Schema.decodeUnknownSync(invocationFactsSchema)({
    instanceId,
    selection: {
      instanceId,
      owner: { kind: "installation", id: "notes" },
      appId: "app_notes",
      releaseId: "rel_example",
      authorityVersion: 1,
    },
    artifactDigest: `sha256:${"1".repeat(64)}`,
    subject: {
      kind: "call",
      context: {
        actor: { kind: "member", memberId: "member_one" },
        computerId: null,
      },
    },
    grants: [],
    deadlineAt: Date.now() + 60_000,
    ancestry: [],
  });
  let record: Instance = {
    ...facts.selection,
    desiredStatus: "enabled",
    status: "active",
    stateSchema: 1,
  };
  const entered = Promise.withResolvers<undefined>();
  const guest = Promise.withResolvers<undefined>();
  const aborts: unknown[] = [];
  let nativeAborts = 0;
  const gate = createInvocationGate({
    abortGuest: () => {
      nativeAborts += 1;
      return Promise.resolve();
    },
    close: (frame) => {
      aborts.push(frame.signal.reason);
      return Promise.resolve();
    },
  });
  const owner = createAppInstance({
    instanceId,
    read: () => Effect.succeed(record),
    write: (next) =>
      Effect.sync(() => {
        record = next;
      }),
    resolve: () => Effect.fail(new Error("Disable must not load a backend")),
    boot: () => Effect.fail(new Error("Disable must not boot a backend")),
    connect: () => Effect.fail(new Error("Unused connection")),
    purge: () => Effect.fail(new Error("Disable must retain state")),
    abort: (reason) =>
      Effect.tryPromise({
        try: async () => {
          assert.equal(record.authorityVersion, 2);
          assert.equal(record.status, "disabled");
          assert.ok(reason instanceof AppInstanceError);
          assert.equal(reason.code, "disabled");
          await gate.revoke(reason);
        },
        catch: (cause) => new Error("Host cancellation failed", { cause }),
      }),
  });
  let held = "";
  const result = gate
    .run(facts, {}, async (frame) => {
      held = frame.frameId;
      entered.resolve(undefined);
      await guest.promise;
    })
    .then(
      () => null,
      (cause: unknown) => cause,
    );
  await entered.promise;
  try {
    await Effect.runPromise(
      owner.apply({
        ...facts.selection,
        status: "disabled",
        authorityVersion: 2,
      }),
    );
    const failure = await result;
    assert.ok(failure instanceof AppInstanceError);
    assert.equal(failure.code, "disabled");
    assert.deepEqual(aborts, [failure]);
    assert.equal(nativeAborts, 1);
    assert.throws(() => gate.active(held), { code: "revoked" });
  } finally {
    guest.resolve(undefined);
    await result;
  }
});

await test("replay grants and fresh admitted methods are coupled at the facts boundary", () => {
  const instanceId = instanceIds.instance.generate();
  const raw = {
    instanceId,
    selection: {
      instanceId,
      owner: { kind: "installation", id: "notes" },
      appId: "app_notes",
      releaseId: "rel_example",
      authorityVersion: 1,
    },
    artifactDigest: `sha256:${"1".repeat(64)}`,
    subject: {
      kind: "call",
      context: {
        actor: { kind: "member", memberId: "member_one" },
        computerId: null,
      },
      method: { name: "continueWrites", effect: "write" },
      replay: { lane: "member:member_one", epoch: 1, admitted: ["save"] },
    },
    grants: [{ binding: "BACKGROUND", operations: ["admit"] }],
    deadlineAt: Date.now() + 60_000,
    ancestry: [],
  };
  const decode = Schema.decodeUnknownSync(invocationFactsSchema);
  assert.deepEqual(decode(raw).grants, [
    { binding: "BACKGROUND", operations: ["admit"] },
  ]);
  assert.throws(() => decode({ ...raw, grants: [] }));
  const foreground = {
    kind: raw.subject.kind,
    context: raw.subject.context,
    method: raw.subject.method,
  };
  assert.throws(() => decode({ ...raw, subject: foreground }));
  for (const admitted of [
    ["then"],
    ["save", "save"],
    Array.from({ length: 257 }, (_, i) => `save${String(i)}`),
  ])
    assert.throws(() =>
      decode({
        ...raw,
        subject: {
          ...raw.subject,
          replay: { ...raw.subject.replay, admitted },
        },
      }),
    );
});

await test("one frame latch blocks effects until its sealed claimed origin is admitted", async () => {
  const instanceId = instanceIds.instance.generate();
  const key = await backgroundOriginKey("synthetic-frame-proof-key");
  const origin = await sealBackgroundOrigin(key, {
    instanceId,
    lane: "member:member_one",
    method: "save",
  });
  const facts = Schema.decodeUnknownSync(invocationFactsSchema)({
    instanceId,
    selection: {
      instanceId,
      owner: { kind: "installation", id: "notes" },
      appId: "app_notes",
      releaseId: "rel_example",
      authorityVersion: 1,
    },
    artifactDigest: `sha256:${"1".repeat(64)}`,
    subject: {
      kind: "call",
      context: {
        actor: { kind: "member", memberId: "member_one" },
        computerId: null,
      },
      method: { name: "continueWrites", effect: "write" },
      replay: { lane: "member:member_one", epoch: 1, admitted: ["save"] },
    },
    grants: [{ binding: "BACKGROUND", operations: ["admit"] }],
    deadlineAt: Date.now() + 60_000,
    ancestry: [],
  });
  const gate = createInvocationGate<Invocation.BackgroundFrameState>({
    abortGuest: () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
  await gate.run(facts, { origin: "unchecked" }, async (frame) => {
    for (const binding of ["GIT", "EVENTS", "COMPUTER", "WORKFLOWS"] as const)
      assert.throws(
        () => {
          Invocation.assertBackgroundBinding(frame, binding);
        },
        {
          code: "revoked",
        },
      );
    Invocation.assertBackgroundBinding(frame, "APP_STORAGE");
    const first = Invocation.admitBackgroundFrame(key, frame, origin);
    assert.deepEqual(
      await Invocation.admitBackgroundFrame(key, frame, origin),
      { kind: "refused", code: "access_changed" },
    );
    assert.deepEqual(await first, { kind: "admitted" });
    Invocation.assertBackgroundBinding(frame, "GIT");
    assert.deepEqual(
      await Invocation.admitBackgroundFrame(key, frame, origin),
      { kind: "refused", code: "access_changed" },
    );
  });
  const retained = await gate.run(
    facts,
    { origin: "unchecked" },
    async (frame) => {
      assert.deepEqual(
        await Invocation.admitBackgroundFrame(key, frame, {
          ...origin,
          method: "other",
        }),
        { kind: "refused", code: "access_changed" },
      );
      assert.throws(
        () => {
          Invocation.assertBackgroundBinding(frame, "GIT");
        },
        {
          code: "revoked",
        },
      );
      return frame;
    },
  );
  await assert.rejects(Invocation.admitBackgroundFrame(key, retained, origin), {
    code: "revoked",
  });
  assert.equal(retained.host.origin, "refused");
});

const sharedFacts = (
  instanceId: string,
  subject: InvocationFacts["subject"],
): InvocationFacts =>
  Schema.decodeUnknownSync(invocationFactsSchema)({
    instanceId,
    selection: {
      instanceId,
      owner: { kind: "installation", id: "notes" },
      appId: "app_notes",
      releaseId: "rel_example",
      authorityVersion: 1,
    },
    artifactDigest: `sha256:${"1".repeat(64)}`,
    subject,
    grants: [{ binding: "WORKFLOWS", operations: ["catalog"] }],
    deadlineAt: Date.now() + 60_000,
    ancestry: [],
  });
const callBy = (
  memberId: string,
  effect?: "read" | "write",
): InvocationFacts["subject"] => {
  const context = {
    computerId: null,
    actor: { kind: "member" as const, memberId },
    role: "owner" as const,
  };
  return effect === undefined
    ? { kind: "call", context }
    : { kind: "call", context, method: { name: `${effect}.one`, effect } };
};

await test("a finished frame stops the guest before closing authority and its id never resolves again", async () => {
  const instanceId = instanceIds.instance.generate();
  let aborts = 0;
  const closed: string[] = [];
  const order: string[] = [];
  const gate = createInvocationGate({
    abortGuest: () => {
      aborts += 1;
      order.push("stop");
      return Promise.resolve();
    },
    close: (frame) => {
      order.push("close");
      closed.push(frame.frameId);
      return Promise.resolve();
    },
  });
  const first = await gate.run(
    sharedFacts(instanceId, callBy("owner")),
    {},
    (frame) => {
      assert.equal(gate.active(frame.frameId), frame);
      return Promise.resolve(frame);
    },
  );
  const second = await gate.run(
    sharedFacts(instanceId, callBy("other")),
    {},
    (frame) => {
      // A leftover packet naming the finished frame is refused.
      assert.throws(() => gate.active(first.frameId), { code: "revoked" });
      return Promise.resolve(frame);
    },
  );
  assert.equal(first.signal.aborted, true);
  assert.notEqual(second.frameId, first.frameId);
  assert.deepEqual(closed, [first.frameId, second.frameId]);
  assert.equal(aborts, 2);
  assert.deepEqual(order, ["stop", "close", "stop", "close"]);
  assert.throws(() => gate.active(second.frameId), { code: "revoked" });
});

await test("five foreground reads share a guest, stop at drain, then admit a queued write alone", async () => {
  const instanceId = instanceIds.instance.generate();
  let aborts = 0;
  const closed: string[] = [];
  const gate = createInvocationGate({
    abortGuest: () => {
      aborts += 1;
      return Promise.resolve();
    },
    close: (frame) => {
      closed.push(frame.frameId);
      return Promise.resolve();
    },
  });
  const releases = Array.from({ length: 5 }, () =>
    Promise.withResolvers<undefined>(),
  );
  const entered: string[] = [];
  const reads = releases.map((release, index) =>
    gate.run(
      sharedFacts(instanceId, callBy(`reader${String(index)}`, "read")),
      {},
      async (frame) => {
        entered.push(`reader${String(index)}`);
        assert.equal(gate.active(frame.frameId), frame);
        await release.promise;
        return frame;
      },
    ),
  );
  const write = gate.run(
    sharedFacts(instanceId, callBy("writer", "write")),
    {},
    () => {
      assert.equal(aborts, 1, "the read cohort stopped before the write");
      assert.equal(closed.length, 5);
      entered.push("writer");
      return Promise.resolve();
    },
  );
  const later = gate.run(
    sharedFacts(instanceId, callBy("later", "read")),
    {},
    () => {
      assert.equal(aborts, 2, "the writer ran alone and stopped");
      entered.push("later");
      return Promise.resolve();
    },
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      [...entered],
      ["reader0", "reader1", "reader2", "reader3", "reader4"],
    );
    for (const release of releases.slice(0, 4)) release.resolve(undefined);
    const finished = await Promise.all(reads.slice(0, 4));
    assert.equal(aborts, 0, "a sibling still owns admitted guest execution");
    assert.equal(closed.length, 4);
    for (const frame of finished) {
      assert.equal(frame.signal.aborted, true);
      assert.throws(() => gate.active(frame.frameId), { code: "revoked" });
    }
    releases[4]?.resolve(undefined);
    await reads[4];
    await Promise.all([write, later]);
    assert.equal(aborts, 3);
    assert.deepEqual(entered.slice(5), ["writer", "later"]);
    assert.equal(new Set(closed).size, 7);
  } finally {
    for (const release of releases) release.resolve(undefined);
    await Promise.allSettled([...reads, write, later]);
  }
});

await test("an arrival during drain waits for the guest stop before entering", async () => {
  const instanceId = instanceIds.instance.generate();
  const stopping = Promise.withResolvers<undefined>();
  const stopped = Promise.withResolvers<undefined>();
  const events: string[] = [];
  let aborts = 0;
  const gate = createInvocationGate({
    abortGuest: async () => {
      aborts += 1;
      events.push("stop-start");
      stopping.resolve(undefined);
      await stopped.promise;
      events.push("stop-done");
    },
    close: () => {
      events.push("close");
      return Promise.resolve();
    },
  });
  const first = gate.run(
    sharedFacts(instanceId, callBy("first", "read")),
    {},
    () => Promise.resolve(),
  );
  await stopping.promise;
  const next = gate.run(
    sharedFacts(instanceId, callBy("next", "read")),
    {},
    () => {
      events.push("enter-next");
      assert.equal(aborts, 1);
      return Promise.resolve();
    },
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual([...events], ["stop-start"]);
    stopped.resolve(undefined);
    await Promise.all([first, next]);
    assert.equal(aborts, 2);
    assert.ok(events.indexOf("stop-done") < events.indexOf("close"));
    assert.ok(events.indexOf("stop-done") < events.indexOf("enter-next"));
  } finally {
    stopped.resolve(undefined);
    await Promise.allSettled([first, next]);
  }
});

await test("revocation stops the admitted guest before a later read enters", async () => {
  const instanceId = instanceIds.instance.generate();
  let aborts = 0;
  const gate = createInvocationGate({
    abortGuest: () => {
      aborts += 1;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  const held = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const first = gate
    .run(sharedFacts(instanceId, callBy("a", "read")), {}, async () => {
      entered.resolve(undefined);
      await held.promise;
    })
    .then(
      () => null,
      (cause: unknown) => cause,
    );
  await entered.promise;
  await gate.revoke();
  const next = gate.run(
    sharedFacts(instanceId, callBy("b", "read")),
    {},
    () => {
      assert.equal(aborts, 1);
      return Promise.resolve();
    },
  );
  try {
    const failure = await first;
    assert.ok(
      failure instanceof AppInstanceError && failure.code === "revoked",
    );
    await next;
    assert.equal(aborts, 2);
  } finally {
    held.resolve(undefined);
    await Promise.allSettled([first, next]);
  }
});

await test("a read stream past the opening deadline drains before a new cohort and waiting write", async () => {
  const instanceId = instanceIds.instance.generate();
  let now = Date.now();
  let aborts = 0;
  const gate = createInvocationGate({
    now: () => now,
    abortGuest: () => {
      aborts += 1;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  const entered: string[] = [];
  const opening = Promise.withResolvers<undefined>();
  const sibling = Promise.withResolvers<undefined>();
  const releaseNew = Promise.withResolvers<undefined>();
  let abortsAtFresh = -1;
  const first = gate.run(
    {
      ...sharedFacts(instanceId, callBy("opening", "read")),
      deadlineAt: now + 10_000,
    },
    {},
    async () => {
      entered.push("opening");
      await opening.promise;
    },
  );
  const second = gate.run(
    sharedFacts(instanceId, callBy("sibling", "read")),
    {},
    async () => {
      entered.push("sibling");
      await sibling.promise;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  opening.resolve(undefined);
  await first;
  now += 10_001;
  const fresh = gate.run(
    sharedFacts(instanceId, callBy("fresh", "read")),
    {},
    async () => {
      entered.push("fresh");
      abortsAtFresh = aborts;
      await releaseNew.promise;
    },
  );
  const write = gate.run(
    sharedFacts(instanceId, callBy("writer", "write")),
    {},
    () => {
      entered.push("writer");
      assert.equal(aborts, 2);
      return Promise.resolve();
    },
  );
  const stream = Array.from({ length: 5 }, (_, index) =>
    gate.run(
      sharedFacts(instanceId, callBy(`stream${String(index)}`, "read")),
      {},
      () => {
        entered.push("stream");
        assert.ok(entered.includes("writer"));
        return Promise.resolve();
      },
    ),
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual([...entered], ["opening", "sibling"]);
    assert.equal(aborts, 0);
    sibling.resolve(undefined);
    await second;
    releaseNew.resolve(undefined);
    await Promise.all([fresh, write, ...stream]);
    assert.equal(abortsAtFresh, 1, "the expired opening cohort has drained");
    assert.deepEqual(entered.slice(0, 4), [
      "opening",
      "sibling",
      "fresh",
      "writer",
    ]);
    assert.equal(
      aborts,
      4,
      "old reads, new read, write, and read stream drain",
    );
  } finally {
    opening.resolve(undefined);
    sibling.resolve(undefined);
    releaseNew.resolve(undefined);
    await Promise.allSettled([first, second, fresh, write, ...stream]);
  }
});

await test("only eight reads enter, and a queued ninth rechecks the opening deadline", async () => {
  const instanceId = instanceIds.instance.generate();
  let now = Date.now();
  let aborts = 0;
  const gate = createInvocationGate({
    now: () => now,
    abortGuest: () => {
      aborts += 1;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  const releases = Array.from({ length: 8 }, () =>
    Promise.withResolvers<undefined>(),
  );
  const entered: number[] = [];
  const reads = releases.map((release, index) => {
    const facts = sharedFacts(
      instanceId,
      callBy(`reader${String(index)}`, "read"),
    );
    return gate.run(
      index === 0 ? { ...facts, deadlineAt: now + 10_000 } : facts,
      {},
      async () => {
        entered.push(index);
        await release.promise;
      },
    );
  });
  const ninth = gate.run(
    sharedFacts(instanceId, callBy("ninth", "read")),
    {},
    () => {
      entered.push(8);
      assert.equal(
        aborts,
        1,
        "queued before the cap, admitted after old drain",
      );
      return Promise.resolve();
    },
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(entered.length, 8);
    now += 10_001;
    releases[0]?.resolve(undefined);
    await reads[0];
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      entered.length,
      8,
      "a free read slot cannot prolong the cohort",
    );
    for (const release of releases) release.resolve(undefined);
    await Promise.all([...reads, ninth]);
    assert.deepEqual(entered, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(aborts, 2);
  } finally {
    for (const release of releases) release.resolve(undefined);
    await Promise.allSettled([...reads, ninth]);
  }
});

await test("Instance admission preserves a typed refusal after waiting for the frame permit", async () => {
  const instanceId = instanceIds.instance.generate();
  let now = Date.now();
  const facts = Schema.decodeUnknownSync(invocationFactsSchema)({
    instanceId,
    selection: {
      instanceId,
      owner: { kind: "installation", id: "notes" },
      appId: "app_notes",
      releaseId: "rel_example",
      authorityVersion: 1,
    },
    artifactDigest: `sha256:${"1".repeat(64)}`,
    subject: {
      kind: "call",
      context: {
        computerId: null,
        actor: { kind: "member", memberId: "owner" },
      },
    },
    grants: [],
    deadlineAt: now + 60_000,
    ancestry: [],
  });
  const gate = createInvocationGate({
    abortGuest: () => Promise.resolve(),
    close: () => Promise.resolve(),
    now: () => now,
  });
  const entered = Promise.withResolvers<undefined>();
  const finish = Promise.withResolvers<undefined>();
  const first = gate.run(facts, {}, async () => {
    entered.resolve(undefined);
    await finish.promise;
  });
  await entered.promise;
  let guestStarted = false;
  const waiting = gate.run({ ...facts, deadlineAt: now + 1 }, {}, () => {
    guestStarted = true;
    return Promise.resolve();
  });
  now += 2;
  finish.resolve(undefined);
  await first;
  await assert.rejects(
    waiting,
    (error: Error) =>
      error instanceof AppInstanceError && error.code === "expired",
  );
  assert.equal(guestStarted, false);
});

await test("syncRefused has no actor or binding grants", () => {
  const instanceId = instanceIds.instance.generate();
  const input = {
    instanceId,
    selection: {
      instanceId,
      owner: { kind: "installation", id: "notes" },
      appId: "app_notes",
      releaseId: "rel_example",
      authorityVersion: 1,
    },
    artifactDigest: `sha256:${"1".repeat(64)}`,
    subject: {
      kind: "lifecycle",
      name: "syncRefused",
      lane: "member:member_one",
      code: "access_changed",
    },
    grants: [],
    deadlineAt: Date.now() + 60_000,
    ancestry: [],
  };
  const decode = Schema.decodeUnknownSync(invocationFactsSchema, {
    onExcessProperty: "error",
  });
  assert.deepEqual(decode(input).subject, input.subject);
  assert.throws(() =>
    decode({ ...input, grants: [{ binding: "GIT", operations: ["write"] }] }),
  );
  assert.throws(() =>
    decode({
      ...input,
      subject: {
        ...input.subject,
        actor: { kind: "member", memberId: "member_one" },
      },
    }),
  );
});

await test("read polls each simulated second wait for one replay step without interrupting it", async () => {
  const instanceId = instanceIds.instance.generate();
  let now = Date.now();
  let completedSteps = 0;
  let aborts = 0;
  const facts = (replay: boolean, epoch: number) =>
    Schema.decodeUnknownSync(invocationFactsSchema)({
      instanceId,
      selection: {
        instanceId,
        owner: { kind: "installation", id: "notes" },
        appId: "app_notes",
        releaseId: "rel_example",
        authorityVersion: 1,
      },
      artifactDigest: `sha256:${"1".repeat(64)}`,
      subject: replay
        ? {
            kind: "call",
            context: {
              actor: { kind: "member", memberId: "writer" },
              computerId: null,
            },
            method: { name: "continueWrites", effect: "write" },
            replay: { lane: "member:writer", epoch, admitted: [] },
          }
        : {
            kind: "call",
            context: {
              actor: { kind: "member", memberId: "reader" },
              computerId: null,
            },
            method: { name: "activity.list", effect: "read" },
          },
      grants: replay ? [{ binding: "BACKGROUND", operations: ["admit"] }] : [],
      deadlineAt: now + 60_000,
      ancestry: [],
    });
  const gate = createInvocationGate({
    now: () => now,
    abortGuest: () => {
      aborts += 1;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  for (let step = 0; step < 3; step++) {
    const entered = Promise.withResolvers<undefined>();
    const exchange = Promise.withResolvers<undefined>();
    const syncing = gate
      .run(facts(true, step + 1), {}, async (frame) => {
        entered.resolve(undefined);
        await exchange.promise;
        assert.equal(gate.active(frame.frameId), frame);
        completedSteps += 1;
      })
      .then(
        () => ({ kind: "completed" as const }),
        (cause: unknown) => ({ kind: "failed" as const, cause }),
      );
    await entered.promise;
    const abortsBeforePoll = aborts;
    now += 1000;
    let readEntered = false;
    const poll = gate.run(facts(false, step + 1), {}, () => {
      readEntered = true;
      // No second replay step has entered before the queued read.
      assert.equal(completedSteps, step + 1);
      return Promise.resolve();
    });
    try {
      // A read waits without interrupting the still-running replay.
      assert.equal(aborts, abortsBeforePoll);
      assert.equal(readEntered, false);
      exchange.resolve(undefined);
      assert.deepEqual(await syncing, { kind: "completed" });
      await poll;
      assert.equal(readEntered, true);
    } finally {
      exchange.resolve(undefined);
      await Promise.allSettled([syncing, poll]);
    }
  }
  assert.equal(completedSteps, 3);
  assert.equal(aborts, 6);
});

await test("a click preempts a held replay, closes its authority, then enters with fresh facts", async () => {
  const instanceId = instanceIds.instance.generate();
  const selection = {
    instanceId,
    owner: { kind: "installation", id: "notes" },
    appId: "app_notes",
    releaseId: "rel_example",
    authorityVersion: 1,
  };
  const replay = Schema.decodeUnknownSync(invocationFactsSchema)({
    instanceId,
    selection,
    artifactDigest: `sha256:${"1".repeat(64)}`,
    subject: {
      kind: "call",
      context: {
        actor: { kind: "member", memberId: "member_one" },
        computerId: null,
        role: "member",
      },
      method: { name: "continueWrites", effect: "write" },
      replay: { lane: "member:member_one", epoch: 1, admitted: ["save"] },
    },
    grants: [
      { binding: "GIT", operations: ["write"] },
      { binding: "BACKGROUND", operations: ["admit"] },
    ],
    deadlineAt: Date.now() + 60_000,
    ancestry: [],
  });
  const click: InvocationFacts = {
    ...replay,
    grants: [],
    subject: {
      kind: "call",
      context: {
        actor: { kind: "member", memberId: "member_two" },
        computerId: null,
        role: "member",
      },
      method: { name: "save", effect: "write" },
    },
  };
  const entered = Promise.withResolvers<undefined>();
  const push = Promise.withResolvers<undefined>();
  const cleanup = Promise.withResolvers<undefined>();
  const late = Promise.withResolvers<undefined>();
  let lateEffects = 0;
  let aborts = 0;
  let closed = 0;
  let clicked = false;
  let retained = "";
  const gate = createInvocationGate({
    abortGuest: () => {
      aborts += 1;
      return Promise.resolve();
    },
    close: async (frame) => {
      if (frame.facts.subject.kind === "call" && frame.facts.subject.replay)
        await cleanup.promise;
      closed += 1;
    },
  });
  const syncing = gate.run(replay, {}, async (frame) => {
    retained = frame.frameId;
    entered.resolve(undefined);
    await push.promise;
    // A late push continuation cannot borrow the next click's authority.
    try {
      assert.throws(
        () => {
          frame.signal.throwIfAborted();
          lateEffects += 1;
        },
        { code: "revoked" },
      );
    } finally {
      late.resolve(undefined);
    }
  });
  const refused = assert.rejects(
    syncing,
    (cause: Error) =>
      cause instanceof AppInstanceError && cause.code === "revoked",
  );
  await entered.promise;
  const next = gate.run(click, {}, async (frame) => {
    clicked = true;
    assert.equal(closed, 1);
    assert.notEqual(frame.frameId, retained);
    assert.deepEqual(gate.active(frame.frameId).facts.grants, []);
    assert.deepEqual(frame.facts.subject, click.subject);
    push.resolve(undefined);
    await late.promise;
    assert.equal(lateEffects, 0);
  });
  try {
    // Count abort at the admission boundary, without releasing the held push.
    assert.equal(aborts, 1);
    assert.equal(clicked, false);
    assert.throws(() => gate.active(retained), { code: "revoked" });
    cleanup.resolve(undefined);
    await next;
    assert.equal(clicked, true);
    await refused;
  } finally {
    cleanup.resolve(undefined);
    push.resolve(undefined);
    await Promise.allSettled([syncing, next, refused]);
  }
  // Both the preempted replay and the completed click stop their guest.
  assert.equal(aborts, 2);
  assert.equal(closed, 2);
});

await test("the host fact builder captures verified metadata and refuses replay enqueue eligibility", () => {
  const instanceId = instanceIds.instance.generate();
  const authority = {
    instanceId,
    selection: {
      instanceId,
      owner: { kind: "installation" as const, id: "notes" },
      appId: "app_notes" as const,
      releaseId: "rel_example" as const,
      authorityVersion: 1,
    },
    artifactDigest: `sha256:${"1".repeat(64)}` as const,
    grants: [],
    ancestry: [],
  };
  // Decode authority through the owning codec; no guest chooses this context.
  const reference = Schema.decodeUnknownSync(invocationFactsSchema)({
    ...authority,
    subject: {
      kind: "call",
      context: {
        computerId: null,
        actor: { kind: "member", memberId: "member_one" },
      },
    },
    deadlineAt: Date.now() + 60_000,
  });
  const verified = {
    instanceId: reference.instanceId,
    selection: reference.selection,
    artifactDigest: reference.artifactDigest,
    grants: reference.grants,
    ancestry: reference.ancestry,
  };
  const deadlineAt = reference.deadlineAt;
  const context = {
    computerId: null,
    actor: { kind: "member" as const, memberId: "member_one" },
    backgroundLane: "member:member_one",
    backgroundOrigin: { method: "save", seal: "A".repeat(43) },
  };
  const facts = invocationFacts.fromCaller(
    verified,
    context,
    { deadlineAt, grantExpiresAt: deadlineAt },
    { name: "save", effect: "write" },
  );
  assert.equal(facts.subject.kind, "call");
  assert.deepEqual(facts.subject.method, { name: "save", effect: "write" });
  assert.equal(facts.subject.context.backgroundLane, "member:member_one");
  const policy = {
    policyRevision: "policy-approved-1",
    grantorMemberId: "member_one",
  };
  const agentFacts = invocationFacts.fromCaller(
    verified,
    { computerId: null, actor: { kind: "agent", agentId: "agent_one" } },
    { deadlineAt, grantExpiresAt: deadlineAt },
    { name: "save", effect: "write" },
    "session_one",
    policy,
  );
  assert.equal(agentFacts.subject.kind, "call");
  assert.deepEqual(agentFacts.subject.method, {
    name: "save",
    effect: "write",
  });
  assert.equal(agentFacts.subject.sessionId, "session_one");
  assert.deepEqual(agentFacts.subject.agentPolicy, policy);
  assert.throws(() =>
    invocationFacts.fromCaller(
      verified,
      context,
      { deadlineAt, grantExpiresAt: deadlineAt },
      { name: "save", effect: "write" },
      "session_one",
      policy,
    ),
  );
  for (const agentPolicy of [
    { policyRevision: "policy-approved-1" },
    { grantorMemberId: "member_one" },
    { policyRevision: "", grantorMemberId: "member_one" },
    { policyRevision: "policy-approved-1", grantorMemberId: "" },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(invocationFactsSchema)({
        ...agentFacts,
        subject: { ...agentFacts.subject, agentPolicy },
      }),
    );
  }

  assert.throws(() =>
    Schema.decodeUnknownSync(invocationFactsSchema)({
      ...facts,
      grants: [{ binding: "BACKGROUND", operations: ["admit"] }],
      subject: {
        ...facts.subject,
        replay: { lane: "member:member_one", epoch: 1, admitted: ["save"] },
      },
    }),
  );
});

function agentPolicyFrame() {
  const instanceId = instanceIds.instance.generate();
  return {
    instanceId,
    selection: {
      instanceId,
      owner: { kind: "installation", id: "notes" },
      appId: "app_notes",
      releaseId: "rel_example",
      authorityVersion: 1,
    },
    artifactDigest: `sha256:${"1".repeat(64)}`,
    subject: {
      kind: "call",
      context: {
        computerId: null,
        actor: { kind: "agent", agentId: "agent_one" },
      },
      agentPolicy: {
        policyRevision: "policy_one",
        grantorMemberId: "member_one",
      },
    },
    grants: [],
    deadlineAt: Date.now() + 60_000,
    ancestry: [],
  };
}

await test("a live frame keeps its captured Agent policy immutable", async () => {
  const facts = Schema.decodeUnknownSync(invocationFactsSchema)(
    agentPolicyFrame(),
  );
  const gate = createInvocationGate({
    abortGuest: () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
  await gate.run(facts, {}, (frame) => {
    assert.equal(frame.facts.subject.kind, "call");
    const policy = frame.facts.subject.agentPolicy;
    assert.ok(policy);
    assert.equal(Object.isFrozen(policy), true);
    assert.throws(() => {
      Object.assign(policy, { policyRevision: "changed" });
    }, TypeError);
    assert.equal(policy.policyRevision, "policy_one");
    return Promise.resolve();
  });
});

for (const { name, agentPolicy } of [
  {
    name: "extra key",
    agentPolicy: {
      policyRevision: "policy_one",
      grantorMemberId: "member_one",
      agentId: "other",
    },
  },
  { name: "non-object", agentPolicy: "policy_one" },
]) {
  await test(`the strict frame boundary refuses an Agent policy with ${name}`, () => {
    const facts = agentPolicyFrame();
    assert.throws(() =>
      Schema.decodeUnknownSync(invocationFactsSchema, {
        onExcessProperty: "error",
      })({
        ...facts,
        subject: { ...facts.subject, agentPolicy },
      }),
    );
  });
}

await test("the frame boundary refuses an Agent policy on a team-key actor", () => {
  const facts = agentPolicyFrame();
  assert.throws(() =>
    Schema.decodeUnknownSync(invocationFactsSchema, {
      onExcessProperty: "error",
    })({
      ...facts,
      subject: {
        ...facts.subject,
        context: {
          computerId: null,
          actor: { kind: "team-key", keyId: "key_one" },
        },
      },
    }),
  );
});
