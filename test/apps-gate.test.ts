import { expect, it } from "vitest";
import * as Result from "effect/Result";
import type { AppDeclaration } from "@fungi.computer/puffball/app";
import { instanceIds } from "../src/index.js";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import {
  applyGrantCommand,
  applyInstallationCommand,
  type CapabilityOperationDescriptor,
} from "../src/apps/installation.js";
import {
  admits,
  admitMethodMetadata,
  appInvocationCeiling,
  scopedBindings,
  approvedBindingGrants,
  type GateFacts,
} from "../src/apps/gate.js";
import { declaration, descriptors, release } from "./apps-fixture.js";

it("admits with host-independent installation facts and no Release record", async () => {
  const current = await approvedFacts();
  const stored = current.installation;
  expect(
    admits(
      {
        ...current,
        installation: {
          status: stored.status,
          instanceId: stored.instanceId,
          authority: stored.authority,
          artifactDigest: release.artifact.artifactDigest,
        },
      },
      {
        kind: "capability",
        capability: "computer.readFile",
        resource: { kind: "computer", id: "c1" },
      },
    ).kind,
  ).toBe("admitted");
});

it("a Computer-scoped grant admits c1 and refuses c2", async () => {
  const current = await approvedFacts();
  const scoped: GateFacts = {
    ...current,
    installation: {
      ...current.installation,
      authority: {
        ...current.installation.authority,
        approvedGrants: current.installation.authority.approvedGrants.map(
          (grant) => ({
            ...grant,
            resources: [{ kind: "computer", id: "c1" }],
          }),
        ),
      },
    },
  };
  expect(
    admits(scoped, {
      kind: "capability",
      capability: "computer.readFile",
      resource: { kind: "computer", id: "c1" },
    }).kind,
  ).toBe("admitted");
  expect(
    admits(scoped, {
      kind: "capability",
      capability: "computer.readFile",
      resource: { kind: "computer", id: "c2" },
    }),
  ).toEqual({ kind: "refused", code: "not_approved" });
  expect(
    admits(scoped, {
      kind: "capability",
      capability: "computer.readFile",
      resource: "any",
    }).kind,
  ).toBe("admitted");
});

it("a tenant-scoped grant admits either Computer", async () => {
  const current = await approvedFacts();
  for (const id of ["c1", "c2"]) {
    expect(
      admits(current, {
        kind: "capability",
        capability: "computer.readFile",
        resource: { kind: "computer", id },
      }).kind,
    ).toBe("admitted");
  }
});

it("a method cannot use its required capability on an unapproved Computer", async () => {
  const current = await approvedFacts();
  const scoped: GateFacts = {
    ...current,
    installation: {
      ...current.installation,
      authority: {
        ...current.installation.authority,
        approvedGrants: current.installation.authority.approvedGrants.map(
          (grant) => ({
            ...grant,
            resources: [{ kind: "computer", id: "c1" }],
          }),
        ),
      },
    },
  };
  for (const id of ["c1", "c2"]) {
    expect(
      admits(scoped, {
        kind: "method",
        name: "notes.read",
        input: { path: "/note" },
        via: "ui",
        resource: { kind: "computer", id },
      }).kind,
    ).toBe(id === "c1" ? "admitted" : "refused");
  }
});

async function approvedFacts(
  nextDeclaration: AppDeclaration = declaration,
  operationDescriptors: readonly CapabilityOperationDescriptor[] = descriptors,
): Promise<GateFacts> {
  const declaredOperations = await deriveDeclaredOperations(
    release,
    nextDeclaration,
    operationDescriptors,
  );
  const result = applyInstallationCommand(
    null,
    { kind: "install", release, releasePin: "pinned" },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: null,
      declaration: nextDeclaration,
      declaredOperations,
      now: 1000,
      identity: {
        installationId: "notes",
        instanceId: instanceIds.instance.generate(),
      },
    },
  );
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  // Admission fixtures start after explicit owner consent, not merely installation.
  const approved = applyGrantCommand(
    result.success.next.authority,
    {
      kind: "change-grants",
      changes: declaredOperations.capabilities.map(
        ({ capability, operations }) => ({
          capability,
          grant: { operations, resources: "tenant-scope" },
        }),
      ),
    },
    {
      principal: {
        actor: { kind: "member", memberId: "owner" },
        role: "owner",
      },
      expectedVersion: result.success.next.authority.authorityVersion,
      declaration: nextDeclaration,
      declaredOperations,
      now: 1001,
    },
  );
  if (Result.isFailure(approved)) throw new Error(approved.failure.code);

  return {
    principal: { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    installation: {
      status: result.success.next.status,
      instanceId: result.success.next.instanceId,
      authority: approved.success,
      artifactDigest: release.artifact.artifactDigest,
    },
    declaration: nextDeclaration,
    declaredOperations,
    api: nextDeclaration.api ?? null,
    access: null,
  };
}
it("projects only approved declared binding operations for host freshness checks", async () => {
  const current = await approvedFacts();
  const installation = {
    ...current.installation,
    authority: {
      ...current.installation.authority,
      approvedGrants: current.installation.authority.approvedGrants.filter(
        (grant) => grant.capability === "computer.readFile",
      ),
    },
  };
  expect(approvedBindingGrants(installation, declaration)).toEqual([
    { binding: "COMPUTER", operations: ["read"] },
  ]);
  expect(
    approvedBindingGrants({ ...installation, status: "disabled" }, declaration),
  ).toEqual([]);
  expect(
    approvedBindingGrants(installation, { ...declaration, capabilities: [] }),
  ).toEqual([]);
  expect(
    approvedBindingGrants(
      {
        ...installation,
        authority: {
          ...installation.authority,
          approvedGrants: [],
        },
      },
      declaration,
    ),
  ).toEqual([]);
});

