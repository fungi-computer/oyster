import * as Result from "effect/Result";
import {
  applyInstallationCommand,
  deriveDeclaredOperations,
} from "../dist/apps/index.js";
import { emptyAppDeclaration } from "@fungi.computer/puffball/app";
import * as Schema from "effect/Schema";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { instanceSchema, selectionOf } from "../dist/index.js";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL, fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";
import process from "node:process";
import { buildAppApi } from "@fungi.computer/agar/backend-declaration";
import { appBackend as notesBackend } from "../examples/notes-app/backend/methods.ts";
import { installApps } from "../dist/standalone/install-apps-cli.js";
import {
  installStandaloneAppSet,
  standaloneAppSet,
} from "../dist/standalone/app-set.js";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { memoryHost } from "@fungi.computer/shiitake/testing";
import { createAgentDirectory } from "@fungi.computer/shiitake/fleet";
import { ApprovalLedger } from "@fungi.computer/approvals";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { createOyster, installOrSelect } from "../dist/host.js";
import { sha256, parseRelease, verifyRelease } from "../dist/release.js";
import { defaultTenant, tenantScope } from "../dist/tenant.js";
import { OysterApprovalHome } from "../dist/approval-home.js";
import { computerHost } from "./computer-host.fixture.mjs";
import { withBackendConstruction } from "./boot-construction.fixture.ts";
import { BootGateError } from "../dist/boot-gate.js";
import {
  installOnOyster,
  observeInstallation,
} from "../dist/installation-client.js";
import { InstallationObservationError, installRelease } from "../dist/pack.js";
import {
  installationCommandIds,
  installationOperationSchema,
} from "../dist/installation-operations.js";

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
const {
  OysterRegistry,
  OysterInstance,
  OysterBinding,
  OysterInstallationExecutor,
  oysterWorkerHost,
  ownerKeyAuth,
} = await import("../dist/workers.js");
hooks.deregister();

