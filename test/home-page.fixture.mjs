import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { after } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import * as Result from "effect/Result";
import { createOyster } from "../dist/host.js";
import { registryInstallations } from "../dist/internal/registry-installations.js";
import { defaultTenant, tenantScope } from "../dist/tenant.js";
import {
  applyGrantCommand,
  applyInstallationCommand,
  deriveDeclaredOperations,
} from "../dist/apps/index.js";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "cloudflare:workers"
      ? {
          url: new globalThis.URL(
            "../dist/testing/workers-runtime.js",
            import.meta.url,
          ).href,
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { OysterRegistry } = await import("../dist/workers.js");
const { installationWorkerEntrypoint } =
  await import("../dist/installation-execution.js");
hooks.deregister();

export async function homePageFixture({
  declared = true,
  home = "desktop",
  rootData = true,
  opens = false,
  shellModule = false,
  approved = true,
  pageScript = "// trusted root composition",
  shellCode = "export const mountShell = async () => () => {};",
  computerId,
  ownerRoutes,
} = {}) {
  const { createAppBuild } = await import("@fungi.computer/puffball/app");
  const { assetBuildMediaType } =
    await import("@fungi.computer/puffball/assets");
  const { sha256 } = await import("../dist/release.js");
  const artifacts = new Map();
  async function put(bytes) {
    const digest = await sha256(bytes);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    artifacts.set(artifactRef, bytes);
    return { artifactRef, digest };
  }
  const encode = (text) => new globalThis.TextEncoder().encode(text);
  async function asset(path, contentType, text) {
    const bytes = encode(text);
    return {
      path,
      ...(await put(bytes)),
      version: "fixture",
      byteLength: bytes.length,
      contentType,
    };
  }
  const bytes = shellModule
    ? encode(
        JSON.stringify({
          format: "fungi-assets-v1",
          base: "./",
          assets: [
            await asset(
              "/index.html",
              "text/html; charset=utf-8",
              "<!doctype html><title>Home fixture</title>",
            ),
            await asset(
              "/shell.js",
              "text/javascript; charset=utf-8",
              shellCode,
            ),
          ],
        }),
      )
    : encode("<!doctype html><title>Home fixture</title>");
  const ui = {
    ...(await put(bytes)),
    version: "fixture",
    byteLength: bytes.length,
    mediaType: shellModule ? assetBuildMediaType : "text/html; charset=utf-8",
  };
  const built = createAppBuild(ui, null, {
    capabilities: [
      ...(declared ? ["team.workbenchHost"] : []),
      ...(opens ? ["apps.open"] : []),
    ],
    handlers: [],
    roles: [],
    storage: [{ key: "desktop", scopes: ["member"], maxBytes: 16384 }],
  });
  const artifact = await put(
    new globalThis.TextEncoder().encode(JSON.stringify(built)),
  );
  assert.ok(built.declaration);
  const installationInput = {
    installationId: "desktop",
    instanceId: null,
    release: {
      appId: "app_desktop",
      releaseId: "rel_desktop",
      artifact: {
        artifactRef: artifact.artifactRef,
        artifactDigest: artifact.digest,
        provenance: {
          sourceRevision: `git:${"a".repeat(40)}`,
          sourceTreeDigest: artifact.digest,
          buildRecipeDigest: artifact.digest,
        },
      },
    },
    // Public, so an anonymous request reaches the page as the host's visitor.
    visibility: "public",
    declaration: built.declaration,
  };
  const installed = applyInstallationCommand(
    null,
    {
      kind: "install",
      release: installationInput.release,
      releasePin: "pinned",
    },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: null,
      now: 1000,
      identity: {
        installationId: installationInput.installationId,
        instanceId: null,
      },
      declaration: built.declaration,
      declaredOperations: await deriveDeclaredOperations(
        installationInput.release,
        built.declaration,
        [],
      ),
    },
  );
  if (Result.isFailure(installed)) throw new Error(installed.failure.code);
  let installation = { ...installed.success.next, visibility: "public" };
  const declaredOperations = await deriveDeclaredOperations(
    installation.release,
    built.declaration,
    [],
  );
  // Positive composition cases start from an ordinary owner's explicit approval.
  if (approved && declaredOperations.capabilities.length > 0) {
    const approval = applyGrantCommand(
      installation.authority,
      {
        kind: "change-grants",
        changes: declaredOperations.capabilities
          .map(({ capability, operations }) => ({
            capability,
            operations,
            resources: "tenant-scope",
          }))
          .map(({ capability, ...grant }) => ({ capability, grant })),
      },
      {
        principal: {
          actor: { kind: "member", memberId: "owner" },
          role: "owner",
        },
        expectedVersion: installation.authority.authorityVersion,
        declaration: built.declaration,
        declaredOperations,
        now: 1001,
      },
    );
    if (Result.isFailure(approval)) throw new Error(approval.failure.code);
    installation = { ...installation, authority: approval.success };
  }
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const initialization = [];
  const deliveries = new Set();
  let alarm = null;
  after(async () => {
    try {
      await Promise.all(deliveries);
    } finally {
      database.close();
    }
  });
  const scope = tenantScope(defaultTenant, "http://localhost");
  const Executor = installationWorkerEntrypoint(() => host);
  const env = {
    RELEASES: {
      get: async (ref) => {
        const value = artifacts.get(ref);
        return value === undefined
          ? null
          : {
              arrayBuffer: async () => value.slice().buffer,
              body: new globalThis.ReadableStream({
                start(controller) {
                  controller.enqueue(value);
                  controller.close();
                },
              }),
            };
      },
    },
  };
  const registry = new OysterRegistry(
    {
      id: { name: scope.durableName("registry") },
      storage: {
        ...storage,
        getAlarm: async () => alarm,
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
      exports: {
        OysterInstallationExecutor: ({ props }) => new Executor({ props }, env),
      },
      blockConcurrencyWhile(work) {
        const pending = work();
        initialization.push(pending);
        return pending;
      },
    },
    env,
  );
  // Keep the fixture's existing stable generation contract, in the REAL store,
  // before any commands or page requests. There is no parallel metadata map.
  storage.sql.exec(
    "UPDATE installation_store SET generation=? WHERE id=1",
    "fixture-generation",
  );
  env.REGISTRY = { getByName: () => registry };
  const dispatch = registry.installationOperation.bind(registry);
  registry.installationOperation = async (request) => {
    const reply = await dispatch(request);
    if (request.action === "admit") {
      // The registry fixture's admission-acknowledgement barrier: deliver the
      // REAL requested alarm before releasing the REAL pending admission reply.
      // No status read drives execution, and no completion response is invented.
      assert.notEqual(alarm, null);
      alarm = null;
      const delivery = registry.alarm();
      deliveries.add(delivery);
      await delivery;
    }
    return reply;
  };
  const installations = registryInstallations(env, scope);
  await Promise.all(initialization);
  assert.deepEqual(
    await installations.compareAndPut(installation, 0, "fixture-generation"),
    { ok: true },
  );
  const host = {
    homeInstallationId: home,
    // UI-only Releases boot in the host's runner; this fixture has nothing to boot.
    bootUi: () => Promise.resolve({ kind: "passed" }),
    auth: {
      resolve: async (actor) =>
        actor.kind === "member" && actor.memberId === "owner"
          ? { actor, role: "owner" }
          : null,
      authenticate: (request) => {
        switch (request.headers.get("x-who") ?? "owner") {
          case "owner":
            return Promise.resolve({
              kind: "admitted",
              principal: {
                actor: { kind: "member", memberId: "owner" },
                role: "owner",
              },
            });
          case "key":
            return Promise.resolve({
              kind: "admitted",
              principal: { actor: { kind: "team-key", keyId: "owner" } },
            });
          default:
            // An anonymous request; the host admits it as a visitor where public.
            return Promise.resolve({ kind: "refused", status: 401 });
        }
      },
    },
    installations,
    artifacts: {
      get: (ref) => Promise.resolve(artifacts.get(ref) ?? null),
      put: () => Promise.reject(new Error("Read only")),
    },
    instances: {
      get: () => {
        throw new Error("No backend expected");
      },
    },
  };
  if (pageScript !== null) host.pageScript = pageScript;
  if (computerId !== undefined) host.computerId = computerId;
  if (ownerRoutes !== undefined) host.ownerRoutes = ownerRoutes;
  if (rootData)
    host.workbench = {
      directory: () => Promise.resolve({ apps: [], roles: {} }),
      storage: () => {
        throw new Error("No storage operation expected");
      },
    };
  return createOyster(host);
}
