import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { appAuthoritySchema } from "../src/apps/installation.js";
import {
  draftOf,
  editPermissions,
  planGrantChange,
  rebaseDraft,
} from "../src/apps/permissions.js";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";
import { declaration, descriptors, release } from "./apps-fixture.js";

const baseline = appAuthoritySchema.parse({
  authorityVersion: 2,
  declaredOperationsDigest: release.artifact.artifactDigest,
  approvedGrants: [
    {
      capability: "computer.readFile",
      capabilityApproved: true,
      operations: ["binding:COMPUTER:read"],
      resources: [{ kind: "computer", id: "c1" }],
    },
    {
      capability: "computer.writeFile",
      capabilityApproved: true,
      operations: ["binding:COMPUTER:write"],
      resources: "tenant-scope",
    },
  ],
  approval: null,
});

it("no edit sends no changes, including narrowed saved operations", () => {
  expect(planGrantChange(baseline, draftOf(baseline))).toEqual([]);
});

it("editing another capability never echoes broader declared read operations", async () => {
  const declared = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  expect(
    declared.capabilities.find((row) => row.capability === "computer.readFile")
      ?.operations.length,
  ).toBeGreaterThan(1);
  const draft = editPermissions(
    draftOf(baseline),
    { kind: "switch", capability: "computer.writeFile", on: false },
    declared,
  );
  expect(planGrantChange(baseline, draft)).toEqual([
    { capability: "computer.writeFile", grant: null },
  ]);
  expect(draft.get("computer.readFile")).toEqual(
    draftOf(baseline).get("computer.readFile"),
  );
});

it("scope edits retain saved operations; removing the final resource revokes", async () => {
  const declared = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const draft = editPermissions(
    draftOf(baseline),
    {
      kind: "resource",
      capability: "computer.readFile",
      resource: { kind: "computer", id: "c2" },
      on: true,
    },
    declared,
  );
  expect(draft.get("computer.readFile")).toEqual({
    operations: ["binding:COMPUTER:read"],
    resources: [
      { kind: "computer", id: "c1" },
      { kind: "computer", id: "c2" },
    ],
  });
  const off = editPermissions(
    draftOf(baseline),
    {
      kind: "resource",
      capability: "computer.readFile",
      resource: { kind: "computer", id: "c1" },
      on: false,
    },
    declared,
  );
  expect(planGrantChange(baseline, off)).toEqual([
    { capability: "computer.readFile", grant: null },
  ]);
});

it("a wrong resource kind and undeclared capability cannot edit authority", async () => {
  const declared = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const draft = draftOf(baseline);
  expect(
    editPermissions(
      draft,
      {
        kind: "resource",
        capability: "computer.readFile",
        resource: { kind: "agent", id: "a1" },
        on: true,
      },
      declared,
    ),
  ).toBe(draft);
  expect(
    editPermissions(
      draft,
      { kind: "switch", capability: "computer.execute", on: true },
      declared,
    ),
  ).toBe(draft);
});

it("rebase keeps touched revocation and adopts concurrent untouched narrowing", async () => {
  const declared = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const draft = editPermissions(
    draftOf(baseline),
    { kind: "switch", capability: "computer.writeFile", on: false },
    declared,
  );
  const current = appAuthoritySchema.parse({
    ...baseline,
    authorityVersion: 3,
    approvedGrants: baseline.approvedGrants.map((grant) =>
      grant.capability === "computer.readFile"
        ? { ...grant, operations: [] }
        : grant,
    ),
  });
  const rebased = rebaseDraft(draft, baseline, current);
  expect(rebased.get("computer.readFile")?.operations).toEqual([]);
  expect(planGrantChange(current, rebased)).toEqual([
    { capability: "computer.writeFile", grant: null },
  ]);
});

it("turning on a new capability starts at its declared operations", async () => {
  const declared = await deriveDeclaredOperations(
    release,
    Schema.decodeUnknownSync(appDeclarationSchema)({
      ...declaration,
      capabilities: [...declaration.capabilities, "computer.execute"],
    }),
    descriptors,
  );
  const draft = editPermissions(
    draftOf(baseline),
    { kind: "switch", capability: "computer.execute", on: true },
    declared,
  );
  expect(draft.get("computer.execute")).toEqual({
    operations: declared.capabilities.find(
      (row) => row.capability === "computer.execute",
    )?.operations,
    resources: "tenant-scope",
  });
});

