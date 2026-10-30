import { admittedBackgroundOrigins } from "../src/internal/background-origins.js";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import { invocationCallerContext } from "../src/invocation.js";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  createInstallationOperations,
  installationOperationsPort,
  installationOperationSchema,
  installationCommandIds,
} from "../src/installation-operations.js";
import { executeInstallation } from "../src/installation-execution.js";
import { observeInstallation } from "../src/installation-client.js";
import { defaultTenant } from "../src/tenant.js";
import * as hostModule from "@fungi.computer/oyster/host";
import { deliverBackground } from "../src/internal/delivery.js";
import {
  backgroundWakeSchema,
  backgroundOriginKey,
  admitClaimedOrigin,
} from "@fungi.computer/puffball/background-replay";
import * as Schema from "effect/Schema";
import type { AppMethodReply } from "@fungi.computer/agar/backend";
import {
  createAppBuild,
  appDeclarationSchema,
  type AppDeclaration,
  type AppUiBuild,
  type AppBackendBuild,
} from "@fungi.computer/puffball/app";
import { parseArtifactRef } from "@fungi.computer/puffball";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import {
  createOyster,
  installOrSelect,
  type OysterHost,
  type InstanceResult,
} from "../src/host.js";
import type { TenantPrincipal } from "@fungi.computer/oyster/tenant";
import { parseRelease, sha256 } from "@fungi.computer/oyster/host";
import { fileCapabilities } from "../src/files.js";
import { installationSchema } from "../src/apps/installation.js";
import { appPermissionsWireSchema } from "../src/apps/permissions.js";
import type { AppToolPolicy } from "../src/apps/tools.js";
import type { InvocationFacts } from "../src/invocation.js";
import { ownerKeyCookieName, ownerOrKeyAuth } from "../src/auth.js";
import { createBuildJobLog } from "../src/build/job-log.js";
import { parse } from "hono/utils/cookie";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0).reverse()) database.close();
});

