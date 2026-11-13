import type { UiBootCheckOutcome } from "../boot-gate.js";

/** One Release and the version of the check that judges it. */
export type BootRunKey = Readonly<{ releaseId: string; checkVersion: string }>;

/** Why a check could not judge the page. */
export type NotCheckedCode = Extract<
  UiBootCheckOutcome,
  { kind: "not_checked" }
>["code"];

/** What an ask for the key's run slot learns. */
export type BootRunClaim =
  | Readonly<{ kind: "acquired" }>
  /** Another asker is running the check right now. */
  | Readonly<{ kind: "held" }>
  /** The last run was inconclusive a moment ago; it is reused, not retried. */
  | Readonly<{ kind: "cooling"; code: NotCheckedCode }>;

/**
 * The run slot for one key, in a store every isolate shares (the Hub's
 * catalog D1). `acquire` is one atomic step: it hands the slot to exactly one
 * asker unless a live claim exists, and a claim past its lease is free, so a
 * crashed holder never blocks the Release.
 */
export type BootRunClaims = Readonly<{
  /** Take the key's slot, or learn who holds it or why it is cooling. */
  acquire: (
    input: BootRunKey &
      Readonly<{ claimId: string; now: number; leaseMs: number }>,
  ) => Promise<BootRunClaim>;
  /**
   * End the holder's claim. With `cooling`, keep the slot closed for `coolMs`
   * so waiters and new asks share the inconclusive reason; without it the slot
   * is free at once. A claim another asker holds is left alone.
   */
  finish: (
    input: BootRunKey &
      Readonly<{
        claimId: string;
        now: number;
        cooling: Readonly<{ code: NotCheckedCode; coolMs: number }> | null;
      }>,
  ) => Promise<void>;
}>;

/** Everything one single-flight boot ask needs. */
export type SingleFlightBootInput = BootRunKey &
  Readonly<{
    claims: BootRunClaims;
    /** The recorded definitive outcome for the key, or null. */
    recorded: () => Promise<UiBootCheckOutcome | null>;
    /** One check; may open a browser session. */
    run: () => Promise<UiBootCheckOutcome>;
    /** Record a definitive outcome; the stored one wins. */
    record: (
      outcome: Exclude<UiBootCheckOutcome, { kind: "not_checked" }>,
    ) => Promise<UiBootCheckOutcome>;
    /** The clock, epoch ms. */
    now: () => number;
    /** Wait between polls of a held slot. */
    sleep: (ms: number) => Promise<void>;
    /** A host-minted identity for one attempt to take the slot. */
    newClaimId: () => string;
    /** Longer than one `run`, cleanup included. */
    leaseMs: number;
    pollMs: number;
    /** How long an inconclusive reason is shared. */
    coolMs: number;
    /** The longest a waiter holds on before giving up as `boot_timeout`. */
    maxWaitMs: number;
  }>;

/**
 * At most one boot check per Release and check version is in flight across
 * every caller sharing `claims`. A definitive outcome is recorded and read by
 * everyone after. A waiter reuses whatever the holder produced: the recorded
 * verdict, or its inconclusive reason for `coolMs`. An inconclusive outcome is
 * never a verdict and never reported as a pass; once the cooldown ends the
 * next ask checks again.
 */
export async function singleFlightBoot(
  input: SingleFlightBootInput,
): Promise<UiBootCheckOutcome> {
  const key = { releaseId: input.releaseId, checkVersion: input.checkVersion };
  const startedAt = input.now();
  for (;;) {
    const stored = await input.recorded();
    if (stored !== null) return stored;
    const claimId = input.newClaimId();
    const claim = await input.claims.acquire({
      ...key,
      claimId,
      now: input.now(),
      leaseMs: input.leaseMs,
    });
    if (claim.kind === "cooling")
      return { kind: "not_checked", code: claim.code };
    if (claim.kind === "acquired") return await held(input, key, claimId);
    if (input.now() - startedAt >= input.maxWaitMs)
      return { kind: "not_checked", code: "boot_timeout" };
    await input.sleep(input.pollMs);
  }
}

async function held(
  input: SingleFlightBootInput,
  key: BootRunKey,
  claimId: string,
): Promise<UiBootCheckOutcome> {
  let cooling: { code: NotCheckedCode; coolMs: number } | null = null;
  try {
    // A verdict recorded between the read and the claim needs no run.
    const stored = await input.recorded();
    if (stored !== null) return stored;
    const outcome = await input.run();
    if (outcome.kind !== "not_checked") return await input.record(outcome);
    cooling = { code: outcome.code, coolMs: input.coolMs };
    return outcome;
  } finally {
    await input.claims.finish({ ...key, claimId, now: input.now(), cooling });
  }
}
