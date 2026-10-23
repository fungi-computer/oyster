const { Request } = globalThis;
import assert from "node:assert/strict";
import { ownerKeyAuth, ownerKeyCookieName } from "@fungi.computer/oyster/auth";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createAppStorage } from "@fungi.computer/oyster/app-storage";
import {
  AppInstanceError,
  createAppInstance,
  instanceIds,
} from "@fungi.computer/oyster";
import {
  createInvocationGate,
  invocationFacts,
} from "@fungi.computer/oyster/invocation";
import {
  capabilityDescriptorSchema,
  createOyster,
} from "@fungi.computer/oyster/host";
import * as Schema from "effect/Schema";
import {
  normalizeAppPublisherRecipe,
  AppPublisherError,
} from "@fungi.computer/oyster/build-contract";
import { createLocalArtifactWriter } from "@fungi.computer/oyster/build";
import {
  ComputerTerminalHost,
  computerSlots,
} from "@fungi.computer/oyster/computer";

assert.equal(ownerKeyCookieName, "oyster_session");
const ownerAuth = ownerKeyAuth(
  "stranger-owner-key-1234567890",
  "stored-member",
);
assert.deepEqual(
  await ownerAuth.authenticate(
    new Request("https://owner.example.test/", {
      headers: { Authorization: "Bearer stranger-owner-key-1234567890" },
    }),
  ),
  {
    kind: "admitted",
    principal: {
      actor: { kind: "member", memberId: "stored-member" },
      role: "owner",
    },
  },
);
assert.deepEqual(
  await ownerAuth.authenticate(new Request("https://owner.example.test/")),
  { kind: "refused", status: 401 },
);

assert.equal(computerSlots.terminal.id, "computer.terminal");
const terminalHost = new ComputerTerminalHost({
  terminalUrl: "https://oyster.invalid/terminal",
  computerId: "workspace",
  hostWindow: {
    setTimeout: () =>
      assert.fail("a refused terminal must not schedule a retry"),
    clearTimeout: () => assert.fail("a refused terminal has no retry timer"),
  },
  ensureAccess: async () => {
    throw new Error("permission refused");
  },
  connect: () => assert.fail("a refused terminal must not connect"),
  mountSignal: undefined,
});
await assert.rejects(
  terminalHost.open({ cols: 80, rows: 24 }),
  /permission refused/u,
);
terminalHost[Symbol.dispose]();

assert.deepEqual(
  Schema.decodeUnknownSync(capabilityDescriptorSchema)({
    id: "agent.send",
    version: 1,
    base: "/agents/",
    methods: {
      open: { kind: "transport", method: "ANY", path: ":agentId/sessions" },
    },
  }).methods.open,
  { kind: "transport", method: "ANY", path: ":agentId/sessions" },
);

const instanceId = instanceIds.instance.generate();
let stored = null;
const instance = createAppInstance({
  instanceId,
  read: () => Effect.succeed(stored),
  write: (value) =>
    Effect.sync(() => {
      stored = value;
    }),
  resolve: () => Effect.fail(new Error("No Releases in this consumer")),
  boot: () => Effect.void,
  abort: () => Effect.void,
  purge: () => Effect.void,
  connect: () => Effect.fail(new Error("No backend in this consumer")),
});
const selection = {
  instanceId,
  owner: { kind: "installation", id: "installation_stranger" },
  appId: "app_stranger",
  releaseId: "rel_stranger",
  authorityVersion: 2,
};
const state = { ...selection, status: "disabled" };

await Effect.runPromise(instance.prepare(state));
assert.equal(stored, null);
const receipt = await Effect.runPromise(instance.apply(state));
assert.equal(receipt.status, "disabled");
assert.deepEqual(await Effect.runPromise(instance.apply(state)), receipt);

const stale = await Effect.runPromise(
  Effect.result(instance.apply({ ...state, authorityVersion: 1 })),
);
assert.equal(stale._tag, "Failure");
assert.ok(stale.failure instanceof AppInstanceError);
assert.equal(stale.failure.code, "stale_authority");