/** HTTP/domain proof with the real retained owner and executor, not a native alarm proof. */
async function fixture(
  withMethods = false,
  withSync = false,
  twoOrigins = false,
  ungrantedOrigin = false,
  shell = false,
) {
  const ui = new TextEncoder().encode("<!doctype html><title>Notes</title>");
  const uiRef = parseArtifactRef("artifact:notes-ui");
  const rootRef = parseArtifactRef("artifact:notes-root");
  const baseDeclaration = Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities: [
      "computer.readFile",
      ...(ungrantedOrigin ? ["computer.writeFile"] : []),
      ...(shell ? ["team.workbenchHost"] : []),
    ],
    handlers: [],
    roles: [],
    commands: [],
    gills: [],
  });
  let declaration = withMethods
    ? Schema.decodeUnknownSync(appDeclarationSchema)({
        ...baseDeclaration,
        backend: {
          bindings: [
            {
              name: "COMPUTER",
              operations: ungrantedOrigin ? ["read", "write"] : ["read"],
            },
          ],
        },
        api: {
          methods: {
            read: {
              description: "Read",
              effect: "read",
              requires: ["computer.readFile"],
              input: { type: "object" },
              output: { type: "object" },
            },
            write: {
              description: "Write",
              effect: "write",
              requires: ["computer.readFile"],
              input: { type: "object" },
              output: { type: "object" },
            },
            external: {
              description: "External",
              effect: "external",
              requires: [],
              input: { type: "object" },
              output: { type: "object" },
            },
          },
        },
      })
    : baseDeclaration;
  if (twoOrigins) {
    if (declaration.api === undefined) throw new Error("Origin API missing");
    declaration = Schema.decodeUnknownSync(appDeclarationSchema)({
      ...declaration,
      api: {
        ...declaration.api,
        methods: {
          ...declaration.api.methods,
          otherWrite: {
            ...declaration.api.methods.write,
            description: "Other queued origin",
            requires: ungrantedOrigin
              ? ["computer.writeFile"]
              : ["computer.readFile"],
          },
        },
      },
    });
  }
  if (withSync) {
    declaration = Schema.decodeUnknownSync(appDeclarationSchema)({
      ...declaration,
      backend: { ...declaration.backend, sync: { method: "continueWrite" } },
      api: {
        methods: {
          ...declaration.api?.methods,
          continueWrite: {
            description: "Continue queued writes",
            effect: "write",
            requires: ungrantedOrigin
              ? ["computer.readFile", "computer.writeFile"]
              : ["computer.readFile"],
            input: { type: "object" },
            output: {
              type: "object",
              properties: { more: { type: "boolean" } },
              required: ["more"],
              additionalProperties: false,
            },
          },
        },
      },
    });
  }
  const uiBuild: AppUiBuild = {
    artifactRef: uiRef,
    digest: Schema.decodeUnknownSync(sha256DigestSchema)(await sha256(ui)),
    version: "1",
    byteLength: ui.byteLength,
    mediaType: "text/html; charset=utf-8",
  };
  const backendRef = parseArtifactRef("artifact:notes-backend");
  const backendBytes = new TextEncoder().encode(
    JSON.stringify({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "Notes",
      code: "export class Notes {}",
    }),
  );
  const backendBuild: AppBackendBuild | null = withMethods
    ? {
        artifactRef: backendRef,
        digest: Schema.decodeUnknownSync(sha256DigestSchema)(
          await sha256(backendBytes),
        ),
        version: "1",
        byteLength: backendBytes.byteLength,
        mediaType: "application/vnd.fungi.app-backend+json",
      }
    : null;
  const build = createAppBuild(uiBuild, backendBuild, declaration);
  const root = new TextEncoder().encode(JSON.stringify(build));
  const release = parseRelease({
    appId: "app_notes",
    releaseId: "rel_notes",
    artifact: {
      artifactRef: rootRef,
      artifactDigest: await sha256(root),
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: `sha256:${"b".repeat(64)}`,
        buildRecipeDigest: `sha256:${"c".repeat(64)}`,
      },
    },
  });
  const artifacts = new Map<string, Uint8Array>([
    [uiRef, ui],
    [rootRef, root],
    [backendRef, backendBytes],
  ]);
  type Record = NonNullable<
    Awaited<ReturnType<OysterHost["installations"]["get"]>>
  >;
  const records = new Map<string, Record>();
  const calls: InvocationFacts[] = [];
  const capabilities = fileCapabilities({
    list: () => Promise.resolve(null),
    read: () => Promise.resolve(new TextEncoder().encode("fixture note")),
    write: () => Promise.reject(new Error("Read-only fixture")),
    mkdir: () => Promise.reject(new Error("Read-only fixture")),
    replace: () => Promise.reject(new Error("Read-only fixture")),
  });
  // Null is an anonymous request: authentication refuses it with 401.
  let principal: TenantPrincipal | null = {
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  };
  let toolPolicy: AppToolPolicy | null = null;
  let toolPolicyCalls = 0;
  let resolvedPrincipal: TenantPrincipal | null = principal;
  const refusals: InvocationFacts[] = [];
  let resolutionCalls = 0;
  const host: OysterHost = {
    homeInstallationId: "configured-home",
    bootUi: () => Promise.resolve({ kind: "passed" as const }),
    appToolPolicy: () => {
      toolPolicyCalls += 1;
      return toolPolicy;
    },
    // A key's App access is its own Ear Tag grants, not this policy; mirror
    // the same fixture-wide `toolPolicy` into one key's live grants so
    // `it.each(toolPrincipals)` drives both actor kinds from one setter.
    keys: {
      live: (keyId) => {
        toolPolicyCalls += 1;
        return Promise.resolve(
          keyId !== "key" || toolPolicy === null
            ? null
            : {
                keyId,
                owner: toolPolicy.grantedBy,
                grantVersion: 1,
                grants: [
                  {
                    capability:
                      toolPolicy.level === "write" ? "apps.use" : "apps.read",
                    targets: { kind: "all" },
                  },
                ],
              },
        );
      },
    },
    auth: {
      resolve: (actor) => {
        resolutionCalls += 1;
        return Promise.resolve(
          actor.kind === "member" ? resolvedPrincipal : null,
        );
      },
      authenticate: () =>
        Promise.resolve(
          principal === null
            ? { kind: "refused", status: 401 }
            : { kind: "admitted", principal },
        ),
    },
    artifacts: {
      get: (ref) => Promise.resolve(artifacts.get(ref) ?? null),
      put: (ref, bytes) => {
        artifacts.set(ref, bytes);
        return Promise.resolve();
      },
    },
    installations: {
      generation: () => Promise.resolve("fixture-generation"),
      list: () => Promise.resolve([...records.values()]),
      get: (id) => Promise.resolve(records.get(id) ?? null),
      compareAndPut: (record, expectedAuthorityVersion, expectedGeneration) => {
        if (expectedGeneration !== "fixture-generation")
          return Promise.resolve({ ok: false, code: "stale_authority" });
        if (
          (records.get(record.installationId)?.authority.authorityVersion ??
            0) !== expectedAuthorityVersion
        )
          return Promise.resolve({ ok: false, code: "stale_authority" });
        records.set(record.installationId, record);
        return Promise.resolve({ ok: true });
      },
    },
    instances: {
      get: () => {
        if (!withMethods)
          throw new Error("A UI-only Release must not execute a backend");
        return {
          prepare: () =>
            Promise.resolve({
              ok: true,
              value: { kind: "passed" as const },
            }),
          apply: (state) =>
            Promise.resolve({
              ok: true,
              value: {
                ...state,
                stateSchema: 1,
                desiredStatus: state.status,
                status: "active",
              },
            }),
          call: (facts): Promise<InstanceResult<AppMethodReply>> => {
            calls.push(facts);
            const value: Schema.Json = withSync ? { more: false } : {};
            return Promise.resolve({ ok: true, value: { kind: "ok", value } });
          },
          syncRefused: (facts) => {
            refusals.push(facts);
            return Promise.resolve();
          },
          gill: () => Promise.reject(new Error("Unexpected Gill read")),
          fetch: () => Promise.reject(new Error("Unexpected backend fetch")),
          onGitPush: () => Promise.reject(new Error("Unexpected Git push")),
          authorizeGitPush: () =>
            Promise.reject(new Error("Unexpected Git policy")),
        };
      },
    },
    capabilities,
  };
  const originKey = await backgroundOriginKey(
    "fixture-background-origin-secret",
  );
  Object.assign(host, {
    backgroundOriginKey: () => Promise.resolve(originKey),
  });
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  let requestedWakes = 0;
  const selectionAdmissions = new Map<
    string,
    {
      admitted(): void;
      acknowledged: Promise<undefined>;
    }
  >();
  const runtime = await createInstallationOperations({
    owner: fromNodeSqlite(database),
    registryName: "registry",
    generation: () => "fixture-generation",
    get: (id) => records.get(id) ?? null,
    compareAndPut: (record, expected, generation) =>
      host.installations.compareAndPut(record, expected, generation),
    execute: (command) => executeInstallation(host, command),
    scheduleWake: () => {
      requestedWakes++;
      return Promise.resolve();
    },
  });
  const operations = installationOperationsPort(
    async (request) => {
      const reply = await runtime.dispatch(request);
      if (request.action === "admit") {
        const barrier = selectionAdmissions.get(request.input.requestId);
        if (barrier !== undefined) {
          barrier.admitted();
          await barrier.acknowledged;
        }
      }
      return reply;
    },
    { tenantId: defaultTenant, origin: "https://oyster.test" },
  );
  Object.assign(host.installations, { operations });
  const app = createOyster(host);
  const tickRequestedWake = async () => {
    expect(requestedWakes).toBeGreaterThan(0);
    requestedWakes = 0;
    // Explicit maintained owner execution, never a status-triggered tick or
    // a test scheduler pretending to be a durable platform alarm.
    await runtime.tick();
  };
  async function completePost(installationId = "notes", candidate = release) {
    requestedWakes = 0;
    const requestId = installationCommandIds.request.generate();
    const response = await app.request("/api/installations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
      body: JSON.stringify({ installationId, release: candidate }),
    });
    expect(response.status).toBe(202);
    const initial = installationOperationSchema.parse(await response.json());
    expect(initial).toMatchObject({
      state: "pending",
      requestId,
      requestedInstallationId: installationId,
    });
    await tickRequestedWake();
    return observeInstallation({
      initial,
      requestId,
      signal: new AbortController().signal,
      read: async () => {
        const status = await app.request(
          `/api/installations/${installationId}/status?requestId=${requestId}`,
        );
        expect(status.status).toBe(200);
        return installationOperationSchema.parse(await status.json());
      },
    });
  }
  async function install(installationId = "notes", candidate = release) {
    const result = await completePost(installationId, candidate);
    expect(result.state).toBe("succeeded");
    if (result.state !== "succeeded" || result.installation === null)
      throw new Error("Exact installation did not apply");
    return result.installation;
  }
  /** The Workflow node's host entry, run through the same explicit owner tick. */
  async function workflowSelect(candidate: typeof release) {
    requestedWakes = 0;
    const requestId = installationCommandIds.request.generate();
    const admitted = Promise.withResolvers<undefined>();
    const acknowledged = Promise.withResolvers<undefined>();
    selectionAdmissions.set(requestId, {
      admitted: () => {
        admitted.resolve(undefined);
      },
      acknowledged: acknowledged.promise,
    });
    const response = installOrSelect(
      host,
      "notes",
      candidate,
      { actor: { kind: "member", memberId: "owner" }, role: "owner" },
      "install-or-select",
      "workflow",
      requestId,
    );
    try {
      await admitted.promise;
      await tickRequestedWake();
    } finally {
      acknowledged.resolve(undefined);
      selectionAdmissions.delete(requestId);
    }
    return response;
  }
  async function select(candidate: typeof release) {
    requestedWakes = 0;
    const requestId = installationCommandIds.request.generate();
    const admitted = Promise.withResolvers<undefined>();
    const acknowledged = Promise.withResolvers<undefined>();
    selectionAdmissions.set(requestId, {
      admitted: () => {
        admitted.resolve(undefined);
      },
      acknowledged: acknowledged.promise,
    });
    const response = app.request("/api/installations/notes/release", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
      body: JSON.stringify(candidate),
    });
    try {
      // Hold only the RPC acknowledgement so the explicit owner execution can
      // finish before PUT's first observation. No fake completion response.
      await admitted.promise;
      await tickRequestedWake();
    } finally {
      acknowledged.resolve(undefined);
      selectionAdmissions.delete(requestId);
    }
    return response;
  }
  async function upgradedRelease(
    withOpenMethod = false,
    capabilities?: AppDeclaration["capabilities"],
  ) {
    const upgradedDeclaration: typeof declaration = withOpenMethod
      ? Schema.decodeUnknownSync(appDeclarationSchema)({
          ...declaration,
          capabilities: [...declaration.capabilities, "apps.open"],
          api: {
            methods: {
              ...declaration.api?.methods,
              open: {
                description: "Open an App",
                effect: "write",
                requires: ["apps.open"],
                input: { type: "object" },
                output: { type: "object" },
              },
            },
          },
        })
      : {
          ...declaration,
          capabilities: capabilities ?? [
            "computer.readFile",
            "computer.writeFile",
          ],
        };
    const upgradedBuild = createAppBuild(
      uiBuild,
      withOpenMethod ? backendBuild : null,
      upgradedDeclaration,
    );
    const bytes = new TextEncoder().encode(JSON.stringify(upgradedBuild));
    const ref = parseArtifactRef("artifact:notes-upgraded-root");
    artifacts.set(ref, bytes);
    return parseRelease({
      ...release,
      releaseId: "rel_notesupgraded",
      artifact: {
        ...release.artifact,
        artifactRef: ref,
        artifactDigest: await sha256(bytes),
      },
    });
  }
  async function replaceOrigin(name: string) {
    if (declaration.api === undefined) throw new Error("Origin API missing");
    const method = declaration.api.methods[name];
    if (method === undefined) throw new Error("Origin method missing");
    const changed = Schema.decodeUnknownSync(appDeclarationSchema)({
      ...declaration,
      api: {
        ...declaration.api,
        methods: {
          ...declaration.api.methods,
          [name]: { ...method, effect: "read" },
        },
      },
    });
    const changedBuild = createAppBuild(uiBuild, backendBuild, changed);
    const bytes = new TextEncoder().encode(JSON.stringify(changedBuild));
    const ref = parseArtifactRef("artifact:notes-origin-replacement");
    artifacts.set(ref, bytes);
    const next = parseRelease({
      ...release,
      releaseId: "rel_originreplacement",
      artifact: {
        ...release.artifact,
        artifactRef: ref,
        artifactDigest: await sha256(bytes),
      },
    });
    const response = await select(next);
    expect(response.status).toBe(200);
  }
  async function approveReadOnly() {
    const current = records.get("notes");
    if (current === undefined) throw new Error("Installation missing");
    const changes = current.authority.approvedGrants
      .filter((grant) => grant.capability !== "computer.readFile")
      .map(({ capability }) => ({ capability, grant: null }));
    const response = await app.request("/api/installations/notes/grants", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeGeneration: "fixture-generation",
        authorityVersion: current.authority.authorityVersion,
        artifactDigest: current.release.artifact.artifactDigest,
        command: {
          kind: "change-grants",
          changes,
        },
      }),
    });
    expect(response.status).toBe(200);
    return installationSchema.parse(await response.json());
  }
  return {
    app,
    host,
    originKey,
    replaceOrigin,
    approveReadOnly,
    refusals,
    resolutionCalls: () => resolutionCalls,
    toolPolicyCalls: () => toolPolicyCalls,
    setResolvedPrincipal: (value: TenantPrincipal | null) => {
      resolvedPrincipal = value;
    },
    records,
    install,
    completePost,
    select,
    workflowSelect,
    upgradedRelease,
    release,
    calls,
    setPrincipal: (value: TenantPrincipal | null) => {
      principal = value;
    },
    setToolPolicy: (value: AppToolPolicy | null) => {
      toolPolicy = value;
    },
  };
}

