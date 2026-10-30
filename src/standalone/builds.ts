/**
 * Owner routes for App builds on the standalone's Computer. They run after
 * the host's owner guard; the build owner is the registry.
 *
 * Repository Apps register through APPS.register from their committed root
 * metadata. Publishing an App's source (PUT /api/apps/:appId/source) instead
 * makes its template the build source at the returned seed revision.
 *
 * - `POST /api/builds` starts a build of that source at one exact commit.
 * - `GET /api/builds/:jobId` reads it; `?log` reads its combined raw output.
 *   Both require the same owner admission. A finished build carries its
 *   Release, which the owner installs or selects through the installation routes.
 */
import * as Schema from "effect/Schema";
import {
  oysterBuildStartMessages,
  type OysterBuildStartReason,
} from "../app-builds.js";
import { type OysterEnv } from "../host.js";
import {
  owner as ownerRoute,
  routes as routeTable,
  type Routes,
} from "../authorization.js";
import {
  appIdSchema,
  releaseSchema,
  sourceRevisionSchema,
} from "@fungi.computer/puffball/effect";
import type { StandaloneRegistry } from "./registry.js";

const buildInput = Schema.Struct({
  appId: appIdSchema,
  sourceRevision: sourceRevisionSchema,
});

/** Both HTTP and APPS expose the same closed preflight reason. */
export function buildStartFailureReply(
  reason: OysterBuildStartReason | "unavailable",
) {
  return {
    status:
      reason === "invalid_revision"
        ? 400
        : reason === "unavailable" || reason === "no_backend"
          ? 503
          : 409,
    body: {
      code: reason,
      error:
        reason === "unavailable"
          ? "Build is unavailable"
          : oysterBuildStartMessages[reason],
    },
  };
}

/** The build routes over the tenant registry that owns builds, resolved per
 * request so mounting the routes reaches no registry. */
export function standaloneBuildRoutes(
  registryFor: () => Pick<
    StandaloneRegistry,
    "startBuild" | "readBuild" | "readBuildLog"
  >,
): Routes<OysterEnv> {
  const routes = routeTable<OysterEnv>();
  const owner = ownerRoute("direct-or-app");
  routes.post("/api/builds", owner, async (context, { principal }) => {
    let input;
    try {
      input = Schema.decodeUnknownSync(buildInput, {
        onExcessProperty: "error",
      })(await context.req.json());
    } catch {
      return Response.json({ error: "Invalid build" }, { status: 400 });
    }
    try {
      const result = await registryFor().startBuild({
        ...input,
        requestedBy: principal.actor.memberId,
      });
      if (result.kind === "started")
        return Response.json(result.build, { status: 202 });
      const reply = buildStartFailureReply(result.reason);
      return Response.json(reply.body, { status: reply.status });
    } catch {
      const reply = buildStartFailureReply("unavailable");
      return Response.json(reply.body, { status: reply.status });
    }
  });
  routes.get("/api/builds/:jobId", owner, async (context) => {
    if (context.req.query("log") !== undefined) {
      const log = await registryFor().readBuildLog(context.req.param("jobId"));
      return log === null
        ? Response.json({ error: "Not found" }, { status: 404 })
        : Response.json(log);
    }
    const build = await registryFor().readBuild(context.req.param("jobId"));
    return build === null
      ? Response.json({ error: "Not found" }, { status: 404 })
      : Response.json({
          ...build,
          release:
            build.release === null
              ? null
              : Schema.encodeUnknownSync(releaseSchema)(build.release),
        });
  });
  return routes;
}
