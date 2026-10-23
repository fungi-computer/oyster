import { describe, expect, expectTypeOf, it } from "vitest";
import {
  approvedGrantSchema,
  installationIdSchema,
} from "../src/apps/installation.js";

describe("the installation contract", () => {
  it("keeps tenant name separators out of installation identities", () => {
    expect(installationIdSchema.parse("notes-v2")).toBe("notes-v2");
    for (const id of ["notes--v2", "1notes", "", "a".repeat(64)])
      expect(installationIdSchema.safeParse(id).success).toBe(false);
  });
  it("stores explicit operations and tenant-bounded resource selectors", () => {
    const grant = {
      capability: "media.generation",
      capabilityApproved: true,
      operations: ["binding:MEDIA:generate"],
      resources: "tenant-scope",
    };
    expect(approvedGrantSchema.parse(grant)).toEqual(grant);
    for (const change of [
      { operations: "declared" },
      { resources: "all" },
      { capability: "unknown" },
    ])
      expect(
        approvedGrantSchema.safeParse({ ...grant, ...change }).success,
      ).toBe(false);
  });
});

import {
  installationSchema,
  installationRefusalSchema,
} from "../src/apps/installation.js";
import {
  gateRefusalSchema,
  gateRequestSchema,
  invocationGrantsSchema,
} from "../src/apps/gate.js";

const stored = {
  installationId: "notes",
  instanceId: null,
  appId: "app_notes",
  release: {
    appId: "app_notes",
    releaseId: "rel_notes",
    artifact: {
      artifactRef: "artifact:notes",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      provenance: {
        sourceRevision: `git:${"b".repeat(40)}`,
        sourceTreeDigest: `sha256:${"c".repeat(64)}`,
        buildRecipeDigest: `sha256:${"d".repeat(64)}`,
      },
    },
  },
  releasePin: "pinned",
  status: "enabled",
  visibility: "private",
  approvedAnonymousMethods: [],
  anonymousApproval: null,
  authority: {
    authorityVersion: 1,
    declaredOperationsDigest: `sha256:${"e".repeat(64)}`,
    approvedGrants: [],
    approval: null,
  },
};

it("stores one embedded authority and refuses the superseded inline grant fields", () => {
  expect(installationSchema.parse(stored).authority).toEqual(stored.authority);
  const { authority, ...identity } = stored;
  expect(
    installationSchema.safeParse({ ...identity, ...authority }).success,
  ).toBe(false);
});

it("pins the Release and operation snapshot with explicit host state", () => {
  expect(installationSchema.parse(stored)).toEqual(stored);
  for (const change of [
    { declaredOperationsDigest: "unverified" },
    { instanceId: "not-an-instance" },
    { appId: "app_other" },
    { visibility: undefined },
    { authorityVersion: 0 },
  ])
    expect(installationSchema.safeParse({ ...stored, ...change }).success).toBe(
      false,
    );
});
it("rejects ambiguous duplicate grants instead of combining operation/resource scopes", () => {
  const read = {
    capability: "computer.readFile",
    capabilityApproved: true,
    operations: ["binding:COMPUTER:read"],
    resources: [{ kind: "computer", id: "a" }],
  };
  expect(
    installationSchema.safeParse({
      ...stored,
      authority: {
        ...stored.authority,
        approvedGrants: [
          read,
          { ...read, resources: [{ kind: "computer", id: "b" }] },
        ],
      },
    }).success,
  ).toBe(false);
});
it("freezes the typed not-declared and external-approval refusal boundaries", () => {
  expect(
    installationRefusalSchema.parse({ kind: "refused", code: "not_declared" }),
  ).toEqual({ kind: "refused", code: "not_declared" });
  expect(
    gateRefusalSchema.parse({ kind: "refused", code: "approval_required" }),
  ).toEqual({ kind: "refused", code: "approval_required" });
  expect(
    gateRefusalSchema.safeParse({ kind: "refused", code: "tenant_mismatch" })
      .success,
  ).toBe(false);
  expect(
    gateRequestSchema.safeParse({
      kind: "binding",
      binding: "UNKNOWN",
      operation: "read",
    }).success,
  ).toBe(false);
  expect(
    invocationGrantsSchema.parse([
      { binding: "MEDIA", operations: ["generate"] },
    ]),
  ).toEqual([{ binding: "MEDIA", operations: ["generate"] }]);
  expect(
    invocationGrantsSchema.safeParse([
      { binding: "MEDIA", operations: ["unknown"] },
    ]).success,
  ).toBe(false);
});

