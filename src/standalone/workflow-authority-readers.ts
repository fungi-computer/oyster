import type { ReadonlyTenancy } from "../tenancy/index.js";
import type { TenantId } from "../tenant.js";
import type { OysterHost } from "../host.js";
import { AppInstanceError } from "../index.js";
import type { WorkflowRunAuthorityPorts } from "@fungi.computer/braid/runtime";
import type { createStandaloneWorkflowHost } from "./workflow-host.js";

/** Host-selected tenant, Computer and library; none come from Workflow input. */
export type StandaloneWorkflowAuthorityReaderOptions = Readonly<{
  tenantId: TenantId;
  tenancy: Pick<ReadonlyTenancy, "memberById">;
  host: Pick<OysterHost, "computerId">;
  libraryInstallationId: string;
  catalogHost: Pick<
    ReturnType<typeof createStandaloneWorkflowHost>,
    "admitLibrary" | "catalogForLibrary"
  >;
}>;

/** Live authority readers only: catalog entries do not establish node grants. */
export type StandaloneWorkflowAuthorityReaders = Pick<
  WorkflowRunAuthorityPorts,
  "member" | "memberComputer" | "catalog"
>;

export function createStandaloneWorkflowAuthorityReaders(
  options: StandaloneWorkflowAuthorityReaderOptions,
): StandaloneWorkflowAuthorityReaders {
  const member: StandaloneWorkflowAuthorityReaders["member"] = async (id) => {
    const current = await options.tenancy.memberById(options.tenantId, id);
    if (
      current?.actor.kind !== "member" ||
      current.actor.memberId !== id ||
      !("role" in current) ||
      current.role !== "owner"
    )
      return null;
    return { membershipVersion: current.membershipVersion };
  };
  return {
    member,
    async memberComputer(id, computerId) {
      const before = await member(id);
      if (before === null || computerId !== options.host.computerId)
        return false;
      const after = await member(id);
      return after?.membershipVersion === before.membershipVersion;
    },
    async catalog(id) {
      const before = await member(id);
      if (before === null) throw new AppInstanceError("revoked");
      const selected = await options.catalogHost.admitLibrary(
        options.libraryInstallationId,
        "catalog",
      );
      const entries = await options.catalogHost.catalogForLibrary(selected, {
        full: true,
      });
      const after = await member(id);
      if (after?.membershipVersion !== before.membershipVersion)
        throw new AppInstanceError("revoked");
      return entries.apps;
    },
  };
}
