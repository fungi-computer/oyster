import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { FungiMessageMetaSchema } from "@fungi.computer/agar/agents";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import { fauxModelSource } from "@fungi.computer/shiitake/testing";
import { ownerKeyAuth } from "../../src/auth.js";
import { serveHost } from "../../src/authorization.js";
import { defaultTenant, tenantScope } from "../../src/tenant.js";
import { agentDirectoryForScope } from "../../src/standalone/agent-directory.js";
import {
  StandaloneAgentBase,
  type StandaloneAgentEnv,
} from "../../src/standalone/agents.js";
import {
  standaloneWebsiteApp,
  standaloneWebsiteControl,
  standaloneWebsiteRoutes,
} from "../../src/standalone/website-channels.js";

export { AgentDirectory } from "../../src/standalone/agents.js";

// Real local workerd: the production directory, website Agent and public edge.
// Only the model, the owner key and this seed route belong to the fixture.
export type FixtureEnv = StandaloneAgentEnv & { OWNER_KEY: string };

export class FixtureAgent extends StandaloneAgentBase<FixtureEnv> {
  protected override hostFor(): never {
    throw new Error("No owner-host action belongs to the website proof");
  }
  protected override shiitakeOptions(): Promise<CloudflareShiitakeOptions> {
    return Promise.resolve({
      extensions: { roster: [], grants: [] },
      model: fauxModelSource(
        Array.from({ length: 4 }, () =>
          fauxAssistantMessage("Ferns like bright, indirect light."),
        ),
      ),
      meta: { schema: FungiMessageMetaSchema },
      instructions: this.channelInstructions({
        load: () =>
          Promise.resolve({ revision: "owner", text: "OWNER-ONLY BRIEF" }),
      }),
      tools: [],
    });
  }
}

const website = standaloneWebsiteApp();
const owner = {
  actor: { kind: "member", memberId: "owner" },
  role: "owner",
} as const;

export default {
  async fetch(request, env, context) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ready");
    const directory = agentDirectoryForScope(
      env,
      tenantScope(defaultTenant, env.OYSTER_ORIGIN),
    );
    if (path === "/__fixture/seed") {
      const chosen = await directory.create(
        "Fern",
        "seed-fern",
        owner,
        "owner-direct",
      );
      return Response.json({ agentId: chosen.agentId });
    }
    if (path.startsWith("/api/websites"))
      return serveHost(
        standaloneWebsiteRoutes(standaloneWebsiteControl(env, () => directory)),
        ownerKeyAuth(env.OWNER_KEY).authenticate,
        { liveKey: () => Promise.resolve(null), appToolPolicy: () => null },
      ).fetch(request, env, context);
    return website.fetch(request, env, context);
  },
} satisfies ExportedHandler<FixtureEnv>;
