/* global Request, fetch, btoa, console */
import assert from "node:assert/strict";
import { TextEncoder } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import * as Effect from "effect/Effect";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { createOyster, sha256 } from "../dist/host.js";
import { deliverGitPush } from "../dist/internal/delivery.js";
import { createAppInstance, instanceIds } from "../dist/index.js";
import { createGitDoor, createAdmittedGit } from "../dist/git.js";
import { parseReceivePack } from "@fungi.computer/agar/git-wire";
import { createInvocationGate } from "../dist/invocation.js";

const memberWriter = {
  kind: "actor",
  actor: { kind: "member", memberId: "member_fixture" },
};
function storeWith(exchange) {
  const unused = () =>
    Promise.reject(new Error("Unexpected Git object operation"));
  return {
    create: unused,
    fork: unused,
    cloneUrl: unused,
    info: unused,
    delete: unused,
    log: unused,
    readCommit: unused,
    readTree: unused,
    readBlob: unused,
    refs: unused,
    exchange,
  };
}
import { presentedGitKey } from "../dist/git-auth.js";
import { attemptWebhook } from "../dist/webhook-delivery.js";

const key = (authorization) =>
  presentedGitKey(
    new Request("https://oyster.example", {
      headers: authorization === null ? {} : { Authorization: authorization },
    }),
  );
assert.deepEqual(key(null), { kind: "absent" });
for (const value of [
  "Basic %%%",
  `Basic ${btoa("no-colon")}`,
  `Basic ${btoa("user:")}`,
  "Bearer ",
  "Digest opaque",
])
  assert.deepEqual(key(value), { kind: "invalid" });
assert.deepEqual(key("Bearer fixture-key"), {
  kind: "key",
  value: "fixture-key",
});
assert.deepEqual(key(`Basic ${btoa("git:fixture:key")}`), {
  kind: "key",
  value: "fixture:key",
});

