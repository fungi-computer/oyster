import { expect, it } from "vitest";
import { observeDesktopGill } from "../../src/page/gill-observation.js";

it("leaves nothing listening when stream construction fails", async () => {
  let calls = 0;
  const focus = new EventTarget();
  expect(() =>
    observeDesktopGill(
      () => {
        calls += 1;
        return Promise.resolve();
      },
      () => {
        throw new Error("Construction failed");
      },
      focus,
    ),
  ).toThrow("Construction failed");
  focus.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(calls).toBe(0);
});

it("refreshes on actual ready/changed signals, not transient reconnect errors", async () => {
  let calls = 0;
  let stopped = 0;
  class Source extends EventTarget {
    close() {
      stopped += 1;
    }
  }
  const source = new Source();
  const close = observeDesktopGill(
    () => {
      calls += 1;
      return Promise.resolve();
    },
    () => source,
    new EventTarget(),
  );
  source.dispatchEvent(new Event("error"));
  await Promise.resolve();
  expect(calls).toBe(0);
  for (const event of ["ready", "rows", "changed", "reset"])
    source.dispatchEvent(new Event(event));
  await Promise.resolve();
  expect(calls).toBe(4);
  close();
  close();
  expect(stopped).toBe(1);
  source.dispatchEvent(new Event("changed"));
  expect(calls).toBe(4);
});
