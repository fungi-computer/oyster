import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { URL } from "node:url";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { readFile } from "node:fs/promises";
import {
  appBackendBindingKinds,
  createAppBuild,
} from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { contentDigest, catalogMethods } from "@fungi.computer/braid";
import {
  approvedBindingGrants,
  deriveDeclaredOperations,
  applyInstallationCommand,
} from "@fungi.computer/oyster/apps";
import { sha256, verifyRelease } from "@fungi.computer/oyster/host";
import {
  admittedCallerFacts,
  createInvocationGate,
} from "@fungi.computer/oyster/invocation";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";
import { createTriggerRunReservations } from "@fungi.computer/braid/runtime";
import { createMcpWorkflowControl } from "../../src/workflows.ts";
import {
  standaloneWorkflowWebhookRoutes,
  standaloneWorkflowWebhookControls,
} from "../../src/standalone/workflow-webhooks.ts";
import { serveDoors, serveHost } from "../../src/authorization.ts";
import { createWorkflowIndexes } from "../../../../apps/trellis/backend/indexes.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "cloudflare:workers" ||
      specifier === "cloudflare:workflows"
    )
      return {
        url: import.meta
          .resolve("@fungi.computer/oyster/testing/workers-runtime"),
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { StandaloneAgent, StandaloneInstance, StandaloneWorkflowRuns } =
  await import("../../src/standalone/worker.ts");
const { OysterBinding } = await import("../../src/standalone/instance.ts");
const { workflowFrameMethods, dispatchWorkflowBinding } =
  await import("../../src/standalone/workflow-binding.ts");
const { StandaloneTenants, standaloneTenancy } =
  await import("../../src/standalone/tenancy.ts");
const { tenantScope, defaultTenant } =
  await import("@fungi.computer/oyster/tenant");
const { buildAppDeclaration } =
  await import("@fungi.computer/agar/backend-declaration");
const { appBackend } =
  await import("../../../../apps/trellis/backend/methods.ts");
const { default: workflowsMetadata } = await import(
  "../../../../apps/trellis/package.json",
  { with: { type: "json" } }
);
const workflowsDeclaration = buildAppDeclaration(
  appBackend,
  workflowsMetadata.fungi.app,
);
const { instanceIds, appInstanceErrorCodeSchema } =
  await import("@fungi.computer/oyster");
const { createFrameBindingWire } =
  await import("@fungi.computer/oyster/testing");
hooks.deregister();

/**
 * One installed Workflows library over the real standalone run host, plus
 * any `extraInstallationIds` installed at the same release so a graph can
 * bind a node to a second App. `extraEnv.KEYS` lets a caller stand in for
 * the real Ear Tag-backed `OysterKeys` store (S2's own wiring, exercised
 * here only through its `host.keys.live` seam): the default refuses any
 * credential lookup, since no S3 proof authenticates a bearer key.
 */
async function libraryFixture(t, extraEnv = {}, extraInstallationIds = []) {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const background = [];
  t.after(async () => {
    try {
      await Promise.all(background);
    } finally {
      database.close();
    }
  });
  const tenantDatabase = new DatabaseSync(":memory:");
  t.after(() => tenantDatabase.close());
  const tenantStorage = fromNodeSqlite(tenantDatabase);
  tenantStorage.sql.exec(
    "CREATE TABLE fixture_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const tenants = new StandaloneTenants({
    storage: {
      ...tenantStorage,
      get: async (key) => {
        const row = tenantStorage.sql
          .exec("SELECT value FROM fixture_kv WHERE key=?", key)
          .toArray()[0];
        return row === undefined ? undefined : JSON.parse(row.value);
      },
      put: async (key, value) => {
        tenantStorage.sql.exec(
          "INSERT INTO fixture_kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          key,
          JSON.stringify(value),
        );
      },
    },
    blockConcurrencyWhile: (work) => work(),
  });
  const blobs = new Map();
  async function put(value) {
    const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
    const digest = await sha256(bytes);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    blobs.set(artifactRef, bytes);
    return { artifactRef, digest, byteLength: bytes.length, version: digest };
  }
  const backend = {
    ...(await put({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "Trellis",
      code: "export class Trellis {}",
    })),
    mediaType: backendMediaType,
  };
  const root = await put(createAppBuild(null, backend, workflowsDeclaration));
  const release = {
    appId: "app_trellis",
    releaseId: "rel_trellis",
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
  let installation;
  const installations = new Map();
  const created = [];
  const env = {
    OYSTER_ORIGIN: "https://workflow-unit.invalid",
    OYSTER_OWNER_KEY: "local-workflow-fixture-owner-key",
    OYSTER_COMPUTER_ID: "workspace",
    TENANTS: {
      getByName: (name) => {
        assert.equal(name, "registry");
        return tenants;
      },
    },
    KEYS: {
      getByName: () => assert.fail("No credential lookup in owner proof"),
    },
    RELEASES: {
      get: async (ref) => {
        const value = blobs.get(ref);
        return value === undefined
          ? null
          : { arrayBuffer: async () => value.slice().buffer };
      },
    },
    REGISTRY: {
      getByName: () => ({
        selectedComputer: async () => env.OYSTER_COMPUTER_ID,
        get: async (installationId) =>
          installations.get(installationId) ?? null,
        list: async () => [...installations.values()],
      }),
    },
    GRAPH_WORKFLOWS: {
      create: async (request) => {
        created.push(request);
      },
    },
    WORKFLOW_RUNS: {
      getByName: (name) => {
        assert.equal(name, "trellis");
        return runs;
      },
    },
    AI: {
      run: async () => {
        throw new Error("No paid calls in digest proof");
      },
    },
    ...extraEnv,
  };
  const shared = await standaloneTenancy(env);
  const currentOwner = await shared.owner();
  assert.ok(currentOwner);
  // Installation consent derives its snapshot from the root's one composition.
  class RootDoor extends StandaloneAgent {
    hostAt(scope) {
      return this.hostFor(scope);
    }
  }
  const httpHost = await new RootDoor({}, env).hostAt(
    tenantScope(defaultTenant, env.OYSTER_ORIGIN),
  );
  const httpSnapshot = await deriveDeclaredOperations(
    release,
    workflowsDeclaration,
    httpHost.capabilities,
  );
  function installAndApprove(installationId) {
    const context = {
      by: currentOwner.actor,
      role: currentOwner.role,
      expectedVersion: null,
      declaration: workflowsDeclaration,
      declaredOperations: httpSnapshot,
      now: 1000,
      identity: { installationId, instanceId: instanceIds.instance.generate() },
    };
    const installed = applyInstallationCommand(
      null,
      { kind: "install", release, releasePin: "pinned" },
      context,
    );
    assert.equal(installed._tag, "Success");
    // Installation alone is not owner consent for Workflow execution.
    const approved = applyInstallationCommand(
      installed.success.next,
      {
        kind: "change-grants",
        changes: httpSnapshot.capabilities.map(
          ({ capability, operations }) => ({
            capability,
            grant: { operations, resources: "tenant-scope" },
          }),
        ),
      },
      {
        ...context,
        expectedVersion: installed.success.next.authority.authorityVersion,
        now: 1001,
      },
    );
    assert.equal(approved._tag, "Success");
    return approved.success.next;
  }
  installation = installAndApprove("trellis");
  installations.set("trellis", installation);
  assert.equal(
    installation.authority.declaredOperationsDigest,
    httpSnapshot.digest,
  );
  // Extra Apps use the same verified Release and their own explicit approvals.
  for (const extraId of extraInstallationIds)
    installations.set(extraId, installAndApprove(extraId));
  const verified = await verifyRelease(httpHost.artifacts, release);
  const facts = admittedCallerFacts(
    installation,
    verified,
    {
      actor: currentOwner.actor,
      role: "owner",
      computerId: "workspace",
    },
    approvedBindingGrants(installation, workflowsDeclaration),
  );
  const definition = JSON.parse(
    await readFile(
      new URL(
        "../../../../apps/trellis/templates/review.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).definition;
  const runs = new StandaloneWorkflowRuns(
    {
      storage,
      blockConcurrencyWhile: (work) => work(),
      waitUntil: (promise) => {
        background.push(promise);
      },
    },
    env,
  );
  return {
    runs,
    storage,
    control: httpHost.workflows,
    host: httpHost,
    created,
    facts,
    definition,
    ownerId: currentOwner.actor.memberId,
    ownerPrincipal: currentOwner,
    agentFacts: (agentId, sessionId, grantorMemberId) =>
      admittedCallerFacts(
        installation,
        verified,
        { actor: { kind: "agent", agentId }, computerId: "workspace" },
        approvedBindingGrants(installation, workflowsDeclaration),
        [],
        sessionId,
        { policyRevision: `${agentId}:1`, grantorMemberId },
      ),
    // A key never becomes a principal; it arrives as `{kind:"team-key"}`,
    // the same shape `host.keys.live` resolves through S2's own gate.
    keyFacts: (keyId) =>
      admittedCallerFacts(
        installation,
        verified,
        { actor: { kind: "team-key", keyId }, computerId: "workspace" },
        approvedBindingGrants(installation, workflowsDeclaration),
      ),
    // The real method digests the catalog will present for every
    // installation sharing this Release, so a hand-built node can pin them
    // exactly as a real authoring client would after reading the catalog.
    methodDigest: async (methodName) =>
      (await catalogMethods(verified.api.methods)).methods[methodName].digest,
    methodSpec: async (methodName) =>
      (await catalogMethods(verified.api.methods)).methods[methodName],
  };
}

// Admission tracer: the production Git-push delivery supplies this lifecycle
// subject, not a human call context. The build/install template is exercised
// separately; this law isolates the first missing capability admission.
test("Workflows admits an onGitPush lifecycle frame without a forged call context", async (t) => {
  const { runs, created, facts } = await libraryFixture(t);
  const sourceRevision = "git:" + "c".repeat(40);
  const definition = {
    format: "fungi.workflow/v1",
    title: "Accepted main head",
    apps: {},
    input: {
      type: "object",
      properties: { sourceRevision: { type: "string" } },
      required: ["sourceRevision"],
      additionalProperties: false,
    },
    nodes: [
      {
        id: "accepted-head",
        kind: "transform",
        fields: {
          sourceRevision: { from: { node: "$input", port: "sourceRevision" } },
        },
      },
    ],
    edges: [],
    output: {
      sourceRevision: { node: "accepted-head", port: "sourceRevision" },
    },
  };
  const lifecycle = {
    ...facts,
    subject: {
      kind: "lifecycle",
      name: "onGitPush",
      eventId: "accepted-main-push-42",
    },
  };
  const request = {
    requestId: "accepted-main-push-42",
    definition,
    bindings: {},
    input: { sourceRevision },
    published: {
      workflowId: "lifecycle-admission-proof",
      commit: "a".repeat(40),
      digest: await contentDigest(definition),
    },
  };
  const gate = createInvocationGate({
    abortGuest: () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
  const dispatch = (captured, method, args) =>
    gate.run(captured, {}, (frame) =>
      dispatchWorkflowBinding(
        { WORKFLOW_RUNS: { getByName: () => runs } },
        frame,
        {
          instanceId: frame.facts.instanceId,
          frameId: frame.frameId,
          binding: "WORKFLOWS",
        },
        method,
        args,
      ),
    );
  const result = await dispatch(lifecycle, "runGraph", [request]);
  assert.equal(result.kind, "started", JSON.stringify(result));
  assert.equal(created.length, 1);
  assert.equal(created[0].id, result.runId);
  const replay = await dispatch(lifecycle, "runGraph", [
    {
      ...request,
      requestId: "guest-changed-id",
    },
  ]);
  assert.equal(replay.kind, "replay", JSON.stringify(replay));
  assert.equal(replay.runId, result.runId);
  const listed = await runs.runs(facts, {
    workflowId: "lifecycle-admission-proof",
  });
  assert.equal(listed.runs.length, 1);
  assert.equal(
    listed.runs[0].source,
    "event",
    "lifecycle is not misreported as a human click",
  );
  assert.deepEqual(
    await runs.loadRun("trellis", result.runId).then((run) => run.input),
    { sourceRevision },
  );
  // The binding dispatcher preserves call-only control operations too.
  for (const method of Object.keys(workflowFrameMethods.WORKFLOWS).filter(
    (name) => name !== "runGraph",
  ))
    await assert.rejects(() => dispatch(lifecycle, method, [{}]), {
      code: "revoked",
    });
  // A lifecycle start is not a general-purpose member call capability.
  for (const action of [
    () => runs.runs(lifecycle, {}),
    () => runs.cancel(lifecycle, { runId: result.runId }),
    () => runs.status(lifecycle, { runId: result.runId }),
  ])
    await assert.rejects(action, { code: "revoked" });
  await assert.rejects(
    () =>
      runs.start(
        {
          ...lifecycle,
          subject: {
            kind: "lifecycle",
            name: "syncRefused",
            lane: "member:owner",
            code: "access_changed",
          },
          grants: [],
        },
        request,
      ),
    { code: "revoked" },
  );
  await assert.rejects(
    () =>
      runs.start(
        {
          ...lifecycle,
          selection: {
            ...lifecycle.selection,
            authorityVersion: lifecycle.selection.authorityVersion + 1,
          },
        },
        request,
      ),
    { code: "revoked" },
  );
});

test("standalone webhook control admits its current owner for an empty metadata list and refuses another member claiming owner role", async (t) => {
  const limiter = { limit: async () => ({ success: true }) };
  const { runs, ownerPrincipal, created } = await libraryFixture(t, {
    WORKFLOW_WEBHOOK_HOST_RATE: limiter,
    WORKFLOW_WEBHOOK_BINDING_RATE: limiter,
    WORKFLOW_WEBHOOK_POLICY: {
      limits: {
        bodyBytes: 65536,
        headerBytes: 8192,
        headerCount: 32,
        readMilliseconds: 1000,
      },
      concurrency: { hostConcurrency: 2, bindingConcurrency: 1 },
    },
  });
  const ownerReply = await runs.webhookControl(ownerPrincipal, "trellis", {
    operation: "list",
  });
  assert.equal(ownerReply.status, 200);
  assert.equal(ownerReply.headers.get("cache-control"), "no-store");
  assert.deepEqual(await ownerReply.json(), { bindings: [], next: null });
  const foreignReply = await runs.webhookControl(
    {
      ...ownerPrincipal,
      actor: { kind: "member", memberId: "foreign" },
    },
    "trellis",
    { operation: "list" },
  );
  assert.equal(foreignReply.status, 403);
  assert.equal(foreignReply.headers.get("cache-control"), "no-store");
  assert.deepEqual(await foreignReply.json(), { error: "refused" });
  assert.equal(created.length, 0);
});

test("standalone webhook admission stays closed when abuse configuration is absent", async (t) => {
  const { runs, ownerPrincipal, created } = await libraryFixture(t);
  const control = await runs.webhookControl(ownerPrincipal, "trellis", {
    operation: "list",
  });
  assert.equal(control.status, 403);
  assert.equal(control.headers.get("cache-control"), "no-store");
  for (const method of ["GET", "POST"]) {
    const response = await runs.fetch(
      new globalThis.Request("https://owner.test/webhooks/binding", { method }),
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "refused" });
  }
  assert.equal(created.length, 0);
});

test("standalone webhook routing addresses only an existing library, forwards to its native owner and preserves refusal", async (t) => {
  const { runs, host, ownerPrincipal } = await libraryFixture(t);
  const addresses = [];
  const env = {
    WORKFLOW_RUNS: {
      getByName(id) {
        addresses.push(id);
        return runs;
      },
    },
  };
  const routes = serveDoors(
    standaloneWorkflowWebhookRoutes(env, async (request) =>
      new URL(request.url).origin === "https://owner.test" ? host : null,
    ),
  );
  for (const [origin, library] of [
    ["https://owner.test", "missing"],
    ["https://foreign.test", "trellis"],
  ]) {
    const response = await routes.request(
      `${origin}/api/installations/${library}/workflows/webhooks/opaque-binding`,
      { method: "POST", body: "{}" },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "refused" });
  }
  assert.deepEqual(addresses, []);
  const response = await routes.request(
    "https://owner.test/api/installations/trellis/workflows/webhooks/opaque-binding",
    { method: "POST", body: "{}" },
  );
  assert.deepEqual(addresses, ["trellis"]);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "refused" });
  const controls = serveHost(
    standaloneWorkflowWebhookControls(env, () => Promise.resolve(host)),
    () => Promise.resolve({ kind: "admitted", principal: ownerPrincipal }),
    { liveKey: async () => null, appToolPolicy: () => null },
  );
  const control = await controls.request(
    "https://owner.test/api/installations/trellis/workflows/webhooks",
    { method: "POST", body: JSON.stringify({ operation: "list" }) },
  );
  assert.deepEqual(addresses, ["trellis", "trellis"]);
  assert.equal(control.status, 403);
  assert.equal(control.headers.get("cache-control"), "no-store");
});

async function webhookControlRouteFixture(t) {
  const { runs, host, ownerPrincipal } = await libraryFixture(t);
  const addresses = [];
  const control = t.mock.method(runs, "webhookControl");
  const routes = serveHost(
    standaloneWorkflowWebhookControls(
      {
        WORKFLOW_RUNS: {
          getByName(id) {
            addresses.push(id);
            return runs;
          },
        },
      },
      () => Promise.resolve(host),
    ),
    () => Promise.resolve({ kind: "admitted", principal: ownerPrincipal }),
    { liveKey: async () => null, appToolPolicy: () => null },
  );
  return {
    addresses,
    control,
    ownerPrincipal,
    request: (body) =>
      routes.request(
        "https://owner.test/api/installations/trellis/workflows/webhooks",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      ),
  };
}

test("standalone webhook control refuses malformed JSON without addressing its native owner", async (t) => {
  const f = await webhookControlRouteFixture(t);
  const response = await f.request("{");
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "refused" });
  assert.deepEqual(f.addresses, []);
  assert.equal(f.control.mock.callCount(), 0);
});

