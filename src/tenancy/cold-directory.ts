import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ResolvedTenant, TenantScope } from "../tenant.js";
import type { ReadonlyTenantRegistry } from "./contracts.js";
import { membershipVersionSchema } from "./registry-record.js";

/** Live directory admission for a host-persisted tenant during background work. */
export type ColdTenantDirectory = Readonly<{
  /** Select only the current active tenant at its stored canonical origin. */
  resolve(scope: TenantScope): Promise<ResolvedTenant | null>;
}>;

/**
 * Reconstruct background admission from the same host-owned tenant registry.
 * Every selection and member lookup reads current authority. This adapter has
 * no credential authority: its authenticate method always refuses requests.
 */
export function coldTenantDirectory(
  registry: Pick<ReadonlyTenantRegistry, "get" | "status" | "memberById">,
): ColdTenantDirectory {
  const current = async (scope: TenantScope): Promise<boolean> => {
    const tenant = await registry.get(scope.tenantId);
    return (
      tenant?.id === scope.tenantId &&
      tenant.origin === scope.origin &&
      tenant.status === "active" &&
      (await registry.status(scope.tenantId)) === "active"
    );
  };
  return {
    async resolve(scope) {
      if (!(await current(scope))) return null;
      const auth: ResolvedTenant["auth"] = {
        async resolve(actor) {
          if (actor.kind !== "member" || !(await current(scope))) return null;
          const membership = await registry.memberById(
            scope.tenantId,
            actor.memberId,
          );
          if (
            membership?.memberId !== actor.memberId ||
            !(await current(scope))
          )
            return null;
          const version = Schema.decodeUnknownOption(membershipVersionSchema)(
            membership.membershipVersion,
          );
          if (Option.isNone(version)) return null;
          return {
            membershipVersion: version.value,
            actor: { kind: "member", memberId: membership.memberId },
            role: membership.role,
          };
        },
        authenticate: () => Promise.resolve({ kind: "refused", status: 401 }),
      };
      return { scope, auth };
    },
  };
}
