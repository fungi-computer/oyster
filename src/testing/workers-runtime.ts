/**
 * Node-only stand-in for `cloudflare:workers` and `cloudflare:workflows`. It
 * supplies constructors, an explicit retained-work recorder for tests, and
 * empty binding lookup; no Cloudflare service or lifetime semantics are
 * supplied. Adapters and SQLite run unchanged.
 * Resolve it with `import.meta.resolve("@fungi.computer/oyster/testing/workers-runtime")`
 * from a module hook.
 */
export const env = {};

type WaitUntilOutcome =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "failed"; causeKind: string }>;
const retainedWork = new Set<Promise<WaitUntilOutcome>>();

/** Node tests retain and explicitly drain the same platform-owned work. */
export function waitUntil(promise: Promise<unknown>): void {
  retainedWork.add(
    Promise.resolve(promise).then(
      () => ({ kind: "completed" }),
      (cause: unknown) => ({
        kind: "failed",
        causeKind: cause instanceof Error ? cause.name : "non-error rejection",
      }),
    ),
  );
}

export async function drainWaitUntil(): Promise<void> {
  const outcomes = await Promise.all(retainedWork);
  retainedWork.clear();
  const failure = outcomes.find((outcome) => outcome.kind === "failed");
  if (failure?.kind === "failed")
    throw new Error(`Retained Worker work failed: ${failure.causeKind}`);
}

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
