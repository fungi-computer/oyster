import * as Schema from "effect/Schema";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import type { Tenant } from "./contracts.js";

const identityIds = defineIdFamily({
  family: "tenancy-member",
  version: 1,
  kinds: { member: { prefix: "tenant_member" } },
});

export function checkedOrigin(
  origin: string,
  domains: readonly string[],
): string {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !domains.includes(url.host)
  )
    throw new TypeError(
      "Tenant origin must be HTTPS and match a declared domain, without credentials or a path",
    );
  for (const domain of domains) {
    const parsed = new URL(`https://${domain}`);
    if (
      parsed.host !== domain ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    )
      throw new TypeError("Tenant domains must be canonical hostnames");
  }
  return url.origin;
}

export function immutable(tenant: Tenant): Tenant {
  return Object.freeze({
    id: tenant.id,
    handle: tenant.handle,
    origin: tenant.origin,
    status: tenant.status,
    owners: Object.freeze([...tenant.owners]),
    domains: Object.freeze([...tenant.domains]),
  });
}

export function createMemberId(): string {
  return identityIds.member.generate();
}

/** Stored membership authority revisions are positive safe integers. */
export const membershipVersionSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
