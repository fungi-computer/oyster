import * as Schema from "effect/Schema";
import type {
  appStorageErrorCodes,
  AppStorageEvent,
} from "@fungi.computer/agar/storage";
import {
  maxStorageWatches,
  storageWatchFrameSchema,
} from "../storage-watch-wire.js";

/** The part of an EventSource the shared stream needs. */
export type WatchSource = {
  addEventListener(
    type: "watch",
    listener: (message: { data: string }) => void,
  ): void;
  close(): void;
};

/** What one watched key's stream said: its signals, or why the owner refused it. */
export type StorageWatchMessage =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "changed"; event: AppStorageEvent }>
  | Readonly<{ kind: "rejected"; code: (typeof appStorageErrorCodes)[number] }>;

type Subscriber = {
  readonly installationId: string;
  readonly key: string;
  readonly listener: (message: StorageWatchMessage) => void;
  /** A refused watch is told once and left out of every later reopen. */
  refused: boolean;
};

/**
 * Every storage key this page watches rides one shared event stream. A browser
 * allows six connections per HTTP/1.1 host, so one stream per open App would
 * starve every later request. The stream reopens when the watched set changes.
 */
export class SharedStorageEvents {
  readonly #subscribers = new Map<number, Subscriber>();
  readonly #open: (url: string) => WatchSource;
  #source: WatchSource | null = null;
  #next = 0;
  #pending = false;

  constructor(
    open: (url: string) => WatchSource = (url) =>
      new EventSource(url, { withCredentials: true }),
  ) {
    this.#open = open;
  }

  /**
   * Watch one key until the returned function is called. Past the page's watch
   * limit the watcher is refused with `quota_exceeded`, like any other refusal.
   */
  subscribe(
    installationId: string,
    key: string,
    listener: (message: StorageWatchMessage) => void,
  ): () => void {
    const id = this.#next++;
    if (this.#subscribers.size >= maxStorageWatches) {
      queueMicrotask(() => {
        listener({ kind: "rejected", code: "quota_exceeded" });
      });
      return () => undefined;
    }
    this.#subscribers.set(id, {
      installationId,
      key,
      listener,
      refused: false,
    });
    this.#reopen();
    return () => {
      if (this.#subscribers.delete(id)) this.#reopen();
    };
  }

  #reopen() {
    if (this.#pending) return;
    this.#pending = true;
    queueMicrotask(() => {
      this.#pending = false;
      const previous = this.#source;
      const live = [...this.#subscribers].filter(([, { refused }]) => !refused);
      if (live.length === 0) {
        this.#source = null;
      } else {
        const query = new URLSearchParams();
        for (const [, { installationId, key }] of live)
          query.append("watch", JSON.stringify([installationId, key]));
        const source = this.#open(`/api/workbench/storage-events?${query}`);
        source.addEventListener("watch", (message) => {
          const frame = Schema.decodeUnknownOption(
            Schema.fromJsonString(storageWatchFrameSchema),
          )(message.data);
          if (frame._tag === "None") return;
          const entry = live[frame.value.watch];
          if (entry === undefined) return;
          const subscriber = entry[1];
          if (frame.value.kind === "rejected") {
            if (subscriber.refused) return;
            subscriber.refused = true;
            subscriber.listener({ kind: "rejected", code: frame.value.code });
            return;
          }
          subscriber.listener(
            frame.value.kind === "ready"
              ? { kind: "ready" }
              : { kind: "changed", event: frame.value.event },
          );
        });
        this.#source = source;
      }
      previous?.close();
    });
  }
}

/** The page's one shared watcher. */
export const storageEvents = new SharedStorageEvents();

/**
 * An EventSource-shaped watch of one key, for the Desktop's observation.
 * A refusal is reported once to `refused`; the watch then stays quiet.
 */
export function watchStorageKey(
  installationId: string,
  key: string,
  refused: (code: (typeof appStorageErrorCodes)[number]) => void,
  events: SharedStorageEvents = storageEvents,
): Pick<EventTarget, "addEventListener"> & { close(): void } {
  const target = new EventTarget();
  const stop = events.subscribe(installationId, key, (message) => {
    if (message.kind === "rejected") refused(message.code);
    else target.dispatchEvent(new Event(message.kind));
  });
  return {
    addEventListener: (type, listener, options) => {
      target.addEventListener(type, listener, options);
    },
    close: stop,
  };
}
