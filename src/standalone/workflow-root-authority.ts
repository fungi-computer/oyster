import {
  createWorkflowRunAuthority,
  createWorkflowCeilingCapture,
  planInstallationLevels,
  type WorkflowRunAuthority,
} from "@fungi.computer/braid/runtime";
import { AppInstanceError } from "../index.js";
import type { RepositoryRef } from "@fungi.computer/agar/git";
import type { AppToolPolicy } from "../apps/index.js";
import { keyAppAccess } from "../authorization.js";
import type { LiveOysterKey } from "../keys.js";
import type { StandaloneTenancy } from "./tenancy.js";
import { createStandaloneWorkflowAuthorityReaders } from "./workflow-authority-readers.js";
import {
  createStandaloneWorkflowNodeCapture,
  type StandaloneWorkflowNodeCaptureOptions,
} from "./workflow-node-capture.js";
import { createStandaloneWorkflowInstallationGitCapture } from "./workflow-git-capture.js";
import type { StandaloneWorkflowAuthorityReaderOptions } from "./workflow-authority-readers.js";

/** The tenant, host and library a standalone Workflow root admits through. */
export type StandaloneWorkflowRootOptions = Readonly<{
  shared: Pick<StandaloneTenancy, "tenantId" | "tenancy" | "owner">;
  host: StandaloneWorkflowNodeCaptureOptions["host"];
  libraryInstallationId: string;
  catalogHost: StandaloneWorkflowAuthorityReaderOptions["catalogHost"];
}>;

/** The configured canonical owner, re-read around the kit registry's member row. */
function rootReaders(options: StandaloneWorkflowRootOptions) {
  const base = createStandaloneWorkflowAuthorityReaders({
    tenantId: options.shared.tenantId,
    tenancy: options.shared.tenancy,
    host: options.host,
    libraryInstallationId: options.libraryInstallationId,
    catalogHost: options.catalogHost,
  });
  const member: typeof base.member = async (id) => {
    const before = await options.shared.owner();
    if (before?.actor.memberId !== id) return null;
    const current = await base.member(id);
    const after = await options.shared.owner();
    return current !== null &&
      after?.actor.memberId === id &&
      before.membershipVersion === current.membershipVersion &&
      after.membershipVersion === current.membershipVersion
      ? current
      : null;
  };
  return { ...base, member };
}

/** One live kit registry and its configured canonical owner back every start. */
export function createStandaloneWorkflowRootAuthority(
  options: StandaloneWorkflowRootOptions &
    Readonly<{
      /** The Agent's current App tool approval from its policy owner. */
      agentToolPolicy(agentId: string): Promise<AppToolPolicy | null>;
      /** A key's live Ear Tag facts, read fresh at every admission and recheck. */
      keyLive(keyId: string): Promise<LiveOysterKey | null>;
    }>,
): WorkflowRunAuthority {
  const readers = rootReaders(options);
  return createWorkflowRunAuthority({
    ...readers,
    // An Agent run stays admitted only while its grantor's write approval lasts.
    async admitAgent(preparation) {
      const policy = await options.agentToolPolicy(
        preparation.initiatedBy.agentId,
      );
      return (
        policy?.level === "write" &&
        policy.grantedBy === preparation.initiatedBy.grantorMemberId
      );
    },
    // A key run stays admitted only while the key is still live, its owner
    // still matches the run's grantor, `apps.use` still reaches this
    // Workflows library, and every installation the plan touches is still
    // inside the key's own grants -- a key never widens past what it was
    // issued, even when the plan's binding set has not changed.
    async admitKey(preparation) {
      const key = await options.keyLive(preparation.initiatedBy.keyId);
      if (key?.owner !== preparation.initiatedBy.grantorMemberId) return false;
      if (keyAppAccess(key, options.libraryInstallationId)?.level !== "write")
        return false;
      return planInstallationLevels(preparation.plan).every(
        ({ installationId, level }) => {
          const access = keyAppAccess(key, installationId);
          return (
            access !== null && (level !== "write" || access.level === "write")
          );
        },
      );
    },
    capture: createWorkflowCeilingCapture({
      node: createStandaloneWorkflowNodeCapture({
        host: options.host,
        readers,
      }),
      git: createStandaloneWorkflowInstallationGitCapture({
        host: options.host,
        readers,
      }),
    }),
    denied: () => new AppInstanceError("revoked"),
  });
}

/**
 * The same live installation-Git admission the start ceiling captured, re-run
 * for a Workflow Git pass: the member must still be the canonical owner and the
 * repository's installation must still grant this Git scope.
 */
export function createStandaloneWorkflowGitAccess(
  options: StandaloneWorkflowRootOptions,
) {
  const readers = rootReaders(options);
  const capture = createStandaloneWorkflowInstallationGitCapture({
    host: options.host,
    readers,
  });
  return async (
    memberId: string,
    repository: RepositoryRef,
    scope: "read" | "write",
  ): Promise<boolean> => {
    const member = await readers.member(memberId);
    return (
      member !== null &&
      (await capture({ kind: "member", memberId }, member, repository, scope))
    );
  };
}
