/** Minimal Node test host for importing Shiitake's Cloudflare-only module. */
export class DurableObject<Env> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  public constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** Base classes that dependencies extend when Node imports them; never run here. */
export class WorkerEntrypoint<Env> {
  protected readonly env: Env;

  public constructor(_ctx: ExecutionContext, env: Env) {
    this.env = env;
  }
}

/** Dependencies extend it; Node has no RPC, so it carries nothing. */
export class RpcTarget {
  public readonly rpc = false;
}