const gate = createInvocationGate({
  abortGuest: () => Promise.resolve(),
  close: () => Promise.resolve(),
});
const authority = {
  instanceId,
  selection,
  artifactDigest: `sha256:${"a".repeat(64)}`,
  grants: [],
  ancestry: [],
};
const deadlineAt = Date.now() + 60_000;
const callFacts = invocationFacts.fromCaller(
  authority,
  { computerId: null, actor: { kind: "member", memberId: "member_stranger" } },
  { deadlineAt, grantExpiresAt: deadlineAt },
);
const inactive = await gate.run(callFacts, undefined, (frame) =>
  Effect.runPromise(
    Effect.result(
      instance.fetch(frame, new globalThis.Request("https://app.test/")),
    ),
  ),
);
assert.equal(inactive._tag, "Failure");
assert.ok(inactive.failure instanceof AppInstanceError);
assert.equal(inactive.failure.code, "instance_inactive");

// Standalone hosts submit best-effort push facts to the same selected runtime.
// A retained fact is unchanged on lifecycle redelivery; inactive admission
// refuses it instead of falling back to an HTTP facet route.
const pushFact = {
  repository: "notes",
  writer: {
    kind: "actor",
    actor: { kind: "member", memberId: "member_stranger" },
  },
  updates: [
    { ref: "refs/heads/main", before: "0".repeat(40), after: "a".repeat(40) },
  ],
  eventId: "push_stranger",
};
for (let attempt = 0; attempt < 2; attempt++) {
  const refused = await gate.run(
    {
      ...authority,
      subject: {
        kind: "lifecycle",
        name: "onGitPush",
        eventId: pushFact.eventId,
      },
      deadlineAt,
    },
    undefined,
    (frame) =>
      Effect.runPromise(Effect.result(instance.onGitPush(frame, pushFact))),
  );
  assert.equal(refused._tag, "Failure");
  assert.equal(refused.failure.code, "instance_inactive");
  assert.equal(pushFact.eventId, "push_stranger");
}

// The public client entries load in a plain process without Worker globals or
// any private workspace dependency. DOM work begins only when invoked.
const pageModule = await import("@fungi.computer/oyster/page");
assert.ok(pageModule.mountOysterPage);
await import("@fungi.computer/oyster/root-data");

// The packed storage owner runs without a Hub or Worker global. Lifecycle
// writes share the team layer and invalidate a live member subscription.
const storageDatabase = new DatabaseSync(":memory:");
const storage = createAppStorage({
  sql: {
    exec: (statement, ...bindings) => {
      const rows = storageDatabase.prepare(statement).all(...bindings);
      return { toArray: () => rows };
    },
  },
  commit: (body) =>
    Effect.try({
      try: () => {
        storageDatabase.exec("BEGIN");
        try {
          const value = body();
          storageDatabase.exec("COMMIT");
          return value;
        } catch (cause) {
          storageDatabase.exec("ROLLBACK");
          throw cause;
        }
      },
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error("Storage commit failed", { cause }),
    }),
});
const storageAdmission = {
  address: "installation_stranger",
  appId: "app_stranger",
  keys: [{ key: "document", scopes: ["team", "member"], maxBytes: 1024 }],
  assertCurrent: () => undefined,
};
const lifecycleStorage = storage.openInstallation(() =>
  Effect.succeed(storageAdmission),
);
const memberStorage = storage.open(() =>
  Effect.succeed({
    ...storageAdmission,
    memberId: "member_stranger",
    membershipVersion: 1,
    isOwner: false,
  }),
);
const storageEvents = Stream.toReadableStream(
  memberStorage.events("document"),
).getReader();
try {
  assert.deepEqual(await storageEvents.read(), { done: false, value: null });
  const { revision } = await Effect.runPromise(
    lifecycleStorage.write({
      key: "document",
      scope: "team",
      basedOn: null,
      value: { changed: true },
    }),
  );
  assert.deepEqual(await storageEvents.read(), {
    done: false,
    value: { appId: "app_stranger", key: "document", scope: "team", revision },
  });
  assert.deepEqual(
    (await Effect.runPromise(memberStorage.read("document"))).value,
    { changed: true },
  );
  const refused = await Effect.runPromise(
    Effect.flip(
      lifecycleStorage.write({
        key: "document",
        scope: "member",
        basedOn: null,
        value: {},
      }),
    ),
  );
  assert.equal(refused.code, "owner_required");
} finally {
  await storageEvents.cancel();
  storageDatabase.close();
}

