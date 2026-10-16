// Only platform constructors are replaced; adapters and SQLite run
// unchanged. Mirrors `packages/oyster/test/workers-runtime.fixture.mjs`.
export function DurableObject(ctx, env) {
  this.ctx = ctx;
  this.env = env;
}
export function WorkerEntrypoint(ctx, env) {
  this.ctx = ctx;
  this.env = env;
}
export function WorkflowEntrypoint(ctx, env) {
  this.ctx = ctx;
  this.env = env;
}
export class NonRetryableError extends Error {}
// A stub: unrelated to the registry/fork path this fixture exercises, and
// `capnweb` is not a direct dependency of this package.
export class RpcTarget {
  dispose() {
    return undefined;
  }
}
