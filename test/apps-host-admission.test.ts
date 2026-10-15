import { admittedBackgroundOrigins } from "../src/internal/background-origins.js";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import { invocationCallerContext } from "../src/invocation.js";
import { expect, it } from "vitest";
import * as hostModule from "@fungi.computer/oyster/host";
import { deliverBackground } from "../dist/internal/delivery.js";
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
  type AppUiBuild,
  type AppBackendBuild,
} from "@fungi.computer/puffball/app";
import { parseArtifactRef } from "@fungi.computer/puffball";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import {
  createOyster,
  type OysterHost,
  type InstanceResult,
} from "@fungi.computer/oyster/host";
import type { TenantPrincipal } from "@fungi.computer/oyster/tenant";
import { parseRelease, sha256 } from "@fungi.computer/oyster/host";
import { fileCapabilities } from "@fungi.computer/oyster/files";
import { installationSchema } from "../src/apps/installation.js";
import type { AppToolPolicy } from "../src/apps/tools.js";
import type { InvocationFacts } from "../src/invocation.js";

/** The real HTTP host over its ordinary artifact/store ports, with no backend to execute. */
async function fixture(
  withMethods = false,
  withSync = false,
  twoOrigins = false,
  ungrantedOrigin = false,
) {
  const ui = new TextEncoder().encode("<!doctype html><title>Notes</title>");
  const uiRef = parseArtifactRef("artifact:notes-ui");
  const rootRef = parseArtifactRef("artifact:notes-root");
  const baseDeclaration = Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities: ungrantedOrigin
      ? ["computer.readFile", "computer.writeFile"]
      : ["computer.readFile"],
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
      list: () => Promise.resolve([...records.values()]),
      get: (id) => Promise.resolve(records.get(id) ?? null),
      put: (record) => {
        records.set(record.installationId, record);
        return Promise.resolve();
      },
      compareAndPut: (record, expectedAuthorityVersion) => {
        if (
          records.get(record.installationId)?.authorityVersion !==
          expectedAuthorityVersion
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
  const app = createOyster(host);
  async function install() {
    const response = await app.request("/api/installations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationId: "notes", release }),
    });
    expect(response.status).toBe(201);
    const record = records.get("notes");
    if (record === undefined) throw new Error("Installation did not commit");
    return record;
  }
  async function upgradedRelease() {
    const upgradedBuild = createAppBuild(uiBuild, null, {
      ...declaration,
      capabilities: ["computer.readFile", "computer.writeFile"],
    });
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
    const response = await app.request("/api/installations/notes/release", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    expect(response.status).toBe(200);
  }
  async function approveReadOnly() {
    const current = records.get("notes");
    if (current === undefined) throw new Error("Installation missing");
    const grants = current.approvedGrants
      .filter((grant) => grant.capability === "computer.readFile")
      .map(({ capability, operations, resources }) => ({
        capability,
        operations,
        resources,
      }));
    const response = await app.request("/api/installations/notes/grants", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authorityVersion: current.authorityVersion,
        artifactDigest: current.release.artifact.artifactDigest,
        command: { kind: "set-grants", grants },
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

it("records the owner's explicit operation approval at the installation HTTP boundary", async () => {
  const { install } = await fixture();
  const record = await install();
  expect(installationSchema.safeParse(record).success).toBe(true);
  expect(record).toMatchObject({
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
    authorityVersion: record.authorityVersion + 1,
    approvedGrants: [],
    approval: null,
  };
  records.set("notes", narrowed);
  expect((await request()).status).toBe(403);
});

it("keeps the approval intersection on a Release upgrade and clears it on deletion", async () => {
  const { app, records, install, upgradedRelease } = await fixture();
  const initial = await install();
  const upgraded = await app.request("/api/installations/notes/release", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await upgradedRelease()),
  });
  expect(upgraded.status).toBe(200);
  const record = records.get("notes");
  expect(record).toMatchObject({
    authorityVersion: 2,
    approvedGrants: [
      {
        capability: "computer.readFile",
        operations: ["route:computer.readFile:open"],
        resources: "tenant-scope",
      },
    ],
  });
  expect(record?.approval).toEqual(initial.approval);
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
    authorityVersion: 3,
    status: "deleted",
    approvedGrants: [],
    approval: null,
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
    authorityVersion: 2,
    approvedGrants: [],
    approval: null,
  });
  const narrowed = await call("read");
  expect(narrowed.status).toBe(403);
  expect(await narrowed.json()).toEqual({ error: "requires_not_granted" });
  expect(calls).toHaveLength(1);
});

it("admits a visitor's public read without asking the Agent and key tool policy", async () => {
  const f = await fixture(true);
  const record = await f.install();
  f.records.set("notes", { ...record, visibility: "public" });
  f.setPrincipal(null);
  const response = await f.app.request("/apps/notes/methods/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(200);
  expect(f.calls).toHaveLength(1);
  expect(f.toolPolicyCalls()).toBe(0);
});

const toolPrincipals: { name: string; principal: TenantPrincipal }[] = [
  { name: "key", principal: { actor: { kind: "team-key", keyId: "key" } } },
  { name: "Agent", principal: { actor: { kind: "agent", agentId: "agent" } } },
];
it.each(toolPrincipals)(
  "uses attested $name tool policy instead of inferred write authority over HTTP",
  async ({ principal }) => {
    const f = await fixture(true);
    const record = await f.install();
    f.records.set("notes", { ...record, visibility: "public" });
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
      authorityVersion: installed.authorityVersion,
      artifactDigest: installed.release.artifact.artifactDigest,
    },
  });
  f.records.set(installed.installationId, {
    ...installed,
    authorityVersion: installed.authorityVersion + 1,
  });
  expect(await deliverBackground(f.host, wake)).toEqual({
    status: "accepted",
    more: false,
  });
  expect(f.resolutionCalls()).toBe(1);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({
    selection: { authorityVersion: installed.authorityVersion + 1 },
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
      authorityVersion: installed.authorityVersion,
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
      authorityVersion: installed.authorityVersion,
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
      authorityVersion: installed.authorityVersion,
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
  const { app, install, upgradedRelease } = await fixture();
  await install();
  const upgrade = await app.request("/api/installations/notes/release", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await upgradedRelease()),
  });
  const current = installationSchema.parse(await upgrade.json());
  expect(current.approvedGrants.map((grant) => grant.capability)).toEqual([
    "computer.readFile",
  ]);
  const response = await app.request("/api/installations/notes/grants", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authorityVersion: current.authorityVersion,
      artifactDigest: current.release.artifact.artifactDigest,
      command: { kind: "set-grants", grants: "declared" },
    }),
  });
  expect(response.status).toBe(200);
  const approved = installationSchema.parse(await response.json());
  expect(approved.instanceId).toBe(current.instanceId);
  expect(approved.authorityVersion).toBe(current.authorityVersion + 1);
  expect(approved.approvedGrants.map((grant) => grant.capability)).toEqual([
    "computer.readFile",
    "computer.writeFile",
  ]);
  expect(approved.approval?.by).toEqual({ kind: "member", memberId: "owner" });
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
        authorityVersion: initial.authorityVersion,
        artifactDigest: initial.release.artifact.artifactDigest,
        command: { kind: "set-grants", grants: "none" },
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
      authorityVersion: initial.authorityVersion,
      artifactDigest: initial.release.artifact.artifactDigest,
      command: { kind: "set-grants", grants: "declared" },
    }),
  });
  expect(response.status).toBe(403);
  expect(records.get("notes")).toEqual(initial);
});
it("refuses stale versions and Release digests without restoring withdrawn approvals", async () => {
  const { app, install, records } = await fixture();
  const initial = await install();
  for (const patch of [
    { authorityVersion: initial.authorityVersion + 1 },
    { artifactDigest: `sha256:${"f".repeat(64)}` },
  ]) {
    const response = await app.request("/api/installations/notes/grants", {
      method: "PUT",
      body: JSON.stringify({
        authorityVersion: initial.authorityVersion,
        artifactDigest: initial.release.artifact.artifactDigest,
        command: { kind: "set-grants", grants: "none" },
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
    authorityVersion: initial.authorityVersion,
    artifactDigest: initial.release.artifact.artifactDigest,
    command: { kind: "set-grants", grants: "none" },
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
it("rejects anonymous approval through the capability-only grants route", async () => {
  const { app, install, records } = await fixture();
  const current = await install();
  const body = JSON.stringify({
    authorityVersion: current.authorityVersion,
    artifactDigest: current.release.artifact.artifactDigest,
    command: { kind: "approve-anonymous", methods: [] },
  });
  const response = await app.request("/api/installations/notes/grants", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
  expect(response.status).toBe(400);
  expect(records.get("notes")).toEqual(current);
});
it("cannot approve a capability outside the verified Release declaration", async () => {
  const { app, install, records } = await fixture();
  const initial = await install();
  const response = await app.request("/api/installations/notes/grants", {
    method: "PUT",
    body: JSON.stringify({
      authorityVersion: initial.authorityVersion,
      artifactDigest: initial.release.artifact.artifactDigest,
      command: {
        kind: "set-grants",
        grants: [
          {
            capability: "computer.writeFile",
            operations: [],
            resources: "tenant-scope",
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
  expect(html).toContain("All of this Oyster");
  expect(html).toContain("Lets this App");
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
      authorityVersion: installed.authorityVersion,
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
    installation,
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
      authorityVersion: installed.authorityVersion,
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
    const { app, install, records, upgradedRelease } = await fixture();
    const first = await install();
    const upgraded = await upgradedRelease();
    const response = await app.request("/api/installations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationId: "notes", release: upgraded }),
    });
    expect(response.status).toBe(200);
    const next = records.get("notes");
    expect(next?.release.releaseId).toBe(upgraded.releaseId);
    expect(next?.instanceId).toBe(first.instanceId);
    expect(next?.authorityVersion).toBe(first.authorityVersion + 1);
  },
);

it("refuses installing or switching a Release for a different App at the same installation id", async () => {
  const { app, install, release } = await fixture();
  await install();
  const foreign = parseRelease({
    ...release,
    appId: "app_other",
    releaseId: "rel_other",
  });
  const response = await app.request("/api/installations/notes/release", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(foreign),
  });
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
    error: "Only the owner manages this Oyster",
  });
  expect(records.get("notes")).toBeUndefined();
});
