import { endTime, startTime } from "hono/timing";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  computerCreateRequestSchema,
  computerPageSchema,
  localBackendAttachSchema,
  localBackendDetachRequestSchema,
  localBackendDetachSchema,
} from "@fungi.computer/computer/fleet";
import type { OysterEnv } from "../host.js";
import {
  keyComputerChoice,
  oysterPrincipalIsOwner,
  owner as ownerRoute,
  routes as routeTable,
  type Routes,
} from "../authorization.js";
import { computerTargetParam } from "../computer-target.js";
import type { TenantPrincipal } from "../tenant.js";
import type {
  OysterKeysLivePort,
  OysterWorkspaceCaller,
} from "../workers-git.js";
import type { StandaloneRegistry } from "./registry.js";

/** Fleet controls never accept an actor from the request body. */
const fleetComputerId = z.string().min(1).max(256);
export const standaloneFleetRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("create"),
    request: computerCreateRequestSchema,
  }),
  z.strictObject({
    operation: z.enum(["list", "choices"]),
    page: computerPageSchema,
  }),
  z.strictObject({
    operation: z.enum(["read", "resolve", "state", "start", "stop", "select"]),
    computerId: fleetComputerId,
  }),
  z.strictObject({
    operation: z.literal("backends"),
    computerId: fleetComputerId,
  }),
  z.strictObject({
    operation: z.literal("attach-local"),
    request: localBackendAttachSchema,
  }),
  z.strictObject({
    operation: z.literal("detach-local"),
    request: z.union([
      localBackendDetachSchema,
      localBackendDetachRequestSchema,
    ]),
  }),
  z.strictObject({
    operation: z.enum(["read-internet-access", "read-keep-awake"]),
    computerId: fleetComputerId,
  }),
  z.strictObject({
    operation: z.enum(["set-internet-access", "set-keep-awake"]),
    computerId: fleetComputerId,
    enabled: z.boolean(),
  }),
]);

export type StandaloneFleetRequest = z.input<
  typeof standaloneFleetRequestSchema
>;

function fleetStatus(
  result: Awaited<ReturnType<StandaloneRegistry["computerFleet"]>>,
): 200 | 400 | 403 | 404 | 409 | 503 {
  if (result === null) return 404;
  if ("error" in result)
    switch (result.error) {
      case "owner_required":
      case "not_owner":
      case "local_limit":
      case "unknown_computer":
        return 403;
      case "invalid":
      case "not_enabled":
        return 400;
      case "no_runtime":
      case "partial_init":
        return 503;
      case "unavailable":
        // The Computer has no such switch: a conflict with its kind, not a fault.
        return 409;
      default:
        return 409;
    }
  return 200;
}

function fleetResponse(
  result: Awaited<ReturnType<StandaloneRegistry["computerFleet"]>>,
): Response {
  return Response.json(result ?? { error: "not_found" }, {
    status: fleetStatus(result),
  });
}

/** Whether `memberId` is the live canonical owner and owns this Computer. */
export async function ownerHoldsComputer(
  registry: Pick<StandaloneRegistry, "computerFleet">,
  memberId: string,
  computerId: string,
): Promise<boolean> {
  const result = await registry.computerFleet(memberId, {
    operation: "resolve",
    computerId,
  });
  return fleetStatus(result) === 200;
}

/**
 * The Computer one host serves. The owner's current selection, unless the
 * owner names another with `?computerId=`, or the caller is a key granted
 * selected Computers: that key's own Computer, whatever the owner selects
 * (`keyComputerChoice`). A window's requested context is a hint, never
 * authority or a default mutation.
 */
export async function standaloneComputerSelection(
  registry: Pick<StandaloneRegistry, "computerFleet" | "selectedComputer">,
  keysLive: OysterKeysLivePort,
  caller?: OysterWorkspaceCaller,
): Promise<string> {
  if (caller === undefined) return registry.selectedComputer();
  let principal: TenantPrincipal;
  let requested: readonly string[] = [];
  if ("request" in caller) {
    requested = new URL(caller.request.url).searchParams.getAll(
      computerTargetParam,
    );
    // One authentication per request: the route requirement reuses it.
    const admission = await caller.auth.authenticate(caller.request);
    if (admission.kind === "refused") {
      // An unauthenticated request reaches no Computer; its route refuses it.
      if (requested.length === 0) return registry.selectedComputer();
      throw new HTTPException(admission.status, {
        res: Response.json(
          { error: "Computer selection refused" },
          {
            status: admission.status,
            headers:
              admission.retryAfter === undefined
                ? {}
                : { "Retry-After": String(admission.retryAfter) },
          },
        ),
      });
    }
    principal = admission.principal;
  } else principal = caller.principal;
  const named = z.tuple([fleetComputerId]).safeParse(requested);
  if (requested.length > 0 && !named.success)
    throw new HTTPException(400, { message: "Invalid Computer selection" });
  const computerId = named.success ? named.data[0] : null;
  // The fleet re-proves the canonical owner holds the Computer it hands out.
  const held = async (memberId: string, id: string) => {
    const result = await registry.computerFleet(memberId, {
      operation: "resolve",
      computerId: id,
    });
    const status = fleetStatus(result);
    if (status !== 200)
      throw new HTTPException(status, { res: fleetResponse(result) });
    return id;
  };
  if (principal.actor.kind === "team-key") {
    const key = await keysLive(principal.actor.keyId);
    const choice = keyComputerChoice(key, computerId);
    if (choice.kind === "owner-selection") return registry.selectedComputer();
    if (choice.kind === "refused")
      throw new HTTPException(choice.status, {
        res: Response.json({ error: choice.error }, { status: choice.status }),
      });
    return held(choice.owner, choice.computerId);
  }
  if (computerId === null) return registry.selectedComputer();
  if (!oysterPrincipalIsOwner(principal))
    throw new HTTPException(403, { message: "Owner only" });
  return held(principal.actor.memberId, computerId);
}

