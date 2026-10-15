import { createOyster } from "@fungi.computer/oyster/host";
import {
  OysterRegistry as Registry,
  ownerKeyAuth,
  oysterWorkerHost,
  type OysterWorkerEnv,
} from "@fungi.computer/oyster/workers";
export { OysterInstance, OysterBinding } from "@fungi.computer/oyster/workers";

/** The real registry plus one fixture door that reproduces a pre-release row the current schema cannot decode. */
export class OysterRegistry extends Registry {
  makeStale(installationId: string): number {
    return this.ctx.storage.sql.exec(
      "UPDATE installations SET record=? WHERE installation_id=?",
      JSON.stringify({ installationId, release: "pre-release" }),
      installationId,
    ).rowsWritten;
  }
}

// STALE_ROWS binds the same OysterRegistry namespace as REGISTRY.
type ReinstallFixtureEnv = OysterWorkerEnv & {
  STALE_ROWS: DurableObjectNamespace<OysterRegistry>;
};
const stalePath = "/__reinstall_fixture/stale/";

export default {
  async fetch(request: Request, env: ReinstallFixtureEnv) {
    const auth = ownerKeyAuth(env.OYSTER_OWNER_KEY);
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(stalePath)) {
      if ((await auth.authenticate(request)).kind !== "admitted")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({
        rowsWritten: await env.STALE_ROWS.getByName("registry").makeStale(
          pathname.slice(stalePath.length),
        ),
      });
    }
    return createOyster(oysterWorkerHost(env, auth)).fetch(request);
  },
};
