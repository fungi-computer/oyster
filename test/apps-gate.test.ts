import { expect, it } from "vitest";
import * as Result from "effect/Result";
import type { AppDeclaration } from "@fungi.computer/puffball/app";
import { instanceIds } from "../src/index.js";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import { applyInstallationCommand } from "../src/apps/installation.js";
import {
  admits,
  admitMethodMetadata,
  appInvocationCeiling,
  scopedBindings,
  approvedBindingGrants,
  type GateFacts,
} from "../src/apps/gate.js";
import { declaration, descriptors, release } from "./apps-fixture.js";

async function facts(
  nextDeclaration: AppDeclaration = declaration,
  operationDescriptors = descriptors,
): Promise<GateFacts> {
  const declaredOperations = await deriveDeclaredOperations(
    release,
    nextDeclaration,
    operationDescriptors,
  );
  const result = applyInstallationCommand(
    null,
    { kind: "install", release, releasePin: "pinned", grants: "declared" },
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
  return {
    principal: { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    installation: result.success.next,
    declaration: nextDeclaration,
    declaredOperations,
    api: nextDeclaration.api ?? null,
    access: null,
  };
}
it("projects only approved declared binding operations for host freshness checks", async () => {
  const current = await facts();
  const installation = {
    ...current.installation,
    approvedGrants: current.installation.approvedGrants.filter(
      (grant) => grant.capability === "computer.readFile",
    ),
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
    approvedBindingGrants({ ...installation, approvedGrants: [] }, declaration),
  ).toEqual([]);
});
it("always refuses external methods before input or write-level admission", async () => {
  const current = await facts();
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
        authorityVersion: 2,
        artifactDigest: f.installation.release.artifact.artifactDigest,
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
      installation: { ...f.installation, approvedGrants: [] },
    }),
    name: "notes.read",
    input: { path: "/note" },
  },
  {
    code: "visitor_read_only",
    change: (f: GateFacts) => ({
      ...f,
      installation: { ...f.installation, visibility: "public" as const },
      principal: { actor: { kind: "visitor" as const }, role: null },
    }),
    name: "notes.write",
    input: {},
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
      admits(change(await facts()), {
        kind: "method",
        name,
        input,
        via: "agent",
      }),
    ).toEqual({ kind: "refused", code });
  },
);
it("admits a dotted read method with only its approved required read binding", async () => {
  const current = await facts();
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
  const current = await facts();
  const installation = {
    ...current.installation,
    approvedGrants: [
      {
        capability: "computer.readFile" as const,
        capabilityApproved: true as const,
        operations: ["route:computer.readFile:open"],
        resources: [{ kind: "computer", id: "selected" }],
      },
    ],
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
      },
    ),
  ).toEqual({ kind: "refused", code: "not_approved" });
});
it("admits visitors only to public read methods with their approved read bindings", async () => {
  const current = await facts();
  const visitor = {
    ...current,
    principal: { actor: { kind: "visitor" as const }, role: null },
  };
  expect(
    admits(visitor, {
      kind: "method",
      name: "notes.read",
      input: { path: "/note" },
      via: "mcp",
    }),
  ).toEqual({ kind: "refused", code: "unavailable" });
  expect(
    admits(
      {
        ...visitor,
        installation: { ...visitor.installation, visibility: "public" },
      },
      {
        kind: "method",
        name: "notes.read",
        input: { path: "/note" },
        via: "mcp",
      },
    ),
  ).toMatchObject({
    kind: "admitted",
    grants: [{ binding: "COMPUTER", operations: ["read"] }],
  });
});
it("maps unsupported declared input schemas to a typed refusal without compiler diagnostics", async () => {
  const current = await facts();
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
    admits(await facts(), {
      kind: "method",
      name: "notes.read",
      input: { path: "x".repeat(65536) },
      via: "agent",
    }),
  ).toEqual({ kind: "refused", code: "invalid_input" });
});

