import { StandaloneInstance as NativeInstance } from "../../src/standalone/worker.js";
import { OysterRegistry as NativeRegistry } from "../../src/standalone/worker.js";
import type { StandaloneRegistryGit } from "../../src/standalone/registry.js";
import { createArtifactsRestNamespace } from "@fungi.computer/burrow";
import { z } from "zod";
import standalone from "../../src/standalone/worker.js";
import { StandaloneWorkflowRuns as NativeWorkflowRuns } from "../../src/standalone/worker.js";

// Production root admission and bindings remain unchanged. The external Git
// provider is local for both App bindings and the public smart-HTTP door.
export * from "../../src/standalone/worker.js";
function localGit<Env extends { GIT_ORIGIN: string }>(
  env: Env,
  namespace = "local",
) {
  return {
    ...env,
    ARTIFACTS: createArtifactsRestNamespace({
      accountId: "workflow-proof",
      namespace,
      apiToken: "local-provider",
      fetch: (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        return fetch(
          new Request(
            new URL(url.pathname + url.search, env.GIT_ORIGIN),
            request,
          ),
        );
      },
    }),
  };
}
// The Instance dispatches GIT from its binding table; supply the same local
// provider to that production dispatch owner.
export class StandaloneInstance extends NativeInstance {
  constructor(
    ctx: ConstructorParameters<typeof NativeInstance>[0],
    env: ConstructorParameters<typeof NativeInstance>[1] & {
      GIT_ORIGIN: string;
    },
  ) {
    super(ctx, localGit(env));
  }
}
// The provider's Cloudflare-shaped remote host (`workflow-git.fixture.mjs`).
const providerRemoteHost = "workflow-proof.artifacts.cloudflare.net";
/** Git v2 ref reads POST a body after their advertisement; isomorphic-git
 * supplies it as sync or async chunks (as hub-edge-artifacts.ts reads it). */
function requestStream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const chunks = (async function* () {
    yield* source;
  })();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
async function* responseChunks(body: ReadableStream<Uint8Array> | null) {
  if (body === null) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally {
    reader.releaseLock();
  }
}
/** The Registry's maintained Artifacts owner accepts only Cloudflare-shaped
 * remotes; its Git transports carry exactly that host to the native provider. */
function providerGit(env: { GIT_ORIGIN: string }): StandaloneRegistryGit {
  const toProvider = (target: string) => {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.host !== providerRemoteHost)
      throw new Error("Registry Git must reach the native provider");
    return new URL(url.pathname + url.search, env.GIT_ORIGIN);
  };
  type GitHttp = NonNullable<StandaloneRegistryGit["gitHttp"]>;
  const requestInit = (input: Parameters<GitHttp["request"]>[0]) => {
    const init: RequestInit = {
      method: input.method ?? "GET",
      headers: new Headers(input.headers),
      redirect: "manual",
      signal: input.signal ?? null,
    };
    if (input.body !== undefined)
      Object.assign(init, { body: requestStream(input.body), duplex: "half" });
    return init;
  };
  const gitHttp: GitHttp = {
    async request(input) {
      const response = await fetch(toProvider(input.url), requestInit(input));
      return {
        url: input.url,
        method: input.method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: responseChunks(response.body),
      };
    },
  };
  return {
    gitHttp,
    gitFetch: (input, init) => {
      const request = new Request(input, init);
      return fetch(new Request(toProvider(request.url), request));
    },
  };
}
// The Registry publishes App source templates and forks them through the
// maintained Artifacts owner, on the same native provider's repositories.
export class OysterRegistry extends NativeRegistry {
  constructor(
    ctx: ConstructorParameters<typeof NativeRegistry>[0],
    env: ConstructorParameters<typeof NativeRegistry>[1] & {
      GIT_ORIGIN: string;
    },
  ) {
    super(ctx, localGit(env, "templates"), providerGit(env));
  }
}
const proofClockRows = z
  .array(z.strictObject({ offset_ms: z.number().int() }))
  .max(1);
// Published run admission uses the same real local Git/Artifacts provider.
// Schedules keep their five-minute floor; the proof clock skips each future
// wake to one real second away, so production alarm delivery runs unchanged.
export class StandaloneWorkflowRuns extends NativeWorkflowRuns {
  constructor(
    ctx: ConstructorParameters<typeof NativeWorkflowRuns>[0],
    env: ConstructorParameters<typeof NativeWorkflowRuns>[1] & {
      GIT_ORIGIN: string;
    },
  ) {
    super(ctx, localGit(env));
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS proof_schedule_clock (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), offset_ms INTEGER NOT NULL
    ) STRICT`);
  }
  private offset(): number {
    const [row] = proofClockRows.parse(
      this.ctx.storage.sql
        .exec("SELECT offset_ms FROM proof_schedule_clock")
        .toArray(),
    );
    return row?.offset_ms ?? 0;
  }
  protected override readonly scheduleClock = {
    now: () => Date.now() + this.offset(),
    alarmAt: (due: number) => {
      const skip = due - (Date.now() + 1000);
      if (skip > this.offset())
        this.ctx.storage.sql.exec(
          "INSERT INTO proof_schedule_clock(singleton,offset_ms) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET offset_ms=excluded.offset_ms",
          skip,
        );
      return due - this.offset();
    },
  };
}
type RootEnv = Parameters<typeof standalone.fetch>[1] & { GIT_ORIGIN: string };
const rootEnvironments = new WeakMap<
  RootEnv,
  ReturnType<typeof localGit<RootEnv>>
>();

export default {
  fetch(
    request: Parameters<typeof standalone.fetch>[0],
    env: RootEnv,
    context: Parameters<typeof standalone.fetch>[2],
  ) {
    // Oyster owns one MCP server per env. A fresh clone here would discard
    // the initialized MCP Session before its next HTTP request.
    let adapted = rootEnvironments.get(env);
    if (adapted === undefined) {
      adapted = localGit(env);
      rootEnvironments.set(env, adapted);
    }
    return standalone.fetch(request, adapted, context);
  },
};