it("matches each Agent binding operation to its own finite resource approval", async () => {
  const declaration: AppDeclaration = {
    ...requirementDeclaration({}, ["agent.read", "agent.manage", "agent.send"]),
    backend: {
      bindings: [
        {
          name: "AGENTS",
          operations: ["schedules", "pauseSchedule", "deleteSchedule", "send"],
        },
      ],
    },
  };
  const current = await approvedFacts(declaration, []);
  const changed = applyGrantCommand(
    current.installation.authority,
    {
      kind: "change-grants",
      changes: current.installation.authority.approvedGrants.map((grant) => ({
        capability: grant.capability,
        grant: {
          operations: grant.operations,
          resources: [
            {
              kind: "agent",
              id: grant.capability === "agent.manage" ? "B" : "A",
            },
          ],
        },
      })),
    },
    {
      principal: current.principal,
      expectedVersion: current.installation.authority.authorityVersion,
      declaration,
      declaredOperations: current.declaredOperations,
      now: 2000,
    },
  );
  if (Result.isFailure(changed)) throw new Error(changed.failure.code);
  const installation = { ...current.installation, authority: changed.success };
  expect(approvedBindingGrants(installation, declaration)).toEqual([
    {
      binding: "AGENTS",
      operations: ["schedules", "pauseSchedule", "deleteSchedule", "send"],
    },
  ]);
  expect(
    approvedBindingGrants(installation, declaration, {
      kind: "agent",
      id: "A",
    }),
  ).toEqual([{ binding: "AGENTS", operations: ["schedules", "send"] }]);
  expect(
    approvedBindingGrants(installation, declaration, {
      kind: "agent",
      id: "B",
    }),
  ).toEqual([
    {
      binding: "AGENTS",
      operations: ["pauseSchedule", "deleteSchedule"],
    },
  ]);
  for (const resource of [
    { kind: "agent", id: "C" },
    { kind: "computer", id: "A" },
  ]) {
    expect(approvedBindingGrants(installation, declaration, resource)).toEqual(
      [],
    );
    expect(
      admits(
        { ...current, installation },
        {
          kind: "capability",
          capability: "agent.read",
          resource,
        },
      ),
    ).toEqual({ kind: "refused", code: "not_approved" });
  }
});

it("always refuses external methods before input or write-level admission", async () => {
  const current = await approvedFacts();
  expect(
    admits(
      {
        ...current,
        access: {
          level: "read",
          bindingName: "NOTES",
          revision: "1",
          grantedBy: "fixture-owner",
        },
      },
      { kind: "method", name: "notes.external", input: null, via: "mcp" },
    ),
  ).toEqual({ kind: "refused", code: "approval_required" });
});

import { grantsFor, invocationGrantsSchema } from "../src/apps/gate.js";

