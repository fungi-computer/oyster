import {
  computerCapabilities,
  computerServiceCapabilities,
  computerValueSchema,
} from "@fungi.computer/computer-contract";

/**
 * Every operation an Oyster Computer advertises: the native ones and the
 * declared-service tools it serves. Static, so hosts describe them without a call.
 */
export function advertisedComputerCapabilities() {
  return computerValueSchema.parse([
    ...computerCapabilities(),
    ...computerServiceCapabilities(),
  ]);
}
