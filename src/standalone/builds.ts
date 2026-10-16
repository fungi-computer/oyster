/**
 * Owner routes for App builds on the standalone's Computer. They run after
 * the host's owner guard; the build owner is the registry.
 *
 * - `PUT /api/apps/:appId/build-source` records an installation repository
 *   and recipe an App builds from (the recipe is normalized and pinned here).
 *   Publishing an App's source (`PUT /api/apps/:appId/source`) instead makes
 *   its template the build source, buildable at the returned seed revision.
 * - `POST /api/builds` starts a build of that source at one exact commit.
 * - `GET /api/builds/:jobId` reads it; a finished build carries its Release,
 *   which the owner installs or selects through the installation routes.
 */
import { Hono } from "hono";
import * as Schema from "effect/Schema";
import {
  capturedPinnedRecipeSchema,
  normalizeAppPublisherRecipe,
  pinnedRecipeSchema,
} from "../build-contract.js";
import { oysterBuildSourceSchema } from "../app-builds.js";
import { oysterPrincipalIsOwner, type OysterEnv } from "../host.js";
import {
  appIdSchema,
  releaseSchema,
  sourceRevisionSchema,
} from "@fungi.computer/puffball/effect";
import type { StandaloneRegistry } from "./registry.js";

const sourceInput = Schema.Struct({
  installationId: Schema.String,
  repository: Schema.String,
  recipe: pinnedRecipeSchema,
});
const buildInput = Schema.Struct({
  appId: appIdSchema,
  sourceRevision: sourceRevisionSchema,
});

/** The build routes over the tenant registry that owns builds, resolved per
 * request so mounting the routes reaches no registry. */
export function standaloneBuildRoutes(
  registryFor: () => DurableObjectStub<StandaloneRegistry>,
): Hono<OysterEnv> {
  const routes = new Hono<OysterEnv>();
  routes.use("/api/builds/*", async (context, next) =>
    oysterPrincipalIsOwner(context.get("principal"))
      ? next()
      : Response.json({ error: "Owner only" }, { status: 403 }),
  );
  routes.put("/api/apps/:appId/build-source", async (context) => {
    if (!oysterPrincipalIsOwner(context.get("principal")))
      return Response.json({ error: "Owner only" }, { status: 403 });
    let source;
    try {
      const appId = Schema.decodeUnknownSync(appIdSchema)(
        context.req.param("appId"),
      );
      const input = Schema.decodeUnknownSync(sourceInput, {
        onExcessProperty: "error",
      })(await context.req.json());
      const pinned = normalizeAppPublisherRecipe({
        appId,
        recipe: Schema.encodeSync(pinnedRecipeSchema)(input.recipe),
      });
      source = Schema.decodeUnknownSync(oysterBuildSourceSchema)({
        appId,
        location: {
          kind: "installation",
          installationId: input.installationId,
          repository: input.repository,
        },
        recipe: Schema.encodeSync(capturedPinnedRecipeSchema)(pinned.recipe),
        buildRecipeDigest: pinned.buildRecipeDigest,
      });
    } catch {
      return Response.json({ error: "Invalid build source" }, { status: 400 });
    }
    await registryFor().registerBuildSource(source);
    return new Response(null, { status: 204 });
  });
  routes.post("/api/builds", async (context) => {
    const principal = context.get("principal");
    if (!oysterPrincipalIsOwner(principal))
      return Response.json({ error: "Owner only" }, { status: 403 });
    let input;
    try {
      input = Schema.decodeUnknownSync(buildInput, {
        onExcessProperty: "error",
      })(await context.req.json());
    } catch {
      return Response.json({ error: "Invalid build" }, { status: 400 });
    }
    try {
      const build = await registryFor().startBuild({
        ...input,
        requestedBy: principal.actor.memberId,
      });
      return Response.json(build, { status: 202 });
    } catch {
      return Response.json(
        { error: "App has no build source" },
        { status: 409 },
      );
    }
  });
  routes.get("/api/builds/:jobId", async (context) => {
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
