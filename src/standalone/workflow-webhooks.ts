import type { BlankEnv } from "hono/types";
import { door, owner, routes, type Routes } from "../authorization.js";
import { bodyLimit } from "hono/body-limit";
import * as Schema from "effect/Schema";
import { workflowWebhookCommandSchema } from "../webhooks.js";
import type { OysterEnv, OysterHost } from "../host.js";
import type { StandaloneWorkflowEnv } from "./workflows.js";

const refused = () =>
  Response.json(
    { error: "refused" },
    { status: 403, headers: { "cache-control": "no-store" } },
  );

/** Address an existing library, never use an opaque binding ID as a DO name. */
async function libraryExists(
  host: Pick<OysterHost, "installations">,
  installationId: string,
) {
  const installation = await host.installations.get(installationId);
  return (
    installation?.status === "enabled" &&
    installation.authority.approvedGrants.some(
      (grant) => grant.capability === "workflow.run",
    )
  );
}

/** The root resolves the origin before this unauthenticated signed-delivery path. */
export function standaloneWorkflowWebhookRoutes(
  env: Pick<StandaloneWorkflowEnv, "WORKFLOW_RUNS">,
  hostFor: (
    request: Request,
  ) => Promise<Pick<OysterHost, "installations"> | null>,
): Routes<BlankEnv> {
  return routes().all(
    "/api/installations/:installationId/workflows/webhooks/:bindingId",
    door("a signed delivery; the library's run owner verifies its signature"),
    async (context) => {
      const host = await hostFor(context.req.raw);
      const installationId = context.req.param("installationId");
      if (host === null || !(await libraryExists(host, installationId)))
        return refused();
      const address = new URL(context.req.url);
      address.pathname = `/webhooks/${encodeURIComponent(context.req.param("bindingId"))}`;
      address.search = "";
      return env.WORKFLOW_RUNS.getByName(installationId).fetch(
        new Request(address, context.req.raw),
      );
    },
  );
}

/** Mounted only under the root's authenticated owner routes; the DO re-admits. */
export function standaloneWorkflowWebhookControls(
  env: Pick<StandaloneWorkflowEnv, "WORKFLOW_RUNS">,
  hostFor: () => Promise<Pick<OysterHost, "installations">>,
): Routes<OysterEnv> {
  return routes<OysterEnv>().post(
    "/api/installations/:installationId/workflows/webhooks",
    owner("direct-or-app"),
    async (context, { principal }) => {
      const installationId = context.req.param("installationId");
      if (!(await libraryExists(await hostFor(), installationId)))
        return refused();
      const body = Schema.decodeUnknownResult(
        Schema.fromJsonString(Schema.Json),
      )(await context.req.text());
      if (body._tag === "Failure") return refused();
      const command = workflowWebhookCommandSchema.safeParse(body.success);
      if (!command.success) return refused();
      return env.WORKFLOW_RUNS.getByName(installationId).webhookControl(
        principal,
        installationId,
        command.data,
      );
    },
    { middleware: [bodyLimit({ maxSize: 64 * 1024, onError: refused })] },
  );
}
