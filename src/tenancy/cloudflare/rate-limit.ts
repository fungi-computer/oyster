import * as Schema from "effect/Schema";
import type { TenancyPolicy } from "../contracts.js";

/** Retry-After is an advisory response delay, not a configured quota or reset time. */
export type RateLimitOptions = Readonly<{
  /** Positive whole seconds returned on a native refusal. */
  retryAfterSeconds: number;
}>;

/** Delegate abuse admission to the configured native binding, using only its key API. */
export function rateLimit(
  binding: Pick<RateLimit, "limit">,
  options: RateLimitOptions,
): TenancyPolicy {
  const retryAfter = Schema.decodeUnknownSync(
    Schema.Int.check(Schema.isGreaterThan(0)),
  )(options.retryAfterSeconds);
  return async ({ tenant, principal }) => {
    const actor = principal.actor;
    const id =
      actor.kind === "member"
        ? actor.memberId
        : actor.kind === "agent"
          ? actor.agentId
          : actor.keyId;
    const { success } = await binding.limit({
      key: JSON.stringify([tenant.id, actor.kind, id]),
    });
    return success
      ? { kind: "allow" }
      : { kind: "refuse", status: 429, retryAfter };
  };
}
