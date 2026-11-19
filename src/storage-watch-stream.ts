import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  AppStorageEvent,
  AppStorageError,
  AppStorageResult,
} from "@fungi.computer/agar/storage";
import type { StorageWatch, StorageWatchFrame } from "./storage-watch-wire.js";

/** The owner's answer for one key: its change stream, or why it refuses it. */
export type StorageKeyWatch = AppStorageResult<
  Stream.Stream<AppStorageEvent | null, AppStorageError>
>;

/**
 * Merge the owner's per-key change streams into one stream of server-sent
 * watch frames, each key admitted by `openKey` under fresh authority. A
 * refused key is a `rejected` frame carrying its code while the rest keep
 * flowing. The result is pull-driven, and cancelling it interrupts every key's
 * own subscription.
 */
export function storageWatchStream(
  watches: readonly StorageWatch[],
  openKey: (watch: StorageWatch) => Promise<StorageKeyWatch>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encode = (frame: StorageWatchFrame) =>
    encoder.encode(`event: watch\ndata: ${JSON.stringify(frame)}\n\n`);
  const one = (watch: StorageWatch, index: number) =>
    Stream.unwrap(
      Effect.map(
        Effect.promise(() => openKey(watch)),
        (opened) =>
          opened.kind === "rejected"
            ? Stream.make(
                encode({ watch: index, kind: "rejected", code: opened.code }),
              )
            : opened.value.pipe(
                Stream.map((event) =>
                  encode(
                    event === null
                      ? { watch: index, kind: "ready" }
                      : { watch: index, kind: "changed", event },
                  ),
                ),
              ),
      ),
    );
  return Stream.toReadableStream(
    Stream.mergeAll(watches.map(one), { concurrency: "unbounded" }),
  );
}