it("reserves build-log artifact refs from owner uploads without blocking opaque App refs", async () => {
  const { app, host } = await fixture();
  const logRef = parseArtifactRef(`artifact:build-log-build_${"a".repeat(32)}`);
  const log = createBuildJobLog();
  log.append(new TextEncoder().encode("actual build output\n"));
  const stored = new TextEncoder().encode(JSON.stringify(log.finish()));
  await host.artifacts.put(logRef, stored);

  const upload = async (ref: string, bytes: Uint8Array) =>
    app.request(
      `/api/artifacts/${encodeURIComponent(ref)}?digest=${encodeURIComponent(await sha256(bytes))}`,
      { method: "PUT", body: bytes },
    );
  const fabricated = new TextEncoder().encode(
    JSON.stringify({
      encoding: "base64url",
      output: "ZmFicmljYXRlZA",
      truncated: null,
    }),
  );
  const refused = await upload(logRef, fabricated);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: "build_job_log_ref_reserved",
  });
  expect(await host.artifacts.get(logRef)).toEqual(stored);

  const uiRef = parseArtifactRef("artifact:ui");
  const ui = new TextEncoder().encode("<h1>App UI</h1>");
  expect((await upload(uiRef, ui)).status).toBe(204);
  expect(await host.artifacts.get(uiRef)).toEqual(ui);
});

it("records the owner's explicit operation approval at the installation HTTP boundary", async () => {
  const { install } = await fixture();
  const record = await install();
  expect(installationSchema.safeParse(record).success).toBe(true);
  expect(record.authority).toMatchObject({
    approval: {
      by: { kind: "member", memberId: "owner" },
      authorityVersion: 1,
    },
    approvedGrants: [
      {
        capability: "computer.readFile",
        operations: ["route:computer.readFile:open"],
        resources: "tenant-scope",
      },
    ],
  });
});

