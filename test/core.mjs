const memberCaller = {
  computerId: null,
  actor: { kind: "member", memberId: "member_fixture" },
};
/* global structuredClone, Response, Request, console */
import { appFacetRequest } from "../dist/backend-request.js";
import {
  appBackendActorHeader,
  appBackendComputerHeader,
} from "@fungi.computer/agar/backend";
import assert from "node:assert/strict";
import { appCatalogEntrySchema } from "@fungi.computer/nacre/app-directory";

const repositoryParam = {
  key: "repository",
  label: "Repository",
  kind: "repository",
  required: true,
  options: "repos.list",
};
assert.deepEqual(
  appCatalogEntrySchema.parse({
    appId: "app_notes",
    surfaceId: "notes",
    gills: [{ id: "entries", title: "Entries", params: [repositoryParam] }],
  }).gills[0].params,
  [repositoryParam],
  "The desktop catalog carries the App's placement and options declaration",
);
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import {
  createAppInstance,
  instanceIds,
  selectionSchema,
} from "../dist/index.js";
import * as Schema from "effect/Schema";
import {
  createInvocationGate,
  invocationFactsSchema,
  APP_INVOCATION_CEILING_MS,
} from "../dist/invocation.js";
const instanceId = instanceIds.instance.generate();
let record = null;
let purgeFails = false;
let writeCount = 0;
let abortCount = 0;
const resolvedReleaseIds = [];
const connectedReleaseIds = [];
const gillInputs = [];
const digestFor = (releaseId) => {
  const content =
    releaseId === "rel_notesv1" || releaseId === "rel_notesv2" ? "a" : "b";
  return `sha256:${content.repeat(64)}`;
};
const ports = {
  boot: () => Effect.void,
  instanceId,
  read: () => Effect.succeed(record),
  write: (value) =>
    Effect.sync(() => {
      writeCount += 1;
      record = structuredClone(value);
    }),
  resolve: (releaseId) => {
    resolvedReleaseIds.push(releaseId);
    return releaseId === "rel_revoked"
      ? Effect.fail(new Error("Release revoked"))
      : Effect.succeed({
          release: {
            releaseId,
            appId: releaseId === "rel_foreign" ? "app_other" : "app_notes",
          },
          digest: digestFor(releaseId),
          backend: {
            runtime: { stateSchema: releaseId === "rel_schema2" ? 2 : 1 },
          },
        });
  },
  abort: () =>
    Effect.sync(() => {
      abortCount += 1;
    }),
  purge: () =>
    purgeFails ? Effect.fail(new Error("interrupted purge")) : Effect.void,
  connect: (backend, frame) => {
    connectedReleaseIds.push(backend.release.releaseId);
    return Effect.succeed({
      fetch: (request) =>
        Effect.succeed(
          new Response(
            JSON.stringify({
              headers: [...request.headers.entries()],
              method: request.method,
              body: request.body === null ? null : "present",
            }),
          ),
        ),
      call: (_name, input) => {
        assert.equal(frame.facts.subject.kind, "call");
        assert.deepEqual(frame.facts.subject.context, memberCaller);
        return Effect.succeed({ kind: "ok", value: input });
      },
      gill: (input) => {
        assert.equal(frame.facts.subject.kind, "call");
        assert.deepEqual(frame.facts.subject.context, memberCaller);
        gillInputs.push(input);
        return Effect.succeed({
          viewId: input.id,
          title: "Entries",
          state: "empty",
          rows: [],
        });
      },
    });
  },
};
const receivedPushes = [];
const refusedSyncs = [];
ports.connect = (
  (connect) => (backend, frame) =>
    connect(backend, frame).pipe(
      Effect.map((connection) => ({
        ...connection,
        onGitPush: (fact) => Effect.sync(() => receivedPushes.push(fact)),
        syncRefused: (refusal) => Effect.sync(() => refusedSyncs.push(refusal)),
      })),
    )
)(ports.connect);
const selected = {
  instanceId,
  appId: "app_notes",
  releaseId: "rel_notesv1",
  authorityVersion: 1,
  owner: { kind: "installation", id: "installation_notes" },
  status: "enabled",
};
const run = Effect.runPromise;
async function expectFailure(effect, code) {
  const outcome = await run(Effect.result(effect));
  assert.equal(outcome._tag, "Failure");
  if (outcome._tag === "Failure") assert.equal(outcome.failure.code, code);
}
let runtime = createAppInstance(ports);
// This fixture host admits its known caller and verified backend before opening
// the same frame gate that production hosts use; Selection alone is no authority.
const gate = createInvocationGate({
  abortGuest: () => Promise.resolve(),
  close: () => Promise.resolve(),
});
const inFrame = (selection, subject, work) => {
  const facts = Schema.decodeUnknownSync(invocationFactsSchema)({
    instanceId,
    selection: Schema.decodeUnknownSync(selectionSchema)(selection),
    artifactDigest: digestFor(selection.releaseId),
    subject,
    grants: [],
    ancestry: [],
    deadlineAt: Date.now() + APP_INVOCATION_CEILING_MS,
  });
  return Effect.tryPromise({
    try: () => gate.run(facts, {}, (frame) => run(Effect.result(work(frame)))),
    catch: (error) =>
      error instanceof Error ? error : new Error("Fixture frame failed"),
  }).pipe(
    Effect.flatMap((result) =>
      result._tag === "Success"
        ? Effect.succeed(result.success)
        : Effect.fail(result.failure),
    ),
  );
};
const fetchAsMember = (selection, request) =>
  inFrame(selection, { kind: "call", context: memberCaller }, (frame) =>
    runtime.fetch(frame, request),
  );