test("standalone webhook control refuses schema-invalid bodies without addressing its native owner", async (t) => {
  const f = await webhookControlRouteFixture(t);
  for (const command of [
    {},
    { operation: "create" },
    { operation: "list", installationAuthority: {} },
  ]) {
    const response = await f.request(JSON.stringify(command));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "refused" });
    assert.deepEqual(f.addresses, []);
    assert.equal(f.control.mock.callCount(), 0);
  }
});

test("standalone webhook control forwards a valid decoded command to its native owner", async (t) => {
  const f = await webhookControlRouteFixture(t);
  const response = await f.request(JSON.stringify({ operation: "list" }));
  // This fixture's native owner has no abuse configuration and still closes
  // the surface. Decoding must not replace or bypass that owner admission.
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "refused" });
  assert.deepEqual(f.addresses, ["trellis"]);
  assert.equal(f.control.mock.callCount(), 1);
  assert.deepEqual(f.control.mock.calls[0].arguments, [
    f.ownerPrincipal,
    "trellis",
    { operation: "list" },
  ]);
});

test("standalone terminal transition settles its existing trigger reservation", async (t) => {
  const { runs, facts, definition, storage } = await libraryFixture(t);
  const started = await runs.start(facts, {
    requestId: "terminal-reservation",
    definition,
    bindings: {},
    input: {},
    published: {
      workflowId: "review",
      commit: "a".repeat(40),
      digest: await contentDigest(definition),
    },
  });
  assert.equal(started.kind, "started");
  const reservations = createTriggerRunReservations(storage);
  const scope = {
    installationId: "trellis",
    workflowId: "review",
    commit: "a".repeat(40),
    triggerId: "hook",
  };
  const reserved = reservations.reserveTriggerRun({
    scope,
    requestId: "terminal-reservation",
  });
  assert.equal(reserved.kind, "reserved");
  assert.equal(
    reservations.bindTriggerRun(reserved.reservationId, started.runId),
    "bound",
  );
  assert.equal(reservations.countActiveTriggerRuns(scope), 1);
  await runs.terminal(started.runId, {
    kind: "failed",
    error: "fixture ending",
  });
  assert.equal(reservations.countActiveTriggerRuns(scope), 0);
});