it("ordinary destinations, including the Tourtois name, require pinned owner approval", async () => {
  const { app, release, records, install, completePost } = await fixture(
    false,
    false,
    false,
    false,
    true,
  );
  for (const installationId of ["third-party", "tourtois"]) {
    const installed = await install(installationId, release);
    expect(
      installed.authority.approvedGrants.map((grant) => grant.capability),
    ).not.toContain("team.workbenchHost");
  }
  const path = "/api/installations/tourtois/grants";
  const projection = Schema.decodeUnknownSync(
    Schema.Struct({
      artifactDigest: sha256DigestSchema,
      permissions: Schema.Unknown,
    }),
  )(
    await (
      await app.request(path, { headers: { Accept: "application/json" } })
    ).json(),
  );
  const permissions = appPermissionsWireSchema.parse(projection.permissions);
  const approved = await app.request(path, {
    method: "PUT",
    body: JSON.stringify({
      storeGeneration: "fixture-generation",
      authorityVersion: permissions.authority.authorityVersion,
      artifactDigest: projection.artifactDigest,
      command: {
        kind: "change-grants",
        changes: permissions.declaredOperations.capabilities
          .map(({ capability, operations }) => ({
            capability,
            operations,
            resources: "tenant-scope",
          }))
          .map(({ capability, ...grant }) => ({ capability, grant })),
      },
    }),
  });
  expect(approved.status).toBe(200);
  const current = installationSchema.parse(await approved.json());
  expect(
    current.authority.approvedGrants.map((grant) => grant.capability),
  ).toContain("team.workbenchHost");
  const withdrawn = await app.request(path, {
    method: "PUT",
    body: JSON.stringify({
      storeGeneration: "fixture-generation",
      authorityVersion: current.authority.authorityVersion,
      artifactDigest: current.release.artifact.artifactDigest,
      command: {
        kind: "change-grants",
        changes: [{ capability: "team.workbenchHost", grant: null }],
      },
    }),
  });
  expect(withdrawn.status).toBe(200);
  const repeated = await completePost("tourtois", release);
  expect(repeated).toMatchObject({
    state: "succeeded",
    creation: "replacement",
  });
  expect(
    records
      .get("tourtois")
      ?.authority.approvedGrants.map((grant) => grant.capability),
  ).toEqual(["computer.readFile"]);
  expect(
    (await app.request("/api/installations/tourtois", { method: "DELETE" }))
      .status,
  ).toBe(204);
  // A deleted installation id is retired: it is never installed again.
  const recreated = await completePost("tourtois", release);
  expect(recreated).toMatchObject({ state: "succeeded", creation: "reminted" });
  if (recreated.state !== "succeeded" || recreated.installation === null)
    throw new Error("Exact remint did not apply");
  const fresh = recreated.installation;
  expect(fresh.installationId).toMatch(/^tourtois-[a-z0-9]{21}$/u);
  expect(
    fresh.authority.approvedGrants.map((row) => row.capability),
  ).not.toContain("team.workbenchHost");
  expect(records.get("tourtois")?.status).toBe("deleted");
  expect(
    records
      .get("tourtois")
      ?.authority.approvedGrants.map((grant) => grant.capability),
  ).toEqual([]);
});
it("refuses the next capability request after the host narrows approval", async () => {
  const { app, records, install } = await fixture();
  const record = await install();
  const request = () =>
    app.request("/files/content?path=/note.txt", {
      headers: { "X-Oyster-Installation": "notes" },
    });
  const before = await request();
  expect(before.status).toBe(200);
  expect(await before.text()).toBe("fixture note");
  // The host commits its authoritative narrowed record and increments its version.
  // No provider/Instance is mocked into a completed operation.
  const narrowed = {
    ...record,
    authority: {
      ...record.authority,
      authorityVersion: record.authority.authorityVersion + 1,
      approvedGrants: [],
      approval: null,
    },
  };
  records.set("notes", narrowed);
  expect((await request()).status).toBe(403);
});

it("keeps the approval intersection on a Release upgrade and clears it on deletion", async () => {
  const { app, records, install, upgradedRelease, select } = await fixture();
  const initial = await install();
  const upgraded = await select(await upgradedRelease());
  expect(upgraded.status).toBe(200);
  const record = records.get("notes");
  expect(record?.authority).toMatchObject({
    authorityVersion: 2,
    approvedGrants: [
      {
        capability: "computer.readFile",
        operations: ["route:computer.readFile:open"],
        resources: "tenant-scope",
      },
    ],
  });
  expect(record?.authority.approval).toEqual(initial.authority.approval);
  const write = await app.request("/files/content?path=/note.txt", {
    method: "PUT",
    headers: { "X-Oyster-Installation": "notes" },
    body: "unapproved write",
  });
  expect(write.status).toBe(403);
  const deleted = await app.request("/api/installations/notes", {
    method: "DELETE",
  });
  expect(deleted.status).toBe(204);
  expect(records.get("notes")).toMatchObject({
    status: "deleted",
    authority: {
      authorityVersion: 3,
      approvedGrants: [],
      approval: null,
    },
  });
});

it("refuses a tenant separator in an installation name before committing", async () => {
  const { app, records, release } = await fixture();
  const response = await app.request("/api/installations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ installationId: "notes--other", release }),
  });
  expect(response.status).toBe(400);
  expect(records.size).toBe(0);
});

