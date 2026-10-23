import { permissionCatalog } from "../apps/catalog.js";
import * as Result from "effect/Result";
import type { AppDeclaration } from "@fungi.computer/puffball/app";
import {
  applyInstallationCommand,
  deriveDeclaredOperations,
  type CapabilityOperationDescriptor,
  type Installation,
} from "../apps/index.js";

/** Build fixture state through the same approval owner used by installation routes. */
export async function approvedInstallation(
  input: Readonly<{
    release: Installation["release"];
    declaration: AppDeclaration;
    installationId: string;
    instanceId: Installation["instanceId"];
    descriptors?: readonly CapabilityOperationDescriptor[];
    visibility?: Installation["visibility"];
  }>,
): Promise<Installation> {
  const result = applyInstallationCommand(
    null,
    {
      kind: "install",
      release: input.release,
      releasePin: "pinned",
    },
    {
      by: { kind: "member", memberId: "fixture-owner" },
      role: "owner",
      expectedVersion: null,
      declaration: input.declaration,
      declaredOperations: await deriveDeclaredOperations(
        input.release,
        input.declaration,
        input.descriptors ?? [],
      ),
      now: 1000,
      identity: {
        installationId: input.installationId,
        instanceId: input.instanceId,
      },
    },
  );
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  const installed = result.success.next;
  const declaredOperations = await deriveDeclaredOperations(
    input.release,
    input.declaration,
    input.descriptors ?? [],
  );
  const changes = declaredOperations.capabilities
    .filter(({ capability }) => permissionCatalog[capability].consent === "ask")
    .map(
      ({ capability, operations }) =>
        ({
          capability,
          grant: { operations, resources: "tenant-scope" },
        }) satisfies import("../apps/installation.js").GrantChange,
    );
  if (changes.length === 0)
    return { ...installed, visibility: input.visibility ?? "private" };
  const approved = applyInstallationCommand(
    installed,
    { kind: "change-grants", changes },
    {
      by: { kind: "member", memberId: "fixture-owner" },
      role: "owner",
      expectedVersion: installed.authority.authorityVersion,
      declaration: input.declaration,
      declaredOperations,
      now: 1001,
      identity: installed,
    },
  );
  if (Result.isFailure(approved)) throw new Error(approved.failure.code);
  return {
    ...approved.success.next,
    visibility: input.visibility ?? "private",
  };
}
