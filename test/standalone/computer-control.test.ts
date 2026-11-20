import { describe, expect, it, vi } from "vitest";
import type { StandaloneRegistryRpc } from "../../src/standalone/registry.js";
import { standaloneComputerControl } from "../../src/standalone/computer-control.js";
import { computerControlSpecs } from "../../src/mcp.js";

const context = {
  executionId: "computer-control-test",
  deadlineAt: null,
  signal: new AbortController().signal,
};
type Fleet = StandaloneRegistryRpc["computerFleet"];
/** The registry's RPC results are disposable stubs; a plain value is made one. */
const rpc = <T extends object>(value: T) =>
  Object.assign(value, { [Symbol.dispose]: () => undefined });

function control(fleet: (...args: Parameters<Fleet>) => ReturnType<Fleet>) {
  return standaloneComputerControl({ computerFleet: fleet }, "member_owner");
}

describe("the owner's stop", () => {
  it.each([
    [rpc({ state: "sleeping" as const }), { kind: "stopped" }],
    [rpc({ error: "busy" }), { kind: "busy" }],
    [rpc({ error: "owner_required" }), { kind: "denied" }],
    [rpc({ error: "unknown_computer" }), { kind: "denied" }],
    [rpc({ error: "no_runtime" }), { kind: "uncertain" }],
    [null, { kind: "denied" }],
  ])("answers %j with %j", async (reply, expected) => {
    const fleet = vi.fn<Fleet>(() => Promise.resolve(reply));
    expect(await control(fleet).stop("computer_a", context)).toEqual(expected);
    expect(fleet).toHaveBeenCalledExactlyOnceWith("member_owner", {
      operation: "stop",
      computerId: "computer_a",
    });
  });

  it("says retry when the registry fails after the runtime may have stopped", async () => {
    expect(
      await control(() => Promise.reject(new Error("rpc"))).stop(
        "computer_a",
        context,
      ),
    ).toEqual({ kind: "uncertain" });
  });
});

describe("delete on Oyster", () => {
  const fleet = vi.fn<Fleet>((_member, request) =>
    Promise.resolve(
      request.operation === "list"
        ? rpc({
            computers: [
              {
                computerId: "computer_a",
                name: "cedar",
                size: "default" as const,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            nextOffset: null,
          })
        : null,
    ),
  );
  const specs = computerControlSpecs(control(fleet));

  it("is unsupported, since Oyster has no path that also erases the Workspace", async () => {
    expect(
      await specs.delete.execute(
        { computerId: "computer_a", confirmHandle: "cedar" },
        context,
      ),
    ).toEqual({ kind: "unsupported" });
    // Nothing but the name lookup reached the registry.
    expect(fleet.mock.calls.map(([, request]) => request.operation)).toEqual([
      "list",
    ]);
  });

  it("still refuses a handle that is not the Computer's name, and an unknown Computer", async () => {
    expect(
      await specs.delete.execute(
        { computerId: "computer_a", confirmHandle: "birch" },
        context,
      ),
    ).toEqual({ kind: "mismatch" });
    expect(
      await specs.delete.execute(
        { computerId: "computer_b", confirmHandle: "cedar" },
        context,
      ),
    ).toEqual({ kind: "denied" });
  });
});
