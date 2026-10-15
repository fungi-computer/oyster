import * as Schema from "effect/Schema";

/** Per-invocation budgets enforced by the guest Worker Loader, including facets. */
export type GuestLimits = Readonly<{
  /** Maximum guest CPU time in milliseconds. Defaults to 1,000. */
  cpuMs: number;
  /** Maximum guest subrequests. Defaults to 50; zero forbids subrequests. */
  subRequests: number;
}>;

const boundedInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isLessThanOrEqualTo(2147483647)),
);
const limitsSchema = Schema.Struct({
  cpuMs: boundedInteger.pipe(Schema.check(Schema.isGreaterThan(0))),
  subRequests: boundedInteger.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});

/** Validate host configuration and fill each omitted budget with its safe default. */
export function guestLimits(input: Partial<GuestLimits> = {}): GuestLimits {
  return Object.freeze(
    Schema.decodeUnknownSync(limitsSchema)({
      cpuMs: input.cpuMs ?? 1000,
      subRequests: input.subRequests ?? 50,
    }),
  );
}
