import type { z } from "zod";
import type {
  computerCreateRequestSchema,
  computerPageSchema,
} from "@fungi.computer/computer/fleet/inventory-wire";
import type { computerStateSchema } from "@fungi.computer/computer/fleet/wire";
import type { teamComputerDirectorySchema } from "@fungi.computer/nacre/workbench";
import type { InvocationContext } from "@fungi.computer/mycelium";

/** Host policy stays outside this family: Hub admits funded slots, standalone
 * admits its current owner. Both call their durable fleet through this port.
 * Keep the host contract independent of the Worker-only fleet lifecycle. */
export type ComputerControlPort = Readonly<{
  /** List a bounded page from the host-admitted inventory. */
  list(
    page: z.output<typeof computerPageSchema>,
    context: InvocationContext,
  ): Promise<z.output<typeof teamComputerDirectorySchema>>;
  /** Read liveness without waking the Computer. */
  state(
    computerId: string,
    context: InvocationContext,
  ): Promise<z.output<typeof computerStateSchema>>;
  /** Start one inventoried hosted Computer through the host's admission. */
  start(
    computerId: string,
    context: InvocationContext,
  ): Promise<z.output<typeof computerStateSchema>>;
  /** Create or replay a durable receipt tied to this request identity. */
  create(
    input: z.output<typeof computerCreateRequestSchema>,
    context: InvocationContext,
  ): Promise<
    | { kind: "created"; computer: { computerId: string; name: string } }
    | { kind: "uncertain" | "denied" | "conflict" | "invalid" }
  >;
}>;