const callAsMember = (selection, api, name, input) =>
  inFrame(selection, { kind: "call", context: memberCaller }, (frame) =>
    runtime.call(frame, api, name, input),
  );
const deliverPush = (selection, fact) =>
  inFrame(
    selection,
    { kind: "lifecycle", name: "onGitPush", eventId: fact.eventId },
    (frame) => runtime.onGitPush(frame, fact),
  );
await run(runtime.apply(selected));
const pushFact = {
  repository: "notes",
  writer: { kind: "actor", actor: { kind: "agent", agentId: "agent_fixture" } },
  updates: [
    { ref: "refs/heads/main", before: "0".repeat(40), after: "a".repeat(40) },
  ],
  eventId: "push_fixture",
};
await run(deliverPush(selected, pushFact));
assert.deepEqual(receivedPushes, [pushFact]);
await assert.rejects(
  run(deliverPush({ ...selected, authorityVersion: 2 }, pushFact)),
);
assert.equal(receivedPushes.length, 1);
const syncRefusal = { lane: "member:member_fixture", code: "access_changed" };
await run(
  inFrame(
    selected,
    { kind: "lifecycle", name: "syncRefused", ...syncRefusal },
    (frame) => runtime.syncRefused(frame, syncRefusal),
  ),
);
assert.deepEqual(refusedSyncs, [syncRefusal]);
await expectFailure(
  inFrame(
    selected,
    { kind: "lifecycle", name: "syncRefused", ...syncRefusal },
    (frame) =>
      runtime.syncRefused(frame, { ...syncRefusal, lane: "member:other" }),
  ),
  "invalid_invocation_facts",
);
assert.deepEqual(refusedSyncs, [syncRefusal]);
await expectFailure(
  inFrame(selected, { kind: "call", context: memberCaller }, (frame) =>
    runtime.syncRefused(frame, syncRefusal),
  ),
  "invalid_invocation_facts",
);
const api = {
  methods: {
    echo: {
      description: "Echo input",
      input: { type: "object" },
      output: { type: "object" },
      effect: "read",
      requires: [],
    },
  },
};
assert.deepEqual(
  await run(callAsMember(selected, api, "echo", { text: "hello" })),
  { kind: "ok", value: { text: "hello" } },
);
// The verified method metadata used by the close hook must match execution.
for (const method of [
  { name: "different", effect: "read" },
  { name: "echo", effect: "write" },
]) {
  await expectFailure(
    inFrame(
      selected,
      { kind: "call", context: memberCaller, method },
      (frame) => runtime.call(frame, api, "echo", {}),
    ),
    "invalid_invocation_facts",
  );
}
const gillInput = {
  id: "entries",
  params: { repository: "notes" },
  after: "page-two",
};
assert.deepEqual(
  await run(
    inFrame(selected, { kind: "call", context: memberCaller }, (frame) =>
      runtime.gill(frame, api, "echo", gillInput),
    ),
  ),
  { viewId: "entries", title: "Entries", state: "empty", rows: [] },
);
assert.deepEqual(gillInputs, [gillInput]);
await assert.rejects(
  run(
    inFrame(selected, { kind: "call", context: memberCaller }, (frame) =>
      runtime.gill(frame, api, "missing", gillInput),
    ),
  ),
  /Gill source must be a declared read method/,
);
await assert.rejects(
  run(
    inFrame(selected, { kind: "call", context: memberCaller }, (frame) =>
      runtime.gill(
        frame,
        {
          methods: { echo: { ...api.methods.echo, effect: "write" } },
        },
        "echo",
        gillInput,
      ),
    ),
  ),
  /Gill source must be a declared read method/,
);
assert.equal(gillInputs.length, 1, "Refused sources never enter the guest");
await assert.rejects(
  run(callAsMember(selected, api, "missing", {})),
  /App method not declared/,
);
await assert.rejects(
  run(callAsMember(selected, api, "constructor", {})),
  /App method not declared/,
);
for (const [selection, reason] of [
  [
    { ...selected, owner: { ...selected.owner, id: "installation_other" } },
    "instance_owner_mismatch",
  ],
  [{ ...selected, appId: "app_other" }, "instance_owner_mismatch"],
  [{ ...selected, authorityVersion: 2 }, "instance_authority_version_mismatch"],
]) {
  await expectFailure(callAsMember(selection, api, "echo", {}), reason);
  await expectFailure(
    fetchAsMember(selection, new Request("https://notes.local")),
    reason,
  );
}
const ownerRecordBeforePreviewRelease = structuredClone(record);
const lifecycleEffectsBeforePreviewRelease = [writeCount, abortCount];
const resolvedBeforePreviewRelease = resolvedReleaseIds.length;
const connectedBeforePreviewRelease = connectedReleaseIds.length;
for (const releaseId of ["rel_notesv2", selected.releaseId]) {
  const response = await run(
    fetchAsMember(
      { ...selected, releaseId },
      new Request("https://notes.local"),
    ),
  );
  assert.equal((await response.json()).method, "GET");
}
const guarded = await run(
  fetchAsMember(
    selected,
    new Request("https://notes.local/operation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agar-Actor-Id": "actor_fixture",
        "X-Agar-Admitted-Resource": "inbox",
        "x-test-admission": "synthetic-private-selection",
        authorization: "Bearer synthetic-secret",
        cookie: "session=synthetic-secret",
      },
      body: '{"note":"hello"}',
    }),
  ),
);
assert.deepEqual(await guarded.json(), {
  headers: [
    ["content-type", "application/json"],
    ["x-agar-actor-id", "actor_fixture"],
  ],
  method: "POST",
  body: "present",
});
assert.deepEqual(resolvedReleaseIds.slice(resolvedBeforePreviewRelease), [
  selected.releaseId,
  "rel_notesv2",
  selected.releaseId,
  selected.releaseId,
]);
console.log(
  "App runtime forwards only Content-Type and admitted actor/Computer headers",
);
await expectFailure(
  fetchAsMember(
    { ...selected, releaseId: "rel_notesv3" },
    new Request("https://notes.local"),
  ),
  "instance_release_mismatch",
);
await expectFailure(
  fetchAsMember(
    { ...selected, releaseId: "rel_schema2" },
    new Request("https://notes.local"),
  ),
  "release_no_longer_matches_instance",
);
await assert.rejects(
  run(
    fetchAsMember(
      { ...selected, releaseId: "rel_revoked" },
      new Request("https://notes.local"),
    ),
  ),
  /Release revoked/,
);
assert.deepEqual(connectedReleaseIds.slice(connectedBeforePreviewRelease), [
  "rel_notesv2",
  selected.releaseId,
  selected.releaseId,
]);
assert.deepEqual(await run(runtime.inspect()), ownerRecordBeforePreviewRelease);
assert.deepEqual(
  [writeCount, abortCount],
  lifecycleEffectsBeforePreviewRelease,
);
console.log(
  "Same-digest promoted Releases preserve admitted versions; changed or revoked backends remain unavailable",
);
await assert.rejects(
  run(
    runtime.apply({
      ...selected,
      instanceId: instanceIds.instance.generate(),
      authorityVersion: 2,
    }),
  ),
);
await assert.rejects(
  run(
    runtime.apply({
      ...selected,
      releaseId: "rel_schema2",
      authorityVersion: 2,
    }),
  ),
);
assert.equal(record.status, "active");
const deleted = { ...selected, status: "deleted", authorityVersion: 2 };
purgeFails = true;
await assert.rejects(run(runtime.apply(deleted)));
assert.equal(record.status, "deleting");
purgeFails = false;
runtime = createAppInstance(ports);
const deletion = await run(runtime.apply(deleted));
assert.equal(deletion.status, "deleted");
await expectFailure(
  fetchAsMember(selected, new Request("https://notes.local")),
  "instance_inactive",
);
assert.deepEqual(await run(runtime.apply(deleted)), deletion);
await assert.rejects(run(runtime.apply({ ...selected, authorityVersion: 3 })));

