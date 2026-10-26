import { defineIdFamily } from "@fungi.computer/cairn/id";
import {
  CloudBrowserLeaseNotFound,
  CloudBrowserUnavailable,
} from "./errors.js";
import {
  createLeaseRegistry,
  type LeaseOwner,
  type LeaseRegistry,
} from "./lease-registry.js";
import type {
  BinaryResult,
  CloudBrowserOperation,
  CloudBrowserOperationResult,
} from "./operations.js";
import {
  attachPage,
  clickPage,
  navigatePage,
  pdfPage,
  pressPage,
  screenshotPage,
  scrollPage,
  snapshotPage,
  typePage,
  type Page,
} from "./page.js";
import type { QuickReads } from "./quick-reads.js";
import type { CdpClient } from "./cdp-client.js";
import type { BrowserSessions } from "./sessions.js";
import { assertCloudBrowserUrlAllowed } from "./url-policy.js";

/**
 * The agent browser: one host port in, one owner-checked lease door out.
 *
 * The host supplies the provider (`sessions`, optional `quickReads`), the
 * REQUIRED metering owner and a code-only event sink. The module owns every
 * decision a host must not be able to skip: the egress URL policy on every
 * agent-supplied URL, the per-Team concurrent cap, lease ownership, idle and
 * lifetime reaping, and the billing order. A lease holds before the provider
 * session opens, starts once it is attached, releases a hold that never
 * opened and settles real elapsed time at close. A Quick Read holds before
 * the provider call, settles the browser time the provider reports and
 * releases its hold when the read fails.
 */

/**
 * One metered execution (a lease or a Quick Read), driven only by
 * `createBrowser`. `maxMs` is the execution's own ceiling: the hold covers it
 * and settlement never exceeds it.
 */
export type BrowserMeter = Readonly<{
  /** Hold credit for `maxMs`; throws to refuse the execution. */
  hold: (
    input: Readonly<{ executionId: string; maxMs: number }>,
  ) => Promise<void>;
  /** The provider did the work; the hold can no longer be released. */
  start: (input: Readonly<{ executionId: string }>) => Promise<void>;
  /** Settle the real browser time used. */
  settle: (
    input: Readonly<{ executionId: string; elapsedMs: number; maxMs: number }>,
  ) => Promise<void>;
  /** Release a hold whose provider work never happened. */
  release: (input: Readonly<{ executionId: string }>) => Promise<void>;
}>;

/** Code-only observations; never a URL, page text, token or provider body. */
export type BrowserEvent = Readonly<{
  kind:
    | "reap_close_failed"
    | "reap_settle_failed"
    | "settle_failed"
    | "open_cleanup_failed"
    | "read_release_failed"
    | "teardown_failed"
    | "teardown_abandoned";
  teamId: string;
  executionId: string;
  cause: unknown;
}>;

/** The ONE host port for config, billing and provider egress. */
export type BrowserHost = Readonly<{
  sessions: BrowserSessions;
  /** Browser Run REST Quick Reads; `null` on a BROWSER binding. */
  quickReads: QuickReads | null;
  /** Required: every lease is metered by the owner the host names. */
  meter: (owner: LeaseOwner) => BrowserMeter;
  /** Receives code-only failure observations. */
  report: (event: BrowserEvent) => void;
}>;

export type BrowserLimits = Readonly<{
  /** Concurrent open leases one Team may hold. */
  maxConcurrentPerTeam: number;
  /** A lease older than this is reaped even if active. */
  maxLifetimeMs: number;
  /** Reaped on the next operation; Browser Run also uses it as keep-alive. */
  idleTimeoutMs: number;
  /** Per-navigation load deadline. */
  navigationTimeoutMs?: number;
  /** How long a close waits for the provider to confirm a "closing" ack. */
  closeConfirmMs?: number;
  /** Whole-call deadline of one Quick Read; also its billing ceiling. */
  quickReadTimeoutMs?: number;
  /** Clock for lease ages and billed time; `Date.now` by default. */
  now?: () => number;
}>;

/** What a Team member may do to a lease an Agent handed off. */
export type BrowserMemberAction =
  | Readonly<{ kind: "screenshot" }>
  | Readonly<{ kind: "click"; x: number; y: number }>
  | Readonly<{ kind: "type"; text: string }>
  | Readonly<{ kind: "scroll"; deltaX: number; deltaY: number }>
  | Readonly<{ kind: "resume" }>;

