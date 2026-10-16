import { tenantScope, type OysterTenancy } from "../tenant.js";
import type { ReadonlyTenancy } from "./contracts.js";

/** Bind the kit's live registry/auth admission to the canonical Oyster port. */
export function createOysterTenancy(
  tenancy: Pick<ReadonlyTenancy, "resolve" | "authenticate" | "memberById">,
): OysterTenancy {
  return {
    async resolve(request) {
      const tenant = await tenancy.resolve(request);
      if (tenant === null) return null;
      return {
        scope: tenantScope(tenant.id, tenant.origin),
        auth: {
          resolve: (actor) =>
            actor.kind === "member"
              ? tenancy.memberById(tenant.id, actor.memberId)
              : Promise.resolve(null),
          authenticate: async (incoming) => {
            const result = await tenancy.authenticate(incoming, tenant);
            return result.kind === "admitted"
              ? { kind: "admitted", principal: result.principal }
              : result;
          },
        },
      };
    },
  };
}