it("the screen shows per-permission scopes and keeps saved unavailable resources removable", async () => {
  const declaredOperations = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const { permissionScreen } = await import("../src/apps/permissions.js");
  const screen = permissionScreen({
    authority: baseline,
    declaredOperations,
    canEdit: true,
    resources: [{ kind: "computer", id: "c2", label: "Second Computer" }],
  });
  const computers = screen.groups.find((group) => group.id === "computers");
  expect(computers?.rows.map((row) => row.label)).toEqual([
    "All Computers",
    "Second Computer",
    "c1",
  ]);
  expect(
    computers?.rows.find(
      (row) => row.resource !== "all" && row.resource.id === "c2",
    )?.cells,
  ).toEqual([
    { capability: "computer.readFile", state: "off" },
    { capability: "computer.writeFile", state: "via-all" },
  ]);
  expect(
    computers?.rows.find(
      (row) => row.resource !== "all" && row.resource.id === "c1",
    )?.cells[0],
  ).toEqual({ capability: "computer.readFile", state: "on" });
});

it("a single Apps.call edit never enables other declared methods", async () => {
  const declared = await deriveDeclaredOperations(
    release,
    Schema.decodeUnknownSync(appDeclarationSchema)({
      ...declaration,
      capabilities: [...declaration.capabilities, "apps.call"],
      calls: [{ appId: "app_bonsai", methods: ["files.read", "files.save"] }],
    }),
    descriptors,
  );
  const draft = draftOf(baseline);
  const off = editPermissions(
    draft,
    {
      kind: "operation",
      capability: "apps.call",
      operation: "route:apps.call:app_bonsai:files.read",
      on: false,
    },
    declared,
  );
  expect(planGrantChange(baseline, off)).toEqual([]);
  const on = editPermissions(
    draft,
    {
      kind: "operation",
      capability: "apps.call",
      operation: "route:apps.call:app_bonsai:files.read",
      on: true,
    },
    declared,
  );
  expect(on.get("apps.call")?.operations).toEqual([
    "route:apps.call:app_bonsai:files.read",
  ]);
});
it("the grant reducer changes only named capabilities and preserves narrowed approvals", async () => {
  const { applyGrantCommand, grantCommandSchema } =
    await import("../src/apps/installation.js");
  const Result = await import("effect/Result");
  const declaredOperations = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const authority = {
    ...baseline,
    declaredOperationsDigest: declaredOperations.digest,
  };
  const result = applyGrantCommand(
    authority,
    grantCommandSchema.parse({
      kind: "change-grants",
      changes: [{ capability: "computer.writeFile", grant: null }],
    }),
    {
      principal: {
        actor: { kind: "member", memberId: "owner" },
        role: "owner",
      },
      expectedVersion: authority.authorityVersion,
      declaration,
      declaredOperations,
      now: 1000,
    },
  );
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  expect(result.success.approvedGrants).toEqual([authority.approvedGrants[0]]);
});

it("the grant reducer rejects a wrong resource kind instead of minting unusable authority", async () => {
  const { applyGrantCommand, grantCommandSchema } =
    await import("../src/apps/installation.js");
  const Result = await import("effect/Result");
  const declaredOperations = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const authority = {
    ...baseline,
    declaredOperationsDigest: declaredOperations.digest,
  };
  const result = applyGrantCommand(
    authority,
    grantCommandSchema.parse({
      kind: "change-grants",
      changes: [
        {
          capability: "computer.readFile",
          grant: { operations: [], resources: [{ kind: "agent", id: "a1" }] },
        },
      ],
    }),
    {
      principal: {
        actor: { kind: "member", memberId: "owner" },
        role: "owner",
      },
      expectedVersion: authority.authorityVersion,
      declaration,
      declaredOperations,
      now: 1000,
    },
  );
  expect(Result.isFailure(result) ? result.failure.code : null).toBe(
    "invalid_command",
  );
});

it("empty selected resources revoke, while empty operations retain capability consent", async () => {
  const { applyGrantCommand, grantCommandSchema } =
    await import("../src/apps/installation.js");
  const Result = await import("effect/Result");
  const declaredOperations = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const authority = {
    ...baseline,
    declaredOperationsDigest: declaredOperations.digest,
  };
  const result = applyGrantCommand(
    authority,
    grantCommandSchema.parse({
      kind: "change-grants",
      changes: [
        {
          capability: "computer.readFile",
          grant: { operations: [], resources: [] },
        },
        {
          capability: "computer.writeFile",
          grant: { operations: [], resources: "tenant-scope" },
        },
      ],
    }),
    {
      principal: {
        actor: { kind: "member", memberId: "owner" },
        role: "owner",
      },
      expectedVersion: authority.authorityVersion,
      declaration,
      declaredOperations,
      now: 1000,
    },
  );
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  expect(result.success.approvedGrants).toEqual([
    {
      capability: "computer.writeFile",
      capabilityApproved: true,
      operations: [],
      resources: "tenant-scope",
    },
  ]);
});
