import { rpcHandleSchema, rpcMethod } from "@fungi.computer/agar/rpc";
import { z } from "zod";
import * as Result from "effect/Result";
import { correlationKey } from "@fungi.computer/cairn";
import type { Backend, Instance } from "./index.js";
import type { AppInstanceContext, AppInstanceLoader } from "./cloudflare.js";
import type { GuestLimits } from "./guest-policy.js";
import { BOOT_DEADLINE_MS, BootGateError } from "./boot-gate.js";

const probeSchema = rpcHandleSchema({
  construct: rpcMethod(z.undefined()).input(z.tuple([])),
});

/** One bounded disposable sibling; it can never become the live App facet. */
export const BACKEND_CONSTRUCTION_FACET = "candidate";

/**
 * The Instance owns the disposable facet and supplies its already-read prior
 * state schema. Only initialized App storage is copied; supervisor state and
 * authority are never copied. A unique Loader ID isolates candidate globals.
 * No invocation frame or guestEnv factory is accepted.
 */
export async function checkBackendConstruction<FacetClass>(
  ctx: Pick<AppInstanceContext<FacetClass>, "facets">,
  loader: AppInstanceLoader<FacetClass> | undefined,
  artifact: Backend,
  limits: GuestLimits,
  priorStateSchema: Instance["stateSchema"],
): Promise<void> {
  if (loader === undefined) throw new BootGateError("boot_runner_unavailable");
  const name = BACKEND_CONSTRUCTION_FACET;
  const loaderId = `boot:${correlationKey()}`;
  let stage: "backend_load_failed" | "backend_construction_failed" =
    "backend_load_failed";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await (async (): Promise<
    Result.Result<void, BootGateError>
  > => {
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new BootGateError("boot_timeout"));
        }, BOOT_DEADLINE_MS);
      });
      if (priorStateSchema !== null) {
        if (ctx.facets.clone === undefined)
          throw new BootGateError("boot_clone_unavailable");
        ctx.facets.clone("app", name);
      } else {
        // A crash may have left the bounded sibling behind. Fresh means empty,
        // not a retry against storage written by an earlier constructor.
        ctx.facets.delete(name);
      }
      using stub = probeSchema.parse(
        ctx.facets.get(name, () => ({
          class: loader
            .get(loaderId, () => ({
              compatibilityDate: artifact.backend.compatibilityDate,
              mainModule: "boot.js",
              modules: {
                "backend.js": artifact.backend.code,
                "boot.js": constructionModule(artifact.backend.exportName),
              },
              env: {},
              globalOutbound: null,
              limits,
            }))
            .getDurableObjectClass("BootConstruction"),
        })),
      );
      stage = "backend_construction_failed";
      await Promise.race([stub.construct(), deadline]);
      return Result.succeed(undefined);
    } catch (cause) {
      return Result.fail(
        cause instanceof BootGateError
          ? cause
          : new BootGateError(stage, { cause }),
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  })();
  // Cleanup uncertainty takes precedence over the captured probe result.
  try {
    try {
      ctx.facets.abort(name, new Error("Candidate boot ended"));
    } finally {
      ctx.facets.delete(name);
    }
  } catch (cause) {
    throw new BootGateError("boot_cleanup_failed", { cause });
  }
  if (Result.isFailure(result)) throw result.failure;
}

function constructionModule(exportName: string): string {
  return `import { DurableObject } from "cloudflare:workers";
// Capture trusted operations BEFORE evaluating any candidate module.
const construct = Reflect.construct;
const freeze = Object.freeze;
// These are host test bindings, not invocation loopbacks. They deny all
// external operations. SQLite is the disposable facet's fresh or copied storage.
const unavailable = () => { throw new Error("Host test binding unavailable"); };
const env = freeze({
  APP_STORAGE: freeze({
    read: unavailable, write: unavailable, reset: unavailable
  })
});
export class BootConstruction extends DurableObject {
  constructor(ctx, bindings) {
    super(ctx, bindings);
    ctx.blockConcurrencyWhile(async () => {
      const backend = await import("./backend.js");
      construct(backend[${JSON.stringify(exportName)}], [ctx, env]);
    });
  }
  // Native constructor blocking must finish before RPC dispatch. No App-mutated
  // Promise methods or candidate-supplied completion value decide readiness.
  construct() {}
}
// A candidate can import this module, but cannot patch the host check.
freeze(BootConstruction.prototype);
freeze(BootConstruction);`;
}