it("refuses external and unapproved required methods before Instance dispatch", async () => {
  const { app, records, install, calls } = await fixture(true);
  const initial = await install();
  const call = (name: string) =>
    app.request(`/apps/notes/methods/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  expect((await call("read")).status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.grants).toEqual([
    { binding: "COMPUTER", operations: ["read"] },
  ]);
  const external = await call("external");
  expect(external.status).toBe(403);
  expect(await external.json()).toEqual({ error: "approval_required" });
  expect(calls).toHaveLength(1);
  records.set("notes", {
    ...initial,
    authority: {
      ...initial.authority,
      authorityVersion: 2,
      approvedGrants: [],
      approval: null,
    },
  });
  const narrowed = await call("read");
  expect(narrowed.status).toBe(403);
  expect(await narrowed.json()).toEqual({ error: "requires_not_granted" });
  expect(calls).toHaveLength(1);
});

it("refuses an anonymous read before any dispatch or tool policy", async () => {
  const f = await fixture(true);
  await f.install();
  f.setPrincipal(null);
  const response = await f.app.request("/apps/notes/methods/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(401);
  expect(f.calls).toHaveLength(0);
  expect(f.toolPolicyCalls()).toBe(0);
});

const toolPrincipals: { name: string; principal: TenantPrincipal }[] = [
  { name: "key", principal: { actor: { kind: "team-key", keyId: "key" } } },
  { name: "Agent", principal: { actor: { kind: "agent", agentId: "agent" } } },
];
it("only the owner cookie opens a browser page; a named-key session cookie admits nobody", async () => {
  const f = await fixture();
  await f.install("notes");
  const ownerKey = "fixture-cookie-owner-key-24-characters"; //gitleaks:allow
  const keys = {
    live: () => Promise.reject(new Error("No key lookup expected")),
    verify: () => Promise.reject(new Error("No bearer secret expected")),
  };
  const app = createOyster({
    ...f.host,
    keys,
    auth: ownerOrKeyAuth(ownerKey, "owner", () => keys),
  });
  const keySession = { Cookie: "oyster_key_session=opaque-browser-session" };
  expect(
    (await app.request("/apps/notes/", { headers: keySession })).status,
  ).toBe(401);
  const page = await app.request("/apps/notes/", {
    headers: { ...keySession, Accept: "text/html" },
  });
  expect(page.status).toBe(302);
  expect(page.headers.get("Location")).toBe("/login");

  const login = await app.request("/login", {
    method: "POST",
    body: new URLSearchParams({ key: ownerKey }),
  });
  expect(login.status).toBe(303);
  const ownerValue = parse(login.headers.get("Set-Cookie") ?? "")[
    ownerKeyCookieName
  ];
  expect(ownerValue).toMatch(/^sha256:[a-f0-9]{64}$/u);
  if (ownerValue === undefined) throw new Error("Expected the owner cookie");
  const ownerBrowser = { Cookie: `${ownerKeyCookieName}=${ownerValue}` };
  expect(
    (await app.request("/apps/notes/", { headers: ownerBrowser })).status,
  ).toBe(200);
  expect(
    (await app.request("/api/installations", { headers: ownerBrowser })).status,
  ).toBe(200);
});

it.each(toolPrincipals)(
  "uses attested $name tool policy instead of inferred write authority over HTTP",
  async ({ principal }) => {
    const f = await fixture(true);
    await f.install();
    f.setPrincipal(principal);
    const call = (name: string) =>
      f.app.request(`/apps/notes/methods/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    expect((await call("write")).status).toBe(403);
    expect(f.calls).toHaveLength(0);
    f.setToolPolicy({
      level: "read",
      revision: "key-policy-1",
      grantedBy: "fixture-owner",
    });
    expect((await call("read")).status).toBe(200);
    expect((await call("write")).status).toBe(403);
    expect(f.calls).toHaveLength(1);
    f.setToolPolicy({
      level: "write",
      revision: "key-policy-2",
      grantedBy: "fixture-owner",
    });
    expect((await call("write")).status).toBe(200);
    expect(f.calls).toHaveLength(2);
    f.setPrincipal(null);
    expect((await call("write")).status).toBe(401);
    expect(f.calls).toHaveLength(2);
  },
);

it("re-admits a retained member continuation through the live gate, without observed revision pins", async () => {
  const f = await fixture(true, true);
  const installed = await f.install();
  const wake = backgroundWakeSchema.parse({
    installationId: installed.installationId,
    actor: { kind: "member", memberId: "owner" },
    lane: "member:owner",
    originMethod: "write",
    epoch: 1,
    observed: {
      authorityVersion: installed.authority.authorityVersion,
      artifactDigest: installed.release.artifact.artifactDigest,
    },
  });
  f.records.set(installed.installationId, {
    ...installed,
    authority: {
      ...installed.authority,
      authorityVersion: installed.authority.authorityVersion + 1,
    },
  });
  const resolutionsBeforeDelivery = f.resolutionCalls();
  expect(await deliverBackground(f.host, wake)).toEqual({
    status: "accepted",
    more: false,
  });
  expect(f.resolutionCalls()).toBe(resolutionsBeforeDelivery + 1);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({
    selection: { authorityVersion: installed.authority.authorityVersion + 1 },
    subject: {
      kind: "call",
      context: { actor: { kind: "member", memberId: "owner" }, role: "owner" },
      method: { name: "continueWrite", effect: "write" },
      replay: {
        lane: "member:owner",
        epoch: 1,
        admitted: ["write", "continueWrite"],
      },
    },
    grants: [
      { binding: "COMPUTER", operations: ["read"] },
      { binding: "BACKGROUND", operations: ["admit"] },
    ],
  });
  expect(
    f.calls[0]?.subject.kind === "call" &&
      f.calls[0].subject.context.backgroundLane,
  ).toBeUndefined();
});

it("a removed member receives zero-grant syncRefused without a continuation call", async () => {
  const f = await fixture(true, true);
  const installed = await f.install();
  f.setResolvedPrincipal(null);
  const wake = backgroundWakeSchema.parse({
    installationId: installed.installationId,
    actor: { kind: "member", memberId: "owner" },
    lane: "member:owner",
    originMethod: "write",
    epoch: 1,
    observed: {
      authorityVersion: installed.authority.authorityVersion,
      artifactDigest: installed.release.artifact.artifactDigest,
    },
  });
  expect(await deliverBackground(f.host, wake)).toEqual({
    status: "accepted",
    more: false,
  });
  expect(f.calls).toEqual([]);
  expect(f.refusals).toHaveLength(1);
  expect(f.refusals[0]).toMatchObject({
    subject: {
      kind: "lifecycle",
      name: "syncRefused",
      lane: "member:owner",
      code: "access_changed",
    },
    grants: [],
  });
});

it("a disabled installation dead-letters its wake without executing the erased facet", async () => {
  const f = await fixture(true, true);
  const installed = await f.install();
  f.records.set(installed.installationId, { ...installed, status: "disabled" });
  const wake = backgroundWakeSchema.parse({
    installationId: installed.installationId,
    actor: { kind: "member", memberId: "owner" },
    lane: "member:owner",
    originMethod: "write",
    epoch: 1,
    observed: {
      authorityVersion: installed.authority.authorityVersion,
      artifactDigest: installed.release.artifact.artifactDigest,
    },
  });
  expect(await deliverBackground(f.host, wake)).toEqual({
    status: "refused",
    more: false,
  });
  expect(f.calls).toEqual([]);
  expect(f.refusals).toEqual([]);
});

it("fits a valid long member lane into the maintained call idempotency key", async () => {
  const f = await fixture(true, true);
  const installed = await f.install();
  const memberId = "m".repeat(180);
  f.setResolvedPrincipal({
    actor: { kind: "member", memberId },
    role: "member",
  });
  const wake = backgroundWakeSchema.parse({
    installationId: installed.installationId,
    actor: { kind: "member", memberId },
    lane: `member:${memberId}`,
    originMethod: "write",
    epoch: 1,
    observed: {
      authorityVersion: installed.authority.authorityVersion,
      artifactDigest: installed.release.artifact.artifactDigest,
    },
  });
  expect(await deliverBackground(f.host, wake)).toEqual({
    status: "accepted",
    more: false,
  });
  const subject = f.calls[0]?.subject;
  expect(subject?.kind).toBe("call");
  if (subject?.kind !== "call") throw new Error("Missing replay call");
  expect(subject.context.idempotencyKey?.length).toBeLessThanOrEqual(128);
});

it("lets the direct owner approve new Release capabilities without reinstalling", async () => {
  const { app, install, upgradedRelease, select } = await fixture();
  await install();
  const upgrade = await select(await upgradedRelease());
  const current = installationSchema.parse(await upgrade.json());
  expect(
    current.authority.approvedGrants.map((grant) => grant.capability),
  ).toEqual(["computer.readFile"]);
  const projection = Schema.decodeUnknownSync(
    Schema.Struct({ permissions: Schema.Unknown }),
  )(
    await (
      await app.request("/api/installations/notes/grants", {
        headers: { Accept: "application/json" },
      })
    ).json(),
  );
  const permissions = appPermissionsWireSchema.parse(projection.permissions);
  const response = await app.request("/api/installations/notes/grants", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeGeneration: "fixture-generation",
      authorityVersion: current.authority.authorityVersion,
      artifactDigest: current.release.artifact.artifactDigest,
      command: {
        kind: "change-grants",
        changes: permissions.declaredOperations.capabilities
          .map((row) => ({
            capability: row.capability,
            operations: row.operations,
            resources: "tenant-scope",
          }))
          .map(({ capability, ...grant }) => ({ capability, grant })),
      },
    }),
  });
  expect(response.status).toBe(200);
  const approved = installationSchema.parse(await response.json());
  expect(approved.instanceId).toBe(current.instanceId);
  expect(approved.authority.authorityVersion).toBe(
    current.authority.authorityVersion + 1,
  );
  expect(
    approved.authority.approvedGrants.map((grant) => grant.capability),
  ).toEqual(["computer.readFile", "computer.writeFile"]);
  expect(approved.authority.approval?.by).toEqual({
    kind: "member",
    memberId: "owner",
  });
});

