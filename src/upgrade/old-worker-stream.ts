import { encode } from "@msgpack/msgpack";
import { snapshotOldSql } from "./old-worker-sql.js";

/**
 * Expose the old Durable Object's own SQLite and its pending alarm observation
 * as a backpressured byte stream. The alarm is read when export starts, not at
 * bridge deployment: null does not prove no alarm was pending at t0.
 * The Worker must require its owner key before obtaining this response. A
 * normally closed stream carries a terminal inventory; an error never does.
 * MessagePack's maintained multi-stream decoder owns the wire framing.
 */
export function streamOldSql(
  sql: SqlStorage,
  alarm: Readonly<{ pendingAt: number | null; observedAt: number }>,
): Response {
  const packets = snapshotOldSql(sql);
  let count = 0;
  let alarmSent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const next = packets.next();
        if (next.done) {
          if (!alarmSent) {
            controller.enqueue(
              encode({ kind: "part", name: "alarm", bytes: encode(alarm) }),
            );
            alarmSent = true;
            count += 1;
          } else {
            controller.enqueue(encode({ kind: "complete", partCount: count }));
            controller.close();
          }
        } else {
          controller.enqueue(
            encode({
              kind: "part",
              name: next.value.name,
              bytes: next.value.bytes,
            }),
          );
          count += 1;
        }
      } catch (cause) {
        controller.error(cause);
      }
    },
    cancel() {
      packets.return();
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/msgpack",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