function fixture(t, artifacts, guest, failedConstructions = 0, backendFor) {
  const pending = [];
  const databases = [];
  const instances = new Map();
  const contexts = new Map();
  const env = {
    OYSTER_OWNER_KEY: "local-registry-owner-key-123456789",
    OYSTER_ORIGIN: "https://oyster.invalid",
    RELEASES: {
      async get(ref) {
        const bytes = await artifacts.get(ref);
        return bytes === null
          ? null
          : {
              arrayBuffer: async () => bytes.slice().buffer,
              body: new globalThis.ReadableStream({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
            };
      },
    },
    INSTANCES: {
      getByName(name) {
        let instance = instances.get(name);
        if (instance === undefined) {
          instance = new OysterInstance(context(name), env);
          instances.set(name, instance);
        }
        return instance;
      },
    },
  };
  const loaded = [];
  const construction = withBackendConstruction(
    {
      // Registry selection probes own no live guest SQLite in this fixture.
      clone(source, destination) {
        assert.equal(source, "app");
        assert.equal(destination, "candidate");
      },
      abort(name) {
        assert.equal(name, "app");
      },
      delete(name) {
        assert.equal(name, "app");
      },
      get(_name, prepare) {
        if (guest === undefined)
          throw new Error("Replacement must not invoke a live facet");
        prepare();
        return {
          invoke: async (method, args) => ({
            kind: "ok",
            value: await guest[method](...args),
          }),
          http: async () => {
            throw new Error("App method unavailable");
          },
        };
      },
    },
    {
      get: (name, configure) => {
        const configured = configure();
        assert.equal(configured.globalOutbound, null);
        assert.deepEqual(configured.env, {});
        loaded.push({ name, limits: configured.limits });
        return { getDurableObjectClass: () => configured };
      },
    },
  );
  env.LOADER = construction.loader;
  function context(name) {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const storage = fromNodeSqlite(db);
    let alarm = null;
    const ctx = {
      id: { name },
      exports: {
        OysterBinding: ({ props }) => new OysterBinding({ props }, env),
        OysterInstallationExecutor: ({ props }) =>
          new OysterInstallationExecutor({ props }, env),
      },
      storage: {
        ...storage,
        getAlarm: async () => alarm,
        deleteAlarm: async () => {
          alarm = null;
        },
        setAlarm: async (at) => {
          alarm = at;
        },
        transaction: async (work) =>
          work({
            getAlarm: async () => alarm,
            setAlarm: async (at) => {
              alarm = at;
            },
          }),
      },
      blockConcurrencyWhile(work) {
        const result = work();
        pending.push(result);
        return result;
      },
      facets: {
        ...construction.facets,
        get(facet, prepare) {
          if (facet !== "app" || backendFor === undefined)
            return construction.facets.get(facet, prepare);
          prepare();
          // The platform's live facet belongs to this named Instance, not
          // the registry or a shared guest object. The caller owns its SQLite.
          const backend = backendFor(name);
          return {
            invoke: async (method, args) => ({
              kind: "ok",
              value: await backend[method](...args),
            }),
            http: async () => {
              throw new Error("This fixture exercises declared methods");
            },
          };
        },
        delete(facet) {
          if (facet === "app" && backendFor !== undefined)
            backendFor(name).delete();
          construction.facets.delete(facet);
        },
      },
    };
    contexts.set(name, ctx);
    return ctx;
  }
  let registry = new OysterRegistry(context("registry"), env);
  env.REGISTRY = { getByName: () => registry };
  const admissions = new Map();
  const dispatch = registry.installationOperation.bind(registry);
  registry.installationOperation = async (request) => {
    const reply = await dispatch(request);
    if (request.action === "admit") {
      const admission = admissions.get(request.input.requestId);
      if (admission !== undefined) {
        admission.entered.resolve();
        await admission.acknowledged.promise;
      }
    }
    return reply;
  };
  const app = createOyster(
    oysterWorkerHost(env, ownerKeyAuth(env.OYSTER_OWNER_KEY)),
  );
  const read = async (operation) => {
    const response = await app.request(
      `/api/installations/${encodeURIComponent(operation.requestedInstallationId)}/status?requestId=${encodeURIComponent(operation.requestId)}`,
      { headers: { Authorization: `Bearer ${env.OYSTER_OWNER_KEY}` } },
    );
    assert.equal(response.status, 200);
    return installationOperationSchema.parse(await response.json());
  };
  // Deterministic source fixture drive: an explicit actual alarm invocation,
  // never a status-triggered tick or a completed-POST compatibility response.
  const post = async (input, headers) => {
    const requestId = installationCommandIds.request.generate();
    const response = await app.request("/api/installations", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": requestId },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 202, await response.clone().text());
    const initial = installationOperationSchema.parse(await response.json());
    assert.equal(initial.requestId, requestId);
    assert.equal(initial.state, "pending");
    await registry.alarm();
    return observeInstallation({
      requestId,
      initial,
      read: () => read(initial),
      signal: new globalThis.AbortController().signal,
    });
  };
  const select = async (
    path,
    input,
    requestId = installationCommandIds.request.generate(),
  ) => {
    const admitted = {
      entered: Promise.withResolvers(),
      acknowledged: Promise.withResolvers(),
    };
    admissions.set(requestId, admitted);
    const response = Promise.resolve(
      app.request(path, {
        ...input,
        headers: { ...input.headers, "Idempotency-Key": requestId },
      }),
    );
    try {
      const first = await Promise.race([
        response.then((value) => ({ response: value })),
        admitted.entered.promise.then(() => ({ admitted: true })),
      ]);
      if ("response" in first) return first.response;
      await registry.alarm();
      admitted.acknowledged.resolve();
      return await response;
    } finally {
      admitted.acknowledged.resolve();
      admissions.delete(requestId);
    }
  };
  t.after(async () => {
    await Promise.all(pending);
    databases.forEach((db) => db.close());
    assert.equal(
      construction.probes.filter((probe) => !probe.completed).length,
      failedConstructions,
    );
    for (const probe of construction.probes) {
      assert.equal(probe.aborted, true);
      assert.equal(probe.deleted, true);
      assert.equal(probe.name, "candidate");
      assert.match(probe.loaderId, /^boot:/);
      assert.ok(loaded.some((load) => load.name === probe.loaderId));
    }
    for (const load of loaded)
      assert.deepEqual(load.limits, { cpuMs: 1000, subRequests: 50 });
  });
  return {
    get registry() {
      return registry;
    },
    restart() {
      registry = new OysterRegistry(contexts.get("registry"), env);
      return registry;
    },
    env,
    contexts,
    databases,
    app,
    post,
    select,
  };
}

test("Registry idle retention shares the consumed alarm with approvals and preserves approval reconciliation on deletion failure", async (t) => {
  let now = Date.UTC(2026, 0, 1);
  t.mock.method(Date, "now", () => now);
  let artifactReads = 0;
  const { registry, env, contexts, databases } = fixture(t, {
    get: () => {
      artifactReads++;
      return Promise.resolve(null);
    },
  });
  let artifactDeletes = 0;
  env.RELEASES.delete = async () => {
    artifactDeletes++;
  };
  const pin = { tenantId: defaultTenant, origin: env.OYSTER_ORIGIN };
  const actor = { kind: "member", memberId: "owner" };
  const release = {
    appId: "app_retention",
    releaseId: "rel_retention",
    artifact: {
      artifactRef: "artifact:retention",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      provenance: {
        sourceRevision: `git:${"b".repeat(40)}`,
        sourceTreeDigest: `sha256:${"c".repeat(64)}`,
        buildRecipeDigest: `sha256:${"d".repeat(64)}`,
      },
    },
  };
  const context = contexts.get("registry");
  const storage = context.storage;
  for (const requestId of ["registry-first", "registry-latest"]) {
    const admitted = await registry.installationOperation({
      action: "admit",
      scope: pin,
      input: {
        requestId,
        installationId: "notes",
        release,
        actor,
        intent: "install-or-select",
        origin: "owner-direct",
      },
    });
    assert.equal(admitted.kind, "operation");
    assert.equal(admitted.operation.state, "pending");
    // The platform consumes a persisted alarm before invoking its handler.
    await storage.deleteAlarm();
    await registry.alarm();
    const completed = await registry.installationOperation({
      action: "read",
      scope: pin,
      requestId,
      installationId: "notes",
    });
    assert.equal(completed.kind, "operation");
    assert.equal(completed.operation.state, "refused");
    assert.equal(completed.operation.code, "artifact_missing");
  }
  // Execution may have armed one earlier immediate recovery wake.
  await storage.deleteAlarm();
  await registry.alarm();
  assert.equal(await storage.getAlarm(), Date.UTC(2026, 3, 1));

  const reopened = new OysterRegistry(context, env);
  env.REGISTRY = { getByName: () => reopened };
  await reopened.approvalSetAutoApprove(pin, actor, {
    scope: { agentId: null },
    family: { module: null, access: "write" },
    enabled: false,
  });
  // Reuse the real home's historical pending-record seam: its current target
  // may be absent, but expiry must still be reconciled by the Registry alarm.
  const staging = new OysterApprovalHome({
    owner: storage,
    scope: tenantScope(defaultTenant, env.OYSTER_ORIGIN),
    current: () =>
      Promise.resolve(
        oysterWorkerHost(env, ownerKeyAuth(env.OYSTER_OWNER_KEY)),
      ),
    commit: (write) => write(),
  });
  const pending = await staging.submit({
    actor,
    installationId: "historical-notes",
    sessionId: null,
    operation: "saveNote",
    access: "write",
    authorityFence: "historically-admitted-generation",
    idempotencyKey: "approval-before-retention",
    input: { text: "do not dispatch" },
  });
  assert.equal(pending.kind, "pending_approval");
  const ledger = new ApprovalLedger({
    owner: storage,
    home: { kind: "oyster", id: defaultTenant },
    now: Date.now,
  });
  const approval = ledger.get(pending.recordId);
  assert.ok(approval.expiresAt < Date.UTC(2026, 3, 1));
  await storage.deleteAlarm();
  await reopened.alarm();
  assert.equal(await storage.getAlarm(), approval.expiresAt);

  const database = databases[0];
  database.exec(`CREATE TRIGGER fail_registry_retention
    BEFORE DELETE ON installation_commands
    BEGIN SELECT RAISE(ABORT, 'registry retention fault'); END`);
  now = Date.UTC(2026, 3, 1);
  await storage.deleteAlarm();
  await assert.rejects(() => reopened.alarm(), /registry retention fault/);
  assert.equal(ledger.get(pending.recordId).state, "expired");
  assert.equal(await storage.getAlarm(), null);
  database.exec("DROP TRIGGER fail_registry_retention");
  await reopened.alarm();
  assert.deepEqual(
    await reopened.installationOperation({
      action: "read",
      scope: pin,
      requestId: "registry-first",
      installationId: "notes",
    }),
    { kind: "operation", operation: null },
  );
  const latest = await reopened.installationOperation({
    action: "read",
    scope: pin,
    requestId: "registry-latest",
    installationId: "notes",
  });
  assert.equal(latest.operation.state, "refused");
  assert.equal(artifactReads, 2, "idle maintenance never executes old work");
  assert.equal(
    artifactDeletes,
    0,
    "Release content has no time-based deletion",
  );
});

test("Registry admission preserves an earlier alarm and only its real alarm delivers retained work", async (t) => {
  // This is the D-only Registry/executor composition. B3b's second-land
  // restore-pin/reconcile composition needs its own real joined-owner proof.
  const backend = new TextEncoder().encode(
    JSON.stringify({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "Guest",
      code: "export class Guest {}",
    }),
  );
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      createAppBuild(null, {
        artifactRef: "artifact:wake-backend",
        digest: await sha256(backend),
        mediaType: backendMediaType,
        byteLength: backend.length,
        version: "1",
      }),
    ),
  );
  const digest = await sha256(bytes);
  const release = {
    appId: "app_wakeproof",
    releaseId: "rel_wakeproof",
    artifact: {
      artifactRef: "artifact:wake-proof",
      artifactDigest: digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: digest,
        buildRecipeDigest: digest,
      },
    },
  };
  let reads = 0;
  const { app, registry, env, contexts } = fixture(t, {
    get: async (ref) => {
      reads++;
      if (ref === release.artifact.artifactRef) return bytes;
      return ref === "artifact:wake-backend" ? backend : null;
    },
  });
  const storage = contexts.get("registry").storage;
  const headers = {
    Authorization: `Bearer ${env.OYSTER_OWNER_KEY}`,
    "Content-Type": "application/json",
  };
  for (const [installationId, previousAlarm] of [
    ["earlier-wake", 1],
    ["later-wake", Date.now() + 60_000],
  ]) {
    await storage.setAlarm(previousAlarm);
    const priorReads = reads;
    const requestId = installationCommandIds.request.generate();
    const response = await app.request("/api/installations", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": requestId },
      body: JSON.stringify({ installationId, release }),
    });
    assert.equal(response.status, 202, await response.clone().text());
    assert.deepEqual(installationOperationSchema.parse(await response.json()), {
      requestId,
      requestedInstallationId: installationId,
      installationId,
      release,
      state: "pending",
    });
    assert.equal(reads, priorReads, "admission does not verify or execute");
    assert.equal(registry.get(installationId), null);
    const armed = await storage.getAlarm();
    assert.notEqual(armed, null);
    if (previousAlarm === 1) assert.equal(armed, previousAlarm);
    else {
      assert.ok(armed < previousAlarm);
      assert.ok(armed <= Date.now());
    }
    const statusUrl = `/api/installations/${installationId}/status?requestId=${requestId}`;
    const read = async () => {
      const status = await app.request(statusUrl, { headers });
      assert.equal(status.status, 200);
      return installationOperationSchema.parse(await status.json());
    };
    assert.equal((await read()).state, "pending");
    assert.equal(reads, priorReads, "status reads do not deliver work");
    await registry.alarm();
    const completed = await read();
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.requestId, requestId);
    assert.equal(completed.installationId, installationId);
    assert.equal(completed.creation, "fresh");
    assert.equal(completed.installation.authority.authorityVersion, 1);
    assert.deepEqual(completed.installation.authority.approvedGrants, []);
    assert.ok(reads > priorReads, "the ordinary executor verified artifacts");
  }
});

