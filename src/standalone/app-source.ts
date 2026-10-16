import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as Schema from "effect/Schema";
import { AppInstanceError } from "../index.js";
import {
  catalogFrameMethods,
  oysterAppCatalog,
  appForkInputSchema,
  appForkResultSchema,
} from "../catalog-frame.js";
import {
  parseTemplateSeedClaim,
  TEMPLATE_SEED_CLAIM_MAX_BYTES,
} from "../source/index.js";
import type { TenantScope } from "../tenant.js";
import type { OysterBindingResult } from "../workers.js";
import type { OysterEnv } from "../host.js";
import type { InvocationFrame } from "../invocation.js";
import type { StandaloneRegistry } from "./registry.js";

/** The standalone App source binding needs the Git-capable registry, by
 * identity: `worker.ts` exports `StandaloneRegistry` as the `REGISTRY`
 * binding's class, so this Instance's env sees that same object. */
export type AppSourceBindingEnv = Readonly<{
  REGISTRY: DurableObjectNamespace<StandaloneRegistry>;
}>;

/** `catalogFrameMethods.APPS`'s descriptors already decode to
 * `OysterBindingResult` at their owner (`catalog-frame.ts`); no re-typing
 * is needed here. */
export const appSourceFrameMethods = catalogFrameMethods;

/** Serve `APPS.catalog`/`APPS.fork`; `fork` is admitted only for the tenant owner,
 * re-checked here (never trusted from a stale captured frame). */
export async function dispatchAppSourceBinding(
  env: AppSourceBindingEnv,
  scope: TenantScope,
  frame: InvocationFrame,
  method: string,
  args: readonly unknown[],
): Promise<OysterBindingResult> {
  const registry = env.REGISTRY.getByName(scope.durableName("registry"));
  if (method === "catalog") return oysterAppCatalog(await registry.directory());
  if (method !== "fork") throw new AppInstanceError("revoked");
  if (
    frame.facts.subject.kind !== "call" ||
    frame.facts.subject.context.actor.kind !== "member" ||
    frame.facts.subject.context.role !== "owner"
  )
    throw new AppInstanceError("revoked");
  const [input] = Schema.decodeUnknownSync(Schema.Tuple([appForkInputSchema]))(
    args,
  );
  const installationId = frame.facts.selection.owner.id;
  const result = await registry.forkApp({
    teamId: scope.tenantId,
    platformAppId: input.platformAppId,
    installationId,
    repositoryPrefix: scope.repositoryPrefix(installationId),
    name: input.name,
  });
  return Schema.decodeUnknownSync(appForkResultSchema)(result);
}

/** Operator-only: seed one App's editable source template (`install-apps.mjs`).
 * Mounted under `host.ownerRoutes`, already owner-key-gated for every `/api/*`
 * path before this handler runs (`host.ts`'s `oysterPrincipalIsOwner` check).
 * The operator `git push`es the projected source to
 * `/api/apps/:appId/source.git`, then claims that head here. */
export function appSourceOwnerRoutes(
  env: AppSourceBindingEnv,
  scope: TenantScope,
): Hono<OysterEnv> {
  const routes = new Hono<OysterEnv>();
  const registry = () => env.REGISTRY.getByName(scope.durableName("registry"));
  routes.on(
    ["GET", "POST"],
    "/api/apps/:appId/source.git/:suffix{info/refs|git-upload-pack|git-receive-pack}",
    (context) =>
      registry().exchangeTemplateSource(
        context.req.param("appId"),
        context.req.param("suffix"),
        context.req.raw,
      ),
  );
  routes.put(
    "/api/apps/:appId/source",
    bodyLimit({
      maxSize: TEMPLATE_SEED_CLAIM_MAX_BYTES,
      onError: (context) => context.json({ kind: "invalid" }, 413),
    }),
    async (context) => {
      const claim = parseTemplateSeedClaim(await context.req.text());
      if (claim === null) return context.json({ kind: "invalid" }, 400);
      const result = await registry().publishSource(
        context.req.param("appId"),
        claim,
        scope.tenantId,
      );
      const status =
        result.kind === "recorded" || result.kind === "existing"
          ? 200
          : result.kind === "conflict"
            ? 409
            : 503;
      return Response.json(result, { status });
    },
  );
  return routes;
}