test("HTTP/MCP approval digests admit the same published Workflow in WorkflowRuns", async (t) => {
  const { runs, created, facts, definition } = await libraryFixture(t);
  const result = await runs.start(facts, {
    requestId: "digest-equality",
    definition,
    bindings: {},
    input: {},
    published: {
      workflowId: "review",
      commit: "a".repeat(40),
      digest: await contentDigest(definition),
    },
  });
  // WorkflowRuns' grantsFor checks exact digest equality, not just capability presence.
  assert.equal(result.kind, "started", JSON.stringify(result));
  assert.equal(created.length, 1);
  assert.equal(created[0].id, result.runId);
});

test("runStatus reports a started run as queued, not a 502, while its engine instance is not yet reachable", async (t) => {
  // The real native Workflows binding acks `create` before a concurrent
  // `get` on the same id can see the instance; that ack is enough for the
  // run to start and be recorded (and so visible to listRuns), while a
  // `graphStatus` landing in that window still gets the platform's
  // "instance.not_found" from `get`.
  const library = await libraryFixture(t, {
    GRAPH_WORKFLOWS: {
      create: async () => undefined,
      get: async () => {
        throw new Error("instance.not_found");
      },
    },
  });
  const { runs, facts, definition } = library;
  const started = await runs.start(facts, {
    requestId: "queued-before-instance",
    definition,
    bindings: {},
    input: {},
    published: {
      workflowId: "review",
      commit: "a".repeat(40),
      digest: await contentDigest(definition),
    },
  });
  assert.equal(started.kind, "started", JSON.stringify(started));
  const status = await runs.status(facts, { runId: started.runId });
  assert.deepEqual(status, {
    runId: started.runId,
    planDigest: started.planDigest,
    title: "Review a result",
    outcome: "active",
    events: [],
    reviews: [],
    status: "queued",
    output: null,
    error: null,
  });
});