it.each([
  {
    code: "unavailable",
    change: (f: GateFacts) => ({
      ...f,
      installation: { ...f.installation, status: "disabled" as const },
    }),
    name: "notes.read",
    input: { path: "/note" },
  },
  {
    code: "stale_authority",
    change: (f: GateFacts) => ({
      ...f,
      pins: {
        authorityVersion: f.installation.authority.authorityVersion + 1,
        artifactDigest: f.installation.artifactDigest,
      },
    }),
    name: "notes.read",
    input: { path: "/note" },
  },
  {
    code: "not_declared",
    change: (f: GateFacts) => f,
    name: "notes.unknown",
    input: {},
  },
  {
    code: "level_too_low",
    change: (f: GateFacts) => ({
      ...f,
      access: {
        level: "read" as const,
        bindingName: "NOTES",
        revision: "1",
        grantedBy: "fixture-owner",
      },
    }),
    name: "notes.write",
    input: {},
  },
  {
    code: "invalid_input",
    change: (f: GateFacts) => f,
    name: "notes.read",
    input: { path: 123 },
  },
  {
    code: "requires_not_granted",
    change: (f: GateFacts) => ({
      ...f,
      installation: {
        ...f.installation,
        authority: {
          ...f.installation.authority,
          approvedGrants: [],
        },
      },
    }),
    name: "notes.read",
    input: { path: "/note" },
  },
  {
    code: "not_approved",
    change: (f: GateFacts) => ({
      ...f,
      principal: {
        actor: { kind: "agent" as const, agentId: "agent" },
        role: null,
      },
    }),
    name: "notes.read",
    input: { path: "/note" },
  },
])(
  "returns $code at the retained admission stage",
  async ({ code, change, name, input }) => {
    expect(
      admits(change(await approvedFacts()), {
        kind: "method",
        name,
        input,
        via: "agent",
      }),
    ).toEqual({ kind: "refused", code });
  },
);
it("admits a dotted read method with only its approved required read binding", async () => {
  const current = await approvedFacts();
  const result = admits(current, {
    kind: "method",
    name: "notes.read",
    input: { path: "/note" },
    via: "workflow",
  });
  expect(result).toEqual({
    kind: "admitted",
    grants: [{ binding: "COMPUTER", operations: ["read"] }],
    method: current.api?.methods["notes.read"],
  });
  if (result.kind === "refused") throw new Error(result.code);
  expect(invocationGrantsSchema.parse(result.grants)).toEqual(result.grants);
});
it("keeps route and backend approvals separate and preserves host resource selectors", async () => {
  const current = await approvedFacts();
  const installation = {
    ...current.installation,
    authority: {
      ...current.installation.authority,
      approvedGrants: [
        {
          capability: "computer.readFile" as const,
          capabilityApproved: true as const,
          operations: ["route:computer.readFile:open"],
          resources: [{ kind: "computer", id: "selected" }],
        },
      ],
    },
  };
  expect(
    grantsFor(
      installation,
      current.declaration,
      current.declaredOperations,
      "computer.readFile",
    )?.resources,
  ).toEqual([{ kind: "computer", id: "selected" }]);
  expect(
    admits(
      { ...current, installation },
      {
        kind: "capability-route",
        capability: "computer.readFile",
        operation: "route:computer.readFile:open",
        effect: "read",
      },
    ),
  ).toEqual({ kind: "admitted", grants: [] });
  expect(
    admits(
      { ...current, installation },
      { kind: "binding", binding: "COMPUTER", operation: "read" },
    ),
  ).toEqual({ kind: "refused", code: "not_approved" });
  expect(
    admits(current, {
      kind: "binding",
      binding: "COMPUTER",
      operation: "exec",
    }),
  ).toEqual({ kind: "refused", code: "not_declared" });
  expect(
    admits(
      { ...current, installation },
      {
        kind: "capability-route",
        capability: "computer.writeFile",
        operation: "route:computer.writeFile:open",
        effect: "write",
      },
    ),
  ).toEqual({ kind: "refused", code: "not_approved" });
});
it("maps unsupported declared input schemas to a typed refusal without compiler diagnostics", async () => {
  const current = await approvedFacts();
  const method = current.api?.methods["notes.read"];
  if (method === undefined) throw new Error("Fixture method missing");
  expect(
    admits(
      {
        ...current,
        api: {
          methods: {
            "notes.read": { ...method, input: { $ref: "#/missing" } },
          },
        },
      },
      {
        kind: "method",
        name: "notes.read",
        input: { path: "/note" },
        via: "ui",
      },
    ),
  ).toEqual({ kind: "refused", code: "invalid_input" });
});
it("retains the Hub's 64 KiB method-input bound", async () => {
  expect(
    admits(await approvedFacts(), {
      kind: "method",
      name: "notes.read",
      input: { path: "x".repeat(65536) },
      via: "agent",
    }),
  ).toEqual({ kind: "refused", code: "invalid_input" });
});

it("refuses EVENTS.emit when the App declares its binding without the required capability", async () => {
  const current = await approvedFacts({
    ...declaration,
    backend: { bindings: [{ name: "EVENTS", operations: ["emit"] }] },
  });
  expect(
    admits(current, {
      kind: "binding",
      binding: "EVENTS",
      operation: "emit",
    }).kind,
  ).toBe("refused");
  expect(
    approvedBindingGrants(current.installation, current.declaration),
  ).toEqual([]);
});

const emittingDeclaration: AppDeclaration = {
  ...declaration,
  capabilities: [...declaration.capabilities, "app.events.emit"],
  backend: { bindings: [{ name: "EVENTS", operations: ["emit"] }] },
  api: {
    methods: {
      emit: {
        description: "Emit an event",
        effect: "write",
        requires: ["app.events.emit"],
        input: { type: "object" },
        output: { type: "object" },
      },
      inspect: {
        description: "Read event state",
        effect: "read",
        requires: ["app.events.emit"],
        input: { type: "object" },
        output: { type: "object" },
      },
    },
  },
};

