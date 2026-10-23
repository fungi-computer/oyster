import { parseReleaseId } from "@fungi.computer/puffball";
import { expect, it } from "vitest";
import * as Result from "effect/Result";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import {
  applyGrantCommand,
  applyInstallationCommand,
} from "../src/apps/installation.js";
import { declaration, descriptors, release } from "./apps-fixture.js";

it("member install grants nothing and owner install grants the declared ordinary capabilities", async () => {
  const declaredOperations = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  for (const role of ["owner", "member"]) {
    const result = applyGrantCommand(
      null,
      { kind: "install" },
      {
        principal: {
          actor: { kind: "member", memberId: "installer" },
          role: role === "owner" ? "owner" : "member",
        },
        expectedVersion: null,
        declaration,
        declaredOperations,
        now: 1000,
      },
    );
    if (Result.isFailure(result)) throw new Error(result.failure.code);
    expect(result.success.approvedGrants.length).toBe(role === "owner" ? 2 : 0);
    expect(result.success.authorityVersion).toBe(1);
  }
});

it("owner installs leave a third-party full-access shell unapproved", async () => {
  const shellDeclaration = Schema.decodeUnknownSync(appDeclarationSchema)({
    ...declaration,
    capabilities: [...declaration.capabilities, "team.workbenchHost"],
  });
  const snapshot = await deriveDeclaredOperations(
    release,
    shellDeclaration,
    descriptors,
  );
  const outcome = applyInstallationCommand(
    null,
    { kind: "install", release, releasePin: "pinned" },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: null,
      declaration: shellDeclaration,
      declaredOperations: snapshot,
      now: 1000,
      identity: { installationId: "third-party-shell", instanceId: null },
    },
  );
  if (Result.isFailure(outcome)) throw new Error(outcome.failure.code);
  expect(
    outcome.success.next.authority.approvedGrants.map(
      (grant) => grant.capability,
    ),
  ).toEqual(["computer.readFile", "computer.writeFile"]);
});

it("installing at the configured home identity does not grant shell consent", async () => {
  const shellDeclaration = Schema.decodeUnknownSync(appDeclarationSchema)({
    ...declaration,
    capabilities: [...declaration.capabilities, "team.workbenchHost"],
  });
  const snapshot = await deriveDeclaredOperations(
    release,
    shellDeclaration,
    descriptors,
  );
  const outcome = applyInstallationCommand(
    null,
    { kind: "install", release, releasePin: "pinned" },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: null,
      declaration: shellDeclaration,
      declaredOperations: snapshot,
      now: 1000,
      identity: { installationId: "tourtois", instanceId: null },
    },
  );
  if (Result.isFailure(outcome)) throw new Error(outcome.failure.code);
  expect(
    outcome.success.next.authority.approvedGrants.map(
      (grant) => grant.capability,
    ),
  ).not.toContain("team.workbenchHost");
});

it("derives approved operations from the real descriptors and registry and pins their digest", async () => {
  const snapshot = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const outcome = applyInstallationCommand(
    null,
    { kind: "install", release, releasePin: "pinned" },
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
  expect(outcome.success.next.authority.approvedGrants).toEqual([
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
  expect(outcome.success.next.authority.declaredOperationsDigest).toBe(
    snapshot.digest,
  );
  expect(outcome.success.next.authority.approval).toEqual({
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
    { kind: "install", release, releasePin: "pinned" },
    context,
  );
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  const installation =
    grants === "declared"
      ? result.success.next
      : next(
          applyInstallationCommand(
            result.success.next,
            {
              kind: "change-grants",
              changes: declaration.capabilities.map((capability) => ({
                capability,
                grant: null,
              })),
            },
            { ...context, expectedVersion: 1 },
          ),
        );
  return {
    installation,
    context: {
      ...context,
      expectedVersion: installation.authority.authorityVersion,
    },
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
  expect(updated.authority.approvedGrants).toEqual(
    installation.authority.approvedGrants,
  );
  expect(updated.authority.declaredOperationsDigest).toBe(snapshot.digest);
  expect(updated.authority.authorityVersion).toBe(2);
  expect(updated.authority.approval).toEqual(installation.authority.approval);
  expect(installation.authority.authorityVersion).toBe(1);
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
  expect(updated.authority.approvedGrants).toEqual([
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
  expect(deleted.authority.approvedGrants).toEqual([]);
  expect(deleted.authority.approval).toBeNull();
  expect(installation.authority.approvedGrants).toHaveLength(2);
});
it.each([false, true])(
  "only owners change grants, including revocation (%s)",
  async (approve) => {
    const { installation, context } = await installed();
    expect(
      applyInstallationCommand(
        installation,
        {
          kind: "change-grants",
          changes: context.declaredOperations.capabilities.map(
            ({ capability, operations }) => ({
              capability,
              grant: approve ? { operations, resources: "tenant-scope" } : null,
            }),
          ),
        },
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
      { kind: "install", release, releasePin: "pinned" },
      member,
    ),
  );
  expect(empty.authority.approvedGrants).toEqual([]);
  expect(empty.authority.approval).toBeNull();
  expect(
    next(
      applyInstallationCommand(
        empty,
        { kind: "set-status", status: "disabled" },
        { ...member, expectedVersion: 1 },
      ),
    ).authority.authorityVersion,
  ).toBe(2);
});
it("refuses non-declared operations and stale version writes", async () => {
  const { installation, context } = await installed();
  expect(
    applyInstallationCommand(
      installation,
      {
        kind: "change-grants",
        changes: [
          {
            capability: "computer.readFile",
            grant: {
              operations: ["binding:COMPUTER:exec"],
              resources: "tenant-scope",
            },
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
    { kind: "install", release, releasePin: "pinned" },
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
  expect(initial.success.next.authority.approvedGrants).toEqual([
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
      expectedVersion: initial.success.next.authority.authorityVersion,
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
  expect(upgraded.success.next.authority.approvedGrants).toEqual(
    initial.success.next.authority.approvedGrants,
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
  const installed = next(
    applyInstallationCommand(
      null,
      {
        kind: "install",
        release,
        releasePin: "pinned",
      },
      context,
    ),
  );
  expect(installed.authority.approvedGrants).toEqual([]);
  const current = next(
    applyInstallationCommand(
      installed,
      {
        kind: "change-grants",
        changes: [
          {
            capability: "workflow.publish",
            grant: {
              operations: ["route:app.methods:publishWorkflow"],
              resources: "tenant-scope",
            },
          },
        ],
      },
      { ...context, expectedVersion: installed.authority.authorityVersion },
    ),
  );
  expect(current.authority.approvedGrants).toEqual([
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
        expectedVersion: current.authority.authorityVersion,
        declaration: after,
        declaredOperations: await deriveDeclaredOperations(
          selectedRelease,
          after,
          [],
        ),
      },
    ),
  );
  expect(selected.authority.approvedGrants).toEqual(
    current.authority.approvedGrants,
  );
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
        expectedVersion: selected.authority.authorityVersion,
        declaration: removed,
        declaredOperations: await deriveDeclaredOperations(
          removedRelease,
          removed,
          [],
        ),
      },
    ),
  );
  expect(narrowed.authority.approvedGrants).toEqual([
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
