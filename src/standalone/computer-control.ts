import { z } from "zod";
import {
  computerStateSchema,
  type FleetComputer,
} from "@fungi.computer/computer/fleet";
import { teamComputerDirectorySchema } from "@fungi.computer/nacre/workbench";
import type { ComputerControlPort } from "../mcp.js";
import type { StandaloneRegistryRpc } from "./registry.js";

const inventoryComputer = z.strictObject({
  computerId: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const inventoryPage = z.strictObject({
  computers: z.array(inventoryComputer),
  nextOffset: z.number().int().nonnegative().nullable(),
});
const inventoryError = z.strictObject({
  error: z.string(),
});

/** MCP control speaks to the same owner-admitted durable fleet as HTTP. */
export function standaloneComputerControl(
  registry: Pick<StandaloneRegistryRpc, "computerFleet">,
  memberId: string,
): ComputerControlPort {
  const fleet = (
    request: Parameters<StandaloneRegistryRpc["computerFleet"]>[1],
  ) => registry.computerFleet(memberId, request);
  const available = <T>(result: T | null): T => {
    if (result === null || inventoryError.safeParse(result).success)
      throw new Error("Computer fleet refused the request");
    return result;
  };
  return {
    list: async (page) =>
      teamComputerDirectorySchema.parse(
        inventoryPage.parse(
          available(await fleet({ operation: "list", page })),
        ),
      ),
    state: async (computerId) =>
      computerStateSchema.parse(
        available(await fleet({ operation: "state", computerId })),
      ),
    start: async (computerId) =>
      computerStateSchema.parse(
        available(await fleet({ operation: "start", computerId })),
      ),
    create: async (input) => {
      let result: unknown;
      try {
        result = await fleet({ operation: "create", request: input });
      } catch {
        // Creation may have persisted before the RPC failed. Surface its
        // identity so the caller can retry, never silently mint another one.
        return { kind: "uncertain" };
      }
      if (result === null) return { kind: "denied" };
      const error = inventoryError.safeParse(result);
      if (error.success) {
        switch (error.data.error) {
          case "owner_required":
            return { kind: "denied" };
          case "name_taken":
          case "request_conflict":
            return { kind: "conflict" };
          case "partial_init":
            return { kind: "uncertain" };
          default:
            return { kind: "invalid" };
        }
      }
      const computer: FleetComputer = inventoryComputer.parse(result);
      return {
        kind: "created",
        computer: { computerId: computer.computerId, name: computer.name },
      };
    },
  };
}
