/**
 * Node stand-in for `cloudflare:workers` and `cloudflare:workflows`: only the
 * platform constructors are replaced, so adapters and SQLite run unchanged.
 * Resolve it with `import.meta.resolve("@fungi.computer/oyster/testing/workers-runtime")`
 * from a module hook.
 */
export class DurableObject<Env = unknown> {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown> {
  readonly ctx: ExecutionContext;
  readonly env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint<Env = unknown> {
  readonly ctx: ExecutionContext;
  readonly env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class NonRetryableError extends Error {}

export { RpcTarget } from "@fungi.computer/capnweb";
