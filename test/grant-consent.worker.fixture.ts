import * as Schema from "effect/Schema";
import { tenantIdSchema, tenantScope } from "@fungi.computer/oyster/tenant";
import { DurableObject } from "cloudflare:workers";
import { createOyster, type OysterHost } from "@fungi.computer/oyster/host";
import {
  ownerKeyAuth,
  oysterWorkerHost,
  OysterRegistry as Registry,
  type OysterWorkerEnv,
} from "@fungi.computer/oyster/workers";
export { OysterInstance } from "@fungi.computer/oyster/workers";

type RetainedStorage = readonly Readonly<{ value: string }>[];

/** Fixture-only raw storage producer: the previous grant contract omitted this field. */
export class OysterRegistry extends Registry {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") await this.makeStale("proof");
    return Response.json(await this.retainedData());
  }
  private makeStale(installationId: string): Promise<void> {
    const current = this.get(installationId);
    if (current === null || "kind" in current)
      throw new Error("Expected installed proof");
    const record = {
      ...current,
      approvedGrants: [
        {
          capability: "app.events.emit",
          operations: [],
          resources: "tenant-scope",
        },
      ],
    };
    this.ctx.storage.sql.exec(
      "UPDATE installations SET record=? WHERE installation_id=?",
      JSON.stringify(record),
      installationId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO hub_app_storage VALUES(?,?,?,?,?,?,?,?,?)",
      `installation:${installationId}`,
      current.release.appId,
      "saved",
      "team",
      "",
      0,
      '{"retained":true}',
      1,
      17,
    );
    return Promise.resolve();
  }
  private retainedData(): Promise<RetainedStorage> {
    return Promise.resolve(
      Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ value: Schema.String })),
      )(
        this.ctx.storage.sql
          .exec("SELECT value FROM hub_app_storage WHERE key='saved'")
          .toArray(),
      ),
    );
  }
}

/** Test-only rendezvous: both requests reach the real commit RPC before either proceeds. */
export class ApprovalBarrier extends DurableObject {
  private readonly arrivals: (() => void)[] = [];
  join(): Promise<void> {
    return new Promise((resolve) => {
      this.arrivals.push(resolve);
      if (this.arrivals.length === 2)
        this.arrivals.splice(0).forEach((ready) => {
          ready();
        });
    });
  }
}
type Env = OysterWorkerEnv & {
  APPROVAL_BARRIER: DurableObjectNamespace<ApprovalBarrier>;
};
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/__stale-proof") {
      if (
        request.headers.get("Authorization") !==
        `Bearer ${env.OYSTER_OWNER_KEY}`
      )
        return new Response(null, { status: 403 });
      return env.REGISTRY.getByName("registry").fetch(request);
    }
    const options = url.pathname.startsWith("/other/")
      ? {
          scope: tenantScope(
            Schema.decodeUnknownSync(tenantIdSchema)("other"),
            url.origin,
          ),
        }
      : {};
    if (url.pathname.startsWith("/other/")) {
      url.pathname = url.pathname.slice("/other".length);
      request = new Request(url, request);
    }
    const host = oysterWorkerHost(
      env,
      ownerKeyAuth(env.OYSTER_OWNER_KEY),
      options,
    );
    const installations: OysterHost["installations"] = {
      ...host.installations,
      compareAndPut: async (record, expected) => {
        if (request.headers.has("X-Proof-Race")) {
          const barrier: Pick<ApprovalBarrier, "join"> =
            env.APPROVAL_BARRIER.getByName("pair");
          await barrier.join();
        }
        return host.installations.compareAndPut(record, expected);
      },
    };
    return createOyster({ ...host, installations }).fetch(request);
  },
};