// Latest owner state can arrive before the first resource delivery.
for (const status of ["disabled", "deleted"]) {
  record = null;
  runtime = createAppInstance(ports);
  const latest = {
    ...selected,
    releaseId: "rel_notesv2",
    authorityVersion: 3,
    status,
  };
  const receipt = await run(runtime.apply(latest));
  assert.equal(receipt.authorityVersion, 3);
  assert.equal(receipt.status, status);
  runtime = createAppInstance(ports);
  assert.deepEqual(await run(runtime.apply(latest)), receipt);
  await assert.rejects(
    run(fetchAsMember(latest, new Request("https://notes.local"))),
  );
  if (status === "disabled") {
    assert.equal(
      (
        await run(
          runtime.apply({ ...latest, status: "enabled", authorityVersion: 4 }),
        )
      ).status,
      "active",
    );
  }
}
record = null;
let failAbort = true;
const interrupted = {
  ...ports,
  abort: () =>
    failAbort ? Effect.fail(new Error("interrupted abort")) : Effect.void,
};
runtime = createAppInstance(interrupted);
await assert.rejects(run(runtime.apply(selected)));
assert.equal(record.status, "disabled");
failAbort = false;
runtime = createAppInstance(interrupted);
const receipt = await run(runtime.apply(selected));
assert.equal(receipt.status, "active");
assert.deepEqual(await run(runtime.apply(selected)), receipt);
const disabled = { ...selected, status: "disabled", authorityVersion: 2 };
await run(runtime.apply(disabled));
await assert.rejects(run(runtime.apply(selected)));
await assert.rejects(run(runtime.apply({ ...disabled, status: "enabled" })));
// An undelivered release selection followed by disable must not require old release equality.
assert.equal(
  (
    await run(
      runtime.apply({
        ...disabled,
        releaseId: "rel_notesv2",
        authorityVersion: 4,
      }),
    )
  ).releaseId,
  "rel_notesv2",
);
console.log(
  "Owner-version exact replay, coalesced first delivery, purge recovery and schema fencing passed",
);

