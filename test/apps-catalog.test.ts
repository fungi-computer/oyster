import { expect, it } from "vitest";
import * as Result from "effect/Result";
import * as z from "zod";
import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import {
  appCatalogResponseSchema,
  appCatalogBrokerResultSchema,
} from "@fungi.computer/nacre/app-directory";
import { admits, type GateFacts } from "../src/apps/gate.js";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import { applyInstallationCommand } from "../src/apps/installation.js";
import { instanceIds } from "../src/index.js";
import { descriptors, release } from "./apps-fixture.js";

it("catalog requires explicit full-access approval and its manifest capability", async () => {
  const backend = defineAppBackend({
    methods: {
      catalog: defineAppMethod({
        description: "Read installed App metadata",
        effect: "read",
        requires: ["team.workbenchHost"],
        input: z.strictObject({}),
        output: appCatalogResponseSchema,
        handler: () => ({ apps: [], roles: {} }),
      }),
    },
  });
  const declaration = buildAppDeclaration(backend, {
    capabilities: ["team.workbenchHost"],
    handlers: [],
    roles: [],
    commands: [],
    backend: { bindings: [{ name: "APPS", operations: ["catalog"] }] },
  });
  const declaredOperations = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const installed = applyInstallationCommand(
    null,
    { kind: "install", release, releasePin: "pinned" },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: null,
      declaration,
      declaredOperations,
      now: 1000,
      identity: {
        installationId: "catalog",
        instanceId: instanceIds.instance.generate(),
      },
    },
  );
  if (Result.isFailure(installed)) throw new Error(installed.failure.code);
  const facts: GateFacts = {
    principal: { actor: { kind: "agent", agentId: "owner-agent" }, role: null },
    installation: {
      ...installed.success.next,
      artifactDigest: release.artifact.artifactDigest,
    },
    declaration,
    declaredOperations,
    api: declaration.api ?? null,
    access: {
      level: "read",
      bindingName: "APP",
      revision: "1",
      grantedBy: "owner",
    },
  };
  const request = {
    kind: "binding",
    binding: "APPS",
    operation: "catalog",
  } as const;
  expect(admits(facts, request)).toEqual({
    kind: "refused",
    code: "not_approved",
  });
  const approved = applyInstallationCommand(
    installed.success.next,
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
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      expectedVersion: installed.success.next.authority.authorityVersion,
      declaration,
      declaredOperations,
      now: 2000,
      identity: installed.success.next,
    },
  );
  if (Result.isFailure(approved)) throw new Error(approved.failure.code);
  expect(
    admits(
      {
        ...facts,
        installation: {
          ...approved.success.next,
          artifactDigest: release.artifact.artifactDigest,
        },
      },
      request,
    ),
  ).toEqual({
    kind: "admitted",
    grants: [{ binding: "APPS", operations: ["catalog"] }],
  });
  expect(
    admits(
      { ...facts, declaration: { ...declaration, capabilities: [] } },
      request,
    ),
  ).toEqual({ kind: "refused", code: "not_declared" });
  expect(
    admits(facts, { kind: "binding", binding: "APPS", operation: "build" }),
  ).toEqual({ kind: "refused", code: "not_declared" });
});

it("decodes catalog and existing broker refusals without accepting other reply shapes", () => {
  const catalog = { apps: [], roles: {} };
  expect(appCatalogBrokerResultSchema.parse(catalog)).toEqual(catalog);
  for (const error of [
    "invalid_request",
    "not_granted",
    "too_large",
    "unavailable",
  ]) {
    expect(appCatalogBrokerResultSchema.parse({ error })).toEqual({ error });
  }
  for (const reply of [
    { error: 42 },
    { error: "unavailable", extra: true },
    { apps: [] },
  ]) {
    expect(appCatalogBrokerResultSchema.safeParse(reply).success).toBe(false);
  }
});
