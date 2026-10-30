import type { OysterAuth, OysterAuthResult } from "../src/host.js";
import type { TenantPrincipal } from "../src/tenant.js";

// Authentication emits only the canonical tenant grammar; no anonymous
// principal exists.
type ResultPrincipal = Extract<
  OysterAuthResult,
  { kind: "admitted" }
>["principal"];
type AuthenticatedPrincipal = Extract<
  Awaited<ReturnType<OysterAuth["authenticate"]>>,
  { kind: "admitted" }
>["principal"];
const resultIsTenant: [ResultPrincipal] extends [TenantPrincipal]
  ? true
  : false = true;
const authenticatedIsTenant: [AuthenticatedPrincipal] extends [TenantPrincipal]
  ? true
  : false = true;
const visitorNotAuthenticated: {
  actor: { kind: "visitor" };
} extends ResultPrincipal
  ? false
  : true = true;
const legacyOwnerExcluded: {
  kind: "owner";
  id: string;
} extends TenantPrincipal
  ? false
  : true = true;
const legacyKeyExcluded: {
  kind: "key";
  id: string;
} extends TenantPrincipal
  ? false
  : true = true;
const legacyAgentExcluded: {
  kind: "agent";
  id: string;
} extends TenantPrincipal
  ? false
  : true = true;
const memberRoleRequired: {
  actor: { kind: "member"; memberId: string };
} extends TenantPrincipal
  ? false
  : true = true;
void [
  resultIsTenant,
  authenticatedIsTenant,
  visitorNotAuthenticated,
  legacyOwnerExcluded,
  legacyKeyExcluded,
  legacyAgentExcluded,
  memberRoleRequired,
];
