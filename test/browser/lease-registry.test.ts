import { describe, expect, it } from "vitest";
import { createLeaseRegistry } from "../../src/browser/lease-registry.js";
import {
  CloudBrowserCapacityExceeded,
  CloudBrowserLeaseNotFound,
  CloudBrowserLeasePaused,
} from "../../src/browser/errors.js";

const owner = Object.freeze({
  teamId: "team-1",
  agentId: "agent-1",
  sessionId: "session-1",
});
const otherSession = Object.freeze({ ...owner, sessionId: "session-2" });

function registry(now = () => 0) {
  return createLeaseRegistry({
    maxConcurrentPerTeam: 2,
    maxLifetimeMs: 30 * 60_000,
    idleTimeoutMs: 5 * 60_000,
    now,
  });
}

describe("cloud browser lease registry", () => {
  it("counts reservations and leases against the per-Team cap", () => {
    const leases = registry();
    leases.reserve("lease-1", owner);
    leases.register("lease-1", owner, 0);
    leases.reserve("lease-2", owner);
    expect(() => {
      leases.reserve("lease-reserved", owner);
    }).toThrow(CloudBrowserCapacityExceeded);
    leases.abandon("lease-2");
    leases.reserve("lease-3", owner);
    expect(leases.count(owner.teamId)).toBe(2);
  });

  it("refuses a call from a different Session", () => {
    const leases = registry();
    leases.register("lease-1", owner, 0);
    expect(() => {
      leases.touch("lease-1", otherSession);
    }).toThrow(CloudBrowserLeaseNotFound);
  });

  it("refuses an unknown lease", () => {
    const leases = registry();
    expect(() => {
      leases.touch("missing", owner);
    }).toThrow(CloudBrowserLeaseNotFound);
  });

  it("reaps a lease past its idle timeout and refuses further access", () => {
    let clock = 0;
    const leases = registry(() => clock);
    leases.register("lease-1", owner, 0);
    clock = 6 * 60_000;
    expect(leases.expired()).toEqual(["lease-1"]);
    expect(() => {
      leases.touch("lease-1", owner);
    }).toThrow(CloudBrowserLeaseNotFound);
  });

  it("reaps a lease past its max lifetime even if continuously active", () => {
    let clock = 0;
    const leases = registry(() => clock);
    leases.register("lease-1", owner, 0);
    // Touch every 4 minutes (under the 5-minute idle timeout) until just
    // past the 30-minute lifetime, so only the lifetime bound can expire it.
    for (clock = 4 * 60_000; clock <= 28 * 60_000; clock += 4 * 60_000)
      leases.touch("lease-1", owner);
    clock = 31 * 60_000;
    expect(leases.expired()).toEqual(["lease-1"]);
  });

  it("pauses a lease for handoff and blocks the Agent until resume", () => {
    const leases = registry();
    leases.register("lease-1", owner, 0);
    leases.pause("lease-1");
    expect(() => {
      leases.touch("lease-1", owner);
    }).toThrow(CloudBrowserLeasePaused);
    leases.resume("lease-1", owner.teamId);
    expect(() => {
      leases.touch("lease-1", owner);
    }).not.toThrow();
  });

  it("lets a Team member touch a paused lease by Team only", () => {
    const leases = registry();
    leases.register("lease-1", owner, 0);
    leases.pause("lease-1");
    expect(() => {
      leases.touchAsMember("lease-1", owner.teamId);
    }).not.toThrow();
    expect(() => {
      leases.touchAsMember("lease-1", "other-team");
    }).toThrow(CloudBrowserLeaseNotFound);
  });

  it("releases a lease so it no longer counts toward the cap", () => {
    const leases = registry();
    leases.register("lease-1", owner, 0);
    leases.release("lease-1");
    expect(leases.count(owner.teamId)).toBe(0);
    expect(() => {
      leases.touch("lease-1", owner);
    }).toThrow(CloudBrowserLeaseNotFound);
  });
});