for (const { acknowledgement, stopObservation } of [
  { acknowledgement: "delivered", stopObservation: false },
  { acknowledgement: "edge-502", stopObservation: false },
  { acknowledgement: "edge-timeout", stopObservation: false },
  { acknowledgement: "lost-reply", stopObservation: false },
  { acknowledgement: "edge-timeout", stopObservation: true },
]) {
  test(`the App CLI install helper exposes correlated admission before waiting for the real owner (${acknowledgement}, stop=${stopObservation})`, async (t) => {
    const selected = await computerHost(
      { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
      null,
      // Match the scaffold's capability-free declaration. The Computer probe's
      // default computer.execute declaration deliberately receives a fresh grant.
      { capabilities: [] },
    );
    const { release } = await selected.installations.get("context-probe");
    const { app, registry, env } = fixture(t, selected.artifacts);
    const directory = await mkdtemp(join(tmpdir(), "cli-install-admission-"));
    const controller = new globalThis.AbortController();
    const admissions = [];
    const firstStatus = Promise.withResolvers();
    const admitted = Promise.withResolvers();
    const errors = [];
    let acknowledged;
    let posts = 0;
    let origin;
    const server = createServer(async (incoming, outgoing) => {
      try {
        const url = new URL(incoming.url, origin);
        const headers = Object.entries(incoming.headers).flatMap(
          ([key, value]) =>
            Array.isArray(value)
              ? value.map((item) => [key, item])
              : value === undefined
                ? []
                : [[key, value]],
        );
        const response = await app.fetch(
          new globalThis.Request(url, {
            method: incoming.method,
            headers,
            body:
              incoming.method === "POST"
                ? Buffer.concat(await Array.fromAsync(incoming))
                : undefined,
          }),
        );
        if (incoming.method === "POST") {
          posts++;
          assert.equal(response.status, 202);
          acknowledged = installationOperationSchema.parse(
            await response.clone().json(),
          );
          if (
            acknowledgement === "edge-timeout" ||
            acknowledgement === "edge-502"
          ) {
            // The real owner accepted the command. Only the edge reply is lost;
            // neither the edge's HTTP 502/504 nor this fixture decides its outcome.
            outgoing.writeHead(acknowledgement === "edge-502" ? 502 : 504);
            outgoing.end("edge timeout");
            return;
          }
          if (acknowledgement === "lost-reply") {
            outgoing.destroy();
            return;
          }
        }
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        outgoing.end(Buffer.from(await response.arrayBuffer()));
        if (url.pathname.endsWith("/status")) firstStatus.resolve();
      } catch (cause) {
        errors.push({ method: incoming.method, path: incoming.url, cause });
        firstStatus.reject(cause);
        outgoing.destroy(cause);
      }
    });
    t.after(async () => {
      controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    await mkdir(join(directory, "artifacts"));
    // These immutable artifacts already exist at the actual owner. The helper
    // still reads the ordinary packed Release and uses its normal HTTP client.
    await writeFile(
      join(directory, "release.json"),
      Schema.encodeUnknownSync(Schema.fromJsonString(releaseSchema))(release),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${server.address().port}`;
    const result = installRelease({
      directory,
      url: origin,
      key: env.OYSTER_OWNER_KEY,
      installationId: "cli-proof",
      // Bound the harness, not the server's durable command lifetime.
      signal: globalThis.AbortSignal.any([
        controller.signal,
        globalThis.AbortSignal.timeout(15_000),
      ]),
      onAdmitted: (operation) => {
        admissions.push(operation);
        admitted.resolve();
      },
    }).then(
      (response) => ({ response }),
      (error) => ({ error }),
    );
    try {
      assert.equal(
        await Promise.race([
          firstStatus.promise.then(() => true),
          result.then(() => false),
        ]),
        true,
        "the client must reach the authoritative status door",
      );
      if (acknowledgement !== "delivered")
        assert.equal(
          await Promise.race([
            admitted.promise.then(() => true),
            result.then(() => false),
          ]),
          true,
          "the client must report admission before ending observation",
        );
      assert.equal(
        admissions.length,
        1,
        "the CLI must receive the correlated identity while completion is pending",
      );
      assert.deepEqual(admissions[0], acknowledged);
      assert.equal(admissions[0].state, "pending");
      assert.equal(registry.get("cli-proof"), null);
      if (stopObservation) {
        const reason = new Error("CLI observer stopped");
        controller.abort(reason);
        const stopped = await result;
        assert.ok("error" in stopped);
        assert.ok(stopped.error instanceof InstallationObservationError);
        assert.equal(stopped.error.requestId, acknowledged.requestId);
        assert.equal(stopped.error.cause, reason);
        assert.equal(registry.get("cli-proof"), null);
      }
      await registry.alarm();
      const statusUrl = new URL("/api/installations/cli-proof/status", origin);
      statusUrl.searchParams.set("requestId", acknowledged.requestId);
      const observed = await globalThis.fetch(statusUrl, {
        headers: { Authorization: `Bearer ${env.OYSTER_OWNER_KEY}` },
        signal: globalThis.AbortSignal.timeout(15_000),
      });
      assert.equal(observed.status, 200);
      const terminal = installationOperationSchema.parse(await observed.json());
      assert.equal(terminal.state, "succeeded");
      assert.equal(terminal.creation, "fresh");
      assert.equal(terminal.installation.authority.authorityVersion, 1);
      assert.deepEqual(terminal.installation.authority.approvedGrants, []);
      if (!stopObservation) {
        const completed = await result;
        assert.ok("response" in completed, String(completed.error));
        assert.equal(completed.response.status, 201);
        assert.deepEqual(
          await completed.response.json(),
          terminal.installation,
        );
      }
      assert.equal(posts, 1);
      assert.equal(admissions.length, 1);
      assert.deepEqual(errors, []);
    } finally {
      controller.abort();
      await result;
    }
  });
}

test("a backend App with a UI and no browser binding succeeds with a not-checked report", async (t) => {
  const ambient = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No ambient network during candidate boot");
  });
  const selected = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const initial = await selected.installations.get("context-probe");
  const verified = await verifyRelease(selected.artifacts, initial.release);
  assert.notEqual(verified.backend, null);
  const html = new TextEncoder().encode("<p>Backend App candidate</p>");
  const uiDigest = await sha256(html);
  const root = new TextEncoder().encode(
    JSON.stringify(
      createAppBuild(
        {
          artifactRef: "artifact:backend-boot-ui",
          digest: uiDigest,
          mediaType: "text/html; charset=utf-8",
          byteLength: html.length,
          version: uiDigest,
        },
        verified.build.backend,
        verified.declaration,
      ),
    ),
  );
  const objects = new Map([
    ["artifact:backend-boot-root", root],
    ["artifact:backend-boot-ui", html],
  ]);
  const release = {
    ...initial.release,
    artifact: {
      ...initial.release.artifact,
      artifactRef: "artifact:backend-boot-root",
      artifactDigest: await sha256(root),
    },
  };
  const { post, env, registry } = fixture(t, {
    get: async (ref) => objects.get(ref) ?? selected.artifacts.get(ref),
  });
  const response = await post(
    { installationId: "backend-boot-probe", release },
    {
      Authorization: `Bearer ${env.OYSTER_OWNER_KEY}`,
      "Content-Type": "application/json",
    },
  );
  assert.equal(response.state, "succeeded");
  assert.deepEqual(response.uiCheck, {
    kind: "not_checked",
    code: "boot_browser_binding_missing",
  });
  assert.equal(registry.get("backend-boot-probe")?.status, "enabled");
  assert.equal(ambient.mock.calls.length, 0);
});

test("owner grant approval refreshes the backend Instance before the next method", async (t) => {
  const selected = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const previous = await selected.installations.get("context-probe");
  const { registry, env, post } = fixture(t, selected.artifacts, {
    fetch: async () => globalThis.Response.json({ accepted: true }),
    context: async () => ({ accepted: true }),
  });
  const app = createOyster(
    oysterWorkerHost(env, ownerKeyAuth(env.OYSTER_OWNER_KEY)),
  );
  const headers = {
    Authorization: `Bearer ${env.OYSTER_OWNER_KEY}`,
    "Content-Type": "application/json",
  };
  const installed = await post(
    {
      installationId: previous.installationId,
      release: previous.release,
    },
    headers,
  );
  assert.equal(installed.state, "succeeded");
  assert.equal(installed.creation, "fresh");
  const current = installed.installation;
  const approved = await app.request(
    `/api/installations/${current.installationId}/grants`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        storeGeneration: (
          await (
            await app.request(
              "/api/installations/" + current.installationId + "/grants",
              { headers: { ...headers, Accept: "application/json" } },
            )
          ).json()
        ).storeGeneration,
        authorityVersion: current.authority.authorityVersion,
        artifactDigest: current.release.artifact.artifactDigest,
        command: {
          kind: "change-grants",
          changes: current.authority.approvedGrants
            .map(({ capability, operations, resources }) => ({
              capability,
              operations,
              resources,
            }))
            .map(({ capability, ...grant }) => ({ capability, grant })),
        },
      }),
    },
  );
  assert.equal(approved.status, 200);
  assert.equal(
    (await approved.json()).authority.authorityVersion,
    current.authority.authorityVersion + 1,
  );
  const called = await app.request(
    `/apps/${current.installationId}/methods/context`,
    {
      method: "POST",
      headers,
      body: "{}",
    },
  );
  assert.equal(called.status, 200, await called.text());
  assert.equal(
    registry.get(current.installationId).authority.authorityVersion,
    current.authority.authorityVersion + 1,
  );
});

test("UI-only release replacement succeeds without creating a backend Instance", async (t) => {
  const html = new TextEncoder().encode("<p>Home</p>");
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      createAppBuild(
        {
          artifactRef: "artifact:ui",
          digest: await sha256(html),
          mediaType: "text/html; charset=utf-8",
          byteLength: html.length,
          version: await sha256(html),
        },
        null,
        { capabilities: ["team.workbenchHost"], handlers: [], roles: [] },
      ),
    ),
  );
  const objects = new Map([
    ["artifact:root", bytes],
    ["artifact:ui", new TextEncoder().encode("<p>Home</p>")],
  ]);
  const { app, registry, env, post, select } = fixture(t, {
    get: async (ref) => objects.get(ref) ?? null,
  });
  let addressedInstances = 0;
  const lookup = env.INSTANCES.getByName;
  env.INSTANCES.getByName = (name) => {
    addressedInstances++;
    return lookup(name);
  };
  const digest = await sha256(bytes);
  const release = {
    appId: "app_tourtois",
    releaseId: "rel_home",
    artifact: {
      artifactRef: "artifact:root",
      artifactDigest: digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: digest,
        buildRecipeDigest: digest,
      },
    },
  };
  const headers = {
    Authorization: `Bearer ${env.OYSTER_OWNER_KEY}`,
    "Content-Type": "application/json",
  };
  const installed = await post(
    { installationId: "tourtois", release },
    headers,
  );
  assert.equal(installed.state, "succeeded", JSON.stringify(installed));
  assert.equal(installed.creation, "fresh");
  // No BROWSER binding here: the UI is reported not checked, never refused.
  assert.deepEqual(installed.uiCheck, {
    kind: "not_checked",
    code: "boot_browser_binding_missing",
  });
  const previous = registry.get("tourtois");
  const replacedRequestId = installationCommandIds.request.generate();
  const replaced = await select(
    "/api/installations/tourtois/release",
    { method: "PUT", headers, body: JSON.stringify(release) },
    replacedRequestId,
  );
  assert.equal(replaced.status, 200);
  assert.equal(registry.get("tourtois").authority.authorityVersion, 2);
  const replacedStatus = await app.request(
    `/api/installations/tourtois/status?requestId=${encodeURIComponent(replacedRequestId)}`,
    { headers: { Authorization: `Bearer ${env.OYSTER_OWNER_KEY}` } },
  );
  assert.equal(replacedStatus.status, 200);
  assert.deepEqual(
    installationOperationSchema.parse(await replacedStatus.json()).uiCheck,
    { kind: "not_checked", code: "boot_browser_binding_missing" },
  );
  assert.notDeepEqual(registry.get("tourtois"), previous);
  assert.equal(addressedInstances, 0);
  const current = registry.get("tourtois");
  const approvals = await Promise.all(
    [0, 1].map(async () =>
      app.request("/api/installations/tourtois/grants", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          storeGeneration: (
            await (
              await app.request(
                "/api/installations/" + current.installationId + "/grants",
                { headers: { ...headers, Accept: "application/json" } },
              )
            ).json()
          ).storeGeneration,
          authorityVersion: current.authority.authorityVersion,
          artifactDigest: current.release.artifact.artifactDigest,
          command: {
            kind: "change-grants",
            changes: [{ capability: "team.workbenchHost", grant: null }],
          },
        }),
      }),
    ),
  );
  assert.deepEqual(
    approvals.map((response) => response.status).sort(),
    [200, 409],
  );
  assert.equal(
    registry.get("tourtois").authority.authorityVersion,
    current.authority.authorityVersion + 1,
  );
  assert.equal(addressedInstances, 0);
});

test("a foreign backend owner refuses replacement before changing the registry selection", async (t) => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const previous = await host.installations.get("context-probe");
  const { registry, env } = fixture(t, host.artifacts);
  assert.deepEqual(
    await registry.compareAndPut(previous, 0, await registry.generation()),
    { ok: true },
  );
  // The foreign selection must itself be committed; only the internal fixture
  // deliberately associates two owners with one Instance to test the refusal.
  assert.deepEqual(
    await registry.compareAndPut(
      { ...previous, installationId: "foreign" },
      0,
      await registry.generation(),
    ),
    { ok: true },
  );
  const instance = env.INSTANCES.getByName(previous.instanceId);
  const applied = await instance.apply(
    {
      instanceId: previous.instanceId,
      owner: { kind: "installation", id: "foreign" },
      appId: previous.release.appId,
      releaseId: previous.release.releaseId,
      authorityVersion: 1,
      status: "enabled",
    },
    previous.release,
    undefined,
    { tenantId: defaultTenant, origin: env.OYSTER_ORIGIN },
  );
  assert.equal(applied.ok, true);
  const next = {
    ...previous,
    authority: {
      ...previous.authority,
      authorityVersion: 2,
    },
  };
  await assert.rejects(
    registry.compareAndPut(
      next,
      previous.authority.authorityVersion,
      await registry.generation(),
    ),
    { code: "instance_owner_mismatch" },
  );
  assert.deepEqual(registry.get(previous.installationId), previous);
});

test("a replacement awaiting revocation cannot overwrite a newer selection", async (t) => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const previous = await host.installations.get("context-probe");
  const { registry, env } = fixture(t, host.artifacts);
  assert.deepEqual(
    await registry.compareAndPut(previous, 0, await registry.generation()),
    { ok: true },
  );
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let finish;
  const waiting = new Promise((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  env.INSTANCES.getByName = () => ({
    async revoke() {
      calls++;
      if (calls === 1) {
        enter();
        await waiting;
      }
    },
  });
  const stale = registry.compareAndPut(
    {
      ...previous,
      authority: {
        ...previous.authority,
        authorityVersion: 2,
      },
    },
    previous.authority.authorityVersion,
    await registry.generation(),
  );
  await entered;
  const current = {
    ...previous,
    authority: {
      ...previous.authority,
      authorityVersion: 3,
    },
  };
  assert.deepEqual(
    await registry.compareAndPut(
      current,
      previous.authority.authorityVersion,
      await registry.generation(),
    ),
    { ok: true },
  );
  finish();
  assert.deepEqual(await stale, { ok: false, code: "stale_authority" });
  assert.deepEqual(registry.get(previous.installationId), current);
});

test("the default root arms one durable wake after a burst and replays the member only on alarm", async (t) => {
  const objects = new Map();
  const persist = async (name, value, mediaType) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = await sha256(bytes);
    const artifactRef = `artifact:${name}`;
    objects.set(artifactRef, bytes);
    return {
      artifactRef,
      digest,
      version: "1",
      byteLength: bytes.length,
      mediaType,
    };
  };
  const backend = await persist(
    "background-backend",
    {
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "Guest",
      code: "export class Guest {}",
    },
    backendMediaType,
  );
  const method = {
    description: "Write queued rows",
    effect: "write",
    requires: [],
    input: { type: "object" },
    output: { type: "object" },
  };
  const build = createAppBuild(null, backend, {
    capabilities: [],
    handlers: [],
    roles: [],
    commands: [],
    gills: [],
    backend: { bindings: [], sync: { method: "continueWrites" } },
    api: { methods: { saveDraft: method, continueWrites: method } },
  });
  const root = await persist("background-root", build, "application/json");
  const release = {
    appId: "app_background",
    releaseId: "rel_background",
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
  await verifyRelease(
    { get: (ref) => Promise.resolve(objects.get(ref) ?? null) },
    parseRelease(release),
  );
  const clicks = [];
  const replays = [];
  const { app, registry, env, contexts, post } = fixture(
    t,
    { get: async (ref) => objects.get(ref) ?? null },
    {
      saveDraft: async (_input, context) => {
        clicks.push(context);
        return { queued: true };
      },
      continueWrites: async (_input, context) => {
        replays.push(context);
        return { more: false };
      },
    },
  );
  const headers = {
    Authorization: `Bearer ${env.OYSTER_OWNER_KEY}`,
    "Content-Type": "application/json",
  };
  const installationResponse = await post(
    { installationId: "background", release },
    headers,
  );
  assert.equal(installationResponse.state, "succeeded");
  for (let click = 0; click < 5; click += 1)
    assert.equal(
      (
        await app.request("/apps/background/methods/saveDraft", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
  assert.equal(clicks.length, 5);
  assert.equal(clicks[0].backgroundLane, "member:owner");
  assert.deepEqual(replays, []);
  const selected = registry.get("background");
  const instance = env.INSTANCES.getByName(selected.instanceId);
  assert.notEqual(
    await contexts.get(selected.instanceId).storage.getAlarm(),
    null,
  );
  await instance.alarm();
  assert.equal(replays.length, 1);
  assert.deepEqual(replays[0].actor, { kind: "member", memberId: "owner" });
  assert.equal(replays[0].role, "owner");
  assert.equal(replays[0].backgroundLane, undefined);
  assert.match(replays[0].idempotencyKey, /^appsync:[a-f0-9]{64}$/u);
  await instance.alarm();
  assert.equal(replays.length, 1);
  assert.equal(
    (
      await app.request("/apps/background/methods/saveDraft", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    200,
  );
  await instance.alarm();
  assert.equal(replays.length, 2);
  assert.notEqual(replays[0].idempotencyKey, replays[1].idempotencyKey);
});

test("a durable approval rejects a competing update with the same expected version", async (t) => {
  const { registry } = fixture(t, { get: async () => null });
  const installed = {
    ...(await (
      await computerHost(
        { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
        null,
      )
    ).installations.get("context-probe")),
  };
  // No attached backend Instance: exercise the durable commit without a revoke await.
  installed.instanceId = null;
  assert.deepEqual(
    await registry.compareAndPut(installed, 0, await registry.generation()),
    { ok: true },
  );
  const first = {
    ...installed,
    authority: {
      ...installed.authority,
      authorityVersion: installed.authority.authorityVersion + 1,
      approvedGrants: [],
      approval: null,
    },
  };
  assert.deepEqual(
    await registry.compareAndPut(
      first,
      installed.authority.authorityVersion,
      await registry.generation(),
    ),
    { ok: true },
  );
  assert.deepEqual(
    await registry.compareAndPut(
      { ...first, status: "disabled" },
      installed.authority.authorityVersion,
      await registry.generation(),
    ),
    { ok: false, code: "stale_authority" },
  );
  assert.deepEqual(registry.get(installed.installationId), first);
});

test("an approval losing during Release resolution refuses before revoking an Instance", async (t) => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const previous = await host.installations.get("context-probe");
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const { registry, env } = fixture(t, {
    get: async (ref) => {
      if (++reads === 1) {
        enter();
        await blocked;
      }
      return host.artifacts.get(ref);
    },
  });
  assert.deepEqual(
    await registry.compareAndPut(previous, 0, await registry.generation()),
    { ok: true },
  );
  let revoked = 0;
  env.INSTANCES.getByName = () => ({
    revoke: async () => {
      revoked++;
    },
  });
  const stale = registry.compareAndPut(
    {
      ...previous,
      authority: {
        ...previous.authority,
        authorityVersion: 2,
      },
    },
    previous.authority.authorityVersion,
    await registry.generation(),
  );
  await entered;
  const winner = {
    ...previous,
    authority: {
      ...previous.authority,
      authorityVersion: 3,
    },
  };
  assert.deepEqual(
    await registry.compareAndPut(
      winner,
      previous.authority.authorityVersion,
      await registry.generation(),
    ),
    { ok: true },
  );
  assert.equal(revoked, 1);
  release();
  assert.deepEqual(await stale, { ok: false, code: "stale_authority" });
  assert.equal(revoked, 1);
  assert.deepEqual(registry.get(previous.installationId), winner);
});

for (const marker of [
  { visibility: "private" },
  { approvedAnonymousMethods: [] },
  { anonymousApproval: null },
]) {
  test(`pre-owner-only installations reset once at boot (${Object.keys(marker)[0]}) and the install-apps client recovers without losing Agents or Sessions`, async (t) => {
    const host = await computerHost();
    const f = fixture(t, host.artifacts, {
      fetch: async () => globalThis.Response.json({ accepted: true }),
    });
    const { databases, app, env } = f;
    const db = databases[0];
    const owner = f.contexts.get("registry").storage;
    // Exercise real foreign owners in the same SQLite database: even a
    // registry-wide wipe cannot accidentally pass the survival assertions.
    const directory = createAgentDirectory(owner.sql);
    const grant = {
      agents: "all",
      actions: ["create", "read", "manage"],
      expiresAt: Date.now() + 60_000,
      provenance: { actor: "fixture" },
    };
    const created = owner.transactionSync(() =>
      directory.create(grant, {
        name: "Retained Agent",
        requestId: "reset-survival-agent",
        configuration: "none",
      }),
    ).agent;
    const agent = await memoryHost({ owner, script: ["Retained answer"] });
    t.after(() => agent.close());
    const session = agent.agent.session("reset-survival-session");
    await session.send("Keep this Session", {
      requestId: "reset-survival-turn",
    });
    const snapshot = await agent.settle("reset-survival-session");
    assert.equal(snapshot.messages.length, 2);
    const installed = await host.installations.get("context-probe");
    assert.notEqual(installed, null);
    db.prepare("INSERT INTO installations VALUES(?,?)").run(
      installed.installationId,
      JSON.stringify(installed),
    );
    const headers = {
      Authorization: `Bearer ${env.OYSTER_OWNER_KEY}`,
      "Content-Type": "application/json",
    };
    // Retain a real accepted command, then represent its pre-owner-only
    // baseline exactly as that version would have serialized it.
    const accepted = await app.request("/api/installations", {
      method: "POST",
      headers: {
        ...headers,
        "Idempotency-Key": installationCommandIds.request.generate(),
      },
      body: JSON.stringify({
        installationId: installed.installationId,
        release: installed.release,
      }),
    });
    assert.equal(accepted.status, 202, await accepted.clone().text());
    const old = { ...installed, ...marker };
    const command = db
      .prepare("SELECT request_id, command FROM installation_commands")
      .get();
    const stored = JSON.parse(command.command);
    stored.baseline = old;
    db.prepare(
      "UPDATE installation_commands SET command=? WHERE request_id=?",
    ).run(JSON.stringify(stored), command.request_id);
    db.prepare("UPDATE installations SET record=?").run(JSON.stringify(old));
    // A reset replaces the installation store, not just the offending row.
    db.prepare("INSERT INTO installations VALUES(?,?)").run(
      "current-app",
      JSON.stringify({ ...installed, installationId: "current-app" }),
    );
    const generation = f.registry.generation();
    db.exec(
      "DROP TABLE installation_store; CREATE TABLE installation_store (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL) STRICT",
    );
    db.prepare("INSERT INTO installation_store VALUES(1,?)").run(generation);
    const jobs = db.prepare("SELECT * FROM watchdog_jobs").all();
    f.restart();
    const notice =
      "This update reset your installed Apps. Reinstall them with npx oyster install-apps.";
    const home = await app.request("/", { headers });
    assert.equal(home.status, 200, await home.clone().text());
    assert.equal((await home.text()).split(notice).length - 1, 1);
    const list = await app.request("/api/installations", { headers });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), []);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM installations").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM installation_commands").get().n,
      0,
    );
    const audit = { ...db.prepare("SELECT * FROM installation_store").get() };
    assert.notEqual(audit.generation, generation);
    assert.ok(audit.reset_at > 0);
    assert.equal(audit.reset_rows, 2);
    assert.deepEqual(db.prepare("SELECT * FROM watchdog_jobs").all(), jobs);
    assert.deepEqual(directory.read(grant, created.agentId), created);
    assert.deepEqual(await session.read(), snapshot);
    const second = await app.request("/", { headers });
    assert.equal(second.status, 200);
    assert.equal((await second.text()).split(notice).length - 1, 1);
    f.restart();
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM installation_store").get() },
      audit,
    );
    await f.registry.alarm(); // Existing orphan handling settles the old wake.
    assert.deepEqual(f.registry.list(), []);
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const response = await app.request(new globalThis.Request(input, init));
      if (init?.method === "POST") await f.registry.alarm();
      return response;
    });
    // This is the same maintained installation client used by install-apps,
    // through real HTTP admission, execution and authoritative observation.
    const reinstalled = await installOnOyster({
      url: env.OYSTER_ORIGIN,
      key: env.OYSTER_OWNER_KEY,
      installationId: installed.installationId,
      release: installed.release,
      signal: new globalThis.AbortController().signal,
    });
    assert.equal(reinstalled.state, "succeeded");
    assert.equal(f.registry.get(installed.installationId)?.status, "enabled");
    assert.doesNotMatch(
      await (await app.request("/", { headers })).text(),
      /This update reset/,
    );
    f.restart();
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM installation_store").get() },
      audit,
    );
    assert.equal(f.registry.list().length, 1);
    assert.deepEqual(directory.read(grant, created.agentId), created);
    assert.deepEqual(await session.read(), snapshot);
  });
}

test("install-apps immediately recovers all seven Apps after reset: Agents and Sessions survive, APP_STORAGE reattaches, backend SQLite is kept but unreachable", async (t) => {
  const host = await computerHost(undefined, undefined, {
    api: buildAppApi(notesBackend),
    storage: [{ key: "saved", scopes: ["team", "member"], maxBytes: 1024 }],
  });
  const base = await host.installations.get("context-probe");
  const releases = new Map(
    standaloneAppSet.map(({ appId }) => [
      appId,
      { ...base.release, appId, releaseId: `rel_${appId.slice(4)}reset` },
    ]),
  );
  // The retained Notes backend is an ordinary App with its own SQLite.
  // Model the platform's separate live `app` facet under each named Instance;
  // never put backend data in the registry or a shared guest singleton.
  const facets = new Map();
  const f = fixture(t, host.artifacts, undefined, 0, (instanceId) => {
    if (!facets.has(instanceId)) {
      const db = new DatabaseSync(":memory:");
      const ctx = { storage: fromNodeSqlite(db) };
      const backend = Object.fromEntries(
        ["readNote", "saveNote"].map((method) => [
          method,
          (input, caller) => notesBackend.call(method, input, { ctx }, caller),
        ]),
      );
      backend.delete = () => {
        db.close();
        facets.delete(instanceId);
      };
      facets.set(instanceId, backend);
      t.after(() => {
        if (db.isOpen) db.close();
      });
    }
    return facets.get(instanceId);
  });
  const physicalRead = (instanceId) =>
    facets
      .get(instanceId)
      .readNote(
        {},
        { computerId: null, actor: { kind: "member", memberId: "owner" } },
      );
  const headers = {
    Authorization: `Bearer ${f.env.OYSTER_OWNER_KEY}`,
    "Content-Type": "application/json",
  };
  const call = async (id, method, input = {}) => {
    const response = await f.app.request(`/apps/${id}/methods/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const owner = f.contexts.get("registry").storage;
  const directory = createAgentDirectory(owner.sql);
  const grant = {
    agents: "all",
    actions: ["create", "read", "manage"],
    expiresAt: Date.now() + 60_000,
    provenance: { actor: "fixture" },
  };
  const created = owner.transactionSync(() =>
    directory.create(grant, {
      name: "Installer-surviving Agent",
      requestId: "installer-survival-agent",
      configuration: "none",
    }),
  ).agent;
  const agent = await memoryHost({ owner, script: ["Still here"] });
  t.after(() => agent.close());
  const session = agent.agent.session("installer-survival-session");
  await session.send("Keep this conversation", {
    requestId: "installer-survival-turn",
  });
  const snapshot = await agent.settle("installer-survival-session");
  assert.equal(snapshot.messages.length, 2);
  const previous = new Map();
  const settings = new Map();
  for (const { installationId, appId } of standaloneAppSet) {
    const outcome = await f.post(
      { installationId, release: releases.get(appId) },
      headers,
    );
    assert.equal(outcome.state, "succeeded");
    previous.set(installationId, f.registry.get(installationId));
    assert.deepEqual(
      await call(installationId, "saveNote", {
        text: `Owned by ${installationId}`,
      }),
      { saved: true },
    );
    for (const scope of ["team", "member"]) {
      const written = await f.registry.storageWrite(installationId, "owner", {
        key: "saved",
        scope,
        basedOn: null,
        value: `${installationId} ${scope} settings`,
      });
      assert.equal(written.kind, "accepted");
    }
    settings.set(
      installationId,
      await f.registry.storageRead(installationId, "owner", "saved"),
    );
  }
  const db = f.databases[0];
  const savedRows = db.prepare("SELECT * FROM hub_app_storage").all();
  assert.equal(savedRows.length, 14);
  db.exec(
    "UPDATE installations SET record=json_set(record, '$.visibility', 'private')",
  );
  const generation = f.registry.generation();
  f.restart();
  assert.notEqual(f.registry.generation(), generation);
  assert.deepEqual(f.registry.list(), []);
  assert.deepEqual(
    db.prepare("SELECT * FROM hub_app_storage").all(),
    savedRows,
  );
  assert.deepEqual(directory.read(grant, created.agentId), created);
  assert.deepEqual(await session.read(), snapshot);
  const home = await f.app.request("/", { headers });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /This update reset your installed Apps/);
  for (const { installationId } of standaloneAppSet) {
    assert.equal(
      (
        await f.app.request(`/apps/${installationId}/methods/readNote`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      404,
    );
    assert.deepEqual(
      await physicalRead(previous.get(installationId).instanceId),
      { text: `Owned by ${installationId}` },
    );
  }

  const builds = new Map();
  const published = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new globalThis.Request(input, init);
    const url = new URL(request.url);
    // Source publication and the external Computer are fixture boundaries.
    // Installation admission, execution, status and dashboard approval below
    // always reach the real host; no installation result is manufactured.
    if (url.pathname === "/api/builds" && request.method === "POST") {
      const { appId } = await request.json();
      assert.ok(releases.has(appId));
      const jobId = `reset-build-${builds.size}`;
      builds.set(jobId, appId);
      return globalThis.Response.json(
        { jobId, status: "running", detail: null, release: null },
        { status: 202 },
      );
    }
    if (url.pathname.startsWith("/api/builds/")) {
      const jobId = url.pathname.slice("/api/builds/".length);
      assert.ok(builds.has(jobId));
      return globalThis.Response.json({
        jobId,
        status: "succeeded",
        detail: null,
        release: releases.get(builds.get(jobId)),
      });
    }
    const response = await f.app.request(request);
    if (url.pathname === "/api/installations" && request.method === "POST")
      await f.registry.alarm();
    return response;
  });
  const output = [];
  const stdout = t.mock.method(process.stdout, "write", (chunk) => {
    output.push(String(chunk));
    return true;
  });
  const priorUrl = process.env.OYSTER_URL;
  const priorKey = process.env.OYSTER_OWNER_KEY;
  const priorExit = process.exitCode;
  process.env.OYSTER_URL = f.env.OYSTER_ORIGIN;
  process.env.OYSTER_OWNER_KEY = f.env.OYSTER_OWNER_KEY;
  try {
    // The CLI's actual parser/source lookup/orchestrator, not a hand-built
    // install or a replacement installer. Only its maintained publisher port
    // and external Computer responses use fixture producers.
    await installApps(
      [
        "--from",
        fileURLToPath(new URL("../../../", import.meta.url)),
        "--concurrency",
        "1",
      ],
      (options) =>
        installStandaloneAppSet({
          ...options,
          publish: async (app, located) => {
            published.push(app.installationId);
            return globalThis.Response.json({
              kind: "recorded",
              receipt: {
                seedRevision: located.sourceRevision,
                sourceRevision: located.sourceRevision,
              },
            });
          },
        }),
    );
  } finally {
    stdout.mock.restore();
    if (priorUrl === undefined) delete process.env.OYSTER_URL;
    else process.env.OYSTER_URL = priorUrl;
    if (priorKey === undefined) delete process.env.OYSTER_OWNER_KEY;
    else process.env.OYSTER_OWNER_KEY = priorKey;
  }
  assert.equal(process.exitCode, priorExit);
  assert.match(output.join(""), /Installed 7 Apps; failed 0/);
  assert.deepEqual(published, [
    "tourtois",
    "bonsai",
    "shed",
    "inkcap",
    "trellis",
    "prints",
    "grove",
  ]);
  assert.equal(builds.size, 7);
  assert.equal(f.registry.list().length, 7);
  for (const { installationId, appId } of standaloneAppSet) {
    const current = f.registry.get(installationId);
    assert.equal(current.status, "enabled");
    assert.equal(current.release.appId, appId);
    assert.equal(
      current.installationId,
      previous.get(installationId).installationId,
    );
    assert.notEqual(
      current.instanceId,
      previous.get(installationId).instanceId,
    );
    assert.deepEqual(
      await f.registry.storageRead(installationId, "owner", "saved"),
      settings.get(installationId),
    );
    assert.deepEqual(await call(installationId, "readNote"), { text: null });
    assert.deepEqual(
      await physicalRead(previous.get(installationId).instanceId),
      { text: `Owned by ${installationId}` },
    );
  }
  assert.equal(facets.size, 14);
  // App ID alone is not the host storage identity: a second installation of
  // the exact same Release must not read the original installation's settings.
  const anotherAddress = await f.post(
    { installationId: "prints-copy", release: releases.get("app_prints") },
    headers,
  );
  assert.equal(anotherAddress.state, "succeeded");
  assert.deepEqual(
    await f.registry.storageRead("prints-copy", "owner", "saved"),
    {
      kind: "accepted",
      value: {
        value: null,
        source: "none",
        team: null,
        member: null,
        canWriteTeam: true,
      },
    },
  );
  assert.deepEqual(
    await f.registry.storageRead("prints", "owner", "saved"),
    settings.get("prints"),
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM hub_app_storage").all(),
    savedRows,
  );
  assert.deepEqual(directory.read(grant, created.agentId), created);
  assert.deepEqual(await session.read(), snapshot);
  assert.doesNotMatch(
    await (await f.app.request("/", { headers })).text(),
    /This update reset/,
  );
});

test("a failed reset audit write rolls back installations, command history and incarnation together", async (t) => {
  const host = await computerHost();
  const f = fixture(t, host.artifacts, {
    fetch: async () => globalThis.Response.json({ accepted: true }),
  });
  const installed = await host.installations.get("context-probe");
  await f.post(
    { installationId: installed.installationId, release: installed.release },
    {
      Authorization: `Bearer ${f.env.OYSTER_OWNER_KEY}`,
      "Content-Type": "application/json",
    },
  );
  const db = f.databases[0];
  const row = f.registry.get(installed.installationId);
  db.prepare("UPDATE installations SET record=?").run(
    JSON.stringify({ ...row, visibility: "private" }),
  );
  const dump = () => ({
    installations: db.prepare("SELECT * FROM installations").all(),
    commands: db.prepare("SELECT * FROM installation_commands").all(),
    store: db.prepare("SELECT * FROM installation_store").all(),
    jobs: db.prepare("SELECT * FROM watchdog_jobs").all(),
  });
  const before = dump();
  assert.equal(before.commands.length, 1);
  const sql = f.contexts.get("registry").storage.sql;
  const exec = sql.exec.bind(sql);
  const fault = t.mock.method(sql, "exec", (statement, ...bindings) => {
    if (statement.startsWith("UPDATE installation_store SET reset_at="))
      throw new Error("fixture reset audit write failed");
    return exec(statement, ...bindings);
  });
  assert.throws(() => f.restart(), /fixture reset audit write failed/);
  assert.deepEqual(dump(), before);
  fault.mock.restore();
  f.restart();
  assert.deepEqual(f.registry.list(), []);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM installation_commands").get().n,
    0,
  );
  assert.equal(
    db.prepare("SELECT reset_rows FROM installation_store").get().reset_rows,
    1,
  );
});

test("the reset re-probes inside its transaction and preserves a concurrently replaced current row", async (t) => {
  const host = await computerHost();
  const f = fixture(t, host.artifacts);
  const installed = await host.installations.get("context-probe");
  const db = f.databases[0];
  db.prepare("INSERT INTO installations VALUES(?,?)").run(
    installed.installationId,
    JSON.stringify({ ...installed, visibility: "private" }),
  );
  const generation = f.registry.generation();
  const storage = f.contexts.get("registry").storage;
  const transaction = storage.transactionSync.bind(storage);
  const interleave = t.mock.method(storage, "transactionSync", (body) => {
    interleave.mock.restore();
    db.prepare("UPDATE installations SET record=?").run(
      JSON.stringify(installed),
    );
    return transaction(body);
  });
  f.restart();
  assert.deepEqual(f.registry.get(installed.installationId), installed);
  assert.equal(f.registry.generation(), generation);
  assert.equal(
    db.prepare("SELECT reset_at FROM installation_store").get().reset_at,
    null,
  );
});

test("the persisted reset fact prevents a second wipe when an old-shaped backup reappears", async (t) => {
  const host = await computerHost();
  const f = fixture(t, host.artifacts);
  const installed = await host.installations.get("context-probe");
  const db = f.databases[0];
  const old = JSON.stringify({ ...installed, anonymousApproval: null });
  db.prepare("INSERT INTO installations VALUES(?,?)").run(
    installed.installationId,
    old,
  );
  f.restart();
  assert.deepEqual(f.registry.list(), []);
  const audit = { ...db.prepare("SELECT * FROM installation_store").get() };
  db.prepare("INSERT INTO installations VALUES(?,?)").run(
    installed.installationId,
    old,
  );
  db.prepare("INSERT INTO installations VALUES(?,?)").run(
    "current-app",
    JSON.stringify({ ...installed, installationId: "current-app" }),
  );
  f.restart();
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM installation_store").get() },
    audit,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM installations").get().n,
    2,
  );
  assert.throws(() => f.registry.list());
});

test("a current-format installation with missing capability approval still hard-fails without resetting anything", async (t) => {
  const host = await computerHost();
  const { registry, databases, app, env, restart } = fixture(t, host.artifacts);
  const installed = await host.installations.get("context-probe");
  const corrupt = {
    ...installed,
    authority: {
      ...installed.authority,
      approvedGrants: [
        {
          capability: "git.repository",
          operations: ["binding:GIT:read"],
          resources: "tenant-scope",
        },
      ],
    },
  };
  databases[0]
    .prepare("INSERT INTO installations VALUES(?,?)")
    .run(installed.installationId, JSON.stringify(corrupt));
  const generation = registry.generation();
  restart();
  // An undecodable row is corruption, never a silently tolerated shape.
  assert.throws(() => registry.get(installed.installationId));
  assert.throws(() => registry.list());
  const headers = { Authorization: `Bearer ${env.OYSTER_OWNER_KEY}` };
  const home = await app.request("/", { headers });
  assert.equal(home.status, 500);
  const list = await app.request("/api/installations", { headers });
  assert.equal(list.status, 500);
  assert.equal(registry.generation(), generation);
  assert.equal(
    databases[0].prepare("SELECT COUNT(*) AS n FROM installations").get().n,
    1,
  );
});

test("store identity survives registry restart and rejects an old save in a replacement store with identical installation pins", async (t) => {
  const selected = await computerHost(
    { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
    null,
  );
  const initial = await selected.installations.get("context-probe");
  const first = fixture(t, selected.artifacts);
  const generation = first.registry.generation();
  const restarted = new OysterRegistry(
    first.contexts.get("registry"),
    first.env,
  );
  assert.equal(restarted.generation(), generation);
  const replacement = fixture(t, selected.artifacts);
  const freshGeneration = replacement.registry.generation();
  assert.notEqual(freshGeneration, generation);
  assert.deepEqual(await first.registry.compareAndPut(initial, 0, generation), {
    ok: true,
  });
  assert.deepEqual(
    await replacement.registry.compareAndPut(initial, 0, freshGeneration),
    { ok: true },
  );
  const headers = {
    Authorization: "Bearer " + first.env.OYSTER_OWNER_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const projection = await (
    await first.app.request("/api/installations/context-probe/grants", {
      headers,
    })
  ).json();
  const response = await replacement.app.request(
    "/api/installations/context-probe/grants",
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        storeGeneration: projection.storeGeneration,
        authorityVersion: projection.permissions.authority.authorityVersion,
        artifactDigest: projection.artifactDigest,
        command: {
          kind: "change-grants",
          changes: [
            {
              capability: initial.authority.approvedGrants[0].capability,
              grant: null,
            },
          ],
        },
      }),
    },
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "stale_authority" });
  assert.deepEqual(replacement.registry.get(initial.installationId), initial);
  assert.deepEqual(
    await replacement.registry.compareAndPut(
      initial,
      initial.authority.authorityVersion,
      generation,
    ),
    { ok: false, code: "stale_authority" },
  );
});