it.each([
  {
    name: "member",
    principal: {
      actor: { kind: "member", memberId: "reader" },
      role: "member",
    },
  },
  {
    name: "Agent",
    principal: { actor: { kind: "agent", agentId: "agent_one" } },
  },
  { name: "key", principal: { actor: { kind: "team-key", keyId: "key" } } },
  { name: "anonymous request", principal: null },
] satisfies { name: string; principal: TenantPrincipal | null }[])(
  "refuses $name grant approval before changing installation authority",
  async ({ principal }) => {
    const { app, install, setPrincipal, records } = await fixture();
    const initial = await install();
    setPrincipal(principal);
    const response = await app.request("/api/installations/notes/grants", {
      method: "PUT",
      body: JSON.stringify({
        storeGeneration: "fixture-generation",
        authorityVersion: initial.authority.authorityVersion,
        artifactDigest: initial.release.artifact.artifactDigest,
        command: {
          kind: "change-grants",
          changes: [
            { capability: "computer.readFile", grant: null },
            { capability: "computer.writeFile", grant: null },
          ],
        },
      }),
    });
    expect(response.status).toBe(principal === null ? 401 : 403);
    expect(records.get("notes")).toEqual(initial);
  },
);
it("refuses App-origin approval even with the owner's browser principal", async () => {
  const { app, install, records } = await fixture();
  const initial = await install();
  const response = await app.request("/api/installations/notes/grants", {
    method: "PUT",
    headers: { "X-Oyster-Installation": "notes" },
    body: JSON.stringify({
      storeGeneration: "fixture-generation",
      authorityVersion: initial.authority.authorityVersion,
      artifactDigest: initial.release.artifact.artifactDigest,
      command: {
        kind: "change-grants",
        changes: [
          { capability: "computer.readFile", grant: null },
          { capability: "computer.writeFile", grant: null },
        ],
      },
    }),
  });
  expect(response.status).toBe(403);
  expect(records.get("notes")).toEqual(initial);
});
it("refuses stale versions and Release digests without restoring withdrawn approvals", async () => {
  const { app, install, records } = await fixture();
  const initial = await install();
  for (const patch of [
    { authorityVersion: initial.authority.authorityVersion + 1 },
    { artifactDigest: `sha256:${"f".repeat(64)}` },
  ]) {
    const response = await app.request("/api/installations/notes/grants", {
      method: "PUT",
      body: JSON.stringify({
        storeGeneration: "fixture-generation",
        authorityVersion: initial.authority.authorityVersion,
        artifactDigest: initial.release.artifact.artifactDigest,
        command: {
          kind: "change-grants",
          changes: [
            { capability: "computer.readFile", grant: null },
            { capability: "computer.writeFile", grant: null },
          ],
        },
        ...patch,
      }),
    });
    expect(response.status).toBe(409);
    expect(records.get("notes")).toEqual(initial);
  }
});
it("refuses malformed approval commands and unknown installations", async () => {
  const { app, install, records } = await fixture();
  const initial = await install();
  const valid = {
    storeGeneration: "fixture-generation",
    authorityVersion: initial.authority.authorityVersion,
    artifactDigest: initial.release.artifact.artifactDigest,
    command: {
      kind: "change-grants",
      changes: [
        { capability: "computer.readFile", grant: null },
        { capability: "computer.writeFile", grant: null },
      ],
    },
  };
  for (const body of [
    "{",
    JSON.stringify({ ...valid, authorityVersion: 0 }),
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({
      ...valid,
      command: { kind: "set-status", status: "deleted" },
    }),
  ]) {
    expect(
      (
        await app.request("/api/installations/notes/grants", {
          method: "PUT",
          body,
        })
      ).status,
    ).toBe(400);
    expect(records.get("notes")).toEqual(initial);
  }
  expect(
    (
      await app.request("/api/installations/missing/grants", {
        method: "PUT",
        body: JSON.stringify(valid),
      })
    ).status,
  ).toBe(404);
});
it("cannot approve a capability outside the verified Release declaration", async () => {
  const { app, install, records } = await fixture();
  const initial = await install();
  const response = await app.request("/api/installations/notes/grants", {
    method: "PUT",
    body: JSON.stringify({
      storeGeneration: "fixture-generation",
      authorityVersion: initial.authority.authorityVersion,
      artifactDigest: initial.release.artifact.artifactDigest,
      command: {
        kind: "change-grants",
        changes: [
          {
            capability: "computer.writeFile",
            grant: { operations: [], resources: "tenant-scope" },
          },
        ],
      },
    }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_declared" });
  expect(records.get("notes")).toEqual(initial);
});

it("caps approval bodies before decoding or committing", async () => {
  const { app, install, records } = await fixture();
  const before = await install();
  const response = await app.request("/api/installations/notes/grants", {
    method: "PUT",
    body: " ".repeat(65537),
  });
  expect(response.status).toBe(413);
  expect(records.get("notes")).toEqual(before);
});
it.each(toolPrincipals)(
  "keeps the consent page owner-only for $name, including path variants",
  async ({ principal }) => {
    const { app, install, setPrincipal } = await fixture();
    await install();
    setPrincipal(principal);
    for (const path of [
      "notes",
      "notes%2Fgrants",
      "notes/../notes",
      "Notes",
      "notes/",
    ]) {
      const response = await app.request(`/api/installations/${path}/grants`, {
        method: "PUT",
        body: "{}",
      });
      expect([403, 404]).toContain(response.status);
    }
    expect((await app.request("/api/installations/notes/grants")).status).toBe(
      403,
    );
  },
);
it("owner consent page rejects App headers and missing/deleted records", async () => {
  const { app, install, records } = await fixture();
  const installed = await install();
  expect(
    (
      await app.request("/api/installations/notes/grants", {
        headers: { "X-Oyster-Installation": "notes" },
      })
    ).status,
  ).toBe(403);
  expect((await app.request("/api/installations/missing/grants")).status).toBe(
    404,
  );
  records.set("notes", { ...installed, status: "deleted" });
  expect((await app.request("/api/installations/notes/grants")).status).toBe(
    404,
  );
});

it.each([
  {
    name: "member",
    principal: {
      actor: { kind: "member", memberId: "reader" },
      role: "member",
    },
  },
  { name: "anonymous request", principal: null },
] satisfies { name: string; principal: TenantPrincipal | null }[])(
  "refuses the consent page to $name",
  async ({ principal }) => {
    const { app, install, setPrincipal } = await fixture();
    await install();
    setPrincipal(principal);
    expect((await app.request("/api/installations/notes/grants")).status).toBe(
      principal === null ? 401 : 403,
    );
  },
);
it("labels the consent with the host's installation identity and default scope", async () => {
  const { app, install } = await fixture();
  await install();
  const page = await app.request("/api/installations/notes/grants");
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('"installationId":"notes"');
  expect(html).toContain('"appId":"app_notes"');
  expect(html).toContain('"resources":"tenant-scope"');
  expect(html).toContain('"declaredOperations"');
});

it("seals the admitted named write origin before member dispatch", async () => {
  const f = await fixture(true, true);
  await f.install();
  const response = await f.app.request("/apps/notes/methods/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(200);
  const facts = f.calls[0];
  if (facts?.subject.kind !== "call")
    throw new Error("Expected named member call");
  const context = facts.subject.context;
  if (context.backgroundLane === undefined)
    throw new Error("Expected sealed member lane");
  expect(context.backgroundOrigin?.method).toBe("write");
  expect(
    await admitClaimedOrigin(
      f.originKey,
      {
        instanceId: facts.instanceId,
        lane: context.backgroundLane,
        admitted: ["write"],
      },
      context.backgroundOrigin,
    ),
  ).toEqual({ kind: "admitted" });
  expect(facts.grants.some((grant) => grant.binding === "BACKGROUND")).toBe(
    false,
  );
});

it("refuses an eligible named member write when no origin key is configured", async () => {
  const f = await fixture(true, true);
  await f.install();
  const host = { ...f.host };
  delete host.backgroundOriginKey;
  const app = createOyster(host);
  const read = await app.request("/apps/notes/methods/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(read.status).toBe(200);
  const write = await app.request("/apps/notes/methods/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(write.status).toBe(500);
  expect(f.calls).toHaveLength(1);
});

it("fresh replay excludes a former write origin while retaining another origin", async () => {
  const f = await fixture(true, true, true);
  const installed = await f.install();
  for (const name of ["write", "otherWrite"]) {
    const response = await f.app.request(`/apps/notes/methods/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
  }
  const origins = f.calls.map((facts) =>
    facts.subject.kind === "call"
      ? facts.subject.context.backgroundOrigin
      : undefined,
  );
  await f.replaceOrigin("otherWrite");
  const wake = backgroundWakeSchema.parse({
    installationId: installed.installationId,
    actor: { kind: "member", memberId: "owner" },
    lane: "member:owner",
    originMethod: "otherWrite",
    epoch: 1,
    observed: {
      authorityVersion: installed.authority.authorityVersion,
      artifactDigest: installed.release.artifact.artifactDigest,
    },
  });
  expect(await deliverBackground(f.host, wake)).toEqual({
    status: "accepted",
    more: false,
  });
  const replay = f.calls[2];
  if (replay?.subject.kind !== "call" || replay.subject.replay === undefined)
    throw new Error("Expected replay");
  expect(replay.subject.replay.admitted).toEqual(["write", "continueWrite"]);
  const claims = {
    instanceId: replay.instanceId,
    lane: wake.lane,
    admitted: replay.subject.replay.admitted,
  };
  expect(await admitClaimedOrigin(f.originKey, claims, origins[0])).toEqual({
    kind: "admitted",
  });
  expect(await admitClaimedOrigin(f.originKey, claims, origins[1])).toEqual({
    kind: "refused",
    code: "access_changed",
  });
});

it("the exact host filter excludes an unapproved write origin on a valid nonsync App", async () => {
  const f = await fixture(true, false, true, true);
  await f.install();
  for (const name of ["write", "otherWrite"])
    expect(
      (
        await f.app.request(`/apps/notes/methods/${name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
  const origins = f.calls.map((facts) =>
    facts.subject.kind === "call"
      ? facts.subject.context.backgroundOrigin
      : undefined,
  );
  const installation = await f.approveReadOnly();
  const release = await hostModule.verifyRelease(
    f.host.artifacts,
    installation.release,
  );
  if (release.declaration === null) throw new Error("Declaration missing");
  const authenticated = await f.host.auth.authenticate(
    new Request("https://host.invalid"),
  );
  if (authenticated.kind !== "admitted") throw new Error("Member missing");
  const caller = invocationCallerContext(authenticated.principal, null);
  const admitted = admittedBackgroundOrigins({
    installation: {
      ...installation,
      artifactDigest: installation.release.artifact.artifactDigest,
    },
    declaration: release.declaration,
    declaredOperations: await deriveDeclaredOperations(
      installation.release,
      release.declaration,
      f.host.capabilities ?? [],
    ),
    api: release.api,
    principal: { actor: caller.actor, role: caller.role ?? null },
    access: null,
  });
  expect(admitted).toEqual(["write"]);
  if (installation.instanceId === null) throw new Error("Instance missing");
  const claims = {
    instanceId: installation.instanceId,
    lane: "member:owner",
    admitted,
  };
  expect(await admitClaimedOrigin(f.originKey, claims, origins[0])).toEqual({
    kind: "admitted",
  });
  expect(await admitClaimedOrigin(f.originKey, claims, origins[1])).toEqual({
    kind: "refused",
    code: "access_changed",
  });
});

it("capability revocation refuses the whole replay while the continuation superset law remains", async () => {
  const f = await fixture(true, true, true, true);
  const installed = await f.install();
  await f.approveReadOnly();
  const wake = backgroundWakeSchema.parse({
    installationId: installed.installationId,
    actor: { kind: "member", memberId: "owner" },
    lane: "member:owner",
    originMethod: "otherWrite",
    epoch: 1,
    observed: {
      authorityVersion: installed.authority.authorityVersion,
      artifactDigest: installed.release.artifact.artifactDigest,
    },
  });
  expect(await deliverBackground(f.host, wake)).toEqual({
    status: "accepted",
    more: false,
  });
  expect(f.calls).toHaveLength(0);
  expect(f.refusals).toHaveLength(1);
  expect(f.refusals[0]?.grants).toEqual([]);
});

it(
  "a second POST switches an already-live installation onto a new Release " +
    "instead of refusing it (install and select share one path)",
  async () => {
    const { install, records, upgradedRelease, completePost } = await fixture();
    const first = await install();
    const upgraded = await upgradedRelease();
    const response = await completePost("notes", upgraded);
    expect(response).toMatchObject({
      state: "succeeded",
      creation: "replacement",
    });
    const next = records.get("notes");
    expect(next?.release.releaseId).toBe(upgraded.releaseId);
    expect(next?.instanceId).toBe(first.instanceId);
    expect(next?.authority.authorityVersion).toBe(
      first.authority.authorityVersion + 1,
    );
  },
);

it("refuses installing or switching a Release for a different App at the same installation id", async () => {
  const { install, release, select } = await fixture();
  await install();
  const foreign = parseRelease({
    ...release,
    appId: "app_other",
    releaseId: "rel_other",
  });
  const response = await select(foreign);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "release_app_mismatch" });
});

it("refuses a non-owner member's install, typed", async () => {
  const { app, release, records, setPrincipal } = await fixture();
  setPrincipal({ actor: { kind: "member", memberId: "ren" }, role: "member" });
  const response = await app.request("/api/installations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ installationId: "notes", release }),
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "Owner only",
  });
  expect(records.get("notes")).toBeUndefined();
});

it("HTTP methods requiring apps.open need stored approval and refuse again after revocation", async () => {
  const f = await fixture(true);
  await f.install();
  const selected = await f.select(await f.upgradedRelease(true));
  expect(selected.status).toBe(200);
  const call = () =>
    f.app.request("/apps/notes/methods/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  const unapproved = await call();
  expect(unapproved.status).toBe(403);
  expect(await unapproved.json()).toEqual({ error: "requires_not_granted" });
  expect(f.calls).toHaveLength(0);
  const save = async (approve: boolean) => {
    const current = f.records.get("notes");
    if (current === undefined) throw new Error("Missing current installation");
    const response = await f.app.request("/api/installations/notes/grants", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeGeneration: "fixture-generation",
        authorityVersion: current.authority.authorityVersion,
        artifactDigest: current.release.artifact.artifactDigest,
        command: {
          kind: "change-grants",
          changes: [
            {
              capability: "apps.open",
              grant: approve
                ? {
                    operations: ["route:app.methods:open"],
                    resources: "tenant-scope",
                  }
                : null,
            },
          ],
        },
      }),
    });
    expect(response.status).toBe(200);
  };
  await save(true);
  expect((await call()).status).toBe(200);
  expect(f.calls).toHaveLength(1);
  await save(false);
  const revoked = await call();
  expect(revoked.status).toBe(403);
  expect(await revoked.json()).toEqual({ error: "requires_not_granted" });
  expect(f.calls).toHaveLength(1);
});

it.each(["{", "not JSON", "null", "[]"])(
  "refuses malformed permission PUT body %s without changing authority",
  async (body) => {
    const f = await fixture();
    const initial = await f.install();
    const response = await f.app.request("/api/installations/notes/grants", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid approval" });
    expect(f.records.get("notes")).toEqual(initial);
    expect(f.calls).toHaveLength(0);
  },
);

it.each([
  { name: "same approved permissions", capabilities: ["computer.readFile"] },
  { name: "a subset of approved permissions", capabilities: [] },
] satisfies { name: string; capabilities: AppDeclaration["capabilities"] }[])(
  "Workflow installation selects a successful Release with $name",
  async ({ capabilities }) => {
    const f = await fixture();
    const before = await f.install();
    const candidate = await f.upgradedRelease(false, capabilities);
    const response = await f.workflowSelect(candidate);
    expect(response.status).toBe(200);
    const after = f.records.get("notes");
    expect(after?.release).toEqual(candidate);
    expect(after?.instanceId).toBe(before.instanceId);
    expect(
      after?.authority.approvedGrants.every((grant) =>
        before.authority.approvedGrants.some(
          (approved) =>
            approved.capability === grant.capability &&
            grant.operations.every((operation) =>
              approved.operations.includes(operation),
            ),
        ),
      ),
    ).toBe(true);
  },
);

it("Workflow installation returns typed needs_consent and keeps the old Release running", async () => {
  const f = await fixture();
  const before = await f.install();
  const candidate = await f.upgradedRelease();
  const response = await f.workflowSelect(candidate);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "needs_consent" });
  expect(f.records.get("notes")).toEqual(before);
});

it("Workflow first install with permission requirements needs consent without creating an installation", async () => {
  const f = await fixture();
  const response = await f.workflowSelect(f.release);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "needs_consent" });
  expect(f.records.size).toBe(0);
});

it("Workflow first install without permission requirements creates the installation without grants", async () => {
  const f = await fixture();
  const candidate = await f.upgradedRelease(false, []);
  const response = await f.workflowSelect(candidate);
  expect(response.status).toBe(201);
  expect(f.records.get("notes")?.release).toEqual(candidate);
  expect(f.records.get("notes")?.authority.approvedGrants).toEqual([]);
});