/** Tenant-owner management controls over the same durable fleet as Hub. */
export function standaloneComputerFleetRoutes(
  registryFor: () => DurableObjectStub<StandaloneRegistry>,
): Routes<OysterEnv> {
  const routes = routeTable<OysterEnv>();
  // Fleet controls are the owner's own (Tourtois calls them directly); an
  // App's bridge request, which names its installation, is refused.
  const owner = ownerRoute("direct");
  routes.onError((error, context) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return context.json({ error: "invalid_input" }, 400);
    throw error;
  });
  routes.get(
    "/api/workbench/directory",
    owner,
    async (context, { principal }) => {
      const registry = registryFor();
      startTime(context, "fleet");
      const admitted = await registry.computerFleet(principal.actor.memberId, {
        operation: "list",
        page: { limit: 1, offset: 0 },
      });
      endTime(context, "fleet");
      if (admitted === null || "error" in admitted)
        return fleetResponse(admitted);
      startTime(context, "registry");
      const [directory, computerId] = await Promise.all([
        registry.directory(),
        registry.selectedComputer(),
      ]);
      endTime(context, "registry");
      return context.json({
        ...directory,
        computer: { computerId, name: computerId },
        computerContext: "owner-fleet",
      });
    },
  );
  routes.get("/api/computers", owner, async (context, { principal }) => {
    const page = computerPageSchema.parse({
      limit: Number(context.req.query("limit") ?? 100),
      offset: Number(context.req.query("offset") ?? 0),
    });
    return fleetResponse(
      await registryFor().computerFleet(principal.actor.memberId, {
        operation: "list",
        page,
      }),
    );
  });
  routes.get(
    "/api/workbench/computers",
    owner,
    async (context, { principal }) => {
      return fleetResponse(
        await registryFor().computerFleet(principal.actor.memberId, {
          operation: "choices",
          page: computerPageSchema.parse({
            limit: Number(context.req.query("limit") ?? 100),
            offset: Number(context.req.query("offset") ?? 0),
          }),
        }),
      );
    },
  );
  routes.post("/api/computers", owner, async (context, { principal }) => {
    const input = computerCreateRequestSchema.parse(await context.req.json());
    return fleetResponse(
      await registryFor().computerFleet(principal.actor.memberId, {
        operation: "create",
        request: input,
      }),
    );
  });
  routes.post(
    "/api/computers/:computerId/start",
    owner,
    async (context, { principal }) => {
      const result = await registryFor().computerFleet(
        principal.actor.memberId,
        {
          operation: "start",
          computerId: context.req.param("computerId"),
        },
      );
      return fleetResponse(result);
    },
  );
  routes.get(
    "/api/computers/:computerId/state",
    owner,
    async (context, { principal }) =>
      fleetResponse(
        await registryFor().computerFleet(principal.actor.memberId, {
          operation: "state",
          computerId: context.req.param("computerId"),
        }),
      ),
  );
  routes.post(
    "/api/computers/:computerId/stop",
    owner,
    async (context, { principal }) =>
      fleetResponse(
        await registryFor().computerFleet(principal.actor.memberId, {
          operation: "stop",
          computerId: context.req.param("computerId"),
        }),
      ),
  );
  // One owner switch per durable Computer setting, read and written alike.
  for (const [path, read, write] of [
    ["internet-access", "read-internet-access", "set-internet-access"],
    ["keep-awake", "read-keep-awake", "set-keep-awake"],
  ] as const) {
    routes.get(
      `/api/computers/:computerId/${path}`,
      owner,
      async (context, { principal }) =>
        fleetResponse(
          await registryFor().computerFleet(principal.actor.memberId, {
            operation: read,
            computerId: context.req.param("computerId"),
          }),
        ),
    );
    routes.put(
      `/api/computers/:computerId/${path}`,
      owner,
      async (context, { principal }) => {
        const input = z
          .strictObject({ enabled: z.boolean() })
          .parse(await context.req.json());
        return fleetResponse(
          await registryFor().computerFleet(principal.actor.memberId, {
            operation: write,
            computerId: context.req.param("computerId"),
            enabled: input.enabled,
          }),
        );
      },
    );
  }
  routes.get(
    "/api/computers/:computerId",
    owner,
    async (context, { principal }) => {
      const result = await registryFor().computerFleet(
        principal.actor.memberId,
        {
          operation: "read",
          computerId: context.req.param("computerId"),
        },
      );
      return fleetResponse(result);
    },
  );
  routes.put(
    "/api/computers/selected",
    owner,
    async (context, { principal }) => {
      const input = z
        .strictObject({ computerId: fleetComputerId })
        .parse(await context.req.json());
      return fleetResponse(
        await registryFor().computerFleet(principal.actor.memberId, {
          operation: "select",
          computerId: input.computerId,
        }),
      );
    },
  );
  return routes;
}
