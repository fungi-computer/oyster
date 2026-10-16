import { parseReleaseId } from "@fungi.computer/puffball";
import { expect, it } from "vitest";
import * as Result from "effect/Result";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import { applyInstallationCommand } from "../src/apps/installation.js";
import { declaration, descriptors, release } from "./apps-fixture.js";

it("derives approved operations from the real descriptors and registry and pins their digest", async () => {
  const snapshot = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const outcome = applyInstallationCommand(
    null,
    { kind: "install", release, releasePin: "pinned", grants: "declared" },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: null,
      declaration,
      declaredOperations: snapshot,
      now: 1000,
      identity: { installationId: "notes", instanceId: null },
    },
  );
  expect(Result.isSuccess(outcome)).toBe(true);
  if (Result.isFailure(outcome)) throw new Error(outcome.failure.code);
  expect(outcome.success.next.approvedGrants).toEqual([
    {
      capability: "computer.readFile",
      capabilityApproved: true,
      operations: [
        "binding:COMPUTER:read",
        "route:app.methods:notes.read",
        "route:computer.readFile:open",
      ],
      resources: "tenant-scope",
    },
    {
      capability: "computer.writeFile",
      capabilityApproved: true,
      operations: [
        "binding:COMPUTER:write",
        "route:app.methods:notes.write",
        "route:computer.writeFile:mkdir",
        "route:computer.writeFile:open",
        "route:computer.writeFile:replace",
      ],
      resources: "tenant-scope",
    },
  ]);
  expect(outcome.success.next.declaredOperationsDigest).toBe(snapshot.digest);
  expect(outcome.success.next.approval).toEqual({
    by: { kind: "member", memberId: "owner" },
    at: 1000,
    authorityVersion: 1,
  });
});

import * as Schema from "effect/Schema";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";
import type {
  InstallationContext,
  Installation,
} from "../src/apps/installation.js";

