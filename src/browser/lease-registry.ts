import {
  CloudBrowserCapacityExceeded,
  CloudBrowserLeaseNotFound,
  CloudBrowserLeasePaused,
} from "./errors.js";

/**
 * The one place that binds a cloud-browser lease to the (teamId, agentId,
 * sessionId) that opened it, enforces the per-Team concurrent cap, and times
 * leases out. The provider (`sessions.ts`) only knows CDP connections; it
 * has no idea which Team or Session owns one.
 * This registry is in-process (one Hub instance): see the report for why a
 * durable, cross-instance counter (the `TeamDO`-backed shape Computer
 * admission uses) is the better home for this long-term.
 */

export type LeaseOwner = Readonly<{
  teamId: string;
  agentId: string;
  sessionId: string;
}>;

export type LeaseRecord = LeaseOwner & {
  leaseId: string;
  openedAt: number;
  lastActiveAt: number;
  /** Set by `cloudBrowser.handoff`; cleared when a member presses "Done". */
  paused: boolean;
};

export type LeaseRegistryConfig = Readonly<{
  /** Concurrent open leases one Team may hold. LIMIT DECISION PENDING (Levi). */
  maxConcurrentPerTeam: number;
  /** A lease older than this is reaped even if active. */
  maxLifetimeMs: number;
  /** A lease idle this long is reaped. */
  idleTimeoutMs: number;
  now?: () => number;
}>;

export type LeaseRegistry = Readonly<{
  /**
   * Reserve one of the Team's slots for an open still in flight. Throws
   * `CloudBrowserCapacityExceeded` when registered leases plus reservations
   * already fill the cap, so concurrent opens cannot overshoot it.
   */
  reserve: (leaseId: string, owner: LeaseOwner) => void;
  /** Give back a reservation whose open failed. */
  abandon: (leaseId: string) => void;
  /** Turn a reservation into an open lease. */
  /** `openedAt` is when the provider session was requested: lifetime and billing start there. */
  register: (leaseId: string, owner: LeaseOwner, openedAt: number) => void;
  /** Throws `CloudBrowserLeaseNotFound` for a wrong owner, unknown, or expired lease. */
  touch: (leaseId: string, owner: LeaseOwner) => void;
  release: (leaseId: string) => void;
  /** Leases past their idle timeout or max lifetime, for a reap sweep. */
  expired: () => readonly string[];
  /** Read-only lookup, e.g. to bill a closing lease's real elapsed time. */
  get: (leaseId: string) => Readonly<LeaseRecord> | undefined;
  count: (teamId: string) => number;
  /** `cloudBrowser.handoff`: the Agent cannot drive the lease until `resume`. */
  pause: (leaseId: string) => void;
  /** The member's "Done": the Agent may drive the lease again. */
  resume: (leaseId: string, teamId: string) => void;
  /**
   * The live view's own admission: Team membership, not Agent identity.
   * Throws `CloudBrowserLeaseNotFound` for a lease outside this Team.
   */
  touchAsMember: (leaseId: string, teamId: string) => void;
}>;

export function createLeaseRegistry(
  config: LeaseRegistryConfig,
): LeaseRegistry {
  const now = config.now ?? Date.now;
  const leases = new Map<string, LeaseRecord>();
  const reserved = new Map<string, string>();

  function countFor(teamId: string): number {
    let total = 0;
    for (const lease of leases.values())
      if (lease.teamId === teamId) total += 1;
    for (const reservedTeam of reserved.values())
      if (reservedTeam === teamId) total += 1;
    return total;
  }

  function isExpired(lease: LeaseRecord, at: number): boolean {
    return (
      at - lease.openedAt > config.maxLifetimeMs ||
      at - lease.lastActiveAt > config.idleTimeoutMs
    );
  }

  function ownedBy(lease: LeaseRecord, owner: LeaseOwner): boolean {
    return (
      lease.teamId === owner.teamId &&
      lease.agentId === owner.agentId &&
      lease.sessionId === owner.sessionId
    );
  }

  return {
    reserve: (leaseId, owner) => {
      if (countFor(owner.teamId) >= config.maxConcurrentPerTeam)
        throw new CloudBrowserCapacityExceeded({
          teamId: owner.teamId,
          limit: config.maxConcurrentPerTeam,
        });
      reserved.set(leaseId, owner.teamId);
    },
    abandon: (leaseId) => {
      reserved.delete(leaseId);
    },
    register: (leaseId, owner, openedAt) => {
      reserved.delete(leaseId);
      leases.set(leaseId, {
        ...owner,
        leaseId,
        openedAt,
        lastActiveAt: now(),
        paused: false,
      });
    },
    touch: (leaseId, owner) => {
      const lease = leases.get(leaseId);
      if (lease === undefined) throw new CloudBrowserLeaseNotFound({ leaseId });
      const at = now();
      if (isExpired(lease, at)) {
        leases.delete(leaseId);
        throw new CloudBrowserLeaseNotFound({ leaseId });
      }
      if (!ownedBy(lease, owner))
        throw new CloudBrowserLeaseNotFound({ leaseId });
      if (lease.paused) throw new CloudBrowserLeasePaused({ leaseId });
      lease.lastActiveAt = at;
    },
    touchAsMember: (leaseId, teamId) => {
      const lease = leases.get(leaseId);
      if (lease === undefined) throw new CloudBrowserLeaseNotFound({ leaseId });
      const at = now();
      if (isExpired(lease, at)) {
        leases.delete(leaseId);
        throw new CloudBrowserLeaseNotFound({ leaseId });
      }
      if (lease.teamId !== teamId)
        throw new CloudBrowserLeaseNotFound({ leaseId });
      lease.lastActiveAt = at;
    },
    release: (leaseId) => {
      leases.delete(leaseId);
    },
    expired: () => {
      const at = now();
      const ids: string[] = [];
      for (const lease of leases.values())
        if (isExpired(lease, at)) ids.push(lease.leaseId);
      return ids;
    },
    get: (leaseId) => leases.get(leaseId),
    count: countFor,
    pause: (leaseId) => {
      const lease = leases.get(leaseId);
      if (lease !== undefined) lease.paused = true;
    },
    resume: (leaseId, teamId) => {
      const lease = leases.get(leaseId);
      if (lease?.teamId !== teamId) return;
      lease.paused = false;
      lease.lastActiveAt = now();
    },
  };
}