import type { HostActor } from "@fungi.computer/puffball/app";
import type {
  ResourceRef,
  GrantChange,
  Approval,
  Installation,
  InstallationReader,
  CapabilityOperationDescriptor,
  InstallationContext,
  InstallationCommand,
  InstallationUpdate,
} from "../src/apps/installation.js";
import {
  installationCommandSchema,
  declaredOperationsSchema,
} from "../src/apps/installation.js";
import type { AppToolEntry } from "../src/apps/tools.js";

it("keeps host identity, read-only storage and pre-read tool facts in the frozen interface", () => {
  expectTypeOf<keyof ResourceRef>().toEqualTypeOf<"kind" | "id">();
  expectTypeOf<Approval["by"]>().toEqualTypeOf<HostActor>();
  expectTypeOf<Extract<GrantChange, string>>().toEqualTypeOf<never>();
  expectTypeOf<keyof InstallationReader>().toEqualTypeOf<"list" | "get">();
  expectTypeOf<InstallationReader["get"]>().returns.toEqualTypeOf<
    Promise<Installation | null>
  >();
  expectTypeOf<keyof AppToolEntry>().toEqualTypeOf<
    "installation" | "declaration" | "declaredOperations" | "api" | "access"
  >();
  expectTypeOf<keyof CapabilityOperationDescriptor>().toEqualTypeOf<
    "id" | "methods" | "permission"
  >();
  const command = installationCommandSchema.parse({
    kind: "install",
    release: stored.release,
    releasePin: "pinned",
  });
  expect(command.kind).toBe("install");
  expect(
    declaredOperationsSchema.safeParse({
      artifactDigest: stored.release.artifact.artifactDigest,
      digest: stored.authority.declaredOperationsDigest,
      anonymousMethods: [],
      capabilities: [
        {
          capability: "media.generation",
          operations: ["binding:MEDIA:generate"],
        },
      ],
    }).success,
  ).toBe(true);
});

it("keeps identities explicit and grant commands distinct from state commands", () => {
  expectTypeOf<InstallationContext["identity"]>().toEqualTypeOf<
    Pick<Installation, "installationId" | "instanceId">
  >();
  expectTypeOf<
    Extract<InstallationCommand, { kind: "change-grants" }>
  >().toEqualTypeOf<{
    kind: "change-grants";
    changes: readonly GrantChange[];
  }>();
  expectTypeOf<keyof InstallationUpdate>().toEqualTypeOf<
    "next" | "authorityChanged"
  >();
  expect(
    installationSchema.safeParse({
      ...stored,
      authority: {
        ...stored.authority,
        approval: {
          by: { kind: "member", memberId: "" },
          at: 1000,
          authorityVersion: 1,
        },
      },
    }).success,
  ).toBe(false);
});

import type {
  GateRequest,
  GateFacts,
  GateDecision,
  InvocationGrants,
} from "../src/apps/gate.js";
import type { InstallationRefusal } from "../src/apps/installation.js";

it("keeps method ingress, admitted frame grants and refusals closed", () => {
  expectTypeOf<Extract<GateRequest, { kind: "method" }>["via"]>().toEqualTypeOf<
    "ui" | "agent" | "mcp" | "workflow"
  >();
  expectTypeOf<GateFacts["principal"]["actor"]>().toEqualTypeOf<
    HostActor | Readonly<{ kind: "visitor" }>
  >();
  expectTypeOf<
    Extract<GateDecision, { kind: "admitted" }>["grants"]
  >().toEqualTypeOf<InvocationGrants>();
  expectTypeOf<InstallationRefusal["kind"]>().toEqualTypeOf<"refused">();
});

it("stores event approval under the sole capability grant grammar", () => {
  const grant = {
    capability: "app.events.emit",
    capabilityApproved: true,
    operations: ["binding:EVENTS:emit"],
    resources: "tenant-scope",
  };
  expect(approvedGrantSchema.parse(grant)).toEqual(grant);
  expect(
    approvedGrantSchema.safeParse({
      binding: "EVENTS",
      operations: ["emit"],
      resources: "tenant-scope",
    }).success,
  ).toBe(false);
});

it("requires explicit stored capability consent even when no operation remains", () => {
  const approved = {
    capability: "workflow.publish",
    capabilityApproved: true,
    operations: [],
    resources: "tenant-scope",
  };
  expect(approvedGrantSchema.parse(approved)).toEqual(approved);
  expect(
    approvedGrantSchema.safeParse({
      capability: "workflow.publish",
      operations: [],
      resources: "tenant-scope",
    }).success,
  ).toBe(false);
  expect(
    approvedGrantSchema.safeParse({ ...approved, capabilityApproved: false })
      .success,
  ).toBe(false);
});
