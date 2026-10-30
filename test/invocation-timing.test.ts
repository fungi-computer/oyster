import { afterEach, expect, it, vi } from "vitest";
import { reportSlowInvocation } from "../src/internal/invocation-timing.js";

afterEach(() => vi.restoreAllMocks());

it("names where a slow invocation waited", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  reportSlowInvocation(
    "repos.list",
    { bindingWaits: { count: 2, ms: 150 } },
    { entered: 1000, verified: 1010, admitted: 1060 },
    () => 1700,
  );
  expect(log).toHaveBeenCalledWith("Slow App invocation", {
    name: "repos.list",
    totalMs: 700,
    verifyMs: 10,
    permitMs: 50,
    runMs: 640,
    bindingCalls: 2,
    bindingMs: 150,
  });
});

it("stays quiet for a fast invocation", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  reportSlowInvocation(
    "layout.get",
    { bindingWaits: { count: 1, ms: 20 } },
    { entered: 1000, verified: 1001, admitted: 1002 },
    () => 1100,
  );
  expect(log).not.toHaveBeenCalled();
});
