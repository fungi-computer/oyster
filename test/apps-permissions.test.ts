import { expect, it } from "vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";
import {
  applyGrantCommand,
  appAuthoritySchema,
  grantCommandSchema,
} from "../src/apps/installation.js";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import {
  draftOf,
  editPermissions,
  planGrantChange,
  grantRequestFor,
  pendingCapabilities,
  permissionScreen,
} from "../src/apps/permissions.js";
import { declaration, descriptors, release } from "./apps-fixture.js";

it("window Allow scopes upgrade approval to its Computer; stale or member approvals refuse", async () => {
  const principal = {
    actor: { kind: "member" as const, memberId: "owner" },
    role: "owner" as const,
  };
  const declaredOperations = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const installed = applyGrantCommand(
    null,
    { kind: "install" },
    {
      principal,
      expectedVersion: null,
      declaration,
      declaredOperations,
      now: 1,
    },
  );
  if (Result.isFailure(installed)) throw new Error(installed.failure.code);
  const upgraded = Schema.decodeUnknownSync(appDeclarationSchema)({
    ...declaration,
    capabilities: [...declaration.capabilities, "computer.execute"],
    backend: {
      bindings: [{ name: "COMPUTER", operations: ["read", "write", "exec"] }],
    },
  });
  const snapshot = await deriveDeclaredOperations(
    release,
    upgraded,
    descriptors,
  );
  const context = {
    principal,
    expectedVersion: 1,
    declaration: upgraded,
    declaredOperations: snapshot,
    now: 2,
  };
  const selected = applyGrantCommand(
    installed.success,
    { kind: "select-release" },
    context,
  );
  if (Result.isFailure(selected)) throw new Error(selected.failure.code);
  expect(pendingCapabilities(selected.success, upgraded, snapshot)).toEqual([
    "computer.execute",
  ]);
  const request = grantRequestFor(
    selected.success,
    {
      declaration: upgraded,
      declaredOperations: snapshot,
    },
    { computers: ["computer.execute"] },
    { computerId: null },
  );
  expect(request).toEqual({
    kind: "refused",
    code: "window_scope_unavailable",
  });
  expect(pendingCapabilities(selected.success, upgraded, snapshot)).toEqual([
    "computer.execute",
  ]);
  // The host mount, not the App request, supplies the window's Computer.
  const windowRequest = grantRequestFor(
    selected.success,
    { declaration: upgraded, declaredOperations: snapshot },
    { computers: ["computer.execute"] },
    { computerId: "computer-a" },
  );
  expect(windowRequest).toMatchObject({
    kind: "ask",
    command: {
      kind: "change-grants",
      changes: [
        {
          capability: "computer.execute",
          grant: {
            operations: ["binding:COMPUTER:exec"],
            resources: [{ kind: "computer", id: "computer-a" }],
          },
        },
      ],
    },
  });
  if (windowRequest.kind !== "ask")
    throw new Error("Window approval not offered");
  const scoped = applyGrantCommand(selected.success, windowRequest.command, {
    ...context,
    expectedVersion: selected.success.authorityVersion,
  });
  if (Result.isFailure(scoped)) throw new Error(scoped.failure.code);
  expect(
    scoped.success.approvedGrants.find(
      (row) => row.capability === "computer.execute",
    ),
  ).toEqual({
    capability: "computer.execute",
    capabilityApproved: true,
    operations: ["binding:COMPUTER:exec"],
    resources: [{ kind: "computer", id: "computer-a" }],
  });
  const storedBeforeReplay = structuredClone(scoped.success);
  expect(
    grantRequestFor(
      scoped.success,
      { declaration: upgraded, declaredOperations: snapshot },
      { computers: ["computer.execute"] },
      { computerId: "computer-a" },
    ),
  ).toEqual({ kind: "covered" });
  expect(scoped.success).toEqual(storedBeforeReplay);
  // Missing host context, partial operation approval, or an unapproved
  // capability never turns a finite resource selection into authority.
  for (const computerId of ["computer-b", null]) {
    expect(
      grantRequestFor(
        scoped.success,
        { declaration: upgraded, declaredOperations: snapshot },
        { computers: ["computer.execute"] },
        { computerId },
      ),
    ).toEqual({ kind: "customize" });
  }
  expect(
    appAuthoritySchema.safeParse({
      ...scoped.success,
      approvedGrants: scoped.success.approvedGrants.map((row) =>
        row.capability === "computer.execute"
          ? { ...row, capabilityApproved: false }
          : row,
      ),
    }).success,
  ).toBe(false);
  for (const change of [{ operations: [] }]) {
    const incomplete = {
      ...scoped.success,
      approvedGrants: scoped.success.approvedGrants.map((row) =>
        row.capability === "computer.execute" ? { ...row, ...change } : row,
      ),
    };
    expect(
      grantRequestFor(
        incomplete,
        { declaration: upgraded, declaredOperations: snapshot },
        { computers: ["computer.execute"] },
        { computerId: "computer-a" },
      ),
    ).toEqual({ kind: "customize" });
  }
  // Another window cannot silently extend this already-selected policy.
  expect(
    grantRequestFor(
      scoped.success,
      { declaration: upgraded, declaredOperations: snapshot },
      { computers: ["computer.execute"] },
      { computerId: "computer-b" },
    ),
  ).toEqual({ kind: "customize" });
  // A separate, explicit Settings edit may still choose a broader scope.
  const command = grantCommandSchema.parse({
    kind: "change-grants",
    changes: planGrantChange(
      selected.success,
      editPermissions(
        draftOf(selected.success),
        { kind: "switch", capability: "computer.execute", on: true },
        snapshot,
      ),
    ),
  });
  expect(applyGrantCommand(selected.success, command, context)).toEqual(
    Result.fail({ kind: "refused", code: "stale_authority" }),
  );
  expect(
    applyGrantCommand(selected.success, command, {
      ...context,
      expectedVersion: 2,
      principal: { ...principal, role: "member" },
    }),
  ).toEqual(Result.fail({ kind: "refused", code: "not_owner" }));
  const approved = applyGrantCommand(selected.success, command, {
    ...context,
    expectedVersion: 2,
  });
  if (Result.isFailure(approved)) throw new Error(approved.failure.code);
  expect(pendingCapabilities(approved.success, upgraded, snapshot)).toEqual([]);
  expect(
    grantRequestFor(
      approved.success,
      {
        declaration: upgraded,
        declaredOperations: snapshot,
      },
      { computers: ["computer.execute"] },
      { computerId: null },
    ),
  ).toEqual({ kind: "covered" });
});

