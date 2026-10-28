import { describe, expect, it } from "vitest";
import { computerTargetUrl } from "../../src/computer-target.js";

describe("a window's Computer routing hint", () => {
  it("does not change a fixed/default host request", () => {
    expect(computerTargetUrl("/apps/notes/backend")).toBe(
      "/apps/notes/backend",
    );
  });

  it("retains capability arguments while binding the window's target", () => {
    const target = new URL(
      computerTargetUrl(
        "/computer/read?path=%2Fworkspace%2Fhello.txt",
        "computer_a",
      ),
      "https://oyster.test",
    );
    expect(target.pathname).toBe("/computer/read");
    expect(target.searchParams.get("path")).toBe("/workspace/hello.txt");
    expect(target.searchParams.get("computerId")).toBe("computer_a");
  });

  it("does not let a capability argument replace the bound routing hint", () => {
    const target = new URL(
      computerTargetUrl("/computer/ports?computerId=computer_b", "computer_a"),
      "https://oyster.test",
    );
    expect(target.searchParams.getAll("computerId")).toEqual(["computer_a"]);
  });

  it("creates independent A/B method URLs rather than mutable shared selection", () => {
    const a = computerTargetUrl("/apps/notes/methods/write", "computer_a");
    const b = computerTargetUrl("/apps/notes/methods/write", "computer_b");
    expect(a).toBe("/apps/notes/methods/write?computerId=computer_a");
    expect(b).toBe("/apps/notes/methods/write?computerId=computer_b");
  });
});