it("requires explicit approval of the canonical event capability before emitting", async () => {
  const current = await approvedFacts(emittingDeclaration);
  const granted = current.installation.authority.approvedGrants.find(
    (grant) => grant.capability === "app.events.emit",
  );
  expect(granted).toEqual({
    capability: "app.events.emit",
    capabilityApproved: true,
    operations: [
      "binding:EVENTS:emit",
      "route:app.methods:emit",
      "route:app.methods:inspect",
    ],
    resources: "tenant-scope",
  });
  expect(
    admits(current, { kind: "binding", binding: "EVENTS", operation: "emit" }),
  ).toEqual({
    kind: "admitted",
    grants: [{ binding: "EVENTS", operations: ["emit"] }],
  });
  const revoked = {
    ...current,
    installation: {
      ...current.installation,
      authority: {
        ...current.installation.authority,
        approvedGrants: current.installation.authority.approvedGrants.filter(
          (grant) => grant.capability !== "app.events.emit",
        ),
      },
    },
  };
  expect(
    admits(revoked, { kind: "binding", binding: "EVENTS", operation: "emit" }),
  ).toEqual({ kind: "refused", code: "not_approved" });
  expect(
    approvedBindingGrants(revoked.installation, emittingDeclaration),
  ).toEqual([]);
});

it("projects event emission only to an approved write method at write level", async () => {
  const current = await approvedFacts(emittingDeclaration);
  expect(
    admits(current, { kind: "method", name: "emit", input: {}, via: "ui" }),
  ).toMatchObject({
    kind: "admitted",
    grants: [{ binding: "EVENTS", operations: ["emit"] }],
  });
  expect(
    admits(current, { kind: "method", name: "inspect", input: {}, via: "ui" }),
  ).toMatchObject({ kind: "admitted", grants: [] });
  expect(
    admits(
      {
        ...current,
        access: {
          bindingName: "NOTES",
          level: "read",
          revision: "read-policy",
          grantedBy: "fixture-owner",
        },
      },
      { kind: "method", name: "emit", input: {}, via: "mcp" },
    ),
  ).toMatchObject({ kind: "refused", code: "level_too_low" });
});

import * as Schema from "effect/Schema";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";

const requirementMethod = (requires: AppDeclaration["capabilities"]) => ({
  description: "Publish a Workflow",
  effect: "write" as const,
  requires,
  input: { type: "object" },
  output: { type: "object" },
});
const requirementDeclaration = (
  methods: NonNullable<AppDeclaration["api"]>["methods"],
  capabilities: AppDeclaration["capabilities"] = ["workflow.publish"],
): AppDeclaration =>
  Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities,
    handlers: [],
    roles: [],
    api: { methods },
  });
async function selectRequirements(
  current: GateFacts,
  nextDeclaration: AppDeclaration,
): Promise<GateFacts> {
  const snapshot = await deriveDeclaredOperations(
    release,
    nextDeclaration,
    descriptors,
  );
  const result = applyGrantCommand(
    current.installation.authority,
    { kind: "select-release" },
    {
      principal: current.principal,
      expectedVersion: current.installation.authority.authorityVersion,
      declaration: nextDeclaration,
      declaredOperations: snapshot,
      now: 2000,
    },
  );
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  return {
    ...current,
    installation: { ...current.installation, authority: result.success },
    declaration: nextDeclaration,
    api: nextDeclaration.api ?? null,
    declaredOperations: snapshot,
  };
}

it("admits an added method under existing capability consent but refuses a new capability", async () => {
  const publish = requirementMethod(["workflow.publish"]);
  const current = await approvedFacts(
    requirementDeclaration({ publishWorkflow: publish }),
  );
  const upgraded = await selectRequirements(
    current,
    requirementDeclaration(
      {
        publishWorkflow: publish,
        publishAnother: publish,
        runWorkflow: requirementMethod(["workflow.run"]),
      },
      ["workflow.publish", "workflow.run"],
    ),
  );
  expect(upgraded.installation.authority.approvedGrants).toEqual(
    current.installation.authority.approvedGrants,
  );
  expect(
    admits(upgraded, {
      kind: "method",
      name: "publishAnother",
      input: {},
      via: "ui",
    }).kind,
  ).toBe("admitted");
  expect(
    admits(upgraded, {
      kind: "method",
      name: "runWorkflow",
      input: {},
      via: "ui",
    }),
  ).toEqual({ kind: "refused", code: "requires_not_granted" });
  const approval = applyGrantCommand(
    upgraded.installation.authority,
    {
      kind: "change-grants",
      changes: upgraded.declaredOperations.capabilities.map(
        ({ capability, operations }) => ({
          capability,
          grant: { operations, resources: "tenant-scope" },
        }),
      ),
    },
    {
      principal: upgraded.principal,
      expectedVersion: upgraded.installation.authority.authorityVersion,
      declaration: upgraded.declaration,
      declaredOperations: upgraded.declaredOperations,
      now: 3000,
    },
  );
  if (Result.isFailure(approval)) throw new Error(approval.failure.code);
  const approved = {
    ...upgraded,
    installation: { ...upgraded.installation, authority: approval.success },
  };
  expect(
    admits(approved, {
      kind: "method",
      name: "runWorkflow",
      input: {},
      via: "ui",
    }).kind,
  ).toBe("admitted");
});

