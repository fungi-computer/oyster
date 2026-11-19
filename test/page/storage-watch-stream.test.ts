import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect, it } from "vitest";
import {
  storageWatchStream,
  type StorageKeyWatch,
} from "../../src/storage-watch-stream.js";
import {
  storageWatchFrameSchema,
  type StorageWatch,
} from "../../src/storage-watch-wire.js";

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(storageWatchFrameSchema),
);

async function frames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
) {
  const decoder = new TextDecoder();
  let text = "";
  while ((text.match(/\n\n/g) ?? []).length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: watch"))
    .map((block) => decode(block.split("data: ")[1]));
}

const watches = (count: number) =>
  Array.from({ length: count }, (_, index): StorageWatch => [
    `app-${String(index)}`,
    "state",
  ]);

/** A key stream that stays open and counts itself while it is subscribed. */
function counted() {
  const state = { live: 0, opened: 0 };
  const open = (): StorageKeyWatch => ({
    kind: "accepted",
    value: Stream.unwrap(
      Effect.sync(() => {
        state.live++;
        state.opened++;
        return Stream.make(null).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(
            Effect.sync(() => {
              state.live--;
            }),
          ),
        );
      }),
    ),
  });
  return { state, open };
}

it("cancelling the shared stream releases every upstream key subscription", async () => {
  const { state, open } = counted();
  const reader = storageWatchStream(watches(9), () =>
    Promise.resolve(open()),
  ).getReader();
  const seen = await frames(reader, 9);
  expect(seen.filter(({ kind }) => kind === "ready")).toHaveLength(9);
  expect(state.live).toBe(9);
  await reader.cancel();
  await expect.poll(() => state.live).toBe(0);
  expect(state.opened).toBe(9);
});

it("a refused key keeps its code and the other keys keep flowing", async () => {
  const { state, open } = counted();
  const reader = storageWatchStream(watches(3), ([installationId]) =>
    Promise.resolve(
      installationId === "app-1"
        ? ({ kind: "rejected", code: "undeclared_key" } as const)
        : open(),
    ),
  ).getReader();
  const seen = await frames(reader, 3);
  expect(seen).toContainEqual({
    watch: 1,
    kind: "rejected",
    code: "undeclared_key",
  });
  expect(seen.filter(({ kind }) => kind === "ready")).toHaveLength(2);
  await reader.cancel();
  await expect.poll(() => state.live).toBe(0);
});
