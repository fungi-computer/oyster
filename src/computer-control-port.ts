import type { z } from "zod";
import type { ComputerSize } from "@fungi.computer/computer/backing";
import type {
  computerCreateRequestSchema,
  computerPageSchema,
} from "@fungi.computer/computer/fleet/inventory-wire";
import type {
  computerBackendViewSchema,
  computerStateSchema,
  LocalBackendAttachInput,
} from "@fungi.computer/computer/fleet/wire";
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
  /** Stop one Computer now; its files are kept. Only the signed-in owner may. */
  stop(
    computerId: string,
    context: InvocationContext,
  ): Promise<{ kind: "stopped" } | { kind: "denied" | "busy" | "uncertain" }>;
  /**
   * Delete one Computer and erase its Workspace. The caller has already matched
   * the person's typed handle to the Computer's name. Only the signed-in owner
   * may; a host with no delete path answers "unsupported". "uncertain" means
   * retry: a delete cut short finishes on the next attempt.
   */
  delete(
    computerId: string,
    context: InvocationContext,
  ): Promise<
    { kind: "deleted" } | { kind: "denied" | "unsupported" | "uncertain" }
  >;
  /** Create or replay a durable receipt tied to this request identity. */
  create(
    input: z.output<typeof computerCreateRequestSchema>,
    context: InvocationContext,
  ): Promise<
    | {
        kind: "created";
        computer: { computerId: string; name: string; size: ComputerSize };
      }
    | { kind: "uncertain" | "denied" | "conflict" | "invalid" }
  >;
  /** List one Computer's attached execution backends with live status. */
  backends(
    computerId: string,
    context: InvocationContext,
  ): Promise<z.output<typeof computerBackendViewSchema>[]>;
  /** Attach the caller's machine, or replay the same request. */
  attachLocal(
    input: LocalBackendAttachInput,
    context: InvocationContext,
  ): Promise<
    | { kind: "attached"; backendId: string }
    | { kind: "uncertain" | "denied" | "conflict" | "invalid" }
  >;
  /** Detach a machine the caller attached; one already gone settles. */
  detachLocal(
    input: Readonly<{ computerId: string; backendId: string }>,
    context: InvocationContext,
  ): Promise<
    | { kind: "detached"; detached: boolean }
    | { kind: "denied" | "uncertain" | "invalid" }
  >;
}>;
