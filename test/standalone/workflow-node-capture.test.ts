import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import {
  createAppBuild,
  appDeclarationSchema,
  type AppBackendBuild,
  type AppBuild,
} from "@fungi.computer/puffball/app";
import { parseArtifactRef } from "@fungi.computer/puffball";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import {
  backendMediaType,
  type DurableBackend,
} from "@fungi.computer/puffball/backend";
import { catalogMethods } from "@fungi.computer/braid";
import {
  applyInstallationCommand,
  deriveDeclaredOperations,
} from "@fungi.computer/oyster/apps";
import {
  parseRelease,
  sha256,
  type ArtifactStore,
  type OysterHost,
} from "@fungi.computer/oyster/host";
import { instanceIds } from "@fungi.computer/oyster";
import { approvedInstallation } from "@fungi.computer/oyster/testing";
import { createTenancy } from "@fungi.computer/oyster/tenancy";
import { memoryRegistry } from "@fungi.computer/oyster/tenancy/registry";
import { subdomain } from "@fungi.computer/oyster/tenancy/resolve";
import { createStandaloneWorkflowAuthorityReaders } from "../../src/standalone/workflow-authority-readers.js";
import { createStandaloneWorkflowNodeCapture } from "../../src/standalone/workflow-node-capture.js";
import { createStandaloneWorkflowInstallationGitCapture } from "../../src/standalone/workflow-git-capture.js";

async function fixture() {
  const registry = memoryRegistry();
  const tenant = await registry.create({
    handle: "capture",
    origin: "https://capture.oyster.test",
    domains: ["capture.oyster.test"],
    owner: { provider: "fixture", subject: "signed-in-owner" },
  });
  const tenancy = createTenancy({
    registry,
    resolve: subdomain("oyster.test"),
    auth: [],
  });
  const ownerId = tenant.owners[0];
  if (ownerId === undefined) throw new Error("Current owner missing");
  const resolved = await tenancy.oyster().resolve(new Request(tenant.origin));
  if (resolved === null) throw new Error("Tenant did not resolve");
  const computerId = "computer-selected";
  const readers = createStandaloneWorkflowAuthorityReaders({
    tenantId: tenant.id,
    tenancy,
    host: { computerId },
    libraryInstallationId: "workflows-installed",
    catalogHost: {
      admitLibrary: () => Promise.reject(new Error("Capture read the catalog")),
      catalogForLibrary: (): Promise<never> =>
        Promise.reject(new Error("Capture read the catalog")),
    },
  });
  const declaration = Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities: ["computer.execute", "app.events.emit", "git.repository"],
    handlers: [],
    roles: [],
    backend: {
      bindings: [
        {
          name: "COMPUTER",
          operations: ["processes", "processStart", "workflowGitPass"],
        },
        { name: "EVENTS", operations: ["emit"] },
        { name: "GIT", operations: ["read", "write"] },
      ],
    },
    api: {
      methods: Object.fromEntries(
        ["read", "write", "external", "unbound"].map((effect) => [
          effect,
          {
            description: `Fixture ${effect} method`,
            effect: effect === "unbound" ? "write" : effect,
            requires:
              effect === "unbound" ? ["app.events.emit"] : ["computer.execute"],
            input: {
              type: "object",
              properties: { task: { type: "string" } },
              required: ["task"],
              additionalProperties: false,
            },
            output: { type: "object" },
          },
        ]),
      ),
    },
  });
  const blobs = new Map<string, Uint8Array>();
  const persist = async (value: AppBuild | DurableBackend) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = Schema.decodeUnknownSync(sha256DigestSchema)(
      await sha256(bytes),
    );
    const artifactRef = parseArtifactRef(`artifact:sha256-${digest.slice(7)}`);
    blobs.set(artifactRef, bytes);
    return {
      artifactRef,
      digest,
      byteLength: bytes.byteLength,
      version: digest,
    };
  };
  const backend: AppBackendBuild = {
    ...(await persist({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-25",
      exportName: "Guest",
      code: "export class Guest {}",
    })),
    mediaType: backendMediaType,
  };
  const root = await persist(createAppBuild(null, backend, declaration));
  const release = parseRelease({
    appId: "app_capture",
    releaseId: "rel_capture",
    artifact: {
      artifactRef: root.artifactRef,
      artifactDigest: root.digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: root.digest,
        buildRecipeDigest: root.digest,
      },
    },
  });
  let installation = await approvedInstallation({
    installationId: "capture-app",
    instanceId: instanceIds.instance.generate(),
    release,
    declaration,
  });
  const api = declaration.api;
  if (api === undefined) throw new Error("Verified API missing");
  const methods = (await catalogMethods(api.methods)).methods;
  let artifactReads = 0;
  let duringRead: (() => Promise<void>) | undefined;
  const artifacts: ArtifactStore = {
    get: async (ref) => {
      artifactReads++;
      const hook = duringRead;
      duringRead = undefined;
      await hook?.();
      return blobs.get(ref) ?? null;
    },
    put: (ref, bytes) => {
      blobs.set(ref, bytes);
      return Promise.resolve();
    },
  };
  const host = {
    auth: resolved.auth,
    computerId,
    artifacts,
    installations: { get: () => Promise.resolve(installation) },
  };
  const actor = { kind: "member", memberId: ownerId } as const;
  const member = await readers.member(ownerId);
  if (member === null) throw new Error("Owner was not admitted");
  const target = (method: string) => {
    const declared = methods[method];
    if (declared === undefined) throw new Error("Fixture method missing");
    return {
      installationId: installation.installationId,
      appId: installation.appId,
      method,
      methodDigest: declared.digest,
      computerId,
    };
  };
  const setGrants = async (choice: "none" | "read-operations" = "none") => {
    const updated = applyInstallationCommand(
      installation,
      {
        kind: "set-grants",
        grants:
          choice === "none"
            ? "none"
            : installation.approvedGrants.map((grant) => ({
                capability: grant.capability,
                resources: grant.resources,
                operations: grant.operations.filter(
                  (operation) =>
                    operation !== "binding:COMPUTER:processStart" &&
                    operation !== "binding:COMPUTER:workflowGitPass" &&
                    operation !== "binding:GIT:write",
                ),
              })),
      },
      {
        by: actor,
        role: "owner",
        expectedVersion: installation.authorityVersion,
        declaration,
        declaredOperations: await deriveDeclaredOperations(
          release,
          declaration,
          [],
        ),
        now: 2000,
        identity: {
          installationId: installation.installationId,
          instanceId: installation.instanceId,
        },
      },
    );
    if (Result.isFailure(updated)) throw new Error(updated.failure.code);
    installation = updated.success.next;
  };
  return {
    host,
    readers,
    actor,
    member,
    target,
    setGrants,
    suspend: () => registry.setStatus(tenant.id, "suspended"),
    onRead: (hook: () => Promise<void>) => {
      duringRead = hook;
    },
    reads: () => artifactReads,
  };
}

