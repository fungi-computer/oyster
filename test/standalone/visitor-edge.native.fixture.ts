import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fauxModelSource } from "@fungi.computer/shiitake/testing";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import { FungiMessageMetaSchema } from "@fungi.computer/agar/agents";
import { createChannelVisitors } from "../../src/channels/visitors.js";
import type { ConversationBinding } from "../../src/channels/binding.js";
import type { WebsiteBinding } from "../../src/channels/web-binding.js";
import {
  StandaloneAgentBase,
  type StandaloneAgentEnv,
} from "../../src/standalone/agents.js";
import { standaloneVisitorEdge } from "../../src/standalone/visitor-edge.js";

// Real local workerd RPC and SQLite owners. Only the model and this site's
// host configuration are fixtures; the channel edge and Agent are production.
const binding = (env: VisitorEdgeNativeEnv): WebsiteBinding => ({
  bindingId: env.BINDING_ID,
  agentId: "agent_native",
  lifecycle: "active",
  authorityVersion: 1,
  persona: "Reply briefly.",
  selector: {
    provider: "web",
    siteKey: env.SITE_KEY,
    origins: ["https://oyster.test"],
  },
});

export type VisitorEdgeNativeEnv = StandaloneAgentEnv & {
  SITE_KEY: string;
  BINDING_ID: string;
  PROOF_KEY: string;
  VISITORS: DurableObjectNamespace<Visitors>;
  WEBSITE_AGENTS: DurableObjectNamespace<WebsiteAgent>;
};

export class Visitors extends DurableObject<VisitorEdgeNativeEnv> {
  private owner() {
    return createChannelVisitors({
      sql: this.ctx.storage.sql,
      transactionSync: (body) => this.ctx.storage.transactionSync(body),
      now: () => Date.now(),
    });
  }
  live(bindingId: string, visitorId: string) {
    return this.owner().live(bindingId, visitorId);
  }
  mint(site: ConversationBinding | null, key: string, address: string) {
    return this.owner().mint(site, key, address);
  }
  refresh(site: ConversationBinding | null, secret: string) {
    return this.owner().refresh(site, secret);
  }
  rotate(
    site: ConversationBinding | null,
    key: string,
    token: string,
    address: string,
  ) {
    return this.owner().rotate(site, key, token, address);
  }
  authenticate(bindingId: string, token: string) {
    return this.owner().authenticate(bindingId, token);
  }
  forget(visitorId: string) {
    this.owner().forget(visitorId);
  }
}

export class WebsiteAgent extends StandaloneAgentBase<VisitorEdgeNativeEnv> {
  protected override readChannelBinding(bindingId: string) {
    const site = binding(this.env);
    return Promise.resolve(site.bindingId === bindingId ? site : null);
  }
  protected override channelVisitorLive(bindingId: string, visitorId: string) {
    return this.env.VISITORS.getByName("agent_native").live(
      bindingId,
      visitorId,
    );
  }
  protected override channelProofKey() {
    return this.env.PROOF_KEY;
  }
  protected override hostFor(): never {
    throw new Error("No owner-host action belongs to the website proof");
  }
  protected override shiitakeOptions(): Promise<CloudflareShiitakeOptions> {
    return Promise.resolve({
      extensions: { roster: [], grants: [] },
      model: fauxModelSource([fauxAssistantMessage("Private native reply")]),
      meta: { schema: FungiMessageMetaSchema },
      instructions: this.channelInstructions({
        load: () =>
          Promise.resolve({ revision: "native-visitor", text: "Reply." }),
      }),
      tools: [],
    });
  }
}

export default {
  fetch(request: Request, env: VisitorEdgeNativeEnv) {
    const app = new Hono<{ Bindings: VisitorEdgeNativeEnv }>();
    app.get("/health", (context) => context.text("ready"));
    app.post("/revoke/:id", (context) => {
      // Fixture-only internal route, used after a real SSE connection opens.
      return env.VISITORS.getByName("agent_native")
        .forget(context.req.param("id"))
        .then(() => context.text("revoked"));
    });
    app.get("/owner/transcripts", async (context) => {
      // Fixture-only owner read through the Agent's own owner RPCs.
      const agent = env.WEBSITE_AGENTS.getByName("agent_native");
      const conversations = await agent.websiteConversations(env.BINDING_ID);
      const transcripts = await Promise.all(
        conversations.map(({ sessionId }) =>
          agent.websiteTranscript(env.BINDING_ID, sessionId),
        ),
      );
      return context.json({ transcripts });
    });
    app.post("/forge/:id", async (context) => {
      try {
        const visitorId = context.req.param("id");
        const expiresAt = Date.now() + 60_000;
        await env.WEBSITE_AGENTS.getByName("agent_native").openChannelVisitor(
          env.BINDING_ID,
          {
            visitorId,
            addressHash: "native-visitor-address",
            expiresAt,
            edgeProof: {
              bindingId: env.BINDING_ID,
              visitorId,
              addressHash: "native-visitor-address",
              expiresAt,
              signature: "A".repeat(43),
            },
          },
          {},
        );
        return context.text("forgery admitted", 500);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "Website channel identity is unauthorized"
        )
          throw error;
        return context.text("forgery denied", 403);
      }
    });
    app.route(
      "/",
      standaloneVisitorEdge<{ Bindings: VisitorEdgeNativeEnv }>({
        site: (_context, key) =>
          key !== env.SITE_KEY
            ? null
            : {
                binding: binding(env),
                facts: {
                  name: "Oyster",
                  avatar: {
                    v: 1,
                    character: "mushroom",
                    appearance: {},
                    expression: "idle",
                    renderStyle: "plain",
                  },
                  origins: ["https://oyster.test"],
                },
              },
        visitors: () => env.VISITORS.getByName("agent_native"),
        agent: () => env.WEBSITE_AGENTS.getByName("agent_native"),
        proofKey: () => env.PROOF_KEY,
        addressHash: () => Promise.resolve("native-visitor-address"),
        turnstile: () => ({
          configuration: { kind: "disabled" },
          timeoutMs: 1_000,
          onError: () => undefined,
        }),
        assetPath: (kind) => `/${kind}`,
        onError: (error) => {
          console.error("Website native proof error", error);
          return new Response("unavailable", { status: 500 });
        },
      }),
    );
    return app.fetch(request, env);
  },
} satisfies ExportedHandler<VisitorEdgeNativeEnv>;