it("keeps capability consent through replacing its only method without widening stored operations", async () => {
  const publish = requirementMethod(["workflow.publish"]);
  const current = await approvedFacts(
    requirementDeclaration({ publishWorkflow: publish }),
  );
  const renamed = await selectRequirements(
    current,
    requirementDeclaration({ publishAnother: publish }),
  );
  expect(renamed.installation.authority.approvedGrants).toEqual([
    {
      capability: "workflow.publish",
      capabilityApproved: true,
      operations: [],
      resources: "tenant-scope",
    },
  ]);
  expect(
    grantsFor(
      renamed.installation,
      renamed.declaration,
      renamed.declaredOperations,
      "workflow.publish",
    ),
  ).not.toBeNull();
  expect(admitMethodMetadata(renamed, "publishAnother").kind).toBe("admitted");
  expect(
    admits(renamed, {
      kind: "method",
      name: "publishAnother",
      input: {},
      via: "ui",
    }).kind,
  ).toBe("admitted");
  const removed = await selectRequirements(
    renamed,
    requirementDeclaration({}, []),
  );
  const restored = await selectRequirements(removed, renamed.declaration);
  expect(restored.installation.authority.approvedGrants).toEqual([]);
  expect(
    admits(restored, {
      kind: "method",
      name: "publishAnother",
      input: {},
      via: "ui",
    }),
  ).toEqual({ kind: "refused", code: "requires_not_granted" });
});

it("stores one capability approval for two signed methods requiring that capability", async () => {
  const publish = requirementMethod(["workflow.publish"]);
  const current = await approvedFacts(
    requirementDeclaration({
      publishWorkflow: publish,
      publishAnother: publish,
    }),
  );
  expect(current.installation.authority.approvedGrants).toEqual([
    {
      capability: "workflow.publish",
      capabilityApproved: true,
      operations: [
        "route:app.methods:publishAnother",
        "route:app.methods:publishWorkflow",
      ],
      resources: "tenant-scope",
    },
  ]);
});

it("refuses a method requiring two capabilities when only one has consent", async () => {
  const current = await approvedFacts(
    requirementDeclaration({
      publishWorkflow: requirementMethod(["workflow.publish"]),
    }),
  );
  const upgraded = await selectRequirements(
    current,
    requirementDeclaration(
      {
        publishWorkflow: requirementMethod(["workflow.publish"]),
        publishAndRun: requirementMethod(["workflow.publish", "workflow.run"]),
      },
      ["workflow.publish", "workflow.run"],
    ),
  );
  expect(
    admits(upgraded, {
      kind: "method",
      name: "publishAndRun",
      input: {},
      via: "ui",
    }),
  ).toEqual({ kind: "refused", code: "requires_not_granted" });
});

it("refuses an old operation digest and reselects the release without adding method operations", async () => {
  const current = await approvedFacts();
  const oldDeclaration = Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities: declaration.capabilities,
    handlers: [],
    roles: [],
    backend: declaration.backend,
  });
  const oldSnapshot = await deriveDeclaredOperations(
    release,
    oldDeclaration,
    descriptors,
  );
  const old = {
    ...current,
    installation: {
      ...current.installation,
      authority: {
        ...current.installation.authority,
        declaredOperationsDigest: oldSnapshot.digest,
        approvedGrants: current.installation.authority.approvedGrants.map(
          (grant) => ({
            ...grant,
            operations: grant.operations.filter(
              (operation) => !operation.startsWith("route:app.methods:"),
            ),
          }),
        ),
      },
    },
  };
  expect(
    grantsFor(
      old.installation,
      declaration,
      current.declaredOperations,
      "computer.readFile",
    ),
  ).toBeNull();
  expect(
    admits(old, {
      kind: "method",
      name: "notes.read",
      input: { path: "/note" },
      via: "ui",
    }),
  ).toEqual({ kind: "refused", code: "stale_authority" });
  const selected = await selectRequirements(old, declaration);
  expect(selected.installation.authority.approvedGrants).toEqual(
    old.installation.authority.approvedGrants,
  );
  expect(
    admits(selected, {
      kind: "method",
      name: "notes.read",
      input: { path: "/note" },
      via: "ui",
    }).kind,
  ).toBe("admitted");
});

it("method approval rows grant neither backend bindings nor capability routes", async () => {
  const current = await approvedFacts(
    requirementDeclaration(
      { readNote: requirementMethod(["computer.readFile"]) },
      ["computer.readFile"],
    ),
    [],
  );
  const selected = await selectRequirements(
    current,
    Schema.decodeUnknownSync(appDeclarationSchema)({
      ...current.declaration,
      backend: { bindings: [{ name: "COMPUTER", operations: ["read"] }] },
    }),
  );
  expect(
    approvedBindingGrants(selected.installation, selected.declaration),
  ).toEqual([]);
  expect(
    admits(selected, {
      kind: "binding",
      binding: "COMPUTER",
      operation: "read",
    }),
  ).toEqual({ kind: "refused", code: "not_approved" });
  expect(
    admits(selected, {
      kind: "capability-route",
      capability: "computer.readFile",
      operation: "route:computer.readFile:open",
      effect: "read",
    }),
  ).toEqual({ kind: "refused", code: "not_approved" });
});

