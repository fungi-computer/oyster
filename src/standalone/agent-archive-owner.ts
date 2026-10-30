import { ShiitakeError } from "@fungi.computer/shiitake";
import type { CloudflareShiitake } from "@fungi.computer/shiitake/cloudflare";
import {
  AgentArchiveRefused,
  type ArchiveRefusalReason,
} from "@fungi.computer/shiitake/agent-control";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { agentArchive } from "./agent-archive.js";
import { reconcileArchiveSchedules } from "./agent-archive-schedules.js";
export { agentArchiveProjection } from "../agent-archive-projection.js";

export type AgentArchiveTransitionResult =
  | Readonly<{ archived: boolean; revision: number }>
  | Readonly<{
      error: ArchiveRefusalReason;
      message?: string;
      archived?: boolean;
      revision?: number;
    }>;

/** The one owner-local archive transition, admission fence and repair cursor.
 * The host lends only its existing transport and revisioned directory projection.
 */
export function agentArchiveOwner(
  deps: Readonly<{
    storage: Pick<WatchdogSqliteOwner, "sql" | "transactionSync">;
    agentId: () => string | undefined;
    agent: () => Promise<CloudflareShiitake>;
    /** Enable reconciliation where the host mounts Almanac and Loop with command grants. */
    scheduledExtensions?: boolean;
    refreshOutstanding: (agentId: string) => Promise<void>;
    record: (
      agentId: string,
      archived: boolean,
      revision: number,
    ) => Promise<boolean>;
    wake: () => Promise<void>;
    waitUntil: (task: Promise<unknown>) => void;
  }>,
) {
  const archive = agentArchive(deps.storage.sql);
  let retryAfter = 0;
  let tail: Promise<void> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const run = tail.then(action);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const repairOnce = async (): Promise<void> => {
    const state = archive.read();
    if (!state.pending) return;
    try {
      const agentId = deps.agentId();
      if (agentId === undefined)
        throw new Error("Agent archive scope is unavailable");
      if (deps.scheduledExtensions)
        await reconcileArchiveSchedules(
          await deps.agent(),
          archive,
          state.archived,
        );
      if (!(await deps.record(agentId, state.archived, state.revision)))
        throw new Error("Agent archive directory is unavailable");
      deps.storage.transactionSync(() => {
        archive.ack(state.revision);
      });
      retryAfter = 0;
    } catch (cause) {
      retryAfter = Date.now() + 30_000;
      throw cause;
    }
  };

  return {
    read: archive.read,
    assertOpen() {
      if (archive.read().archived)
        throw new ShiitakeError("contract", "archived", "Agent is archived");
    },
    work: {
      pending: () => {
        const state = archive.read();
        return {
          due: state.pending && Date.now() >= retryAfter,
          nextWakeAt: state.pending ? Math.max(Date.now(), retryAfter) : null,
        };
      },
      run: () => serialize(repairOnce),
    },
    setArchived: (archived: boolean): Promise<AgentArchiveTransitionResult> =>
      serialize(async () => {
        const agent = await deps.agent();
        const agentId = deps.agentId();
        if (agentId === undefined) return { error: "unreadable" as const };
        if (archived) {
          try {
            await deps.refreshOutstanding(agentId);
          } catch (cause) {
            console.error("agent archive settlement refresh failed", {
              kind: cause instanceof Error ? cause.name : "Unknown",
            });
            return { error: "unreadable" as const };
          }
        }
        let changed: ReturnType<typeof archive.read>;
        try {
          changed = deps.storage.transactionSync(() => {
            const before = archive.read();
            if (archived && !before.archived) {
              const busy = agent.busySync();
              if (busy !== undefined)
                throw new AgentArchiveRefused(
                  busy.kind === "session" ? "running" : "pending",
                  busy.kind === "session"
                    ? `Command ${busy.commandId} is busy in Session ${busy.sessionId}`
                    : `Delegated command ${busy.commandId} is unsettled for Agent ${busy.agentId}`,
                );
            }
            return archive.transition(archived);
          });
        } catch (error) {
          if (error instanceof AgentArchiveRefused)
            return { error: error.reason, message: error.message };
          console.error("agent archive busy read failed", {
            kind: error instanceof Error ? error.name : "Unknown",
          });
          return { error: "unreadable" as const };
        }
        if (changed.pending) {
          try {
            await repairOnce();
          } catch (error) {
            deps.waitUntil(
              deps.wake().catch((cause: unknown) => {
                console.error("agent archive repair wake failed", cause);
              }),
            );
            console.error("agent archive projection pending", {
              kind: error instanceof Error ? error.name : "Unknown",
            });
            return {
              error: "unreadable" as const,
              message:
                "Archive state changed; directory or schedule repair is pending",
              archived: changed.archived,
              revision: changed.revision,
            };
          }
        }
        return { archived: changed.archived, revision: changed.revision };
      }),
  };
}