async function installed(grants: "none" | "declared" = "declared") {
  const snapshot = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const context: InstallationContext = {
    by: { kind: "member", memberId: "owner" },
    role: "owner",
    expectedVersion: null,
    declaration,
    declaredOperations: snapshot,
    now: 1000,
    identity: { installationId: "notes", instanceId: null },
  };
  const result = applyInstallationCommand(
    null,
    { kind: "install", release, releasePin: "pinned", grants },
    context,
  );
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  return {
    installation: result.success.next,
    context: { ...context, expectedVersion: 1 },
  };
}
function next(
  result: ReturnType<typeof applyInstallationCommand>,
): Installation {
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  return result.success.next;
}
it("recomputes a stable digest from the Release and rejects a stale snapshot", async () => {
  const a = await deriveDeclaredOperations(release, declaration, descriptors);
  const b = await deriveDeclaredOperations(
    release,
    {
      ...declaration,
      capabilities: [...declaration.capabilities].reverse(),
      backend: {
        bindings: [{ name: "COMPUTER", operations: ["write", "read"] }],
      },
    },
    [...descriptors].reverse(),
  );
  expect(b).toEqual(a);
  const { installation, context } = await installed();
  const changed = await deriveDeclaredOperations(
    {
      ...release,
      artifact: {
        ...release.artifact,
        artifactDigest: context.declaredOperations.digest,
      },
    },
    declaration,
    descriptors,
  );
  expect(
    applyInstallationCommand(
      installation,
      { kind: "set-status", status: "disabled" },
      { ...context, declaredOperations: changed },
    ),
  ).toEqual(Result.fail({ kind: "refused", code: "stale_authority" }));
});
it("never adds a capability or an operation on an already-approved capability during upgrade", async () => {
  const { installation, context } = await installed();
  const upgraded = Schema.decodeUnknownSync(appDeclarationSchema)({
    ...declaration,
    capabilities: [...declaration.capabilities, "media.generation"],
    backend: {
      bindings: [
        ...(declaration.backend?.bindings ?? []),
        { name: "MEDIA", operations: ["generate"] },
      ],
    },
  });
  const snapshot = await deriveDeclaredOperations(
    release,
    upgraded,
    descriptors,
  );
  expect(
    snapshot.capabilities.find((row) => row.capability === "computer.writeFile")
      ?.operations,
  ).toContain("binding:MEDIA:generate");
  const updated = next(
    applyInstallationCommand(
      installation,
      { kind: "select-release", release, releasePin: "floating" },
      { ...context, declaration: upgraded, declaredOperations: snapshot },
    ),
  );
  expect(updated.approvedGrants).toEqual(installation.approvedGrants);
  expect(updated.declaredOperationsDigest).toBe(snapshot.digest);
  expect(updated.authorityVersion).toBe(2);
  expect(updated.approval).toEqual(installation.approval);
  expect(installation.authorityVersion).toBe(1);
});
it("drops removed operations and clears grants on deletion without changing the source record", async () => {
  const { installation, context } = await installed();
  const reduced = Schema.decodeUnknownSync(appDeclarationSchema)({
    handlers: [],
    roles: [],
    commands: [],
    gills: [],
    capabilities: ["computer.writeFile"],
    backend: { bindings: [{ name: "COMPUTER", operations: ["write"] }] },
  });
  const snapshot = await deriveDeclaredOperations(release, reduced, []);
  const updated = next(
    applyInstallationCommand(
      installation,
      { kind: "select-release", release, releasePin: "pinned" },
      { ...context, declaration: reduced, declaredOperations: snapshot },
    ),
  );
  expect(updated.approvedGrants).toEqual([
    {
      capability: "computer.writeFile",
      capabilityApproved: true,
      operations: ["binding:COMPUTER:write"],
      resources: "tenant-scope",
    },
  ]);
  const deleted = next(
    applyInstallationCommand(
      installation,
      { kind: "set-status", status: "deleted" },
      context,
    ),
  );
  expect(deleted.approvedGrants).toEqual([]);
  expect(deleted.approval).toBeNull();
  expect(installation.approvedGrants).toHaveLength(2);
});
it.each(["none", "declared"] as const)(
  "only owners change grants, including %s",
  async (grants) => {
    const { installation, context } = await installed();
    expect(
      applyInstallationCommand(
        installation,
        { kind: "set-grants", grants },
        { ...context, role: "member" },
      ),
    ).toEqual(Result.fail({ kind: "refused", code: "not_owner" }));
  },
);
it("lets members manage installations without granting operations", async () => {
  const { context } = await installed();
  const member = { ...context, role: "member" as const, expectedVersion: null };
  const empty = next(
    applyInstallationCommand(
      null,
      { kind: "install", release, releasePin: "pinned", grants: "none" },
      member,
    ),
  );
  expect(empty.approvedGrants).toEqual([]);
  expect(empty.approval).toBeNull();
  expect(
    next(
      applyInstallationCommand(
        empty,
        { kind: "set-status", status: "disabled" },
        { ...member, expectedVersion: 1 },
      ),
    ).authorityVersion,
  ).toBe(2);
  expect(
    applyInstallationCommand(
      null,
      { kind: "install", release, releasePin: "pinned", grants: "declared" },
      member,
    ),
  ).toEqual(Result.fail({ kind: "refused", code: "not_owner" }));
});
it("refuses non-declared operations and stale version writes", async () => {
  const { installation, context } = await installed();
  expect(
    applyInstallationCommand(
      installation,
      {
        kind: "set-grants",
        grants: [
          {
            capability: "computer.readFile",
            operations: ["binding:COMPUTER:exec"],
            resources: "tenant-scope",
          },
        ],
      },
      context,
    ),
  ).toEqual(Result.fail({ kind: "refused", code: "not_declared" }));
  expect(
    applyInstallationCommand(
      installation,
      { kind: "set-visibility", visibility: "public" },
      { ...context, expectedVersion: 0 },
    ),
  ).toEqual(Result.fail({ kind: "refused", code: "stale_authority" }));
});