it("admits method metadata without fabricating mapped input and preserves dispatch input priority", async () => {
  const current = await approvedFacts();
  expect(admitMethodMetadata(current, "notes.read")).toEqual({
    kind: "admitted",
    method: current.api?.methods["notes.read"],
  });
  expect(
    admits(current, {
      kind: "method",
      name: "notes.read",
      input: {},
      via: "workflow",
    }),
  ).toEqual({ kind: "refused", code: "invalid_input" });
  const unapproved = {
    ...current,
    installation: {
      ...current.installation,
      authority: {
        ...current.installation.authority,
        approvedGrants: [],
      },
    },
  };
  expect(admitMethodMetadata(unapproved, "notes.read")).toEqual({
    kind: "refused",
    code: "requires_not_granted",
  });
  expect(
    admits(unapproved, {
      kind: "method",
      name: "notes.read",
      input: {},
      via: "workflow",
    }),
  ).toEqual({ kind: "refused", code: "invalid_input" });
});

it("metadata admission preserves live Release, principal, effect and capability refusal ordering", async () => {
  const current = await approvedFacts();
  expect(
    admitMethodMetadata(
      {
        ...current,
        installation: { ...current.installation, status: "disabled" },
      },
      "notes.read",
    ),
  ).toEqual({ kind: "refused", code: "unavailable" });
  expect(
    admitMethodMetadata(
      {
        ...current,
        pins: {
          authorityVersion: current.installation.authority.authorityVersion + 1,
          artifactDigest: current.installation.artifactDigest,
        },
      },
      "notes.read",
    ),
  ).toEqual({ kind: "refused", code: "stale_authority" });
  expect(
    admitMethodMetadata(
      {
        ...current,
        principal: {
          actor: { kind: "agent", agentId: "agent_one" },
          role: null,
        },
        access: null,
      },
      "notes.read",
    ),
  ).toEqual({ kind: "refused", code: "not_approved" });
  expect(admitMethodMetadata(current, "notes.unknown")).toEqual({
    kind: "refused",
    code: "not_declared",
  });
  const unapproved = {
    ...current,
    installation: {
      ...current.installation,
      authority: {
        ...current.installation.authority,
        approvedGrants: [],
      },
    },
  };
  expect(admitMethodMetadata(unapproved, "notes.external")).toEqual({
    kind: "refused",
    code: "approval_required",
  });
  expect(
    admitMethodMetadata(
      {
        ...unapproved,
        access: {
          level: "read",
          bindingName: "NOTES",
          revision: "one",
          grantedBy: "fixture-owner",
        },
      },
      "notes.write",
    ),
  ).toEqual({ kind: "refused", code: "level_too_low" });
});

it("capture uses the same principal ceiling as ordinary invocation", async () => {
  const current = await approvedFacts();
  const captured = approvedBindingGrants(
    current.installation,
    current.declaration,
  );
  const readLevel: GateFacts = {
    ...current,
    access: {
      level: "read",
      bindingName: "NOTES",
      revision: "one",
      grantedBy: "fixture-owner",
    },
  };
  const writeMethod = current.api?.methods["notes.write"];
  if (writeMethod === undefined) throw new Error("Fixture method missing");
  expect(appInvocationCeiling(current)).toBe("write");
  for (const restricted of [readLevel]) {
    expect(appInvocationCeiling(restricted)).toBe("read");
    expect(
      scopedBindings(captured, writeMethod, appInvocationCeiling(restricted)),
    ).toEqual([]);
    const metadata = admitMethodMetadata(restricted, "notes.read");
    const dispatch = admits(restricted, {
      kind: "method",
      name: "notes.read",
      input: { path: "/note" },
      via: "workflow",
    });
    if (metadata.kind !== "admitted" || dispatch.kind !== "admitted")
      throw new Error("Read method unexpectedly refused");
    expect(
      scopedBindings(
        captured,
        metadata.method,
        appInvocationCeiling(restricted),
      ),
    ).toEqual(dispatch.grants);
  }
});

import { installationSchema } from "../src/apps/installation.js";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";

it("rejects a false stored capability marker before metadata admission", async () => {
  const current = await approvedFacts();
  const stored = installationSchema.safeParse({
    ...current.installation,
    authority: {
      ...current.installation.authority,
      approvedGrants: current.installation.authority.approvedGrants.map(
        (grant) => ({
          ...grant,
          capabilityApproved: false,
        }),
      ),
    },
  });
  expect(stored.success).toBe(false);
});