const normalized = normalizeAppPublisherRecipe({
  appId: "app_stranger",
  recipe: {
    kind: "bundled-html",
    entry: "bundle/index.html",
    assetBase: "./",
    backend: null,
    maxOutputBytes: 4096,
    assets: {
      maxManifestBytes: 4096,
      maxObjects: 4,
      maxObjectBytes: 4096,
      maxTotalBytes: 4096,
    },
  },
});
assert.equal(normalized.recipe.format, "assets");
assert.match(normalized.buildRecipeDigest, /^sha256:[a-f0-9]{64}$/);
assert.ok(
  createLocalArtifactWriter(
    "/tmp/oyster-stranger-artifacts",
    normalized.recipe.assets,
  ),
);

assert.throws(
  () =>
    normalizeAppPublisherRecipe({
      appId: "app_stranger",
      recipe: {
        entry: "../outside.js",
        backend: null,
        maxOutputBytes: 4096,
      },
    }),
  (error) =>
    error instanceof AppPublisherError &&
    error._tag === "AppPublisherError" &&
    error.stage === "configuration",
);

const {
  defaultTenant,
  tenantScope,
  singleTenant,
  implicitTenancy,
  tenantIdSchema,
} = await import("@fungi.computer/oyster/tenant");
const legacyScope = tenantScope(defaultTenant, "https://oyster.example");
assert.equal(legacyScope.durableName("registry"), "registry");
assert.equal(legacyScope.repositoryPrefix("bonsai"), "bonsai--");
const shopScope = tenantScope(
  Schema.decodeUnknownSync(tenantIdSchema)("shop-one"),
  "https://shop-one.oyster.example",
);
assert.equal(shopScope.repositoryPrefix("bonsai"), "t.shop-one--bonsai--");
assert.equal(
  await singleTenant("https://oyster.example").resolve(
    new Request("https://unknown.example"),
  ),
  null,
);
const tenantAuth = {
  authenticate: () => Promise.resolve({ kind: "refused", status: 403 }),
};
const tenancy = implicitTenancy("https://oyster.example", tenantAuth);
const selected = await tenancy.resolve(
  new Request("https://oyster.example/apps/notes"),
);
assert.equal(selected.auth, tenantAuth);
assert.equal(selected.scope.tenantId, defaultTenant);
assert.equal(selected.scope.workspacePrefix, "workspace/");
assert.equal(
  await tenancy.resolve(new Request("https://unknown.example")),
  null,
);

for (const status of [404, 429]) {
  const app = createOyster({
    bootUi: () => Promise.resolve({ kind: "passed" }),
    auth: {
      authenticate: async () => ({ kind: "refused", status, retryAfter: 9 }),
    },
    artifacts: { get: async () => null },
    installations: { get: async () => null, list: async () => [] },
    instances: {
      get: () => {
        throw new Error("Refused request reached an Instance");
      },
    },
  });
  const response = await app.request("/", { headers: { Accept: "text/html" } });
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Retry-After"), "9");
  assert.equal(response.headers.get("Location"), null);
}

const { appToolPolicySchema } = await import("@fungi.computer/oyster/apps");
assert.deepEqual(
  Schema.decodeUnknownSync(appToolPolicySchema)({
    level: "read",
    revision: "approved-1",
    grantedBy: "authenticated-member",
  }),
  { level: "read", revision: "approved-1", grantedBy: "authenticated-member" },
);
assert.throws(() =>
  Schema.decodeUnknownSync(appToolPolicySchema)({
    level: "read",
    revision: "old-policy",
  }),
);