it("refuses EVENTS.emit when the App declares its binding without the required capability", async () => {
  const current = await facts({
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
  const current = await facts(emittingDeclaration);
  const granted = current.installation.approvedGrants.find(
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
      approvedGrants: current.installation.approvedGrants.filter(
        (grant) => grant.capability !== "app.events.emit",
      ),
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
  const current = await facts(emittingDeclaration);
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
  const result = applyInstallationCommand(
    current.installation,
    {
      kind: "select-release",
      release,
      releasePin: "pinned",
    },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: current.installation.authorityVersion,
      declaration: nextDeclaration,
      declaredOperations: snapshot,
      now: 2000,
      identity: {
        installationId: "notes",
        instanceId: current.installation.instanceId,
      },
    },
  );
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  return {
    ...current,
    installation: result.success.next,
    declaration: nextDeclaration,
    api: nextDeclaration.api ?? null,
    declaredOperations: snapshot,
  };
}

it("admits an added method under existing capability consent but refuses a new capability", async () => {
  const publish = requirementMethod(["workflow.publish"]);
  const current = await facts(
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
  expect(upgraded.installation.approvedGrants).toEqual(
    current.installation.approvedGrants,
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
  const approval = applyInstallationCommand(
    upgraded.installation,
    { kind: "set-grants", grants: "declared" },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: upgraded.installation.authorityVersion,
      declaration: upgraded.declaration,
      declaredOperations: upgraded.declaredOperations,
      now: 3000,
      identity: {
        installationId: "notes",
        instanceId: upgraded.installation.instanceId,
      },
    },
  );
  if (Result.isFailure(approval)) throw new Error(approval.failure.code);
  const approved = { ...upgraded, installation: approval.success.next };
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
  const current = await facts(
    requirementDeclaration({ publishWorkflow: publish }),
  );
  const renamed = await selectRequirements(
    current,
    requirementDeclaration({ publishAnother: publish }),
  );
  expect(renamed.installation.approvedGrants).toEqual([
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
  expect(restored.installation.approvedGrants).toEqual([]);
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
  const current = await facts(
    requirementDeclaration({
      publishWorkflow: publish,
      publishAnother: publish,
    }),
  );
  expect(current.installation.approvedGrants).toEqual([
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
  const current = await facts(
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
  const current = await facts();
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
      declaredOperationsDigest: oldSnapshot.digest,
      approvedGrants: current.installation.approvedGrants.map((grant) => ({
        ...grant,
        operations: grant.operations.filter(
          (operation) => !operation.startsWith("route:app.methods:"),
        ),
      })),
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
  expect(selected.installation.approvedGrants).toEqual(
    old.installation.approvedGrants,
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
  const current = await facts(
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
    }),
  ).toEqual({ kind: "refused", code: "not_approved" });
});

it("admits method metadata without fabricating mapped input and preserves dispatch input priority", async () => {
  const current = await facts();
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
    installation: { ...current.installation, approvedGrants: [] },
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
  const current = await facts();
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
          authorityVersion: current.installation.authorityVersion + 1,
          artifactDigest: current.installation.release.artifact.artifactDigest,
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
    installation: { ...current.installation, approvedGrants: [] },
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
  const current = await facts();
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
  const visitor: GateFacts = {
    ...current,
    installation: { ...current.installation, visibility: "public" },
    principal: { actor: { kind: "visitor" }, role: null },
  };
  const writeMethod = current.api?.methods["notes.write"];
  if (writeMethod === undefined) throw new Error("Fixture method missing");
  expect(appInvocationCeiling(current)).toBe("write");
  for (const restricted of [readLevel, visitor]) {
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
  const current = await facts();
  const stored = installationSchema.safeParse({
    ...current.installation,
    approvedGrants: current.installation.approvedGrants.map((grant) => ({
      ...grant,
      capabilityApproved: false,
    })),
  });
  expect(stored.success).toBe(false);
});

it("metadata does not prove an input schema can compile for execution", async () => {
  const current = await facts();
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
  const current = await facts();
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
          authorityVersion: value.installation.authorityVersion + 1,
          artifactDigest: value.installation.release.artifact.artifactDigest,
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
        installation: { ...value.installation, approvedGrants: [] },
      }),
    },
    {
      label: "visitor private",
      name: "notes.read",
      input: { path: "/note" },
      expected: "unavailable",
      change: (value) => ({
        ...value,
        principal: { actor: { kind: "visitor" }, role: null },
      }),
    },
    {
      label: "visitor read",
      name: "notes.read",
      input: { path: "/note" },
      expected: "admitted",
      change: (value) => ({
        ...value,
        principal: { actor: { kind: "visitor" }, role: null },
        installation: { ...value.installation, visibility: "public" },
      }),
    },
    {
      label: "visitor write",
      name: "notes.write",
      input: {},
      expected: "visitor_read_only",
      change: (value) => ({
        ...value,
        principal: { actor: { kind: "visitor" }, role: null },
        installation: { ...value.installation, visibility: "public" },
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