it("metadata does not prove an input schema can compile for execution", async () => {
  const current = await approvedFacts();
  const method = current.api?.methods["notes.read"];
  if (method === undefined) throw new Error("Fixture method missing");
  const unsupported = {
    ...current,
    api: {
      methods: { "notes.read": { ...method, input: { $ref: "#/missing" } } },
    },
  };
  expect(admitMethodMetadata(unsupported, "notes.read").kind).toBe("admitted");
  expect(
    admits(unsupported, {
      kind: "method",
      name: "notes.read",
      input: { path: "/note" },
      via: "workflow",
    }),
  ).toEqual({ kind: "refused", code: "invalid_input" });
});

it("metadata and dispatch preserve refusal parity for every valid-input policy fixture", async () => {
  const current = await approvedFacts();
  const otherDigest = Schema.decodeUnknownSync(sha256DigestSchema)(
    `sha256:${"f".repeat(64)}`,
  );
  const cases: readonly {
    label: string;
    name: string;
    input: unknown;
    expected: string;
    change: (value: GateFacts) => GateFacts;
  }[] = [
    {
      label: "approved",
      name: "notes.read",
      input: { path: "/note" },
      expected: "admitted",
      change: (value) => value,
    },
    {
      label: "disabled",
      name: "notes.read",
      input: { path: "/note" },
      expected: "unavailable",
      change: (value) => ({
        ...value,
        installation: { ...value.installation, status: "disabled" },
      }),
    },
    {
      label: "no instance",
      name: "notes.read",
      input: { path: "/note" },
      expected: "unavailable",
      change: (value) => ({
        ...value,
        installation: { ...value.installation, instanceId: null },
      }),
    },
    {
      label: "snapshot digest",
      name: "notes.read",
      input: { path: "/note" },
      expected: "stale_authority",
      change: (value) => ({
        ...value,
        declaredOperations: {
          ...value.declaredOperations,
          digest: otherDigest,
        },
      }),
    },
    {
      label: "artifact digest",
      name: "notes.read",
      input: { path: "/note" },
      expected: "stale_authority",
      change: (value) => ({
        ...value,
        declaredOperations: {
          ...value.declaredOperations,
          artifactDigest: otherDigest,
        },
      }),
    },
    {
      label: "authority version",
      name: "notes.read",
      input: { path: "/note" },
      expected: "stale_authority",
      change: (value) => ({
        ...value,
        pins: {
          authorityVersion: value.installation.authority.authorityVersion + 1,
          artifactDigest: value.installation.artifactDigest,
        },
      }),
    },
    {
      label: "Agent policy",
      name: "notes.read",
      input: { path: "/note" },
      expected: "not_approved",
      change: (value) => ({
        ...value,
        principal: {
          actor: { kind: "agent", agentId: "agent_one" },
          role: null,
        },
        access: null,
      }),
    },
    {
      label: "missing capability",
      name: "notes.read",
      input: { path: "/note" },
      expected: "requires_not_granted",
      change: (value) => ({
        ...value,
        installation: {
          ...value.installation,
          authority: {
            ...value.installation.authority,
            approvedGrants: [],
          },
        },
      }),
    },
    {
      label: "read level",
      name: "notes.write",
      input: {},
      expected: "level_too_low",
      change: (value) => ({
        ...value,
        access: {
          level: "read",
          bindingName: "NOTES",
          revision: "one",
          grantedBy: "fixture-owner",
        },
      }),
    },
    {
      label: "external",
      name: "notes.external",
      input: {},
      expected: "approval_required",
      change: (value) => value,
    },
    {
      label: "unknown",
      name: "notes.unknown",
      input: {},
      expected: "not_declared",
      change: (value) => value,
    },
    {
      label: "prototype",
      name: "__proto__",
      input: {},
      expected: "not_declared",
      change: (value) => value,
    },
    {
      label: "constructor",
      name: "constructor",
      input: {},
      expected: "not_declared",
      change: (value) => value,
    },
  ];
  for (const scenario of cases) {
    const selected = scenario.change(current);
    const metadata = admitMethodMetadata(selected, scenario.name);
    const dispatch = admits(selected, {
      kind: "method",
      name: scenario.name,
      input: scenario.input,
      via: "workflow",
    });
    expect(
      metadata.kind === "refused" ? metadata.code : metadata.kind,
      scenario.label,
    ).toBe(scenario.expected);
    expect(
      dispatch.kind === "refused" ? dispatch.code : dispatch.kind,
      scenario.label,
    ).toBe(scenario.expected);
  }
});

