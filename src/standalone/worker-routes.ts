/**
 * The standalone Worker's top-level table, before any tenant is selected:
 * device enrollment and links, the public website visitor surface, attached-machine
 * dials, signed Workflow webhook delivery, then the
 * selected tenant's own declared host table for every other path. The Worker
 * and the authorization law both compose it here.
 */
import type { BlankEnv } from "hono/types";
import { door, routes, type Routes } from "../authorization.js";

/** What the Worker-top doors forward to. */
export type StandaloneWorkerRoutePorts = Readonly<{
  /** The machine-link doors' own table, served for this request. */
  machineLink: (request: Request) => Promise<Response>;
  /** The public website channel: launcher, visitor document and visitor API. */
  website: (request: Request) => Promise<Response>;
  /** A machine's signed dial to its attached Computer, verified by that Computer. */
  localBackendDial: (request: Request) => Promise<Response>;
  /** Signed Workflow webhook delivery, verified by the library's run owner. */
  workflowWebhooks: Routes<BlankEnv>;
  /** The selected tenant's declared host table. */
  tenant: (request: Request) => Promise<Response>;
}>;

/** The Worker-top table; `serveDoors` serves it, so no route admits a principal. */
export function standaloneWorkerRoutes(
  ports: StandaloneWorkerRoutePorts,
): Routes<BlankEnv> {
  return routes()
    .all(
      "/local/mesh/join",
      door("machine enrollment; the join route verifies its key"),
      (context) => ports.machineLink(context.req.raw),
    )
    .all(
      "/api/teams/:teamId/local/mesh/:deviceId/connect",
      door("a machine link; the device's link verifies Seam"),
      (context) => ports.machineLink(context.req.raw),
    )
    .all(
      "/embed/*",
      door("a website visitor; the edge checks the site key and origin"),
      (context) => ports.website(context.req.raw),
    )
    .all(
      "/styles.css",
      door("the website chat's public stylesheet"),
      (context) => ports.website(context.req.raw),
    )
    .all(
      "/api/embed/*",
      door(
        "a website visitor; the edge checks the site key, origin and bearer",
      ),
      (context) => ports.website(context.req.raw),
    )
    .all(
      "/api/computers/:computerId/backends/:backendId/connect",
      door(
        "an attached machine's dial; the Computer verifies its Seam signature",
      ),
      (context) => ports.localBackendDial(context.req.raw),
    )
    .include(ports.workflowWebhooks)
    .all(
      "*",
      door("the selected tenant's own declared host table"),
      (context) => ports.tenant(context.req.raw),
    );
}
