import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveDurableBackend } from "@fungi.computer/puffball/backend";
import { createFixtureCatalog, seedFixtureCatalog } from "./catalog.js";
import {
  createCloudflareAppInstance,
  createCloudflareInvocationGate,
} from "../cloudflare.js";
import {
  invocationFactsSchema,
  APP_INVOCATION_CEILING_MS,
} from "../invocation.js";
import { selectionSchema, instanceIdSchema } from "../index.js";

export type Env = {
  LOADER: WorkerLoader;
  INSTANCES: DurableObjectNamespace<ConfiguredInstance>;
  CATALOG_FIXTURE: string;
  OWNER: string;
};
// Configured test admission and catalog persistence stand-ins; not Team/Grant APIs.
export class ConfiguredInstance extends DurableObject<Env> {
  private readonly catalog;
  private readonly runtime;
  private readonly gate;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.catalog = createFixtureCatalog(env.CATALOG_FIXTURE);
    this.gate = createCloudflareInvocationGate(ctx, () => Promise.resolve());
    void ctx.blockConcurrencyWhile(() =>
      seedFixtureCatalog(env.CATALOG_FIXTURE, this.catalog),
    );
    this.runtime = createCloudflareAppInstance(
      ctx,
      env.LOADER,
      (id) =>
        resolveDurableBackend(this.catalog, id).pipe(
          Effect.mapError((error) => new Error(String(error))),
        ),
      () => ({}),
    );
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    try {
      const authority = Schema.decodeUnknownSync(
        Schema.fromJsonString(selectionSchema),
      )(request.headers.get("x-test-admission"));
      if (
        authority.owner.kind !== "deployment" ||
        authority.owner.id !== this.env.OWNER ||
        authority.instanceId !== this.ctx.id.name
      )
        return new Response("Denied", { status: 403 });
      if (url.pathname.endsWith("/select"))
        return Response.json(
          await Effect.runPromise(
            this.runtime.apply({ ...authority, status: "enabled" }),
          ),
        );
      if (url.pathname.endsWith("/disable"))
        return Response.json(
          await Effect.runPromise(
            this.runtime.apply({ ...authority, status: "disabled" }),
          ),
        );
      if (url.pathname.endsWith("/delete"))
        return Response.json(
          await Effect.runPromise(
            this.runtime.apply({ ...authority, status: "deleted" }),
          ),
        );
      const backend = await Effect.runPromise(
        resolveDurableBackend(this.catalog, authority.releaseId),
      );
      const facts = Schema.decodeUnknownSync(invocationFactsSchema)({
        instanceId: authority.instanceId,
        selection: authority,
        artifactDigest: backend.digest,
        subject: {
          kind: "call",
          context: {
            computerId: null,
            actor: { kind: "member", memberId: this.env.OWNER },
          },
        },
        grants: [],
        deadlineAt: Date.now() + APP_INVOCATION_CEILING_MS,
        ancestry: [],
      });
      return await this.gate.run(facts, undefined, (frame) =>
        Effect.runPromise(this.runtime.fetch(frame, request)),
      );
    } catch {
      return new Response("Unavailable or denied", { status: 409 });
    }
  }
}
const route = new URLPattern({ pathname: "/instances/:id/:operation" });
export default {
  fetch(request: Request, env: Env) {
    const match = route.exec(request.url);
    if (!match) return new Response("Not found", { status: 404 });
    const id = Schema.decodeUnknownSync(instanceIdSchema)(
      match.pathname.groups.id,
    );
    return env.INSTANCES.getByName(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