export type Browser = Readonly<{
  /** Whether the stateless Quick Reads exist on this host. */
  quickReads: boolean;
  /** One agent call, bound to the exact (teamId, agentId, sessionId) owner. */
  call: (
    owner: LeaseOwner,
    op: CloudBrowserOperation,
    signal: AbortSignal,
  ) => Promise<CloudBrowserOperationResult>;
  /** Pause the owner's lease until a Team member presses "Done". */
  handoff: (owner: LeaseOwner, leaseId: string) => void;
  /** A Team member's door into a paused lease (membership checked by the host). */
  member: (
    teamId: string,
    leaseId: string,
    action: BrowserMemberAction,
    signal: AbortSignal,
  ) => Promise<BinaryResult | null>;
}>;

type Lease = Readonly<{ sessionId: string; client: CdpClient; page: Page }>;

/** Module-issued lease ids; provider session ids never reach the Agent. */
const leaseIds = defineIdFamily({
  family: "oyster-browser-lease",
  version: 1,
  kinds: { lease: { prefix: "lease" } },
});

/** One billing execution per Quick Read. */
const readIds = defineIdFamily({
  family: "oyster-browser-read",
  version: 1,
  kinds: { read: { prefix: "read" } },
});

export function createBrowser(
  host: BrowserHost,
  limits: BrowserLimits,
): Browser {
  const now = limits.now ?? Date.now;
  const navigationTimeoutMs = limits.navigationTimeoutMs ?? 15_000;
  const quickReadTimeoutMs = limits.quickReadTimeoutMs ?? 30_000;
  const closeConfirmMs = limits.closeConfirmMs ?? 5_000;
  const maxTeardownAttempts = 5;
  const registry: LeaseRegistry = createLeaseRegistry({
    maxConcurrentPerTeam: limits.maxConcurrentPerTeam,
    maxLifetimeMs: limits.maxLifetimeMs,
    idleTimeoutMs: limits.idleTimeoutMs,
    now,
  });
  const leases = new Map<string, Lease>();

  function lease(leaseId: string): Lease {
    const found = leases.get(leaseId);
    if (found === undefined) throw new CloudBrowserLeaseNotFound({ leaseId });
    return found;
  }

  function quickReads(): QuickReads {
    if (host.quickReads === null)
      throw new CloudBrowserUnavailable({ reason: "unconfigured" });
    return host.quickReads;
  }

  const allowed = (url: string, signal: AbortSignal) =>
    assertCloudBrowserUrlAllowed(url, { signal });

  /**
   * Provider sessions this module still owes a confirmed teardown. A lease
   * leaves the Agent's view and its bill closes at close or reap; the
   * provider session stays here until the provider confirms it ended.
   */
  const teardowns = new Map<string, { teamId: string; attempts: number }>();

  /**
   * Delete one provider session by id; confirm a "closing" ack before calling
   * it closed. Callers have already closed any CDP client of it.
   */
  async function tearDown(
    sessionId: string,
    teamId: string,
    signal: AbortSignal,
  ): Promise<"closed" | "closing"> {
    const keep = (): void => {
      const pending = teardowns.get(sessionId);
      const attempts = (pending?.attempts ?? 0) + 1;
      if (attempts > maxTeardownAttempts) {
        teardowns.delete(sessionId);
        // Browser Run has an idle backstop. Chromium does not: a context
        // abandoned here persists until Chromium restarts.
        host.report({
          kind: "teardown_abandoned",
          teamId,
          executionId: sessionId,
          cause: null,
        });
        return;
      }
      teardowns.set(sessionId, { teamId, attempts });
    };
    let acknowledged: "closed" | "closing";
    try {
      acknowledged = await host.sessions.release(sessionId, signal);
    } catch (error) {
      keep();
      throw error;
    }
    if (acknowledged === "closing")
      try {
        await host.sessions.confirmClosed(
          sessionId,
          Date.now() + closeConfirmMs,
        );
      } catch {
        keep();
        return "closing";
      }
    teardowns.delete(sessionId);
    return "closed";
  }

  /** Retry every owed teardown once; bounded by `maxTeardownAttempts` each. */
  async function retryTeardowns(signal: AbortSignal): Promise<void> {
    // Map iteration tolerates the deletes and in-place updates tearDown makes.
    for (const [sessionId, { teamId }] of teardowns)
      await tearDown(sessionId, teamId, signal).catch((cause: unknown) => {
        host.report({
          kind: "teardown_failed",
          teamId,
          executionId: sessionId,
          cause,
        });
      });
  }

  /**
   * End a lease the registry already released: it leaves the Agent's view,
   * its real elapsed time is settled even when the provider refuses the
   * delete, and the provider session stays owed in `teardowns` until
   * confirmed. A refused delete on close rethrows its typed error.
   */
  async function end(
    owner: LeaseOwner,
    leaseId: string,
    openedAt: number,
    signal: AbortSignal,
    failure: "reap" | "close",
  ): Promise<"closed" | "closing"> {
    const open = leases.get(leaseId);
    leases.delete(leaseId);
    try {
      if (open === undefined) return "closed";
      open.client.close();
      return await tearDown(open.sessionId, owner.teamId, signal);
    } catch (cause) {
      if (failure === "close") throw cause;
      host.report({
        kind: "reap_close_failed",
        teamId: owner.teamId,
        executionId: leaseId,
        cause,
      });
      return "closing";
    } finally {
      await host
        .meter(owner)
        .settle({
          executionId: leaseId,
          elapsedMs: now() - openedAt,
          maxMs: limits.maxLifetimeMs,
        })
        .catch((cause: unknown) => {
          host.report({
            kind: failure === "reap" ? "reap_settle_failed" : "settle_failed",
            teamId: owner.teamId,
            executionId: leaseId,
            cause,
          });
        });
    }
  }

  /**
   * One billed Quick Read: hold, call the provider under the module's own
   * deadline, then start and settle the browser time the provider reports
   * (the measured call time when it reports none). A failed read releases.
   */
  async function quickRead<Result>(
    owner: LeaseOwner,
    read: (
      reads: QuickReads,
      signal: AbortSignal,
    ) => Promise<Readonly<{ result: Result; browserMs: number | null }>>,
    signal: AbortSignal,
  ): Promise<Result> {
    const reads = quickReads();
    const executionId: string = readIds.read.generate();
    const meter = host.meter(owner);
    await meter.hold({ executionId, maxMs: quickReadTimeoutMs });
    const startedAt = now();
    let provided: Readonly<{ result: Result; browserMs: number | null }>;
    try {
      provided = await read(
        reads,
        AbortSignal.any([signal, AbortSignal.timeout(quickReadTimeoutMs)]),
      );
    } catch (error) {
      await meter.release({ executionId }).catch((cause: unknown) => {
        host.report({
          kind: "read_release_failed",
          teamId: owner.teamId,
          executionId,
          cause,
        });
      });
      throw error;
    }
    await meter.start({ executionId });
    await meter.settle({
      executionId,
      elapsedMs: provided.browserMs ?? now() - startedAt,
      maxMs: quickReadTimeoutMs,
    });
    return provided.result;
  }

  async function reap(signal: AbortSignal): Promise<void> {
    for (const leaseId of registry.expired()) {
      const record = registry.get(leaseId);
      registry.release(leaseId);
      if (record === undefined) continue;
      await end(record, leaseId, record.openedAt, signal, "reap");
    }
  }

  async function open(
    owner: LeaseOwner,
    rawUrl: string | null,
    signal: AbortSignal,
  ): Promise<CloudBrowserOperationResult> {
    // Egress first: the provider never sees a URL the policy refused.
    const url = rawUrl === null ? null : await allowed(rawUrl, signal);
    const leaseId: string = leaseIds.lease.generate();
    // The slot is reserved before any await, so concurrent opens count.
    registry.reserve(leaseId, owner);
    let acquired: Readonly<{ page: Page; openedAt: number }>;
    try {
      acquired = await acquireLease(owner, leaseId, signal);
    } catch (error) {
      registry.abandon(leaseId);
      throw error;
    }
    const { page, openedAt } = acquired;
    registry.register(leaseId, owner, openedAt);
    if (url === null) return { leaseId, url: null };
    try {
      const location = await navigatePage(page, url, navigationTimeoutMs);
      return { leaseId, url: location.url };
    } catch (error) {
      // A lease whose first page never loaded is not left running or unbilled.
      registry.release(leaseId);
      await end(owner, leaseId, openedAt, signal, "reap");
      throw error;
    }
  }

  /** Hold, acquire, attach and start one lease's provider session. */
  async function acquireLease(
    owner: LeaseOwner,
    leaseId: string,
    signal: AbortSignal,
  ): Promise<Readonly<{ page: Page; openedAt: number }>> {
    const meter = host.meter(owner);
    await meter.hold({ executionId: leaseId, maxMs: limits.maxLifetimeMs });
    const cleanup = (cause: unknown) => {
      host.report({
        kind: "open_cleanup_failed",
        teamId: owner.teamId,
        executionId: leaseId,
        cause,
      });
    };
    // The provider bills from the session request, so the lease's billed
    // time starts here, before create, not once it is attached.
    const openedAt = now();
    let sessionId: string;
    try {
      sessionId = await host.sessions.create(
        { keepAliveMs: limits.idleTimeoutMs },
        signal,
      );
    } catch (error) {
      await meter.release({ executionId: leaseId }).catch(cleanup);
      throw error;
    }
    // From here the provider session exists: every failure hands its id to
    // the teardown owner, which retries until the provider confirms it.
    const abandon = async (client: CdpClient | null) => {
      client?.close();
      await tearDown(sessionId, owner.teamId, signal).catch(cleanup);
    };
    let client: CdpClient;
    let page: Page;
    try {
      client = await host.sessions.connect(
        sessionId,
        AbortSignal.any([signal, AbortSignal.timeout(navigationTimeoutMs)]),
      );
    } catch (error) {
      await abandon(null);
      await meter.release({ executionId: leaseId }).catch(cleanup);
      throw error;
    }
    try {
      page = await attachPage(client);
    } catch (error) {
      await abandon(client);
      await meter.release({ executionId: leaseId }).catch(cleanup);
      throw error;
    }
    try {
      await meter.start({ executionId: leaseId });
    } catch (error) {
      // The meter released its own hold; only the provider session remains.
      await abandon(client);
      throw error;
    }
    leases.set(leaseId, { sessionId, client, page });
    return { page, openedAt };
  }

  async function driven(
    owner: LeaseOwner,
    op: Exclude<
      CloudBrowserOperation,
      Readonly<{ kind: "markdown" | "links" | "scrape" | "extract" | "open" }>
    >,
    signal: AbortSignal,
  ): Promise<CloudBrowserOperationResult> {
    if (op.kind === "close") {
      const record = registry.get(op.leaseId);
      registry.touch(op.leaseId, owner);
      const openedAt = record?.openedAt ?? now();
      registry.release(op.leaseId);
      const provider = await end(owner, op.leaseId, openedAt, signal, "close");
      return { leaseId: op.leaseId, closed: true, provider };
    }
    registry.touch(op.leaseId, owner);
    const { page } = lease(op.leaseId);
    switch (op.kind) {
      case "navigate": {
        const url = await allowed(op.url, signal);
        const location = await navigatePage(page, url, navigationTimeoutMs);
        return {
          leaseId: op.leaseId,
          url: location.url,
          status: null,
          title: location.title,
        };
      }
      case "snapshot":
        return snapshotPage(page, op.leaseId, signal);
      case "click":
        await clickPage(page, op.x, op.y, signal);
        return { leaseId: op.leaseId };
      case "type":
        await typePage(page, op.text, signal);
        return { leaseId: op.leaseId };
      case "press":
        await pressPage(page, op.key, signal);
        return { leaseId: op.leaseId };
      case "scroll":
        await scrollPage(page, op.deltaX, op.deltaY, signal);
        return { leaseId: op.leaseId };
      case "screenshot":
        return screenshotPage(page, op.leaseId, signal);
      case "pdf":
        return pdfPage(page, op.leaseId, signal);
    }
  }

  return {
    quickReads: host.quickReads !== null,
    call: async (owner, op, signal) => {
      await retryTeardowns(signal);
      await reap(signal);
      switch (op.kind) {
        case "markdown": {
          const url = await allowed(op.input.url, signal);
          return quickRead(
            owner,
            (reads, bounded) => reads.markdown(url, op.input.maxChars, bounded),
            signal,
          );
        }
        case "links": {
          const url = await allowed(op.url, signal);
          return quickRead(
            owner,
            (reads, bounded) => reads.links(url, bounded),
            signal,
          );
        }
        case "scrape": {
          const url = await allowed(op.input.url, signal);
          return quickRead(
            owner,
            (reads, bounded) => reads.scrape(url, op.input.selectors, bounded),
            signal,
          );
        }
        case "extract": {
          const url = await allowed(op.input.url, signal);
          return quickRead(
            owner,
            (reads, bounded) => reads.extract(url, op.input.prompt, bounded),
            signal,
          );
        }
        case "open":
          return open(owner, op.url, signal);
        default:
          return driven(owner, op, signal);
      }
    },
    handoff: (owner, leaseId) => {
      registry.touch(leaseId, owner);
      registry.pause(leaseId);
    },
    member: async (teamId, leaseId, action, signal) => {
      registry.touchAsMember(leaseId, teamId);
      if (action.kind === "resume") {
        registry.resume(leaseId, teamId);
        return null;
      }
      if (registry.get(leaseId)?.paused !== true)
        throw new CloudBrowserLeaseNotFound({ leaseId });
      const { page } = lease(leaseId);
      switch (action.kind) {
        case "screenshot":
          return screenshotPage(page, leaseId, signal);
        case "click":
          await clickPage(page, action.x, action.y, signal);
          return null;
        case "type":
          await typePage(page, action.text, signal);
          return null;
        case "scroll":
          await scrollPage(page, action.deltaX, action.deltaY, signal);
          return null;
      }
    },
  };
}