for (const schedule of [
  "committed-loser-after-winner",
  "uncommitted-loser-after-winner",
  "uncommitted-loser-before-winner-active",
]) {
  test(`a real Instance fences the losing selection: ${schedule}`, async (t) => {
    const source = await computerHost(
      { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
      null,
    );
    const initial = await source.installations.get("context-probe");
    const { registry, env, contexts } = fixture(t, source.artifacts);
    const generation = registry.generation();
    const instance = env.INSTANCES.getByName(initial.instanceId);
    const tenant = { tenantId: defaultTenant, origin: env.OYSTER_ORIGIN };
    const state = (record) => ({
      ...selectionOf(record),
      status: record.status,
    });
    const select = async (current, releaseId) => {
      const release = { ...current.release, releaseId };
      const verified = await verifyRelease(source.artifacts, release);
      const declaration = verified.declaration ?? emptyAppDeclaration;
      const update = applyInstallationCommand(
        current,
        { kind: "select-release", release, releasePin: "pinned" },
        {
          by: { kind: "member", memberId: "fixture" },
          role: "owner",
          now: 1001,
          expectedVersion: current.authority.authorityVersion,
          identity: current,
          declaration,
          declaredOperations: await deriveDeclaredOperations(
            release,
            declaration,
            source.capabilities ?? [],
          ),
        },
      );
      if (Result.isFailure(update)) throw new Error(update.failure.code);
      return update.success.next;
    };
    const persisted = () => ({
      releases: contexts
        .get(initial.instanceId)
        .storage.sql.exec(
          "SELECT release_id, release FROM oyster_releases ORDER BY release_id",
        )
        .toArray(),
      instances: contexts
        .get(initial.instanceId)
        .storage.sql.exec("SELECT record FROM app_instance")
        .toArray(),
    });
    const beforePrepare = persisted();
    assert.deepEqual(
      await instance.prepare(
        state(initial),
        initial.release,
        undefined,
        tenant,
      ),
      {
        ok: true,
        value: { kind: "passed" },
      },
    );
    assert.deepEqual(persisted(), beforePrepare);
    assert.deepEqual(await registry.compareAndPut(initial, 0, generation), {
      ok: true,
    });
    assert.equal(
      (await instance.apply(state(initial), initial.release, undefined, tenant))
        .ok,
      true,
    );
    const committedState = persisted();
    const losing = await select(initial, "rel_loser");
    assert.equal(
      (await instance.prepare(state(losing), losing.release, undefined, tenant))
        .ok,
      true,
    );
    assert.deepEqual(persisted(), committedState);
    const committedLoser = schedule === "committed-loser-after-winner";
    if (committedLoser)
      assert.deepEqual(
        await registry.compareAndPut(
          losing,
          initial.authority.authorityVersion,
          generation,
        ),
        { ok: true },
      );
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const loser = (async () => {
      entered.resolve();
      await resume.promise;
      return instance.apply(state(losing), losing.release, undefined, tenant);
    })();
    await entered.promise;
    const basis = committedLoser ? losing : initial;
    const winner = await select(basis, "rel_winner");
    assert.equal(
      (await instance.prepare(state(winner), winner.release, undefined, tenant))
        .ok,
      true,
    );
    assert.deepEqual(persisted(), committedState);
    assert.deepEqual(
      await registry.compareAndPut(
        winner,
        basis.authority.authorityVersion,
        generation,
      ),
      { ok: true },
    );

    const active = () =>
      Schema.decodeUnknownSync(Schema.fromJsonString(instanceSchema))(
        contexts
          .get(initial.instanceId)
          .storage.sql.exec("SELECT record FROM app_instance WHERE id=1")
          .toArray()[0].record,
      );
    const beforeActivation = active();
    if (schedule === "uncommitted-loser-before-winner-active") {
      resume.resolve();
      assert.deepEqual(await loser, { ok: false, code: "stale_authority" });
      assert.deepEqual(active(), beforeActivation);
    }
    assert.equal(
      (await instance.apply(state(winner), winner.release, undefined, tenant))
        .ok,
      true,
    );
    const selected = active();
    assert.equal(selected.releaseId, winner.release.releaseId);
    assert.equal(selected.authorityVersion, winner.authority.authorityVersion);
    resume.resolve();
    assert.deepEqual(await loser, { ok: false, code: "stale_authority" });
    assert.deepEqual(registry.get(initial.installationId), winner);
    assert.deepEqual(active(), selected);
  });
}

for (const failure of ["constructor", "state-schema"]) {
  test(`a refused ${failure} preflight preserves the committed selection and SQLite records`, async (t) => {
    const source = await computerHost(
      { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
      null,
    );
    const previous = await source.installations.get("context-probe");
    const artifacts = new Map();
    const put = async (value) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const digest = await sha256(bytes);
      const artifactRef = `artifact:sha256-${digest.slice(7)}`;
      artifacts.set(artifactRef, bytes);
      return { artifactRef, digest, byteLength: bytes.length, version: digest };
    };
    const backend = await put({
      runtime: {
        kind: "durable-facet",
        stateSchema: failure === "state-schema" ? 2 : 1,
      },
      compatibilityDate: "2026-09-04",
      exportName: "ContextProbe",
      code:
        failure === "constructor"
          ? 'export class ContextProbe { constructor() { throw new Error("candidate refused"); } }'
          : "export class ContextProbe {}",
    });
    const root = await put(
      createAppBuild(
        null,
        { ...backend, mediaType: backendMediaType },
        emptyAppDeclaration,
      ),
    );
    const candidate = parseRelease({
      ...previous.release,
      releaseId: "rel_refused",
      artifact: {
        ...previous.release.artifact,
        artifactRef: root.artifactRef,
        artifactDigest: root.digest,
      },
    });
    const { registry, env, contexts, post, select } = fixture(
      t,
      {
        get: async (ref) => artifacts.get(ref) ?? source.artifacts.get(ref),
      },
      undefined,
      failure === "constructor" ? 1 : 0,
    );
    const headers = {
      Authorization: `Bearer ${env.OYSTER_OWNER_KEY}`,
      "Content-Type": "application/json",
    };
    const installed = await post(
      {
        installationId: previous.installationId,
        release: previous.release,
      },
      headers,
    );
    assert.equal(installed.state, "succeeded");
    assert.equal(installed.creation, "fresh");
    const committed = registry.get(previous.installationId);
    const records = () => ({
      installation: registry.get(previous.installationId),
      releases: contexts
        .get(committed.instanceId)
        .storage.sql.exec(
          "SELECT release_id, release FROM oyster_releases ORDER BY release_id",
        )
        .toArray(),
      instances: contexts
        .get(committed.instanceId)
        .storage.sql.exec("SELECT record FROM app_instance")
        .toArray(),
    });
    const before = records();
    const refused = await select(
      `/api/installations/${previous.installationId}/release`,
      { method: "PUT", headers, body: JSON.stringify(candidate) },
    );
    assert.equal(refused.status, failure === "constructor" ? 422 : 409);
    assert.deepEqual(
      await refused.json(),
      failure === "constructor"
        ? {
            error: "backend_construction_failed",
            message: new BootGateError("backend_construction_failed").message,
          }
        : { error: "state_schema_migration_unsupported" },
    );
    assert.deepEqual(records(), before);
  });
}

for (const recovery of ["delete", "select"]) {
  test(
    "a committed first install with a post-CAS boot failure can " + recovery,
    async (t) => {
      const source = await computerHost(
        { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
        null,
      );
      const previous = await source.installations.get("context-probe");
      const { registry, env, contexts, post, select } = fixture(
        t,
        source.artifacts,
      );
      // Inject a real loader-boundary failure, not a lifecycle/registry substitute:
      // preparation boots, then the activation load fails once.
      const loader = env.LOADER;
      let loads = 0;
      env.LOADER = {
        get(name, configure) {
          if (++loads === 2)
            throw new Error("Transient activation load failure");
          return loader.get(name, configure);
        },
      };
      const headers = {
        Authorization: "Bearer " + env.OYSTER_OWNER_KEY,
        "Content-Type": "application/json",
      };
      const installed = await post(
        {
          installationId: "recoverable",
          release: previous.release,
        },
        headers,
      );
      assert.equal(installed.state, "refused");
      assert.equal(installed.status, 422);
      assert.equal(installed.code, "backend_load_failed");
      const committed = registry.get("recoverable");
      assert.notEqual(committed, null);
      assert.equal(committed.authority.authorityVersion, 1);
      const records = () =>
        contexts
          .get(committed.instanceId)
          .storage.sql.exec("SELECT record FROM app_instance")
          .toArray();
      assert.deepEqual(records(), []);
      const request = { method: "DELETE", headers };
      if (recovery === "select") {
        request.method = "PUT";
        request.body = JSON.stringify({
          ...previous.release,
          releaseId: "rel_recovered",
        });
      }
      const recovered = await select(
        recovery === "delete"
          ? "/api/installations/recoverable"
          : "/api/installations/recoverable/release",
        request,
      );
      assert.equal(recovered.status, recovery === "delete" ? 204 : 200);
      const current = registry.get("recoverable");
      assert.equal(
        current.status,
        recovery === "delete" ? "deleted" : "enabled",
      );
      assert.equal(current.authority.authorityVersion, 2);
      const [row] = records();
      const receipt = Schema.decodeUnknownSync(
        Schema.fromJsonString(instanceSchema),
      )(row.record);
      assert.equal(
        receipt.status,
        recovery === "delete" ? "deleted" : "active",
      );
      assert.equal(receipt.authorityVersion, 2);
    },
  );
}

test("delegated install authority cannot borrow a member owner role, and App-stamped HTTP cannot bypass it", async (t) => {
  const owner = {
    actor: { kind: "member", memberId: "fixture" },
    role: "owner",
  };
  const source = await computerHost(owner, null);
  const previous = await source.installations.get("context-probe");
  const f = fixture(t, source.artifacts);
  const host = oysterWorkerHost(f.env, ownerKeyAuth(f.env.OYSTER_OWNER_KEY));
  const headers = {
    Authorization: "Bearer " + f.env.OYSTER_OWNER_KEY,
    "Content-Type": "application/json",
    "X-Oyster-Installation": "marketplace",
    "Idempotency-Key": installationCommandIds.request.generate(),
  };
  const responses = [
    // An old JS caller cannot omit provenance and regain delegated authority.
    await installOrSelect(
      host,
      "blocked",
      previous.release,
      owner,
      "install-or-select",
    ),
    await installOrSelect(
      host,
      "blocked",
      previous.release,
      owner,
      "install-or-select",
      "app",
    ),
    await f.app.request("/api/installations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        installationId: "blocked",
        release: previous.release,
      }),
    }),
    await f.app.request("/api/installations/blocked/release", {
      method: "PUT",
      headers,
      body: JSON.stringify(previous.release),
    }),
  ];
  for (const response of responses) {
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "install_authority_unavailable",
    });
  }
  assert.deepEqual(f.registry.list(), []);
  assert.deepEqual([...f.contexts.keys()], ["registry"]);
});