test("standalone MCP status and terminal cancellation share the live Workflow owner and refuse foreign actors", async (t) => {
  let state = "running";
  let terminated = 0;
  const library = await libraryFixture(t, {
    GRAPH_WORKFLOWS: {
      create: async () => undefined,
      get: async () => ({
        status: async () => ({ status: state }),
        terminate: async () => {
          terminated++;
          state = "terminated";
        },
      }),
    },
  });
  const started = await library.runs.start(library.facts, {
    requestId: "mcp-controls",
    definition: library.definition,
    bindings: {},
    input: {},
    published: {
      workflowId: "review",
      commit: "a".repeat(40),
      digest: await contentDigest(library.definition),
    },
  });
  assert.equal(started.kind, "started");
  const bound = await library.control({
    actor: { kind: "member", memberId: library.ownerId },
    role: "owner",
  });
  assert.ok(bound);
  const tools = createMcpWorkflowControl(bound);
  const status = await tools.operations.status({ runId: started.runId });
  assert.equal(status.kind, "found");
  assert.equal(status.snapshot.runId, started.runId);
  assert.deepEqual(await tools.operations.cancel({ runId: started.runId }), {
    kind: "cancelled",
  });
  assert.deepEqual(await tools.operations.cancel({ runId: started.runId }), {
    kind: "terminal",
  });
  assert.equal(terminated, 1);
  await assert.rejects(
    library.control({
      actor: { kind: "member", memberId: "foreign" },
      role: "owner",
    }),
  );
});

test("Agent Workflow schedule and App-event controls require the exact current approval revision", async (t) => {
  let policy = null;
  const library = await libraryFixture(t, {
    AGENT_DIRECTORY: {
      getByName: () => ({
        appToolPolicy: async () => policy,
      }),
    },
  });
  policy = {
    level: "write",
    revision: "agent_one:1",
    grantedBy: library.ownerId,
  };
  const facts = library.agentFacts("agent_one", "session_one", library.ownerId);
  assert.deepEqual(await library.runs.schedules(facts, {}), {
    schedules: [],
    nextCursor: null,
  });
  assert.deepEqual(await library.runs.eventTriggers(facts), {
    eventTriggers: [],
  });
  policy = { ...policy, revision: "agent_one:2" };
  await assert.rejects(library.runs.schedules(facts, {}));
  await assert.rejects(library.runs.eventTriggers(facts));
});

test("an Agent-started run acts as its grantor and reports its ending to the starting Session; a declared chat receives any run's ending", async (t) => {
  let policy = null;
  const sent = [];
  const library = await libraryFixture(t, {
    AGENT_DIRECTORY: {
      getByName: () => ({
        appToolPolicy: async (actor) =>
          actor.kind === "agent" && actor.agentId === "agent_one"
            ? policy
            : null,
        has: (agentId) => agentId === "agent_one",
      }),
    },
    AGENTS: {
      getByName: (agentId) => ({
        sendFromApp: async (installationId, sessionId, message) => {
          sent.push({ agentId, installationId, sessionId, message });
          return { status: "accepted", commandId: "command_one" };
        },
      }),
    },
  });
  const { runs, created, definition, ownerId } = library;
  policy = { level: "write", revision: "agent_one:1", grantedBy: ownerId };
  const request = {
    requestId: "agent-start",
    definition,
    bindings: {},
    input: {},
    published: {
      workflowId: "review",
      commit: "a".repeat(40),
      digest: await contentDigest(definition),
    },
  };
  const facts = library.agentFacts("agent_one", "session_one", ownerId);
  const started = await runs.start(facts, request);
  assert.equal(started.kind, "started", JSON.stringify(started));
  assert.equal(created.at(-1).id, started.runId);
  // The same request from another Session is a different origin, not a replay.
  assert.equal(
    (
      await runs.start(
        library.agentFacts("agent_one", "session_two", ownerId),
        request,
      )
    ).kind,
    "conflict",
  );
  // Each node rechecks the live approval; a read-only approval stops the run.
  const event = {
    runId: started.runId,
    nodeId: "message",
    iteration: "0",
    state: "running",
    attempt: 0,
  };
  assert.deepEqual(await runs.beforeNode(event), { kind: "admitted" });
  policy = { level: "read", revision: "agent_one:2", grantedBy: ownerId };
  assert.deepEqual(await runs.beforeNode(event), {
    kind: "refused",
    code: "revoked",
  });
  await runs.terminal(started.runId, {
    kind: "complete",
    output: { decision: "approved" },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].agentId, "agent_one");
  assert.equal(sent[0].installationId, "trellis");
  assert.equal(sent[0].sessionId, "session_one");
  assert.equal(sent[0].message.delivery, "followUp");
  assert.equal(
    sent[0].message.requestId,
    `workflow-run-report:${started.runId}`,
  );
  assert.match(sent[0].message.text, /finished\./);
  assert.match(sent[0].message.text, /"decision": "approved"/);

  // A person's run with no declared delivery reports nowhere.
  const manual = await runs.start(library.facts, {
    ...request,
    requestId: "member-start",
  });
  assert.equal(manual.kind, "started", JSON.stringify(manual));
  await runs.terminal(manual.runId, { kind: "failed", error: "boom" });
  assert.equal(sent.length, 1);

  // A Run-button start that declares a chat reports there, like every run does.
  const declared = await runs.start(library.facts, {
    ...request,
    requestId: "member-declared",
    delivery: { agentId: "agent_one", sessionId: "session_reports" },
  });
  assert.equal(declared.kind, "started", JSON.stringify(declared));
  await runs.terminal(declared.runId, { kind: "failed", error: "boom" });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].agentId, "agent_one");
  assert.equal(sent[1].sessionId, "session_reports");
  assert.match(sent[1].message.text, /failed: boom/);
  // A chat on an Agent this Oyster does not have is refused at start.
  assert.deepEqual(
    await runs.start(library.facts, {
      ...request,
      requestId: "member-missing-chat",
      delivery: { agentId: "agent_missing", sessionId: "session_reports" },
    }),
    { error: "not_granted" },
  );

  // Without a captured approval an Agent cannot start a run at all.
  policy = null;
  const refused = await runs.start(
    library.agentFacts("agent_one", "session_one", ownerId),
    { ...request, requestId: "agent-refused" },
  );
  assert.deepEqual(refused, { error: "not_granted" });

  // listRuns reads the host's own run store: the source and initiator are
  // the ones admitted at start, never recomputed from a saved caller.
  const indexDb = new DatabaseSync(":memory:");
  t.after(() => indexDb.close());
  const indexes = createWorkflowIndexes(fromNodeSqlite(indexDb));
  const listed = await appBackend.call(
    "listRuns",
    {},
    {
      indexes,
      env: { WORKFLOWS: { runs: (input) => runs.runs(library.facts, input) } },
    },
    { actor: { kind: "member", memberId: ownerId }, computerId: null },
  );
  const byId = (runId) => listed.find((row) => row.runId === runId);
  assert.equal(byId(started.runId)?.source, "agent");
  // The Agent Session stays host-side; the wire shape names only the Agent
  // and its grantor.
  assert.deepEqual(byId(started.runId)?.initiatedBy, {
    kind: "agent",
    agentId: "agent_one",
    grantorMemberId: ownerId,
  });
  assert.equal(byId(manual.runId)?.source, "manual");
  assert.deepEqual(byId(manual.runId)?.initiatedBy, {
    kind: "member",
    memberId: ownerId,
  });
});

