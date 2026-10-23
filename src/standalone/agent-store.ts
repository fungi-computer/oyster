import type {
  ColdSessionPage,
  ColdSessionPageRequest,
} from "@fungi.computer/shiitake";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import {
  durableObjectStorageBudget,
  openPatrol,
  openStoragePressure,
  type DurableObjectSizedStorage,
  type PatrolReport,
} from "@fungi.computer/zookeeper";

/** Log what a Zookeeper patrol pass measured; a quiet store logs nothing. */
function reportPatrol(report: PatrolReport): void {
  if (report.status === "quiet") return;
  if (report.status === "unavailable") {
    console.warn("agent zookeeper patrol unavailable", {
      stage: report.source,
      code: report.failure,
    });
    return;
  }
  console.info("agent zookeeper patrol measured", {
    storeBytes: report.usedBytes,
    sessionBytes: report.sessionBytes,
    sessionCount: report.sessions,
  });
}

/**
 * An Oyster Agent's store keeping: Zookeeper's admission check and patrol over
 * the one Durable Object budget. Shiitake's agent pack only; the Pi Durable
 * pack keeps its own store.
 */
export function agentStoreKeeping(
  storage: DurableObjectSizedStorage,
  readColdSessions: (
    request: ColdSessionPageRequest,
  ) => Promise<ColdSessionPage>,
): Required<Pick<CloudflareShiitakeOptions, "hostWork" | "storagePressure">> {
  const budget = durableObjectStorageBudget(storage);
  return {
    hostWork: [openPatrol({ budget, readColdSessions, report: reportPatrol })],
    storagePressure: openStoragePressure(budget),
  };
}