for (const status of ["disabled", "deleted"]) {
  record = null;
  const started = await run(Deferred.make());
  const response = await run(Deferred.make());
  let inFlight = false;
  runtime = createAppInstance({
    ...ports,
    connect: () =>
      Effect.succeed({
        fetch: () =>
          Effect.gen(function* () {
            inFlight = true;
            yield* Deferred.succeed(started, undefined);
            return yield* Deferred.await(response);
          }),
        call: () => Effect.fail(new Error("No named methods")),
        gill: () => Effect.fail(new Error("No Gills")),
      }),
    abort: () =>
      inFlight
        ? Deferred.fail(response, new Error("native connection aborted")).pipe(
            Effect.asVoid,
          )
        : Effect.void,
  });
  await run(runtime.apply(selected));
  const stoppedRequest = assert.rejects(
    run(fetchAsMember(selected, new Request("https://notes.local"))),
    /native connection aborted/,
  );
  await run(Deferred.await(started));
  const stopped = await run(
    runtime
      .apply({ ...selected, status, authorityVersion: 2 })
      .pipe(Effect.timeout("2 seconds")),
  );
  assert.equal(stopped.status, status);
  await stoppedRequest;
}
console.log(
  "Owner disable/delete abort pending responses without waiting for them",
);

const scoped = appFacetRequest(
  new Request("https://app.internal/", {
    headers: {
      "Content-Type": "application/json",
      [appBackendActorHeader]: "user_one",
      [appBackendComputerHeader]: "computer_a",
      Authorization: "untrusted",
      "X-Arbitrary": "untrusted",
    },
  }),
);
assert.equal(scoped.headers.get(appBackendComputerHeader), "computer_a");
assert.equal(scoped.headers.get(appBackendActorHeader), "user_one");
assert.equal(scoped.headers.get("Content-Type"), "application/json");
assert.equal(scoped.headers.get("Authorization"), null);
assert.equal(scoped.headers.get("X-Arbitrary"), null);