/**
 * S3's own key-run proofs. `keyLibraryFixture` is `libraryFixture` with a
 * second "bonsai" installation (same Release, so its method digests and
 * effects are real) and a controllable `host.keys.live` seam: the `keys`
 * Map stands in for S2's own Ear Tag-backed `OysterKeys` store, mutated
 * here only to issue and revoke -- the gating under test is entirely
 * Bonsai's own `prepare`/`admitKey`, never this stub.
 */
async function keyLibraryFixture(t) {
  const keys = new Map();
  const library = await libraryFixture(
    t,
    {
      KEYS: {
        getByName: () => ({ live: async (keyId) => keys.get(keyId) ?? null }),
      },
    },
    ["bonsai"],
  );
  return { ...library, keys };
}

/** A key record `keyAppAccess` (packages/oyster/src/keys.ts) can decide against. */
function liveKey(owner, grants) {
  return { keyId: "morel", owner, grantVersion: 1, grants };
}

test('a key with apps.use on Workflows and apps.read on Bonsai starts a run with source "key" and the key initiator', async (t) => {
  const library = await keyLibraryFixture(t);
  const listDigest = await library.methodDigest("listRuns");
  library.keys.set(
    "morel",
    liveKey(library.ownerId, [
      {
        capability: "apps.use",
        targets: { kind: "selected", ids: ["trellis"] },
      },
      {
        capability: "apps.read",
        targets: { kind: "selected", ids: ["bonsai"] },
      },
    ]),
  );
  const definition = {
    format: "fungi.workflow/v1",
    title: "Key list runs",
    apps: { bonsai: { appId: "app_trellis" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "list",
        kind: "app",
        app: "bonsai",
        method: "listRuns",
        methodDigest: listDigest,
        values: {},
      },
    ],
    edges: [],
    output: { result: { node: "list", port: "value" } },
  };
  // Published, like every other `runs()`-listed start in this file: the
  // store's own installation_id column comes from `publication`, never a
  // raw request's library -- true for a member or Agent run exactly as
  // much as for a key's.
  const result = await library.runs.start(library.keyFacts("morel"), {
    requestId: "key-start",
    definition,
    bindings: { bonsai: "bonsai" },
    input: {},
    published: {
      workflowId: "key-run",
      commit: "a".repeat(40),
      digest: await contentDigest(definition),
    },
  });
  assert.equal(result.kind, "started", JSON.stringify(result));
  const { runs: listed } = await library.runs.runs(library.facts, {});
  const row = listed.find((item) => item.runId === result.runId);
  assert.equal(row?.source, "key");
  assert.deepEqual(row?.initiatedBy, {
    kind: "key",
    keyId: "morel",
    grantorMemberId: library.ownerId,
  });
});

test("a key with no Bonsai grant gets a compile issue, and no run starts", async (t) => {
  const library = await keyLibraryFixture(t);
  const listDigest = await library.methodDigest("listRuns");
  library.keys.set(
    "morel",
    liveKey(library.ownerId, [
      {
        capability: "apps.use",
        targets: { kind: "selected", ids: ["trellis"] },
      },
    ]),
  );
  const definition = {
    format: "fungi.workflow/v1",
    title: "Key list runs, no Bonsai grant",
    apps: { bonsai: { appId: "app_trellis" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "list",
        kind: "app",
        app: "bonsai",
        method: "listRuns",
        methodDigest: listDigest,
        values: {},
      },
    ],
    edges: [],
    output: { result: { node: "list", port: "value" } },
  };
  const result = await library.runs.start(library.keyFacts("morel"), {
    requestId: "key-no-bonsai",
    definition,
    bindings: { bonsai: "bonsai" },
    input: {},
  });
  assert.equal(result.kind, "invalid", JSON.stringify(result));
  assert.equal(library.created.length, 0);
});