const server = createServer((request, response) => {
  if (request.url === "/disconnect") {
    request.socket.destroy();
    return;
  }
  if (request.url === "/repo/git-receive-pack") {
    response.writeHead(200);
    const pkt = (text) =>
      (text.length + 4).toString(16).padStart(4, "0") + text;
    response.end(pkt("unpack ok\n") + pkt("ok refs/heads/main\n") + "0000");
    return;
  }
  assert.equal(request.method, "POST");
  assert.ok(request.headers["webhook-signature"]);
  response.writeHead(request.url === "/refused" ? 503 : 204);
  response.end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  assert.ok(address);
  const origin = `http://127.0.0.1:${address.port}`;
  const pushes = [];
  const questions = [];
  const tips = new Map();
  const exchange = async (_repository, request) => {
    const response = await fetch(origin + "/repo/git-receive-pack", {
      method: "POST",
      body: request.body,
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: new Uint8Array(await response.arrayBuffer()),
    };
  };
  const admittedGit = createAdmittedGit({
    installationId: "fixture",
    store: storeWith(exchange),
    grants: { admits: async () => true },
    policy: {
      authorize: async (question) => {
        questions.push(question);
        return { allowed: true };
      },
    },
    journal: {
      tip: async (_name, ref) => tips.get(ref) ?? null,
      record: async (fact) => {
        pushes.push({ installationId: "fixture", fact });
        for (const update of fact.updates) {
          if (update.after === "0".repeat(40)) tips.delete(update.ref);
          else tips.set(update.ref, update.after);
        }
      },
    },
  });
  const door = createGitDoor({
    authenticate: async () => memberWriter,
    isPublic: async () => false,
    git: async () => admittedGit,
  });
  const pkt = (text) => (text.length + 4).toString(16).padStart(4, "0") + text;
  const pushBody =
    pkt(
      "0".repeat(40) +
        " " +
        "a".repeat(40) +
        " refs/heads/main\0report-status\n",
    ) + "0000";
  const pending = [];
  const execution = {
    waitUntil: (work) => pending.push(work),
    passThroughOnException() {
      throw new Error("Fixture does not pass through exceptions");
    },
  };
  const resetBody =
    pkt(
      "a".repeat(40) +
        " " +
        "0".repeat(40) +
        " refs/heads/main\0report-status\n",
    ) + "0000";
  const bodies = [pushBody, resetBody, pushBody];
  for (let attempt = 0; attempt < bodies.length; attempt++) {
    const response = await door.request(
      "/git/fixture/trellis.git/git-receive-pack",
      {
        method: "POST",
        body: bodies[attempt],
      },
      {},
      execution,
    );
    assert.equal(response.status, 200);
    await Promise.all(pending.splice(0));
    assert.equal(pushes.length, attempt + 1);
  }
  assert.equal(questions.length, 3);
  assert.ok(
    questions.every(
      (question) => question.writer.actor.memberId === "member_fixture",
    ),
  );
  assert.equal(pushes[0].installationId, "fixture");
  assert.deepEqual(pushes[0].fact, {
    repository: "trellis",
    writer: memberWriter,
    updates: [
      { ref: "refs/heads/main", before: "0".repeat(40), after: "a".repeat(40) },
    ],
    eventId: pushes[0].fact.eventId,
  });
  assert.ok(pushes[0].fact.eventId);
  assert.notEqual(
    pushes[2].fact.eventId,
    pushes[0].fact.eventId,
    "distinct accepted pushes after a reset never share an event identity",
  );
  // Real standalone host -> selected Instance runtime; the backend rail
  // authorizes only and never receives the old push POST.
  const artifacts = new Map();
  const put = async (bytes) => {
    const digest = await sha256(bytes);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    artifacts.set(artifactRef, bytes);
    return { artifactRef, digest, byteLength: bytes.byteLength };
  };
  const uiBytes = new globalThis.TextEncoder().encode(
    "<!doctype html><title>Git</title>",
  );
  const ui = {
    ...(await put(uiBytes)),
    version: "fixture",
    byteLength: uiBytes.length,
    mediaType: "text/html; charset=utf-8",
  };
  const backend = {
    ...(await put(
      new TextEncoder().encode(
        JSON.stringify({
          runtime: { kind: "durable-facet", stateSchema: 1 },
          compatibilityDate: "2026-09-04",
          exportName: "Guest",
          code: "export class Guest {}",
        }),
      ),
    )),
    mediaType: backendMediaType,
    version: "fixture",
  };
  const root = await put(
    new globalThis.TextEncoder().encode(
      JSON.stringify(
        createAppBuild(ui, backend, {
          capabilities: ["git.repository"],
          handlers: [],
          roles: [],
          receives: ["git.push"],
        }),
      ),
    ),
  );
  const release = {
    appId: "app_fixture",
    releaseId: "rel_fixture",
    artifact: {
      artifactRef: root.artifactRef,
      artifactDigest: root.digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: root.digest,
        buildRecipeDigest: root.digest,
      },
    },
  };
  const installation = {
    installationId: "fixture",
    instanceId: instanceIds.instance.generate(),
    release,
    authorityVersion: 1,
    status: "enabled",
  };
  const selected = {
    instanceId: installation.instanceId,
    appId: release.appId,
    releaseId: release.releaseId,
    authorityVersion: 1,
    owner: { kind: "installation", id: "fixture" },
    status: "enabled",
  };
  let stored = null;
  const runtimePushes = [];
  const runtimeQuestions = [];
  const runtime = createAppInstance({
    instanceId: installation.instanceId,
    read: () => Effect.succeed(stored),
    write: (value) =>
      Effect.sync(() => {
        stored = value;
      }),
    abort: () => Effect.void,
    purge: () => Effect.void,
    resolve: () =>
      Effect.succeed({
        release,
        digest: backend.digest,
        backend: { runtime: { stateSchema: 1 } },
      }),
    connect: () =>
      Effect.succeed({
        authorizeGitPush: (question) =>
          Effect.sync(() => {
            runtimeQuestions.push(question);
            return { allowed: true };
          }),
        onGitPush: (fact) =>
          Effect.sync(() => {
            runtimePushes.push(fact);
          }),
      }),
  });
  await Effect.runPromise(runtime.apply(selected));
  const gate = createInvocationGate({
    abortGuest: () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
  const authority = (selection, subject) => ({
    instanceId: installation.instanceId,
    selection: {
      instanceId: selection.instanceId,
      owner: selection.owner,
      appId: selection.appId,
      releaseId: selection.releaseId,
      authorityVersion: selection.authorityVersion,
    },
    artifactDigest: backend.digest,
    subject,
    grants: [],
    ancestry: [],
    deadlineAt: Date.now() + 60_000,
  });
  const handle = {
    onGitPush: (facts, fact) =>
      gate.run(facts, {}, (frame) =>
        Effect.runPromise(runtime.onGitPush(frame, fact)),
      ),
  };
  const lifecycleFacts = (selection, fact) =>
    authority(selection, {
      kind: "lifecycle",
      name: "onGitPush",
      eventId: fact.eventId,
    });
  const runtimePolicy = (question) =>
    gate.run(
      authority(selected, {
        kind: "call",
        context: { computerId: null, actor: memberWriter.actor },
      }),
      {},
      (frame) => Effect.runPromise(runtime.authorizeGitPush(frame, question)),
    );
  const standaloneHost = {
    auth: {
      authenticate: async () => ({
        kind: "admitted",
        principal: {
          actor: { kind: "member", memberId: "member_fixture" },
          role: "owner",
        },
      }),
    },
    artifacts: {
      get: async (ref) => artifacts.get(ref) ?? null,
      put: async (ref, bytes) => {
        artifacts.set(ref, bytes);
      },
    },
    installations: { get: async () => installation },
    instances: { get: () => handle },
    git: {
      writerOf: () => memberWriter,
      git: async () =>
        createAdmittedGit({
          installationId: "fixture",
          store: storeWith(exchange),
          grants: { admits: async () => true },
          policy: { authorize: runtimePolicy },
          journal: {
            tip: async () => null,
            record: (fact) => deliverGitPush(standaloneHost, "fixture", fact),
          },
        }),
    },
  };
  const standalone = createOyster(standaloneHost);
  standalone.onError((cause) => {
    throw cause;
  });
  const accepted = await standalone.request(
    "/git/fixture/trellis.git/git-receive-pack",
    { method: "POST", body: pushBody },
    {},
    execution,
  );
  assert.equal(accepted.status, 200);
  await Promise.all(pending.splice(0));
  assert.equal(runtimePushes.length, 1);
  assert.equal(runtimeQuestions.length, 1);
  assert.deepEqual(runtimeQuestions[0].writer, memberWriter);
  const retainedFact = runtimePushes[0];
  await handle.onGitPush(lifecycleFacts(selected, retainedFact), retainedFact);
  assert.equal(runtimePushes.length, 2);
  assert.deepEqual(
    runtimePushes[1],
    retainedFact,
    "lifecycle redelivery keeps the accepted fact and eventId",
  );
  await assert.rejects(
    handle.onGitPush(
      lifecycleFacts({ ...selected, authorityVersion: 2 }, retainedFact),
      retainedFact,
    ),
  );
  assert.equal(
    runtimePushes.length,
    2,
    "stale selections do not execute lifecycle handlers",
  );
  const queuedPushes = [];
  const composedGit = {
    writerOf: () => memberWriter,
    git: async () =>
      createAdmittedGit({
        installationId: "fixture",
        store: storeWith(exchange),
        grants: { admits: async () => true },
        policy: { authorize: runtimePolicy },
        journal: {
          tip: async () => null,
          record: async (fact) => {
            queuedPushes.push({ installationId: "fixture", fact });
          },
        },
      }),
  };
  const composed = createOyster({ ...standaloneHost, git: composedGit });
  const queued = await composed.request(
    "/git/fixture/trellis.git/git-receive-pack",
    { method: "POST", body: pushBody },
    {},
    execution,
  );
  assert.equal(queued.status, 200);
  await Promise.all(pending.splice(0));
  assert.equal(
    queuedPushes.length,
    1,
    "the composition receives accepted pushes",
  );
  assert.equal(queuedPushes[0].installationId, "fixture");
  assert.ok(queuedPushes[0].fact.eventId);
  assert.equal(
    runtimePushes.length,
    2,
    "journal composition queues acceptance before lifecycle delivery",
  );

  for (const changed of [
    { ...installation, authorityVersion: 2 },
    { ...installation, instanceId: instanceIds.instance.generate() },
    { ...installation, release: { ...release, releaseId: "rel_changed" } },
    { ...installation, status: "disabled" },
  ]) {
    let reads = 0;
    await assert.rejects(
      deliverGitPush(
        {
          ...standaloneHost,
          installations: {
            get: async () => (++reads === 1 ? installation : changed),
          },
        },
        "fixture",
        queuedPushes[0].fact,
      ),
      /Git push installation changed/u,
    );
    assert.equal(
      runtimePushes.length,
      2,
      "a changed installation cannot execute retained delivery",
    );
    assert.equal(
      queuedPushes.length,
      1,
      "refused delivery preserves its retained journal fact",
    );
  }
  await deliverGitPush(
    { ...standaloneHost, git: composedGit },
    "fixture",
    queuedPushes[0].fact,
  );
  assert.equal(
    runtimePushes.length,
    3,
    "a retained fact reaches the current Instance",
  );
  assert.deepEqual(runtimePushes[2], queuedPushes[0].fact);
  assert.equal(
    queuedPushes.length,
    1,
    "Post delivery never re-enqueues itself",
  );
  let retryReads = 0;
  await assert.rejects(
    deliverGitPush(
      {
        ...standaloneHost,
        installations: {
          get: async () =>
            ++retryReads === 1
              ? installation
              : { ...installation, authorityVersion: 2 },
        },
      },
      "fixture",
      queuedPushes[0].fact,
    ),
    /Git push installation changed/u,
  );
  assert.equal(runtimePushes.length, 3, "retries repeat fresh admission");
  const delivery = {
    id: "event-fixture",
    type: "git.push",
    body: '{"fixture":true}',
  };
  for (const [path, status] of [
    ["/accepted", 204],
    ["/refused", 503],
  ])
    assert.deepEqual(
      await attemptWebhook(
        { url: origin + path, secret: "fixture-signing-key" },
        delivery,
      ),
      { kind: "response", status },
    );
  assert.deepEqual(
    await attemptWebhook(
      { url: origin + "/disconnect", secret: "fixture-signing-key" },
      delivery,
    ),
    { kind: "transport-error" },
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
console.log("oyster git auth refusals and webhook transport outcomes: ok");

// A host with its own admission and durable push journal retains both owners.
{
  let admitted = true;
  const exchanges = [];
  const nativeDoor = createGitDoor({
    authenticate: async () => (admitted ? memberWriter : null),
    isPublic: async () => false,
    git: async (installationId) =>
      createAdmittedGit({
        installationId,
        store: storeWith(async (repository, request) => {
          exchanges.push({
            installationId,
            repository,
            writer: memberWriter,
            request,
          });
          return {
            status: 200,
            headers: {
              "content-type": "application/x-git-upload-pack-advertisement",
            },
            body: new TextEncoder().encode("0000"),
          };
        }),
        grants: { admits: async () => true },
        policy: {
          authorize: async () => {
            throw new Error("Reads must not ask push policy");
          },
        },
        journal: {
          tip: async () => null,
          record: async () => {
            throw new Error("Reads must not record pushes");
          },
        },
      }),
  });
  const url =
    "https://hub.example/git/bonsai/notes.git/info/refs?service=git-upload-pack";
  const opened = await nativeDoor.request(url);
  assert.equal(
    opened.status,
    200,
    "host-owned exchange serves the clone advertisement",
  );
  assert.equal(await opened.text(), "0000");
  assert.deepEqual(exchanges, [
    {
      installationId: "bonsai",
      repository: "notes",
      writer: memberWriter,
      request: {
        service: "upload-pack",
        phase: "advertise",
        headers: {},
        body: null,
      },
    },
  ]);
  admitted = false;
  assert.equal((await nativeDoor.request(url)).status, 401);
  assert.equal(exchanges.length, 1, "revoked client never reaches exchange");
}

// An authenticated Computer/Agent pass is transport admission, not the App's
// permission to update its repository. The App receives every actual command.
{
  const forwarded = [];
  const questions = [];
  const writer = {
    kind: "actor",
    actor: { kind: "agent", agentId: "agent_morel" },
  };
  const update = {
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: "a".repeat(40),
  };
  const policyDoor = createGitDoor({
    authenticate: async () => writer,
    isPublic: async () => false,
    git: async () =>
      createAdmittedGit({
        installationId: "bonsai",
        grants: { admits: async () => true },
        store: storeWith(async (...args) => {
          forwarded.push(args);
          return { status: 200, headers: {}, body: new Uint8Array() };
        }),
        policy: {
          authorize: async (question) => {
            questions.push(question);
            return {
              allowed: false,
              refused: [
                {
                  ref: update.ref,
                  message: "Agents push only to their own fork",
                },
              ],
            };
          },
        },
        journal: {
          tip: async () => null,
          record: async () => {
            throw new Error("Refused push cannot record");
          },
        },
      }),
  });
  const line = `${update.before} ${update.after} ${update.ref}\0report-status\n`;
  const body = (line.length + 4).toString(16).padStart(4, "0") + line + "0000";
  const response = await policyDoor.request(
    "https://hub.example/git/bonsai/canonical.git/git-receive-pack",
    { method: "POST", body },
  );
  assert.equal(
    response.status,
    200,
    "App refuses an Agent push with a native receive-pack report",
  );
  assert.deepEqual(questions, [
    {
      repository: "canonical",
      writer: {
        kind: "actor",
        actor: { kind: "agent", agentId: "agent_morel" },
      },
      updates: [update],
    },
  ]);
  assert.equal(forwarded.length, 0, "refused push never reaches the provider");
}

// A real receive-pack pre-flush section can contain signed push commands.
// Unsupported syntax must never disappear from the authorization question.
{
  const pkt = (line) => (line.length + 4).toString(16).padStart(4, "0") + line;
  const body = new TextEncoder().encode(
    pkt("push-cert\0report-status\n") +
      pkt(`${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\n`) +
      "0000",
  );
  assert.equal(
    parseReceivePack(body).kind,
    "invalid",
    "unsupported push-cert lines cannot be skipped before flush",
  );
}

// Packet bytes are client supplied; trailing NUL fields cannot be discarded.
{
  const line = `${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\0report-status\0hidden-command\n`;
  const body = new TextEncoder().encode(
    (line.length + 4).toString(16).padStart(4, "0") + line + "0000",
  );
  assert.equal(
    parseReceivePack(body).kind,
    "invalid",
    "the complete command packet must be understood before authorization",
  );
}
