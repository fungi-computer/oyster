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
      grants: "declared",
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
  return { ...result.success.next, visibility: input.visibility ?? "private" };
}