it("captures real approvals without asking for runtime input or invoking an App", async () => {
  const f = await fixture();
  const capture = createStandaloneWorkflowNodeCapture(f);
  expect(await capture(f.actor, f.member, f.target("write"))).toEqual({
    level: "write",
    capabilities: ["computer.execute"],
    bindings: [
      {
        name: "COMPUTER",
        operations: ["processes", "processStart", "workflowGitPass"],
      },
    ],
  });
});

it("captures a verified non-Computer method without selecting or reading a Computer", async () => {
  const f = await fixture();
  const capture = createStandaloneWorkflowNodeCapture({
    host: f.host,
    readers: {
      member: f.readers.member,
      memberComputer: () =>
        Promise.reject(new Error("Unexpected Computer admission")),
    },
  });
  await expect(
    capture(f.actor, f.member, { ...f.target("unbound"), computerId: null }),
  ).resolves.toEqual({
    level: "write",
    capabilities: ["app.events.emit"],
    bindings: [{ name: "EVENTS", operations: ["emit"] }],
  });
});

it("read capture excludes approved writes and emits", async () => {
  const f = await fixture();
  expect(
    await createStandaloneWorkflowNodeCapture(f)(
      f.actor,
      f.member,
      f.target("read"),
    ),
  ).toEqual({
    level: "read",
    capabilities: ["computer.execute"],
    bindings: [{ name: "COMPUTER", operations: ["processes"] }],
  });
});

it.each([
  "other-computer",
  "null-computer",
  "app-drift",
  "method-drift",
  "unknown-method",
  "external",
])("refuses %s without a fallback ceiling", async (failure) => {
  const f = await fixture();
  const original = f.target(failure === "external" ? "external" : "write");
  const target =
    failure === "other-computer"
      ? { ...original, computerId: "guest-selected" }
      : failure === "null-computer"
        ? { ...original, computerId: null }
        : failure === "app-drift"
          ? { ...original, appId: "app_other" }
          : failure === "method-drift"
            ? { ...original, methodDigest: `sha256:${"f".repeat(64)}` }
            : failure === "unknown-method"
              ? { ...original, method: "absent" }
              : original;
  expect(
    await createStandaloneWorkflowNodeCapture(f)(f.actor, f.member, target),
  ).toBeNull();
});

