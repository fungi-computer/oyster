import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  computerCreateRequestSchema,
  computerPageSchema,
} from "@fungi.computer/computer/fleet";
import {
  oysterPrincipalIsOwner,
  type OysterAuth,
  type OysterEnv,
} from "../host.js";
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
    operation: z.enum(["read", "resolve", "state", "start", "select"]),
    computerId: fleetComputerId,
  }),
  z.strictObject({
    operation: z.literal("read-internet-access"),
    computerId: fleetComputerId,
  }),
  z.strictObject({
    operation: z.literal("set-internet-access"),
    computerId: fleetComputerId,
    enabled: z.boolean(),
  }),
]);

export type StandaloneFleetRequest = z.input<
  typeof standaloneFleetRequestSchema
>;

function fleetStatus(
  result: Awaited<ReturnType<StandaloneRegistry["computerFleet"]>>,
): 200 | 403 | 404 | 409 | 503 {
  if (result === null) return 404;
  if ("error" in result)
    return result.error === "owner_required"
      ? 403
      : result.error === "partial_init"
        ? 503
        : 409;
  return 200;
}

function fleetResponse(
  result: Awaited<ReturnType<StandaloneRegistry["computerFleet"]>>,
): Response {
  return Response.json(result ?? { error: "not_found" }, {
    status: fleetStatus(result),
  });
}

/** A window's requested context is a hint, never authority or a default mutation. */
export async function standaloneComputerSelection(
  registry: Pick<StandaloneRegistry, "computerFleet" | "selectedComputer">,
  incoming?: Readonly<{ request: Request; auth: OysterAuth }>,
): Promise<string> {
  if (incoming === undefined) return registry.selectedComputer();
  const requested = new URL(incoming.request.url).searchParams.getAll(
    "computerId",
  );
  if (requested.length === 0) return registry.selectedComputer();
  const admission = await incoming.auth.authenticate(incoming.request);
  if (admission.kind === "refused")
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
  if (!oysterPrincipalIsOwner(admission.principal))
    throw new HTTPException(403, { message: "Owner only" });
  const computerId = z.tuple([fleetComputerId]).safeParse(requested);
  if (!computerId.success)
    throw new HTTPException(400, { message: "Invalid Computer selection" });
  const result = await registry.computerFleet(
    admission.principal.actor.memberId,
    {
      operation: "resolve",
      computerId: computerId.data[0],
    },
  );
  const status = fleetStatus(result);
  if (status !== 200)
    throw new HTTPException(status, { res: fleetResponse(result) });
  return computerId.data[0];
}

/** Tenant-owner management controls over the same durable fleet as Hub. */
export function standaloneComputerFleetRoutes(
  registryFor: () => DurableObjectStub<StandaloneRegistry>,
): Hono<OysterEnv> {
  const routes = new Hono<OysterEnv>();
  routes.use("/api/computers/*", async (context, next) =>
    oysterPrincipalIsOwner(context.get("principal"))
      ? next()
      : context.json({ error: "Owner only" }, 403),
  );
  routes.onError((error, context) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return context.json({ error: "invalid_input" }, 400);
    throw error;
  });
  routes.get("/api/workbench/directory", async (context) => {
    const principal = context.get("principal");
    if (!oysterPrincipalIsOwner(principal))
      return context.json({ error: "Owner only" }, 403);
    const registry = registryFor();
    const admitted = await registry.computerFleet(principal.actor.memberId, {
      operation: "list",
      page: { limit: 1, offset: 0 },
    });
    if (admitted === null || "error" in admitted)
      return fleetResponse(admitted);
    const [directory, computerId] = await Promise.all([
      registry.directory(),
      registry.selectedComputer(),
    ]);
    return context.json({
      ...directory,
      computer: { computerId, name: computerId },
      computerContext: "owner-fleet",
    });
  });
  routes.get("/api/computers", async (context) => {
    const principal = context.get("principal");
    if (!oysterPrincipalIsOwner(principal))
      return context.json({ error: "Owner only" }, 403);
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
  routes.get("/api/workbench/computers", async (context) => {
    const principal = context.get("principal");
    if (!oysterPrincipalIsOwner(principal))
      return context.json({ error: "Owner only" }, 403);
    return fleetResponse(
      await registryFor().computerFleet(principal.actor.memberId, {
        operation: "choices",
        page: computerPageSchema.parse({
          limit: Number(context.req.query("limit") ?? 100),
          offset: Number(context.req.query("offset") ?? 0),
        }),
      }),
    );
  });
  routes.post("/api/computers", async (context) => {
    const principal = context.get("principal");
    if (!oysterPrincipalIsOwner(principal))
      return context.json({ error: "Owner only" }, 403);
    const input = computerCreateRequestSchema.parse(await context.req.json());
    return fleetResponse(
      await registryFor().computerFleet(principal.actor.memberId, {
        operation: "create",
        request: input,
      }),
    );
  });
  routes.post("/api/computers/:computerId/start", async (context) => {
    const principal = context.get("principal");
    if (!oysterPrincipalIsOwner(principal))
      return context.json({ error: "Owner only" }, 403);
    const result = await registryFor().computerFleet(principal.actor.memberId, {
      operation: "start",
      computerId: context.req.param("computerId"),
    });
    return fleetResponse(result);
  });
  routes.get("/api/computers/:computerId/internet-access", async (context) => {
    const principal = context.get("principal");
    if (!oysterPrincipalIsOwner(principal))
      return context.json({ error: "Owner only" }, 403);
    return fleetResponse(
      await registryFor().computerFleet(principal.actor.memberId, {
        operation: "read-internet-access",
        computerId: context.req.param("computerId"),
      }),
    );
  });
  routes.put("/api/computers/:computerId/internet-access", async (context) => {
    const principal = context.get("principal");
    if (!oysterPrincipalIsOwner(principal))
      return context.json({ error: "Owner only" }, 403);
    const input = z
      .strictObject({ enabled: z.boolean() })
      .parse(await context.req.json());
    return fleetResponse(
      await registryFor().computerFleet(principal.actor.memberId, {
        operation: "set-internet-access",
        computerId: context.req.param("computerId"),
        enabled: input.enabled,
      }),
    );
  });
  routes.get("/api/computers/:computerId", async (context) => {
    const principal = context.get("principal");
    if (!oysterPrincipalIsOwner(principal))
      return context.json({ error: "Owner only" }, 403);
    const result = await registryFor().computerFleet(principal.actor.memberId, {
      operation: "read",
      computerId: context.req.param("computerId"),
    });
    return fleetResponse(result);
  });
  routes.put("/api/computers/selected", async (context) => {
    const principal = context.get("principal");
    if (!oysterPrincipalIsOwner(principal))
      return context.json({ error: "Owner only" }, 403);
    const input = z
      .strictObject({ computerId: fleetComputerId })
      .parse(await context.req.json());
    return fleetResponse(
      await registryFor().computerFleet(principal.actor.memberId, {
        operation: "select",
        computerId: input.computerId,
      }),
    );
  });
  return routes;
}
