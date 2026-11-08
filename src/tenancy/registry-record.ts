import * as Schema from "effect/Schema";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import type { Tenant } from "./contracts.js";

const identityIds = defineIdFamily({
  family: "tenancy-member",
  version: 1,
  kinds: { member: { prefix: "tenant_member" } },
});

const loopbackHosts: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/** Plain HTTP on a loopback host: traffic that never leaves this machine. */
export function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && loopbackHosts.has(url.hostname);
}

/**
 * Where a loopback request at another loopback host (localhost, 127.0.0.1,
 * [::1]) on the same port belongs: the same path at the canonical origin, or
 * null when either origin is not loopback HTTP or the host is already canonical.
 */
export function loopbackAliasLocation(
  request: URL,
  canonicalOrigin: string,
): string | null {
  const canonical = new URL(canonicalOrigin);
  if (
    !isLoopbackHttp(request) ||
    !isLoopbackHttp(canonical) ||
    request.port !== canonical.port ||
    request.host === canonical.host
  )
    return null;
  return `${canonical.origin}${request.pathname}${request.search}`;
}

/**
 * A tenant origin is HTTPS. Plain HTTP is admitted only for a loopback host,
 * which browsers treat as a secure context; no other HTTP origin is.
 */
export function isTenantOriginScheme(url: URL): boolean {
  return url.protocol === "https:" || isLoopbackHttp(url);
}

export function checkedOrigin(
  origin: string,
  domains: readonly string[],
): string {
  const url = new URL(origin);
  if (
    !isTenantOriginScheme(url) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !domains.includes(url.host)
  )
    throw new TypeError(
      "Tenant origin must be HTTPS (or HTTP on a loopback host) and match a declared domain, without credentials or a path",
    );
  for (const domain of domains) {
    const parsed = new URL(`${url.protocol}//${domain}`);
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