it("an apps.open affordance cannot satisfy a method without stored owner approval", async () => {
  const current = await approvedFacts(
    requirementDeclaration(
      {
        open: requirementMethod(["apps.open"]),
      },
      ["apps.open"],
    ),
  );
  const unapproved: GateFacts = {
    ...current,
    installation: {
      ...current.installation,
      authority: {
        ...current.installation.authority,
        approvedGrants: [],
        approval: null,
      },
    },
  };
  expect(
    admits(unapproved, { kind: "method", name: "open", input: {}, via: "ui" }),
  ).toEqual({ kind: "refused", code: "requires_not_granted" });
  expect(
    grantsFor(
      unapproved.installation,
      current.declaration,
      current.declaredOperations,
      "apps.open",
    ),
  ).toBeNull();
  expect(
    admits(current, { kind: "method", name: "open", input: {}, via: "ui" })
      .kind,
  ).toBe("admitted");
  const revoked = applyGrantCommand(
    current.installation.authority,
    {
      kind: "change-grants",
      changes: [{ capability: "apps.open", grant: null }],
    },
    {
      principal: current.principal,
      expectedVersion: current.installation.authority.authorityVersion,
      declaration: current.declaration,
      declaredOperations: current.declaredOperations,
      now: 2001,
    },
  );
  if (Result.isFailure(revoked)) throw new Error(revoked.failure.code);
  expect(
    admits(
      {
        ...current,
        installation: { ...current.installation, authority: revoked.success },
      },
      {
        kind: "method",
        name: "open",
        input: {},
        via: "ui",
      },
    ),
  ).toEqual({ kind: "refused", code: "requires_not_granted" });
});

it("an apps.open affordance preserves stored operation and resource ceilings", async () => {
  const current = await approvedFacts(
    requirementDeclaration(
      {
        open: requirementMethod(["apps.open"]),
        other: requirementMethod(["apps.open"]),
      },
      ["apps.open"],
    ),
  );
  const approved = {
    capability: "apps.open",
    capabilityApproved: true,
    operations: ["route:app.methods:open"],
    resources: [{ kind: "computer", id: "c1" }],
  } satisfies NonNullable<ReturnType<typeof grantsFor>>;
  const installation = {
    ...current.installation,
    authority: {
      ...current.installation.authority,
      approvedGrants: [approved],
    },
  };
  expect(
    grantsFor(
      installation,
      current.declaration,
      current.declaredOperations,
      "apps.open",
      { kind: "computer", id: "c1" },
    ),
  ).toEqual(approved);
  expect(
    grantsFor(
      installation,
      current.declaration,
      current.declaredOperations,
      "apps.open",
      "any",
    ),
  ).toEqual(approved);
  expect(
    grantsFor(
      installation,
      current.declaration,
      current.declaredOperations,
      "apps.open",
      { kind: "computer", id: "c2" },
    ),
  ).toBeNull();
});

it("a read-level App key cannot invoke a write capability route", async () => {
  const current = await approvedFacts();
  const reader: GateFacts = {
    ...current,
    principal: { actor: { kind: "team-key", keyId: "reader" }, role: null },
    access: {
      bindingName: "NOTES",
      level: "read",
      revision: "key:reader:1",
      grantedBy: "owner",
    },
  };
  const route = {
    kind: "capability-route",
    capability: "computer.readFile",
    operation: "route:computer.readFile:open",
  } as const;
  expect(admits(reader, { ...route, effect: "read" })).toEqual({
    kind: "admitted",
    grants: [],
  });
  expect(admits(reader, { ...route, effect: "write" })).toEqual({
    kind: "refused",
    code: "level_too_low",
  });
});

it("approvals routes require their own current installation consent", async () => {
  const request = {
    kind: "capability-route",
    capability: "approvals",
    operation: "route:approvals:list",
    effect: "write",
  } as const;
  expect(admits(await approvedFacts(), request)).toEqual({
    kind: "refused",
    code: "not_declared",
  });
  const current = await approvedFacts(
    {
      ...declaration,
      capabilities: [...declaration.capabilities, "approvals"],
    },
    [
      ...descriptors,
      {
        id: "approvals",
        permission: "approvals",
        methods: { list: { kind: "json", method: "POST", path: "/list" } },
      },
    ],
  );
  expect(admits(current, request).kind).toBe("admitted");
  const revoked = applyGrantCommand(
    current.installation.authority,
    {
      kind: "change-grants",
      changes: [{ capability: "approvals", grant: null }],
    },
    {
      principal: current.principal,
      expectedVersion: current.installation.authority.authorityVersion,
      declaration: current.declaration,
      declaredOperations: current.declaredOperations,
      now: 1002,
    },
  );
  if (Result.isFailure(revoked)) throw new Error(revoked.failure.code);
  const fresh = {
    ...current,
    installation: { ...current.installation, authority: revoked.success },
  };
  expect(admits(fresh, request)).toEqual({
    kind: "refused",
    code: "not_approved",
  });
  expect(
    admits(fresh, {
      kind: "capability",
      capability: "computer.readFile",
      resource: "any",
    }).kind,
  ).toBe("admitted");
  expect(
    admits(
      {
        ...fresh,
        pins: {
          authorityVersion: current.installation.authority.authorityVersion,
          artifactDigest: current.installation.artifactDigest,
        },
      },
      request,
    ),
  ).toEqual({ kind: "refused", code: "stale_authority" });
});