// Tenancy: resolve provisioned tenants, verify identities, apply membership.
{
  const { createTenancy } = await import("@fungi.computer/oyster/tenancy");
  const { subdomain, path } =
    await import("@fungi.computer/oyster/tenancy/resolve");
  const { memoryRegistry } =
    await import("@fungi.computer/oyster/tenancy/registry");
  const registry = memoryRegistry();
  const identity = { provider: "fixture", subject: "owner" };
  const tenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [
      {
        id: "identity",
        authenticate: () => Promise.resolve({ kind: "identity", identity }),
      },
    ],
  });
  const tenant = await tenancy.create({
    handle: "alpha",
    origin: "https://alpha.example.test",
    domains: ["alpha.example.test"],
    owner: identity,
  });
  const request = new globalThis.Request(tenant.origin);
  assert.equal((await tenancy.resolve(request))?.id, tenant.id);
  assert.deepEqual(await tenancy.authenticate(request, tenant), {
    kind: "admitted",
    tenant,
    principal: {
      actor: { kind: "member", memberId: tenant.owners[0] },
      role: "owner",
    },
  });
  assert.equal(path("/t/:tenant").kind, "path");
  const { ownerKey } = await import("@fungi.computer/oyster/tenancy/owner-key");
  const { auth0 } = await import("@fungi.computer/oyster/tenancy/auth0");
  const ownerSecret = "packed-owner-secret-at-least-24-characters";
  const ownerAdapter = ownerKey({
    registry,
    keys: {
      get: () =>
        Promise.resolve({ key: ownerSecret, memberId: tenant.owners[0] }),
    },
  });
  assert.deepEqual(
    await ownerAdapter.authenticate(
      new globalThis.Request(tenant.origin, {
        headers: { Authorization: `Bearer ${ownerSecret}` },
      }),
      tenant,
    ),
    {
      kind: "principal",
      principal: {
        actor: { kind: "member", memberId: tenant.owners[0] },
        role: "owner",
      },
    },
  );
  const auth0Adapter = auth0({
    domain: "identity.example.test",
    clientId: "application",
    audience: "https://api.example.test",
  });
  assert.deepEqual(await auth0Adapter.authenticate(request, tenant), {
    kind: "pass",
  });
  const oyster = tenancy.oyster();
  const scoped = await oyster.resolve(request);
  assert.equal(scoped.scope.origin, tenant.origin);
  assert.deepEqual(await scoped.auth.authenticate(request), {
    kind: "admitted",
    principal: {
      actor: { kind: "member", memberId: tenant.owners[0] },
      role: "owner",
    },
  });
  assert.equal(
    await oyster.resolve(
      new globalThis.Request("https://unknown.example.test"),
    ),
    null,
  );
  assert.equal(
    "oyster" in
      createTenancy({ registry, resolve: path("/t/:tenant"), auth: [] }),
    false,
  );

  const { coldTenantDirectory } =
    await import("@fungi.computer/oyster/tenancy/cold-directory");
  const { tenantScope } = await import("@fungi.computer/oyster/tenant");
  const coldSelected = await coldTenantDirectory(registry).resolve(
    tenantScope(tenant.id, tenant.origin),
  );
  assert.ok(coldSelected);
  assert.deepEqual(
    await coldSelected.auth.resolve({
      kind: "member",
      memberId: tenant.owners[0],
    }),
    {
      actor: { kind: "member", memberId: tenant.owners[0] },
      role: "owner",
      membershipVersion: (
        await registry.memberById(tenant.id, tenant.owners[0])
      ).membershipVersion,
    },
  );
  assert.equal(
    await coldSelected.auth.resolve({
      kind: "team-key",
      keyId: tenant.owners[0],
    }),
    null,
  );
  assert.deepEqual(await coldSelected.auth.authenticate(request), {
    kind: "refused",
    status: 401,
  });
  await registry.setStatus(tenant.id, "suspended");
  assert.equal(
    await coldSelected.auth.resolve({
      kind: "member",
      memberId: tenant.owners[0],
    }),
    null,
  );

  await registry.setStatus(tenant.id, "active");

  await tenancy.delete(tenant.id);
  assert.deepEqual(await scoped.auth.authenticate(request), {
    kind: "refused",
    status: 404,
  });
  assert.equal(await tenancy.resolve(request), null);

  assert.equal(
    await coldSelected.auth.resolve({
      kind: "member",
      memberId: tenant.owners[0],
    }),
    null,
  );
}

import { decodeMachineAgentHome } from "@fungi.computer/oyster/machine-link";
assert.deepEqual(decodeMachineAgentHome({ kind: "hosted" }), {
  kind: "hosted",
});
assert.deepEqual(
  decodeMachineAgentHome({ kind: "machine", deviceId: "device-one" }),
  { kind: "machine", deviceId: "device-one" },
);
assert.throws(
  () =>
    decodeMachineAgentHome({
      kind: "machine",
      deviceId: "device-one",
      memberId: "member-one",
    }),
  Schema.isSchemaError,
);
