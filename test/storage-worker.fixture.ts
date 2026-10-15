import { DurableObject } from "cloudflare:workers";
import {
  createAgentDirectory,
  agentIds,
  type AgentGrant,
} from "@fungi.computer/shiitake/fleet";
import { createOyster, type OysterHost } from "@fungi.computer/oyster/host";
import {
  ownerKeyAuth,
  oysterWorkerHost,
  type OysterWorkerEnv,
} from "@fungi.computer/oyster/workers";
export {
  OysterRegistry,
  OysterInstance,
  OysterBinding,
} from "@fungi.computer/oyster/workers";

export class StorageAgentDirectory extends DurableObject {
  private readonly directory = createAgentDirectory(this.ctx.storage.sql);
  private grant(actor: string): AgentGrant {
    return {
      agents: "all",
      actions: ["create", "read"],
      expiresAt: Date.now() + 60000,
      provenance: { actor },
    };
  }
  seed() {
    return this.ctx.storage.transactionSync(() => ({
      owned: this.directory.create(this.grant("owner"), {
        name: "Owner Agent",
        requestId: "owner-agent",
        configuration: "none",
      }).agent.agentId,
      foreign: this.directory.create(this.grant("foreign"), {
        name: "Foreign Agent",
        requestId: "foreign-agent",
        configuration: "none",
      }).agent.agentId,
      missing: agentIds.agent.generate(),
    }));
  }
  readCreator(agentId: string): string | null {
    return this.directory.readCreator(this.grant("owner"), agentId);
  }
}
/** An Agent the owner never approved: the App gate refuses it before storage. */
const unapprovedAgent = "no-policy-agent";

type StorageFixtureEnv = Omit<OysterWorkerEnv, "AGENT_DIRECTORY"> & {
  AGENT_DIRECTORY: DurableObjectNamespace<StorageAgentDirectory>;
};

// Only authentication is substituted: the fixed non-owner exercises the real method/frame/storage route.
export default {
  async fetch(request: Request, env: StorageFixtureEnv) {
    const owner = ownerKeyAuth(env.OYSTER_OWNER_KEY);
    if (new URL(request.url).pathname === "/__storage_fixture/agents") {
      const admitted = await owner.authenticate(request);
      if (admitted.kind !== "admitted")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json(
        await env.AGENT_DIRECTORY.getByName("agents").seed(),
      );
    }
    const auth: OysterHost["auth"] = {
      resolve: (actor) =>
        actor.kind === "member" && actor.memberId === "fixture-member"
          ? Promise.resolve({ actor, role: "member" })
          : owner.resolve(actor),
      authenticate: (input) => {
        const agent = input.headers.get("X-Storage-Agent");
        if (agent !== null)
          return Promise.resolve({
            kind: "admitted",
            principal: { actor: { kind: "agent", agentId: agent } },
          });
        switch (input.headers.get("X-Storage-Fixture")) {
          case "member":
            return Promise.resolve({
              kind: "admitted",
              principal: {
                actor: { kind: "member", memberId: "fixture-member" },
                role: "member",
              },
            });
          case "agent":
            return Promise.resolve({
              kind: "admitted",
              principal: {
                actor: { kind: "agent", agentId: "fixture-agent" },
              },
            });
          case "key":
            return Promise.resolve({
              kind: "admitted",
              principal: {
                actor: { kind: "team-key", keyId: "fixture-key" },
              },
            });
          default:
            return owner.authenticate(input);
        }
      },
    };
    // Fixed Agents and keys hold an owner-approved write policy, so the storage
    // owner law (not the tool gate) decides them; the named unapproved Agent has none.
    // (A key's own App access is its live Ear Tag grants now, never this
    // port, but this fixture's storage paths never consult it either way.)
    return createOyster(
      oysterWorkerHost(env, auth, {
        appToolPolicy: (actor) =>
          actor.agentId === unapprovedAgent
            ? null
            : {
                level: "write",
                revision: "storage-fixture-policy",
                grantedBy: "fixture-owner",
              },
      }),
    ).fetch(request);
  },
};
