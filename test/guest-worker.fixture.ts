import {
  oysterWorkerHost,
  createOysterMcpOwner,
  OysterInstance as RuntimeInstance,
  type OysterWorkerEnv,
} from "@fungi.computer/oyster/workers";
import {
  createOyster,
  type OysterEnv,
  type OysterHost,
} from "@fungi.computer/oyster/host";
import { OysterKeys } from "@fungi.computer/oyster/workers-git";
import { ownerOrKeyAuth } from "@fungi.computer/oyster/auth";
import { Hono } from "hono";
export { OysterKeys };
export { OysterBinding, OysterRegistry } from "@fungi.computer/oyster/workers";

/** The native proof verifies host configuration reaches the real Worker Loader. */
export class OysterInstance extends RuntimeInstance {
  constructor(ctx: DurableObjectState, env: OysterWorkerEnv) {
    super(ctx, {
      ...env,
      LOADER: {
        get: (id, configure) =>
          env.LOADER.get(id, async () => {
            const code = await configure();
            if (code.limits?.cpuMs !== 250 || code.limits.subRequests !== 10)
              throw new Error(
                "Host guest budgets did not reach the Worker Loader",
              );
            return code;
          }),
        load: (code) => env.LOADER.load(code),
      },
    });
  }
}

/** This proof's one named key reaches every App, read and write; others hold none. */
const proofKeyGrants = [
  { capability: "apps.use", targets: { kind: "all" } },
] as const;

type ProofEnv = OysterWorkerEnv & {
  KEYS: DurableObjectNamespace<OysterKeys>;
};
const keysOf = (env: ProofEnv, scope: { durableName(kind: string): string }) =>
  env.KEYS.getByName(scope.durableName("keys"));
const keysPort = (
  env: ProofEnv,
  scope: { durableName(kind: string): string },
): OysterHost["keys"] => ({
  live: (keyId) => keysOf(env, scope).live(keyId),
});
export class OysterMcp extends createOysterMcpOwner<ProofEnv>((env, scope) => ({
  ...oysterWorkerHost(
    env,
    ownerOrKeyAuth(env.OYSTER_OWNER_KEY, "owner", () => keysOf(env, scope)),
    { scope, guestLimits: { cpuMs: 250, subRequests: 10 } },
  ),
  keys: keysPort(env, scope),
})) {}
const apps = new WeakMap<ProofEnv, ReturnType<typeof createOyster>>();
const fixedScope = { durableName: () => "keys" };

export default {
  fetch(request, env) {
    let app = apps.get(env);
    if (app === undefined) {
      const keys = () => keysOf(env, fixedScope);
      const auth = ownerOrKeyAuth(env.OYSTER_OWNER_KEY, "owner", keys);
      const ownerRoutes = new Hono<OysterEnv>();
      // Only this local proof provisions a fixed named Agent; createOyster
      // applies its ordinary owner-only /api admission before this route.
      ownerRoutes.post("/api/proof-key", async () => {
        const issued = await keys().issue("owner", {
          name: "contest-agent",
          grants: [...proofKeyGrants],
        });
        return issued.kind === "error"
          ? Response.json({ error: issued.error.code }, { status: 409 })
          : Response.json(
              { key: issued.value.record, plaintext: issued.value.key },
              { status: 201 },
            );
      });
      app = createOyster({
        ...oysterWorkerHost(env, auth, {
          guestLimits: { cpuMs: 250, subRequests: 10 },
        }),
        keys: keysPort(env, fixedScope),
        ownerRoutes,
      });
      apps.set(env, app);
    }
    return app.fetch(request);
  },
} satisfies ExportedHandler<ProofEnv>;
