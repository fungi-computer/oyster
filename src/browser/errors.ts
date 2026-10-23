import * as Data from "effect/Data";

/**
 * The cloud-browser backend's closed, typed failure channel. Every backend
 * (today only Cloudflare Browser Run) throws exclusively from this union;
 * `agent-cloud-browser-source.ts` is the one place that maps it onto
 * Mycelium's `CapabilityFailed`, so the model only ever sees a bounded,
 * owner-admitted message (never a raw provider error body or stack).
 */

/** The target URL failed policy before any provider call was made. */
export class CloudBrowserUrlDenied extends Data.TaggedError(
  "CloudBrowserUrlDenied",
)<{
  readonly reason:
    | "invalid_url"
    | "unsupported_scheme"
    | "credentials_in_url"
    | "not_public"
    | "dns_unavailable";
  readonly message: string;
}> {}

/** The provider (Cloudflare Browser Run) answered with a failure. */
export class CloudBrowserUpstreamError extends Data.TaggedError(
  "CloudBrowserUpstreamError",
)<{
  readonly op: string;
  readonly status: number | null;
  readonly message: string;
}> {}

/** A call did not complete within its deadline. */
export class CloudBrowserTimeout extends Data.TaggedError(
  "CloudBrowserTimeout",
)<{
  readonly op: string;
  readonly timeoutMs: number;
}> {}

/** The named lease is not held by this (teamId, agentId, sessionId). */
export class CloudBrowserLeaseNotFound extends Data.TaggedError(
  "CloudBrowserLeaseNotFound",
)<{
  readonly leaseId: string;
}> {}

/** A member was asked to take over; the Agent cannot drive it until "Done". */
export class CloudBrowserLeasePaused extends Data.TaggedError(
  "CloudBrowserLeasePaused",
)<{
  readonly leaseId: string;
}> {}

/** The Team has no more concurrent leases available right now. */
export class CloudBrowserCapacityExceeded extends Data.TaggedError(
  "CloudBrowserCapacityExceeded",
)<{
  readonly teamId: string;
  readonly limit: number;
}> {}

/** The Team has no credit to start or continue a lease. */
export class CloudBrowserCreditDenied extends Data.TaggedError(
  "CloudBrowserCreditDenied",
)<{
  readonly teamId: string;
}> {}

/** No backend is configured (credentials absent, or the feature is paused). */
export class CloudBrowserUnavailable extends Data.TaggedError(
  "CloudBrowserUnavailable",
)<{
  readonly reason: "unconfigured" | "paused";
}> {}

/** Every typed failure the browser module throws; nothing else escapes it. */
export type CloudBrowserFailure =
  | CloudBrowserUrlDenied
  | CloudBrowserUpstreamError
  | CloudBrowserTimeout
  | CloudBrowserLeaseNotFound
  | CloudBrowserLeasePaused
  | CloudBrowserCapacityExceeded
  | CloudBrowserCreditDenied
  | CloudBrowserUnavailable;