it("a member install lists every declared capability in Needs approval", async () => {
  const declaredOperations = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const result = applyGrantCommand(
    null,
    { kind: "install" },
    {
      principal: {
        actor: { kind: "member", memberId: "member" },
        role: "member",
      },
      expectedVersion: null,
      declaration,
      declaredOperations,
      now: 1000,
    },
  );
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  expect(
    pendingCapabilities(result.success, declaration, declaredOperations),
  ).toEqual(declaration.capabilities);
  const request = grantRequestFor(
    result.success,
    { declaration, declaredOperations },
    {
      computers: ["computer.readFile"],
    },
    { computerId: null },
  );
  expect(request).toEqual({
    kind: "refused",
    code: "window_scope_unavailable",
  });
  expect(result.success.approvedGrants).toEqual([]);
  expect(
    grantRequestFor(
      result.success,
      { declaration, declaredOperations },
      {
        computers: ["computer.execute"],
      },
      { computerId: null },
    ),
  ).toEqual({ kind: "refused", code: "not_declared" });
});

it("bulk owner installs leave third-party shell authority pending with its full-access warning", async () => {
  const shell = Schema.decodeUnknownSync(appDeclarationSchema)({
    ...declaration,
    capabilities: [...declaration.capabilities, "team.workbenchHost"],
  });
  const declaredOperations = await deriveDeclaredOperations(
    release,
    shell,
    descriptors,
  );
  for (let installation = 0; installation < 3; installation += 1) {
    const result = applyGrantCommand(
      null,
      { kind: "install" },
      {
        principal: {
          actor: { kind: "member", memberId: "owner" },
          role: "owner",
        },
        expectedVersion: null,
        declaration: shell,
        declaredOperations,
        now: 1000,
      },
    );
    if (Result.isFailure(result)) throw new Error(result.failure.code);
    const view = permissionScreen({
      authority: result.success,
      declaredOperations,
      resources: [],
      canEdit: true,
    });
    expect(
      view.groups
        .flatMap((group) => group.switches)
        .find((row) => row.capability === "team.workbenchHost"),
    ).toMatchObject({
      on: false,
      pending: true,
      label: "Shell",
      description: "Full access to your Team and every App",
      warning: "Only pick a shell you trust.",
    });
    expect(
      grantRequestFor(
        result.success,
        { declaration: shell, declaredOperations },
        {
          computers: ["computer.readFile"],
        },
        { computerId: null },
      ),
    ).toEqual({ kind: "covered" });
  }
});

it("owner install leaves explicit-consent capabilities pending without withholding ordinary file access", async () => {
  const requested = Schema.decodeUnknownSync(appDeclarationSchema)({
    ...declaration,
    capabilities: [
      ...declaration.capabilities,
      "approvals",
      "team.workbenchHost",
      "git.repository",
      "workflow.publish",
      "workflow.arm",
      "app.events.emit",
      "channels.read",
      "channels.personal.manage",
    ],
  });
  const declaredOperations = await deriveDeclaredOperations(
    release,
    requested,
    descriptors,
  );
  const installed = applyGrantCommand(
    null,
    { kind: "install" },
    {
      principal: {
        actor: { kind: "member", memberId: "owner" },
        role: "owner",
      },
      expectedVersion: null,
      declaration: requested,
      declaredOperations,
      now: 1000,
    },
  );
  if (Result.isFailure(installed)) throw new Error(installed.failure.code);
  expect(
    installed.success.approvedGrants.map((grant) => grant.capability),
  ).toEqual(declaration.capabilities);
  expect(
    pendingCapabilities(installed.success, requested, declaredOperations),
  ).toEqual([
    "approvals",
    "team.workbenchHost",
    "git.repository",
    "workflow.publish",
    "workflow.arm",
    "app.events.emit",
    "channels.read",
    "channels.personal.manage",
  ]);
});
