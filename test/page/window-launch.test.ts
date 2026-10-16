import { describe, expect, it } from "vitest";
import { createWindowLaunchTracker } from "../../src/page/window-launch.js";

const first = {
  kind: "navigate" as const,
  requestId: "open-a",
  params: [{ key: "path", value: "/a.txt" }],
};
const second = {
  kind: "navigate" as const,
  requestId: "open-b",
  params: [{ key: "path", value: "/b.txt" }],
};

describe("window launch tracker", () => {
  it("starts at the window's first open request and Computer", () => {
    const tracker = createWindowLaunchTracker({
      openRequest: first,
      computerId: "computer-a",
    });
    expect(tracker.current()).toEqual({
      openRequest: first,
      computerId: "computer-a",
    });
  });

  it("advances to the latest reconfigured launch; a later read never reverts to the first one", () => {
    const tracker = createWindowLaunchTracker({
      openRequest: first,
      computerId: "computer-a",
    });
    tracker.advance({ openRequest: second, computerId: "computer-b" });
    // A restore (setVisibility) reads the tracker again here, as the real
    // host does; it must see the advanced target, not the first open.
    expect(tracker.current()).toEqual({
      openRequest: second,
      computerId: "computer-b",
    });
    expect(tracker.current()).toEqual({
      openRequest: second,
      computerId: "computer-b",
    });
  });

  it("holds a null open request once reconfigured to one", () => {
    const tracker = createWindowLaunchTracker({
      openRequest: first,
      computerId: "computer-a",
    });
    tracker.advance({ openRequest: null, computerId: "computer-a" });
    expect(tracker.current().openRequest).toBeNull();
  });
});
