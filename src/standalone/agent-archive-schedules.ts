import type { ShiitakeAgent } from "@fungi.computer/shiitake/client";
import {
  almanacContract,
  Schedule,
} from "@fungi.computer/shiitake-extensions/almanac";
import {
  loopContract,
  LoopProjection,
} from "@fungi.computer/shiitake-extensions/loop";
import * as Schema from "effect/Schema";
import type { agentArchive } from "./agent-archive.js";

const schedules = Schema.Array(Schedule);
const schedule = Schema.NullOr(Schedule);
const loop = Schema.NullOr(LoopProjection);

/** Reconcile extension-owned timers via their ordinary commands, not private tables.
 * Durable pause markers are written before the commands, so restart can retry.
 */
export async function reconcileArchiveSchedules(
  owner: ShiitakeAgent,
  archive: ReturnType<typeof agentArchive>,
  archived: boolean,
): Promise<void> {
  if (archived) {
    let after: string | undefined;
    do {
      const request: Readonly<Record<string, string | number>> =
        after === undefined ? { limit: 64 } : { after, limit: 64 };
      const listed = Schema.decodeUnknownSync(schedules)(
        await owner.extensions.call(almanacContract.id, "list", request),
      );
      for (const item of listed) {
        if (item.state !== "active") continue;
        archive.suspend("almanac", item.id);
        await owner.extensions.call(almanacContract.id, "pause", {
          scheduleId: item.id,
        });
      }
      after = listed.length === 64 ? listed.at(-1)?.id : undefined;
    } while (after !== undefined);

    let next: string | undefined;
    do {
      const page = await owner.listSessions(next);
      for (const row of page.sessions) {
        const slot = (await owner.session(row.sessionId).read({ limit: 1 }))
          .extensions[loopContract.id];
        if (slot?.status !== "running") continue;
        const current = Schema.decodeUnknownSync(loop)(slot.value);
        if (current?.loop.state !== "active") continue;
        archive.suspend("loop", row.sessionId);
        await owner
          .session(row.sessionId)
          .extension(loopContract.id)
          .call("pause", {});
      }
      next = page.next;
    } while (next !== undefined);
    return;
  }

  for (;;) {
    const batch = archive.suspended();
    if (batch.length === 0) break;
    for (const item of batch) {
      if (item.kind === "almanac") {
        const current = Schema.decodeUnknownSync(schedule)(
          await owner.extensions.call(almanacContract.id, "read", {
            scheduleId: item.id,
          }),
        );
        if (current?.state === "paused")
          await owner.extensions.call(almanacContract.id, "resume", {
            scheduleId: item.id,
          });
      } else {
        const slot = (await owner.session(item.id).read({ limit: 1 }))
          .extensions[loopContract.id];
        if (slot?.status === "running") {
          const current = Schema.decodeUnknownSync(loop)(slot.value);
          if (current?.loop.state === "paused")
            await owner
              .session(item.id)
              .extension(loopContract.id)
              .call("resume", {});
        }
      }
      archive.resumed(item.kind, item.id);
    }
  }
}
