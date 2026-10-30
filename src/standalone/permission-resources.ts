import type { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { workbenchComputerDirectorySchema } from "@fungi.computer/nacre/workbench-directory";
import type { OysterHost } from "../host.js";
import { oysterPrincipalIsOwner } from "../authorization.js";
import type { OysterAgents } from "../agents.js";
import type { ResourceOption } from "../apps/permissions.js";
import type { StandaloneRegistryRpc } from "./registry.js";

/** The existing owner picker includes its configured Computer as well as the fleet. */
export function standalonePermissionResources(
  registry: Pick<StandaloneRegistryRpc, "computerFleet">,
  agents: Pick<OysterAgents, "list">,
): NonNullable<OysterHost["permissionResources"]> {
  return async (principal) => {
    if (!oysterPrincipalIsOwner(principal))
      throw new HTTPException(403, { message: "Owner only" });
    const resources: ResourceOption[] = (await agents.list()).map((agent) => ({
      kind: "agent",
      id: agent.agentId,
      label: agent.name,
    }));
    // Follow the native picker cursor, as inventory.ids() does for inventory.
    // A transport failure refuses the read; it is never an empty directory.
    let offset: number | null = 0;
    while (offset !== null) {
      const page: z.output<typeof workbenchComputerDirectorySchema> =
        workbenchComputerDirectorySchema.parse(
          await registry.computerFleet(principal.actor.memberId, {
            operation: "choices",
            page: { offset, limit: 100 },
          }),
        );
      resources.push(
        ...page.computers.map((computer) => ({
          kind: "computer",
          id: computer.computerId,
          label: computer.name,
        })),
      );
      offset = page.nextOffset;
    }
    return resources;
  };
}