test("Bonsai read-only plus a write node gives a compile issue", async (t) => {
  const library = await keyLibraryFixture(t);
  const cancelDigest = await library.methodDigest("cancel");
  library.keys.set(
    "morel",
    liveKey(library.ownerId, [
      {
        capability: "apps.use",
        targets: { kind: "selected", ids: ["trellis"] },
      },
      {
        capability: "apps.read",
        targets: { kind: "selected", ids: ["bonsai"] },
      },
    ]),
  );
  const definition = {
    format: "fungi.workflow/v1",
    title: "Key write node on a read-only Bonsai",
    apps: { bonsai: { appId: "app_trellis" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "mutate",
        kind: "app",
        app: "bonsai",
        method: "cancel",
        methodDigest: cancelDigest,
        values: { runId: { literal: "run_other" } },
      },
    ],
    edges: [],
    // "ok", cancelReplySchema's non-error completion outlet: wired so a
    // write grant (today's bug) would compile and start, isolating the
    // read-only refusal this proof is actually about from an unrelated
    // "unreachable" issue.
    output: { result: { node: "mutate", port: "ok" } },
  };
  const result = await library.runs.start(library.keyFacts("morel"), {
    requestId: "key-write-on-read",
    definition,
    bindings: { bonsai: "bonsai" },
    input: {},
  });
  assert.equal(result.kind, "invalid", JSON.stringify(result));
  assert.equal(library.created.length, 0);
});

test("a run is refused with not_granted when it declares a delivery or has a Git node, even for a fully-granted key", async (t) => {
  const library = await keyLibraryFixture(t);
  library.keys.set(
    "morel",
    liveKey(library.ownerId, [
      { capability: "apps.use", targets: { kind: "all" } },
    ]),
  );
  // Control: the same fully-granted key, the same plain definition, with no
  // delivery and no Git node, is admitted. This isolates the two refusals
  // below from a blanket "no key ever starts" bug.
  const plain = await library.runs.start(library.keyFacts("morel"), {
    requestId: "key-plain",
    definition: library.definition,
    bindings: {},
    input: {},
  });
  assert.equal(plain.kind, "started", JSON.stringify(plain));
  const delivered = await library.runs.start(library.keyFacts("morel"), {
    requestId: "key-delivery",
    definition: library.definition,
    bindings: {},
    input: {},
    delivery: { agentId: "agent_one", sessionId: "session_one" },
  });
  assert.deepEqual(delivered, { error: "not_granted" });
  const listDigest = await library.methodDigest("listRuns");
  const gitDefinition = {
    format: "fungi.workflow/v1",
    title: "Key Git node",
    apps: { bonsai: { appId: "app_trellis" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "list",
        kind: "app",
        app: "bonsai",
        method: "listRuns",
        methodDigest: listDigest,
        values: {},
        gitAccess: {
          binding: "repo",
          repository: "demo-repo",
          branches: ["refs/heads/main"],
        },
      },
    ],
    edges: [],
    output: { result: { node: "list", port: "value" } },
  };
  // Published: the old rule ("a Git step needs a published run") would
  // otherwise refuse this on its own, before the key's own rule ever runs.
  // Publishing it is what isolates the key-specific refusal this proof is
  // actually about.
  const gitRun = await library.runs.start(library.keyFacts("morel"), {
    requestId: "key-git-node",
    definition: gitDefinition,
    bindings: {
      bonsai: "bonsai",
      // An installation repository, never team-source: standalone admits
      // only installation repositories, and the "bonsai" installation
      // (same Release as the library) already carries an approved GIT
      // binding. This is what lets the ceiling capture genuinely succeed
      // once the key check is gone, instead of failing for an unrelated
      // reason that would mask it.
      repo: "bonsai",
    },
    input: {},
    published: {
      workflowId: "key-git",
      commit: "a".repeat(40),
      digest: await contentDigest(gitDefinition),
    },
  });
  assert.deepEqual(gitRun, { error: "not_granted" });
  // Only the control run above launched; neither refusal did.
  assert.equal(library.created.length, 1);
});

// Standalone red 2: the run owner's issuer admits only the exact library,
// repository and scope of an admitted Git step's live credential.
test("standalone Workflow Git credentials refuse another repository, owner, secret, non-live, closed invocation or ended run", async (t) => {
  // The selected Computer answers native liveness; the library never names it.
  const live = new Set();
  const library = await libraryFixture(
    t,
    {
      COMPUTER: {
        getByName: (computerId) => {
          assert.equal(computerId, "workspace");
          return {
            executionIsLive: async (invocationId) => live.has(invocationId),
          };
        },
      },
    },
    ["bonsai"],
  );
  const listDigest = await library.methodDigest("listRuns");
  const gitDefinition = {
    format: "fungi.workflow/v1",
    title: "Owner Git node",
    apps: { bonsai: { appId: "app_trellis" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "list",
        kind: "app",
        app: "bonsai",
        method: "listRuns",
        methodDigest: listDigest,
        values: {},
        gitAccess: {
          binding: "repo",
          repository: "demo-repo",
          branches: ["refs/heads/main"],
        },
      },
    ],
    edges: [],
    output: { result: { node: "list", port: "value" } },
  };
  const started = await library.runs.start(library.facts, {
    requestId: "owner-git-node",
    definition: gitDefinition,
    bindings: { bonsai: "bonsai", repo: "bonsai" },
    input: {},
    published: {
      workflowId: "owner-git",
      commit: "a".repeat(40),
      digest: await contentDigest(gitDefinition),
    },
  });
  assert.equal(started.kind, "started", JSON.stringify(started));
  const event = {
    runId: started.runId,
    nodeId: "list",
    iteration: "0",
    state: "running",
    attempt: 0,
  };
  assert.deepEqual(await library.runs.beforeNode(event), { kind: "admitted" });
  const idempotencyKey = started.runId + ":list";
  // The dispatched step is recorded before its App call; this harness has
  // no App Instance, so only the call itself then fails.
  const methodSpec = await library.methodSpec("listRuns");
  await assert.rejects(
    library.runs.dispatch({
      teamId: "trellis",
      runId: started.runId,
      nodeId: "list",
      iteration: "0",
      installationId: "bonsai",
      method: "listRuns",
      methodSpec,
      input: {},
      idempotencyKey,
    }),
    /INSTANCES|getByName/u,
  );
  const workflow = {
    workflowId: "owner-git",
    runId: started.runId,
    nodeId: "list",
    armedBy: { kind: "member", memberId: library.ownerId },
  };
  const request = {
    installationId: "bonsai",
    idempotencyKey,
    workflow,
    memberId: library.ownerId,
    computerId: "workspace",
  };
  // A frame claiming another member or Computer is a revocation.
  for (const forged of [
    { ...request, memberId: "someone-else" },
    { ...request, computerId: "elsewhere" },
  ])
    await assert.rejects(library.runs.admitWorkflowGit(forged));
  const grant = await library.runs.admitWorkflowGit(request);
  assert.ok(grant);
  assert.equal(grant.scope, "write");
  const credential = await library.runs.issueWorkflowGit("exec:one", grant);
  assert.equal(
    credential.remote,
    "https://workflow-unit.invalid/git/bonsai/demo-repo.git",
  );
  assert.match(credential.bearer, /^wgp\.trellis\.[0-9a-f]{64}$/u);
  const repository = (name) => ({
    kind: "installation",
    installationId: "bonsai",
    repository: name,
  });
  const admit = (bearer, name, scope) =>
    library.runs.admitWorkflowGitPass(bearer, repository(name), scope);
  // A credential whose native command is not proven live admits nothing.
  assert.equal(await admit(credential.bearer, "demo-repo", "read"), null);
  live.add("exec:one");
  // Write grants push and read their own repository.
  assert.ok(await admit(credential.bearer, "demo-repo", "write"));
  assert.ok(await admit(credential.bearer, "demo-repo", "read"));
  const token = credential.bearer.split(".")[2];
  for (const [bearer, name] of [
    [credential.bearer, "other-repo"],
    ["wgp.other-library." + token, "demo-repo"],
    ["wgp.trellis." + "0".repeat(64), "demo-repo"],
  ])
    assert.equal(await admit(bearer, name, "read"), null);
  // A replayed invocation never obtains a second secret.
  await assert.rejects(library.runs.issueWorkflowGit("exec:one", grant));
  // Closing the invocation's credential denies its next request.
  await library.runs.closeWorkflowGit("exec:one", grant);
  assert.equal(await admit(credential.bearer, "demo-repo", "read"), null);
  await assert.rejects(library.runs.renewWorkflowGit("exec:one", grant));
  // Ending the run denies every credential it issued.
  const second = await library.runs.issueWorkflowGit("exec:two", grant);
  live.add("exec:two");
  assert.ok(await admit(second.bearer, "demo-repo", "read"));
  // A proven native exit denies the next request at once.
  live.delete("exec:two");
  assert.equal(await admit(second.bearer, "demo-repo", "read"), null);
  live.add("exec:two");
  await library.runs.terminal(started.runId, {
    kind: "failed",
    error: "fixture ending",
  });
  assert.equal(await admit(second.bearer, "demo-repo", "read"), null);
  assert.equal(await library.runs.admitWorkflowGit(request), null);
});

