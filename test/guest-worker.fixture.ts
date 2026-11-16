import {
  oysterWorkerHost,
  createOysterMcpOwner,
  OysterInstance as RuntimeInstance,
  OysterRegistry as RuntimeRegistry,
  type OysterWorkerEnv,
  installationWorkerEntrypoint,
} from "@fungi.computer/oyster/workers";
import {
  createOyster,
  type OysterEnv,
  type OysterHost,
} from "@fungi.computer/oyster/host";
import { OysterKeys } from "@fungi.computer/oyster/workers-git";
import { ownerOrKeyAuth, ownerKeyAuth } from "@fungi.computer/oyster/auth";
import { ApprovalLedger } from "@fungi.computer/approvals";
import { owner, routes } from "@fungi.computer/oyster/authorization";
import type { TenantScope } from "@fungi.computer/oyster/tenant";
export { OysterKeys };
export { OysterBinding } from "@fungi.computer/oyster/workers";

/** Read-only instrumentation of the actual host home, not a fixture-produced action. */
export class OysterRegistry extends RuntimeRegistry {
  readonly #proofEnv: ProofEnv;
  constructor(ctx: DurableObjectState, env: ProofEnv) {
    super(ctx, env);
    this.#proofEnv = env;
  }
  protected override hostFor(scope: TenantScope) {
    return Promise.resolve(proofHostFor(this.#proofEnv, scope));
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/approvals")
      return new Response("Not found", { status: 404 });
    return Response.json(await this.#approvalSnapshot());
  }

  #approvalSnapshot() {
    const ledger = new ApprovalLedger({
      owner: {
        sql: this.ctx.storage.sql,
        transactionSync: (body) => this.ctx.storage.transactionSync(body),
      },
      home: { kind: "oyster", id: "default" },
      now: Date.now,
    });
    return ledger
      .capability({
        actor: async () => {
          const principal = await ownerKeyAuth(
            this.env.OYSTER_OWNER_KEY,
          ).resolve({
            kind: "member",
            memberId: "owner",
          });
          if (principal === null || !("role" in principal))
            throw new Error("Native proof owner is not admitted");
          return {
            kind: "human",
            memberId: principal.actor.memberId,
            role: principal.role,
            actingForAgent: false,
            mayUseOperation: false,
          };
        },
        decision: () =>
          Promise.reject(new Error("Native snapshot is read-only")),
      })
      .list({});
  }
}

/** Instrument the real owner: guest budgets, shared wake delivery and expiry. */
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

  override async openTestCopy(
    ...args: Parameters<RuntimeInstance["openTestCopy"]>
  ) {
    // Another owner's earlier wake must survive admission's five-minute wake.
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return super.openTestCopy(...args);
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    // Read only after the production shared owner delivered both alarm quanta.
    // SQLite's JSON decoder observes the retained phase, without lazy inspect.
    const row = this.ctx.storage.sql
      .exec<{ copy_id: string; phase: string }>(
        `SELECT json_extract(record,'$.copyId') AS copy_id,
                json_extract(record,'$.phase') AS phase
         FROM app_test_copy WHERE id=1`,
      )
      .toArray()[0];
    if (row !== undefined)
      console.log("Oyster native copy alarm", row.phase, row.copy_id);
  }
}

/** This proof's one named key reaches every App, read and write; others hold none. */
const proofKeyGrants = [
  { capability: "apps.use", targets: { kind: "all" } },
] as const;

/** The proof Worker environment the exported Registry is constructed with. */
export type ProofEnv = OysterWorkerEnv & {
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
const proofHostFor = (env: ProofEnv, scope: TenantScope): OysterHost => ({
  ...oysterWorkerHost(
    env,
    ownerOrKeyAuth(env.OYSTER_OWNER_KEY, "owner", () => keysOf(env, scope)),
    { scope, guestLimits: { cpuMs: 250, subRequests: 10 } },
  ),
  keys: keysPort(env, scope),
});
export class OysterMcp extends createOysterMcpOwner<ProofEnv>(proofHostFor) {}
export class OysterInstallationExecutor extends installationWorkerEntrypoint<ProofEnv>(
  proofHostFor,
) {}
const apps = new WeakMap<ProofEnv, ReturnType<typeof createOyster>>();
const fixedScope = { durableName: () => "keys" };

export default {
  fetch(request, env) {
    let app = apps.get(env);
    if (app === undefined) {
      const keys = () => keysOf(env, fixedScope);
      const auth = ownerOrKeyAuth(env.OYSTER_OWNER_KEY, "owner", keys);
      const ownerRoutes = routes<OysterEnv>();
      ownerRoutes.get("/api/proof-approvals", owner("direct-or-app"), () =>
        env.REGISTRY.getByName("registry").fetch(
          new Request("https://native-proof.invalid/approvals"),
        ),
      );
      // Only this local proof provisions a fixed named Agent, as the owner.
      ownerRoutes.post("/api/proof-key", owner("direct-or-app"), async () => {
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
