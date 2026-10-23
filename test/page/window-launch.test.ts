import { describe, expect, it } from "vitest";
import { createWindowLaunchTracker } from "../../src/page/window-launch.js";
import { computerTargetUrl } from "../../src/page/computer-target.js";

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
  it("preserves route input while pinning one admitted Computer, not guest selector input", () => {
    expect(
      computerTargetUrl("/files?path=%2Fnotes&computerId=forged", "A"),
    ).toBe("/files?path=%2Fnotes&computerId=A");
    expect(computerTargetUrl("/apps/notes/", "B")).toBe(
      "/apps/notes/?computerId=B",
    );
    expect(computerTargetUrl("/apps/notes/")).toBe("/apps/notes/");
  });
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