test("revoking the key mid-run gets the next node refused with revoked", async (t) => {
  const library = await keyLibraryFixture(t);
  const listDigest = await library.methodDigest("listRuns");
  library.keys.set(
    "morel",
    liveKey(library.ownerId, [
      { capability: "apps.use", targets: { kind: "all" } },
    ]),
  );
  const definition = {
    format: "fungi.workflow/v1",
    title: "Key run, revoked mid-flight",
    apps: { bonsai: { appId: "app_trellis" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "list",
        kind: "app",
        app: "bonsai",
        method: "listRuns",
        methodDigest: listDigest,
        values: {},
      },
    ],
    edges: [],
    output: { result: { node: "list", port: "value" } },
  };
  const started = await library.runs.start(library.keyFacts("morel"), {
    requestId: "key-revoke",
    definition,
    bindings: { bonsai: "bonsai" },
    input: {},
  });
  assert.equal(started.kind, "started", JSON.stringify(started));
  const event = {
    runId: started.runId,
    nodeId: "list",
    iteration: "0",
    state: "running",
    attempt: 0,
  };
  assert.deepEqual(await library.runs.beforeNode(event), { kind: "admitted" });
  library.keys.delete("morel");
  assert.deepEqual(await library.runs.beforeNode(event), {
    kind: "refused",
    code: "revoked",
  });
});

/**
 * admitKey proofs the other key tests can't tell apart from a trivial
 * `key !== null`: each flips exactly one live fact mid-run, while leaving
 * the other two checks unable to catch it on their own, so each is red if
 * its own check in workflow-root-authority.ts's admitKey were dropped.
 */
test("a key run is refused with revoked when the key's owner no longer matches the run's grantor", async (t) => {
  const library = await keyLibraryFixture(t);
  const listDigest = await library.methodDigest("listRuns");
  library.keys.set(
    "morel",
    liveKey(library.ownerId, [
      { capability: "apps.use", targets: { kind: "all" } },
    ]),
  );
  const definition = {
    format: "fungi.workflow/v1",
    title: "Key run, owner mismatch mid-flight",
    apps: { bonsai: { appId: "app_trellis" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "list",
        kind: "app",
        app: "bonsai",
        method: "listRuns",
        methodDigest: listDigest,
        values: {},
      },
    ],
    edges: [],
    output: { result: { node: "list", port: "value" } },
  };
  const started = await library.runs.start(library.keyFacts("morel"), {
    requestId: "key-owner-mismatch",
    definition,
    bindings: { bonsai: "bonsai" },
    input: {},
  });
  assert.equal(started.kind, "started", JSON.stringify(started));
  const event = {
    runId: started.runId,
    nodeId: "list",
    iteration: "0",
    state: "running",
    attempt: 0,
  };
  assert.deepEqual(await library.runs.beforeNode(event), { kind: "admitted" });
  // The key is still live, with the very same grants -- only its recorded
  // owner changed. Neither the library's apps.use nor the plan's
  // installation levels look at `owner`, so only the grantor-identity
  // check can catch this.
  library.keys.set(
    "morel",
    liveKey("impostor-owner", [
      { capability: "apps.use", targets: { kind: "all" } },
    ]),
  );
  assert.deepEqual(await library.runs.beforeNode(event), {
    kind: "refused",
    code: "revoked",
  });
});

test("a key run is refused with revoked when the key's apps.use on the Workflows library is pulled mid-run", async (t) => {
  const library = await keyLibraryFixture(t);
  const listDigest = await library.methodDigest("listRuns");
  library.keys.set(
    "morel",
    liveKey(library.ownerId, [
      { capability: "apps.use", targets: { kind: "all" } },
    ]),
  );
  const definition = {
    format: "fungi.workflow/v1",
    title: "Key run, library grant pulled mid-flight",
    apps: { bonsai: { appId: "app_trellis" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "list",
        kind: "app",
        app: "bonsai",
        method: "listRuns",
        methodDigest: listDigest,
        values: {},
      },
    ],
    edges: [],
    output: { result: { node: "list", port: "value" } },
  };
  const started = await library.runs.start(library.keyFacts("morel"), {
    requestId: "key-library-pulled",
    definition,
    bindings: { bonsai: "bonsai" },
    input: {},
  });
  assert.equal(started.kind, "started", JSON.stringify(started));
  const event = {
    runId: started.runId,
    nodeId: "list",
    iteration: "0",
    state: "running",
    attempt: 0,
  };
  assert.deepEqual(await library.runs.beforeNode(event), { kind: "admitted" });
  // The plan's one node binds only to "bonsai", so planInstallationLevels
  // never names "trellis" itself; only the library's own apps.use check
  // (runGraph is a write on the library) catches a key that lost it.
  library.keys.set(
    "morel",
    liveKey(library.ownerId, [
      {
        capability: "apps.read",
        targets: { kind: "selected", ids: ["trellis"] },
      },
      {
        capability: "apps.use",
        targets: { kind: "selected", ids: ["bonsai"] },
      },
    ]),
  );
  assert.deepEqual(await library.runs.beforeNode(event), {
    kind: "refused",
    code: "revoked",
  });
});