for (const recovery of ["delete", "select"]) {
  test(
    "a committed install whose first activation was never delivered can " +
      recovery,
    async (t) => {
      const source = await computerHost(
        { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
        null,
      );
      const previous = await source.installations.get("context-probe");
      const f = fixture(t, source.artifacts);
      const committed = { ...previous, installationId: "undelivered" };
      // The real commit completes, but the process/RPC can disappear before apply.
      // No forged activation result or receipt stands in for that delivery gap.
      assert.deepEqual(
        await f.registry.compareAndPut(committed, 0, f.registry.generation()),
        { ok: true },
      );
      assert.deepEqual([...f.contexts.keys()], ["registry"]);
      const request = {
        method: "DELETE",
        headers: {
          Authorization: "Bearer " + f.env.OYSTER_OWNER_KEY,
          "Content-Type": "application/json",
        },
      };
      if (recovery === "select") {
        request.method = "PUT";
        request.body = JSON.stringify({
          ...previous.release,
          releaseId: "rel_delivered",
        });
      }
      const response = await f.select(
        recovery === "select"
          ? "/api/installations/undelivered/release"
          : "/api/installations/undelivered",
        request,
      );
      assert.equal(response.status, recovery === "select" ? 200 : 204);
      const current = f.registry.get("undelivered");
      assert.equal(
        current.status,
        recovery === "select" ? "enabled" : "deleted",
      );
      assert.equal(current.authority.authorityVersion, 2);
    },
  );
}
