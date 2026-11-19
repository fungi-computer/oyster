import * as Schema from "effect/Schema";
import { appStorageReadResultSchema } from "@fungi.computer/agar/storage";
import { afterEach, expect, it, vi } from "vitest";
import {
  SharedStorageEvents,
  type StorageWatchMessage,
} from "../../src/page/storage-events.js";
import { oysterStorageHandle } from "../../src/page/storage.js";
import {
  maxStorageWatches,
  storageWatchSchema,
  type StorageWatchFrame,
} from "../../src/storage-watch-wire.js";

class FakeSource {
  static created: FakeSource[] = [];
  closed = false;
  readonly #listeners = new Set<(message: { data: string }) => void>();
  constructor(readonly url: string) {
    FakeSource.created.push(this);
  }
  addEventListener(
    _type: "watch",
    listener: (message: { data: string }) => void,
  ) {
    this.#listeners.add(listener);
  }
  close() {
    this.closed = true;
  }
  say(frame: StorageWatchFrame) {
    for (const listener of this.#listeners)
      listener({ data: JSON.stringify(frame) });
  }
}

function shared() {
  const sources: FakeSource[] = [];
  const events = new SharedStorageEvents((url) => {
    const source = new FakeSource(url);
    sources.push(source);
    return source;
  });
  return { events, sources };
}

const settle = () =>
  new Promise<void>((done) => {
    queueMicrotask(done);
  });
const watched = (source: FakeSource | undefined) =>
  new URL(source?.url ?? "", "http://x").searchParams.getAll("watch");
const change = {
  appId: "app",
  key: "state",
  scope: "team",
  revision: 1,
} as const;

it("nine watched keys share one open stream", async () => {
  const { events, sources } = shared();
  for (let index = 0; index < 9; index++)
    events.subscribe(`app-${String(index)}`, "state", () => undefined);
  await settle();
  expect(sources).toHaveLength(1);
  expect(watched(sources[0])).toHaveLength(9);
});

it("delivers each frame only to its own watcher and reopens when the set changes", async () => {
  const { events, sources } = shared();
  const first: StorageWatchMessage[] = [];
  const second: StorageWatchMessage[] = [];
  events.subscribe("a", "k", (message) => {
    first.push(message);
  });
  const stopSecond = events.subscribe("b", "k", (message) => {
    second.push(message);
  });
  await settle();
  sources[0]?.say({ watch: 1, kind: "changed", event: change });
  expect(first).toEqual([]);
  expect(second).toEqual([{ kind: "changed", event: change }]);
  stopSecond();
  await settle();
  expect(sources).toHaveLength(2);
  expect(sources[0]?.closed).toBe(true);
  expect(watched(sources[1])).toHaveLength(1);
});

it("closes the stream when the last watcher leaves", async () => {
  const { events, sources } = shared();
  const stop = events.subscribe("a", "k", () => undefined);
  await settle();
  stop();
  await settle();
  expect(sources).toHaveLength(1);
  expect(sources[0]?.closed).toBe(true);
});

it("tells a refused watcher once, keeps its code, and leaves it out of every reopen", async () => {
  const { events, sources } = shared();
  const refused: StorageWatchMessage[] = [];
  events.subscribe("a", "k", (message) => {
    refused.push(message);
  });
  events.subscribe("b", "k", () => undefined);
  await settle();
  sources[0]?.say({ watch: 0, kind: "rejected", code: "undeclared_key" });
  sources[0]?.say({ watch: 0, kind: "rejected", code: "undeclared_key" });
  expect(refused).toEqual([{ kind: "rejected", code: "undeclared_key" }]);
  events.subscribe("c", "k", () => undefined);
  await settle();
  expect(
    watched(sources[1]).map(
      (raw) =>
        Schema.decodeUnknownSync(Schema.fromJsonString(storageWatchSchema))(
          raw,
        )[0],
    ),
  ).toEqual(["b", "c"]);
});

it("refuses a watcher past the page limit with a reason instead of throwing", async () => {
  const { events, sources } = shared();
  for (let index = 0; index < maxStorageWatches; index++)
    events.subscribe(`app-${String(index)}`, "state", () => undefined);
  const over: StorageWatchMessage[] = [];
  expect(() =>
    events.subscribe("one-too-many", "state", (message) => {
      over.push(message);
    }),
  ).not.toThrow();
  await settle();
  expect(over).toEqual([{ kind: "rejected", code: "quota_exceeded" }]);
  expect(watched(sources[0])).toHaveLength(maxStorageWatches);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("a refused App watch reaches Agar as the owner's code, not as unavailable", async () => {
  FakeSource.created = [];
  vi.stubGlobal("EventSource", FakeSource);
  const handle = await oysterStorageHandle("app-refused").openEvents("state");
  const answer = handle.fetch(
    new Request("https://app-storage.invalid/events"),
  );
  await settle();
  FakeSource.created
    .at(-1)
    ?.say({ watch: 0, kind: "rejected", code: "undeclared_key" });
  const response = await answer;
  expect(response.ok).toBe(false);
  // The exact decoder Agar applies to a refused watch.
  expect(
    Schema.decodeUnknownSync(appStorageReadResultSchema)(await response.json()),
  ).toEqual({ kind: "rejected", code: "undeclared_key" });
});