test("a key run is refused with revoked when a planInstallationLevels entry is downgraded mid-run", async (t) => {
  const library = await keyLibraryFixture(t);
  const cancelDigest = await library.methodDigest("cancel");
  library.keys.set(
    "morel",
    liveKey(library.ownerId, [
      { capability: "apps.use", targets: { kind: "all" } },
    ]),
  );
  const definition = {
    format: "fungi.workflow/v1",
    title: "Key run, plan level downgraded mid-flight",
    apps: { bonsai: { appId: "app_trellis" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "mutate",
        kind: "app",
        app: "bonsai",
        method: "cancel",
        methodDigest: cancelDigest,
        values: { runId: { literal: "run_other" } },
      },
    ],
    edges: [],
    output: { result: { node: "mutate", port: "ok" } },
  };
  const started = await library.runs.start(library.keyFacts("morel"), {
    requestId: "key-plan-downgrade",
    definition,
    bindings: { bonsai: "bonsai" },
    input: {},
  });
  assert.equal(started.kind, "started", JSON.stringify(started));
  const event = {
    runId: started.runId,
    nodeId: "mutate",
    iteration: "0",
    state: "running",
    attempt: 0,
  };
  assert.deepEqual(await library.runs.beforeNode(event), { kind: "admitted" });
  // The library's own apps.use is untouched; only Bonsai's grant drops from
  // apps.use to apps.read, below the plan's write requirement on that same
  // node -- the one fact only planInstallationLevels's own check names.
  library.keys.set(
    "morel",
    liveKey(library.ownerId, [
      {
        capability: "apps.use",
        targets: { kind: "selected", ids: ["trellis"] },
      },
      {
        capability: "apps.read",
        targets: { kind: "selected", ids: ["bonsai"] },
      },
    ]),
  );
  assert.deepEqual(await library.runs.beforeNode(event), {
    kind: "refused",
    code: "revoked",
  });
});

function fixture(installationId) {
  const database = new DatabaseSync(":memory:");
  const calls = [];
  const pending = [];
  const entrypoint = (name) => (input) => {
    calls.push({ name, ...input.props });
    return { name: input.props.binding, ...input.props };
  };
  class InstanceProbe extends StandaloneInstance {
    installationId() {
      return installationId;
    }
    guestEnvForFrame() {
      return this.guestEnv({
        facts: { instanceId: "instance_library" },
        frameId: "app_frame_7rid3mf288uvsdldxmu5l",
      });
    }
  }
  const instance = new InstanceProbe(
    {
      id: { name: "instance_library" },
      storage: fromNodeSqlite(database),
      blockConcurrencyWhile: (work) => {
        const result = work();
        pending.push(result);
        return result;
      },
      exports: { OysterBinding: entrypoint("OysterBinding") },
    },
    { RELEASES: {} },
  );
  return {
    instance,
    calls,
    close: async () => {
      await Promise.all(pending);
      database.close();
    },
  };
}

for (const installationId of [null, "library"]) {
  test(`host bindings use only Instance routing with installation ${String(installationId)}`, async () => {
    const probe = fixture(installationId);
    try {
      const bindings = probe.instance.guestEnvForFrame();
      assert.deepEqual(
        Object.keys(bindings).sort(),
        Object.keys(appBackendBindingKinds).sort(),
      );
      for (const [name, binding] of Object.entries(bindings)) {
        assert.deepEqual(binding, {
          name,
          instanceId: "instance_library",
          frameId: "app_frame_7rid3mf288uvsdldxmu5l",
          binding: name,
        });
      }
      assert.deepEqual(
        [...new Set(probe.calls.map((call) => call.binding))].sort(),
        Object.keys(appBackendBindingKinds).sort(),
      );
    } finally {
      await probe.close();
    }
  });
}

test("Git fixture reports request failures when the owning proof awaits close", async () => {
  const provider = await workflowGitProvider();
  try {
    const response = await globalThis.fetch(provider.origin + "/repos", {
      method: "POST",
      body: "not-json",
    });
    assert.equal(response.status, 500);
    await response.text();
  } finally {
    await assert.rejects(provider.close(), (cause) => {
      assert.ok(cause instanceof AggregateError);
      assert.equal(cause.message, "Workflow Git fixture requests failed");
      assert.equal(cause.errors.length, 1);
      assert.ok(cause.errors[0] instanceof SyntaxError);
      return true;
    });
  }
});

test("the Workflows catalog method crosses its declared standalone frame binding", async () => {
  const packets = [];
  const binding = new OysterBinding(
    {
      props: {
        instanceId: instanceIds.instance.generate(),
        binding: "WORKFLOWS",
        frameId: "app_frame_7rid3mf288uvsdldxmu5l",
      },
    },
    {
      INSTANCES: {
        getByName: () => ({
          bindingCall: (_props, method, args) => {
            packets.push({ method, args });
            return Promise.resolve({ kind: "result", value: { apps: [] } });
          },
        }),
      },
    },
  );
  assert.deepEqual(
    await appBackend.call(
      "catalog",
      {},
      {
        env: createFrameBindingWire(appInstanceErrorCodeSchema.literals).wrap({
          WORKFLOWS: binding,
        }),
      },
      { computerId: null, actor: { kind: "member", memberId: "owner" } },
    ),
    { apps: [] },
  );
  assert.deepEqual(packets, [{ method: "catalog", args: [{}] }]);
});

for (const [method, replies] of [
  ["catalog", [{ apps: [] }, { error: "not_granted" }]],
  [
    "runGraph",
    [
      { kind: "started", runId: "run-1", planDigest: "digest-1" },
      { kind: "invalid", issues: [] },
      { error: "not_granted" },
    ],
  ],
  [
    "graphStatus",
    [
      {
        runId: "run-1",
        planDigest: "digest-1",
        outcome: "active",
        title: "Test",
        events: [],
        reviews: [],
        status: "running",
        output: null,
        error: null,
      },
      { error: "not_found" },
    ],
  ],
  ["cancel", [{ kind: "cancelled" }, { kind: "refused", reason: "denied" }]],
  ["answerReview", [{ result: "accepted" }, { error: "not_granted" }]],
]) {
  test(`WORKFLOWS.${method} keeps closed domain outcomes separate from local refusal`, () => {
    const { decodeResult } = workflowFrameMethods.WORKFLOWS[method];
    for (const reply of replies) assert.deepEqual(decodeResult(reply), reply);
    for (const reply of [
      null,
      false,
      [],
      {},
      { kind: "local_refusal", code: "revoked" },
      { ...replies[0], unexpected: true },
    ])
      assert.throws(() => decodeResult(reply));
  });
}