it("uses the live human, never the installation creator or a matching key id", async () => {
  const f = await fixture();
  const capture = createStandaloneWorkflowNodeCapture(f);
  expect(
    await capture(
      { kind: "member", memberId: "fixture-owner" },
      f.member,
      f.target("write"),
    ),
  ).toBeNull();
  expect(f.reads()).toBe(0);
  const auth: Pick<OysterHost["auth"], "resolve"> = {
    resolve: () =>
      Promise.resolve({ actor: { kind: "team-key", keyId: f.actor.memberId } }),
  };
  expect(
    await createStandaloneWorkflowNodeCapture({
      ...f,
      host: { ...f.host, auth },
    })(f.actor, f.member, f.target("write")),
  ).toBeNull();
});

it("refuses withdrawn App approvals instead of treating the declaration as a grant", async () => {
  const f = await fixture();
  await f.setGrants();
  expect(
    await createStandaloneWorkflowNodeCapture(f)(
      f.actor,
      f.member,
      f.target("write"),
    ),
  ).toBeNull();
});

it.each(["member", "approval"])(
  "refuses %s revocation while verifying Release bytes",
  async (race) => {
    const f = await fixture();
    f.onRead(race === "member" ? f.suspend : f.setGrants);
    expect(
      await createStandaloneWorkflowNodeCapture(f)(
        f.actor,
        f.member,
        f.target("write"),
      ),
    ).toBeNull();
  },
);

it("captures only currently approved operations even when the declared method can write", async () => {
  const f = await fixture();
  await f.setGrants("read-operations");
  expect(
    await createStandaloneWorkflowNodeCapture(f)(
      f.actor,
      f.member,
      f.target("write"),
    ),
  ).toEqual({
    level: "write",
    capabilities: ["computer.execute"],
    bindings: [{ name: "COMPUTER", operations: ["processes"] }],
  });
});

it("refuses a host/reader Computer mismatch instead of trusting a stale selected host", async () => {
  const f = await fixture();
  const capture = createStandaloneWorkflowNodeCapture({
    ...f,
    host: { ...f.host, computerId: "other-host-computer" },
  });
  expect(await capture(f.actor, f.member, f.target("write"))).toBeNull();
  expect(f.reads()).toBe(0);
});

it("captures installation Git scope from the live human and current verified approvals without provider access", async () => {
  const f = await fixture();
  const capture = createStandaloneWorkflowInstallationGitCapture(f);
  const repository = {
    kind: "installation",
    installationId: f.target("write").installationId,
    repository: "notes",
  } as const;
  await expect(capture(f.actor, f.member, repository, "read")).resolves.toBe(
    true,
  );
  await expect(capture(f.actor, f.member, repository, "write")).resolves.toBe(
    true,
  );
  await f.setGrants("read-operations");
  await expect(capture(f.actor, f.member, repository, "read")).resolves.toBe(
    true,
  );
  await expect(capture(f.actor, f.member, repository, "write")).resolves.toBe(
    false,
  );
  await f.setGrants();
  await expect(capture(f.actor, f.member, repository, "read")).resolves.toBe(
    false,
  );
});

it("refuses Git scope for another installation, unknown Team-source policy, stale membership, or another human", async () => {
  const f = await fixture();
  const capture = createStandaloneWorkflowInstallationGitCapture(f);
  const repository = {
    kind: "installation",
    installationId: f.target("write").installationId,
    repository: "notes",
  } as const;
  await expect(
    capture(
      f.actor,
      f.member,
      { ...repository, installationId: "other-app" },
      "write",
    ),
  ).resolves.toBe(false);
  await expect(
    capture(
      f.actor,
      f.member,
      { kind: "team-source", repository: "notes" },
      "write",
    ),
  ).resolves.toBe(false);
  await expect(
    capture(
      f.actor,
      { membershipVersion: f.member.membershipVersion + 1 },
      repository,
      "write",
    ),
  ).resolves.toBe(false);
  await expect(
    capture(
      { kind: "member", memberId: "fixture-owner" },
      f.member,
      repository,
      "write",
    ),
  ).resolves.toBe(false);
});

it.each(["grants", "membership"])(
  "refuses installation Git capture when %s change during verified Release reading",
  async (change) => {
    const f = await fixture();
    const capture = createStandaloneWorkflowInstallationGitCapture(f);
    f.onRead(async () => {
      if (change === "grants") await f.setGrants();
      else await f.suspend();
    });
    await expect(
      capture(
        f.actor,
        f.member,
        {
          kind: "installation",
          installationId: f.target("write").installationId,
          repository: "notes",
        },
        "write",
      ),
    ).resolves.toBe(false);
  },
);