it("an App-call approval names each target method and upgrades never add calls", async () => {
  const before = {
    ...declaration,
    capabilities: ["apps.call"] as const,
    backend: undefined,
    api: undefined,
    calls: [{ appId: "app_bonsai", methods: ["files.read"] }],
  };
  const after = {
    ...before,
    calls: [
      {
        appId: "app_bonsai",
        methods: ["files.read", "files.save", "changes.merge"],
      },
    ],
  };
  const initial = applyInstallationCommand(
    null,
    { kind: "install", release, releasePin: "pinned", grants: "declared" },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: null,
      declaration: before,
      declaredOperations: await deriveDeclaredOperations(release, before, []),
      now: 1000,
      identity: { installationId: "inkcap", instanceId: null },
    },
  );
  if (Result.isFailure(initial)) throw new Error(initial.failure.code);
  expect(initial.success.next.approvedGrants).toEqual([
    {
      capability: "apps.call",
      capabilityApproved: true,
      operations: ["route:apps.call:app_bonsai:files.read"],
      resources: "tenant-scope",
    },
  ]);
  const nextRelease = { ...release, releaseId: parseReleaseId("rel_new") };
  const upgraded = applyInstallationCommand(
    initial.success.next,
    { kind: "select-release", release: nextRelease, releasePin: "pinned" },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: initial.success.next.authorityVersion,
      declaration: after,
      declaredOperations: await deriveDeclaredOperations(
        nextRelease,
        after,
        [],
      ),
      now: 2000,
      identity: { installationId: "inkcap", instanceId: null },
    },
  );
  if (Result.isFailure(upgraded)) throw new Error(upgraded.failure.code);
  expect(upgraded.success.next.approvedGrants).toEqual(
    initial.success.next.approvedGrants,
  );
});

it("approves signed API requirements and intersects stored operation identities on release selection", async () => {
  const publish = {
    description: "Publish a Workflow",
    effect: "write",
    requires: ["workflow.publish"],
    input: { type: "object" },
    output: { type: "object" },
  };
  const before = Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities: ["workflow.publish"],
    handlers: [],
    roles: [],
    api: { methods: { publishWorkflow: publish } },
  });
  const context: InstallationContext = {
    by: { kind: "member", memberId: "owner" },
    role: "owner",
    expectedVersion: null,
    declaration: before,
    declaredOperations: await deriveDeclaredOperations(release, before, []),
    now: 1000,
    identity: { installationId: "trellis", instanceId: null },
  };
  const current = next(
    applyInstallationCommand(
      null,
      {
        kind: "install",
        release,
        releasePin: "pinned",
        grants: "declared",
      },
      context,
    ),
  );
  expect(current.approvedGrants).toEqual([
    {
      capability: "workflow.publish",
      capabilityApproved: true,
      operations: ["route:app.methods:publishWorkflow"],
      resources: "tenant-scope",
    },
  ]);
  const after = Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities: ["workflow.publish"],
    handlers: [],
    roles: [],
    api: { methods: { publishWorkflow: publish, publishAnother: publish } },
  });
  const selectedRelease = { ...release, releaseId: parseReleaseId("rel_next") };
  const selected = next(
    applyInstallationCommand(
      current,
      {
        kind: "select-release",
        release: selectedRelease,
        releasePin: "pinned",
      },
      {
        ...context,
        expectedVersion: current.authorityVersion,
        declaration: after,
        declaredOperations: await deriveDeclaredOperations(
          selectedRelease,
          after,
          [],
        ),
      },
    ),
  );
  expect(selected.approvedGrants).toEqual(current.approvedGrants);
  const removed = Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities: ["workflow.publish"],
    handlers: [],
    roles: [],
    api: { methods: { publishAnother: publish } },
  });
  const removedRelease = {
    ...release,
    releaseId: parseReleaseId("rel_removed"),
  };
  const narrowed = next(
    applyInstallationCommand(
      selected,
      {
        kind: "select-release",
        release: removedRelease,
        releasePin: "pinned",
      },
      {
        ...context,
        expectedVersion: selected.authorityVersion,
        declaration: removed,
        declaredOperations: await deriveDeclaredOperations(
          removedRelease,
          removed,
          [],
        ),
      },
    ),
  );
  expect(narrowed.approvedGrants).toEqual([
    {
      capability: "workflow.publish",
      capabilityApproved: true,
      operations: [],
      resources: "tenant-scope",
    },
  ]);
});

it("reserves the app.methods descriptor identity for signed API requirement operations", async () => {
  await expect(
    deriveDeclaredOperations(release, declaration, [
      {
        id: "app.methods",
        permission: "computer.readFile",
        methods: {
          "notes.read": { kind: "json", method: "POST", path: "read" },
        },
      },
    ]),
  ).rejects.toThrow("app_methods_descriptor_reserved");
});
