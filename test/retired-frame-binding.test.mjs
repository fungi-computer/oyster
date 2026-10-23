import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TextEncoder } from "node:util";
import { withBackendConstruction } from "./boot-construction.fixture.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: import.meta
          .resolve("@fungi.computer/oyster/testing/workers-runtime"),
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { fromNodeSqlite } = await import("@fungi.computer/watchdog/node-sqlite");
const { createAppBuild } = await import("@fungi.computer/puffball/app");
const { createOyster, sha256 } = await import("../dist/host.js");
const {
  OysterRegistry,
  OysterInstance,
  OysterBinding,
  oysterWorkerHost,
  ownerKeyAuth,
} = await import("../dist/workers.js");
const { createFrameBindingWire } =
  await import("../dist/frame-binding-wire.js");
const { appInstanceErrorCodeSchema } = await import("../dist/index.js");
const { installationWorkerEntrypoint } =
  await import("../dist/installation-execution.js");
const { installationCommandIds } =
  await import("../dist/installation-operations.js");
const { defaultTenant, tenantScope } = await import("../dist/tenant.js");
hooks.deregister();

test(
  "a held old Instance binding write is refused after delete and new-id reinstall",
  { timeout: 15000 },
  async (t) => {
    const databases = [];
    const pending = [];
    const state = (name) => {
      const database = new DatabaseSync(":memory:");
      databases.push(database);
      let alarm = null;
      const alarms = {
        getAlarm: async () => alarm,
        setAlarm: async (at) => {
          alarm = at;
        },
      };
      return {
        id: { name },
        storage: {
          ...fromNodeSqlite(database),
          ...alarms,
          transaction: async (work) => work(alarms),
        },
        blockConcurrencyWhile(work) {
          const result = work();
          pending.push(result);
          return result;
        },
      };
    };
    t.after(async () => {
      await Promise.all(pending);
      for (const database of databases) database.close();
    });
    const artifacts = new Map();
    const persist = async (value) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const digest = await sha256(bytes);
      const artifactRef = `artifact:sha256-${digest.slice(7)}`;
      artifacts.set(artifactRef, bytes);
      return { artifactRef, digest, byteLength: bytes.length, version: "1" };
    };
    const backend = {
      ...(await persist({
        runtime: { kind: "durable-facet", stateSchema: 1 },
        compatibilityDate: "2026-09-04",
        exportName: "Guest",
        code: "export class Guest {}",
      })),
      mediaType: "application/vnd.fungi.app-backend+json",
    };
    const built = createAppBuild(null, backend, {
      displayName: "Notes",
      capabilities: ["app.storage"],
      handlers: [],
      roles: [],
      storage: [{ key: "desktop", scopes: ["team"], maxBytes: 16384 }],
      backend: {
        bindings: [{ name: "APP_STORAGE", operations: ["read", "write"] }],
      },
      api: {
        methods: {
          write: {
            description: "Write the desktop",
            effect: "write",
            requires: ["app.storage"],
            input: { type: "object" },
            output: {},
          },
        },
      },
    });
    const root = await persist(built);
    const release = {
      appId: "app_notes",
      releaseId: "rel_notes",
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
    const instances = new Map();
    const wire = createFrameBindingWire(appInstanceErrorCodeSchema.literals);
    const arrived = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const packetReply = Promise.withResolvers();
    let holdNextRead = false;
    let heldOwner;
    let arm = false;
    let registry;
    const env = {
      OYSTER_OWNER_KEY: "fixture-owner-key-for-host-proof",
      OYSTER_ORIGIN: "https://oyster.test",
      RELEASES: {
        get: async (ref) => {
          const bytes = artifacts.get(ref);
          return bytes === undefined
            ? null
            : { arrayBuffer: async () => bytes.buffer };
        },
      },
      REGISTRY: {
        getByName: () => ({
          generation: () => registry.generation(),
          get: async (id) => {
            if (holdNextRead) {
              holdNextRead = false;
              heldOwner = id;
              arrived.resolve();
              await resume.promise;
            }
            return registry.get(id);
          },
          list: () => registry.list(),
          compareAndPut: (...args) => registry.compareAndPut(...args),
          installationOperation: (request) =>
            registry.installationOperation(request),
          storageBackend: (...args) => registry.storageBackend(...args),
        }),
      },
      INSTANCES: {
        getByName: (id) => {
          const instance = instanceOf(id);
          return {
            prepare: (...args) => instance.prepare(...args),
            apply: (...args) => instance.apply(...args),
            revoke: (...args) => instance.revoke(...args),
            call: (...args) => instance.call(...args),
            bindingCall: (props, method, args) => {
              const held = arm;
              if (held) {
                arm = false;
                holdNextRead = true;
              }
              // No mocked admission or refusal: this is the production Instance.
              const reply = instance.bindingCall(props, method, args);
              if (held) reply.then(packetReply.resolve, packetReply.reject);
              return reply;
            },
          };
        },
      },
    };
    const instanceOf = (id) => {
      if (instances.has(id)) return instances.get(id);
      const context = {
        ...state(id),
        exports: {
          OysterBinding: ({ props }) => new OysterBinding({ props }, env),
        },
        facets: {
          get: (_name, prepare) => {
            prepare();
            return {
              http: () => {
                throw new Error(
                  "This proof invokes a declared method, not HTTP",
                );
              },
              invoke: async (_method, _args, bindings) => ({
                kind: "ok",
                value: await wire.wrap(bindings).APP_STORAGE.write({
                  key: "desktop",
                  scope: "team",
                  basedOn: null,
                  value: { instance: id },
                }),
              }),
            };
          },
          abort: () => undefined,
          delete: () => undefined,
        },
      };
      const construction = withBackendConstruction(context.facets, {
        get: (_id, configure) => ({ getDurableObjectClass: () => configure() }),
      });
      context.facets = construction.facets;
      const instance = new OysterInstance(context, {
        ...env,
        LOADER: construction.loader,
      });
      instances.set(id, instance);
      return instance;
    };
    const scope = tenantScope(defaultTenant, env.OYSTER_ORIGIN);
    const Executor = installationWorkerEntrypoint((bindings, scope) =>
      oysterWorkerHost(bindings, ownerKeyAuth(bindings.OYSTER_OWNER_KEY), {
        scope,
      }),
    );
    registry = new OysterRegistry(
      {
        ...state(scope.durableName("registry")),
        exports: {
          OysterInstallationExecutor: ({ props }) =>
            new Executor({ props }, env),
        },
      },
      env,
    );
    const app = createOyster(
      oysterWorkerHost(env, ownerKeyAuth(env.OYSTER_OWNER_KEY)),
    );
    const json = (body) => ({
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-owner-key-for-host-proof",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const install = async () => {
      const requestId = installationCommandIds.request.generate();
      const request = json({ installationId: "notes", release });
      request.headers["Idempotency-Key"] = requestId;
      const response = await app.request("/api/installations", request);
      assert.equal(response.status, 202, await response.clone().text());
      const admitted = await response.json();
      assert.equal(admitted.requestId, requestId);
      assert.equal(admitted.state, "pending");
      await registry.alarm();
      const status = await app.request(
        `/api/installations/notes/status?requestId=${requestId}`,
        {
          headers: { Authorization: "Bearer fixture-owner-key-for-host-proof" },
        },
      );
      assert.equal(status.status, 200, await status.clone().text());
      const completed = await status.json();
      assert.equal(completed.requestId, requestId);
      assert.equal(completed.installationId, admitted.installationId);
      assert.equal(completed.state, "succeeded", JSON.stringify(completed));
      assert.equal(completed.installation.authority.authorityVersion, 1);
      assert.deepEqual(completed.installation.authority.approvedGrants, [
        {
          capability: "app.storage",
          capabilityApproved: true,
          operations: [
            "binding:APP_STORAGE:read",
            "binding:APP_STORAGE:write",
            "route:app.methods:write",
          ],
          resources: "tenant-scope",
        },
      ]);
      return completed.installation;
    };
    const first = await install();
    arm = true;
    const guest = app.request("/apps/notes/methods/write", json({}));
    await arrived.promise;
    assert.equal(heldOwner, "notes");
    // The packet is held inside assertCurrent's registry read, after the real
    // Instance has captured the old frame and before dispatch can write.
    assert.equal(
      (
        await app.request("/api/installations/notes", {
          method: "DELETE",
          headers: { Authorization: "Bearer fixture-owner-key-for-host-proof" },
        })
      ).status,
      204,
    );
    const fresh = await install();
    assert.match(fresh.installationId, /^notes-[a-z0-9]{21}$/u);
    assert.notEqual(fresh.instanceId, first.instanceId);
    assert.equal(registry.get("notes").status, "deleted");
    const before = await registry.storageRead(
      fresh.installationId,
      "owner",
      "desktop",
    );
    assert.equal(before.kind, "accepted");
    assert.equal(before.value.source, "none");
    resume.resolve();
    assert.deepEqual(await packetReply.promise, {
      kind: "local_refusal",
      code: "revoked",
    });
    const response = await guest;
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "revoked" });
    assert.deepEqual(registry.get(fresh.installationId), fresh);
    // A fresh frame can write: refusal is fencing, not a missing store/binding.
    const control = await app.request(
      `/apps/${fresh.installationId}/methods/write`,
      json({}),
    );
    assert.equal(control.status, 200, await control.clone().text());
    const written = await control.json();
    assert.equal(written.kind, "accepted");
    const after = await registry.storageRead(
      fresh.installationId,
      "owner",
      "desktop",
    );
    assert.equal(after.kind, "accepted");
    assert.deepEqual(after.value.value, { instance: fresh.instanceId });
  },
);
