import { describe, expect, it } from "vitest";
import type { UiBootCheckOutcome } from "../../src/boot-gate.js";
import {
  singleFlightBoot,
  type BootRunClaim,
  type BootRunClaims,
  type SingleFlightBootInput,
} from "../../src/browser/boot-once.js";

const key = { releaseId: "rel_once01", checkVersion: "boot-v1" } as const;

/** The shared claim store with the atomic acquire a D1 statement gives. */
function memoryClaims(): BootRunClaims {
  let row:
    { claimId: string; cooling: string | null; expiresAt: number } | undefined;
  return {
    acquire: ({ claimId, now, leaseMs }) => {
      if (row !== undefined && row.expiresAt > now) {
        const live = row;
        return Promise.resolve<BootRunClaim>(
          live.cooling === null
            ? { kind: "held" }
            : { kind: "cooling", code: "boot_timeout" },
        );
      }
      row = { claimId, cooling: null, expiresAt: now + leaseMs };
      return Promise.resolve<BootRunClaim>({ kind: "acquired" });
    },
    finish: ({ claimId, now, cooling }) => {
      if (row?.claimId === claimId)
        row =
          cooling === null
            ? undefined
            : {
                claimId,
                cooling: cooling.code,
                expiresAt: now + cooling.coolMs,
              };
      return Promise.resolve();
    },
  };
}

function harness(
  outcomes: readonly UiBootCheckOutcome[],
  overrides: Partial<SingleFlightBootInput> = {},
) {
  let runs = 0;
  let ids = 0;
  let verdict: UiBootCheckOutcome | null = null;
  const claims = memoryClaims();
  const input: SingleFlightBootInput = {
    ...key,
    claims,
    recorded: () => Promise.resolve(verdict),
    run: async () => {
      const outcome = outcomes[Math.min(runs, outcomes.length - 1)];
      runs += 1;
      // The browser session is slow; every other asker arrives meanwhile.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      if (outcome === undefined) throw new Error("no outcome");
      return outcome;
    },
    record: (outcome) => {
      verdict ??= outcome;
      return Promise.resolve(verdict);
    },
    now: Date.now,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    newClaimId: () => `claim-${String((ids += 1))}`,
    leaseMs: 1_000,
    pollMs: 2,
    coolMs: 500,
    maxWaitMs: 2_000,
    ...overrides,
  };
  return { input, runs: () => runs };
}

describe("one boot check per Release", () => {
  it("starts exactly one check for N concurrent installs of a Release", async () => {
    const { input, runs } = harness([{ kind: "passed" }]);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => singleFlightBoot(input)),
    );
    expect(runs()).toBe(1);
    expect(results).toEqual(
      Array.from({ length: 50 }, () => ({ kind: "passed" })),
    );
  });

  it("shares a definitive failure with every waiter", async () => {
    const failed = { kind: "failed", code: "ui_mount_failed" } as const;
    const { input, runs } = harness([failed]);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => singleFlightBoot(input)),
    );
    expect(runs()).toBe(1);
    expect(results.every((result) => result.kind === "failed")).toBe(true);
    expect(await singleFlightBoot(input)).toEqual(failed);
    expect(runs()).toBe(1);
  });

  it("never reports an inconclusive run as a pass, and shares its reason", async () => {
    const timeout = { kind: "not_checked", code: "boot_timeout" } as const;
    const { input, runs } = harness([timeout]);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => singleFlightBoot(input)),
    );
    expect(runs()).toBe(1);
    expect(results.every((result) => result.kind === "not_checked")).toBe(true);
  });

  it("checks again once the inconclusive cooldown has passed", async () => {
    const timeout = { kind: "not_checked", code: "boot_timeout" } as const;
    const { input, runs } = harness([timeout, { kind: "passed" }], {
      coolMs: 0,
    });
    expect((await singleFlightBoot(input)).kind).toBe("not_checked");
    expect(await singleFlightBoot(input)).toEqual({ kind: "passed" });
    expect(runs()).toBe(2);
  });

  it("frees the slot when the run throws", async () => {
    const { input } = harness([{ kind: "passed" }]);
    let attempts = 0;
    const flaky: SingleFlightBootInput = {
      ...input,
      run: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("provider down"))
          : Promise.resolve({ kind: "passed" });
      },
    };
    await expect(singleFlightBoot(flaky)).rejects.toThrow("provider down");
    expect(await singleFlightBoot(flaky)).toEqual({ kind: "passed" });
  });

  it("takes over a claim whose holder vanished past its lease", async () => {
    const { input, runs } = harness([{ kind: "passed" }]);
    await input.claims.acquire({
      ...key,
      claimId: "dead",
      now: Date.now() - 1_000,
      leaseMs: 100,
    });
    expect(await singleFlightBoot(input)).toEqual({ kind: "passed" });
    expect(runs()).toBe(1);
  });

  it("gives up waiting on a holder that never finishes", async () => {
    const { input, runs } = harness([{ kind: "passed" }], {
      leaseMs: 1_000_000,
      maxWaitMs: 100,
    });
    await input.claims.acquire({
      ...key,
      claimId: "stuck",
      now: Date.now(),
      leaseMs: 1_000_000,
    });
    expect(await singleFlightBoot(input)).toEqual({
      kind: "not_checked",
      code: "boot_timeout",
    });
    expect(runs()).toBe(0);
  });
});
