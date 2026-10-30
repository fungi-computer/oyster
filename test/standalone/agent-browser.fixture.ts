import { fauxModel } from "@fungi.computer/mule/testing";
import type { StandaloneModelSource } from "../../src/standalone/agents.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { oysterPrincipalIsOwner } from "@fungi.computer/oyster/authorization";
import { standaloneAgents } from "../../src/standalone/agents.js";
import {
  standaloneTenancy,
  type StandaloneTenancyEnv,
} from "../../src/standalone/tenancy.js";
import standalone, {
  StandaloneAgent,
  type StandaloneEnv,
} from "../../src/standalone/worker.js";

// The standalone root's own Durable Object classes, as its Wrangler config
// binds them (the root's workspace reads StandaloneRegistry.selectedComputer).
export {
  AgentDirectory,
  OysterInstallationExecutor,
  OysterKeys,
  OysterRegistry,
  StandaloneInstance,
  StandaloneTenants,
} from "../../src/standalone/worker.js";

/**
 * The page the Agent browses. Cloudflare's browser must reach it, so it is a
 * stable public page rather than a local fixture server.
 */
const BROWSED_PAGE = "https://example.com/";

// Only the model is deterministic. The standalone Agent's tool sources, the
// Worker Loader sandbox and the real BROWSER binding run unchanged.
export class BrowserAgent extends StandaloneAgent {
  protected override modelSource(): StandaloneModelSource {
    const faux = fauxModel([]);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("execute", {
          code: [
            "const refused = await env.cloudBrowser",
            '  .open({ url: "http://127.0.0.1/" })',
            '  .then(() => "opened", (error) => String(error?.message ?? error));',
            `const opened = await env.cloudBrowser.open({ url: ${JSON.stringify(BROWSED_PAGE)} });`,
            "const page = await env.cloudBrowser.snapshot({ leaseId: opened.leaseId });",
            "const closed = await env.cloudBrowser.close({ leaseId: opened.leaseId });",
            "return {",
            "  refused,",
            "  leaseId: opened.leaseId,",
            "  url: opened.url,",
            "  tree: page.tree,",
            "  closed: closed.closed,",
            "  quickReads: typeof env.cloudBrowser.markdown,",
            "};",
          ].join("\n"),
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Browsed the page."),
    ]);
    return {
      acquire: () =>
        Promise.resolve({
          retryable: () => false,
          model: faux.model,
          stream: (model, context, options) =>
            faux.stream(model, context, options),
          release: () => Promise.resolve(),
        }),
    };
  }

  async probe() {
    const session = (await this.shiitake()).session("browser-proof");
    const accepted = await this.sendFromApp("browser-proof", "browser-proof", {
      text: "Open the page, read it and close the browser.",
      requestId: "browser-proof-command",
      delivery: "followUp",
    });
    const watch = await session.watch();
    try {
      const changes = watch.changes[Symbol.asyncIterator]();
      let snapshot = watch.snapshot;
      while (
        !snapshot.terminals.some(
          ({ commandId }) => commandId === accepted.commandId,
        )
      ) {
        const frame = await changes.next();
        if (frame.done) throw new Error("Agent ended before settlement");
        snapshot = await session.read();
      }
      return JSON.stringify({
        terminal: snapshot.terminals.find(
          ({ commandId }) => commandId === accepted.commandId,
        ),
        results: snapshot.messages
          .map(({ value }) => value)
          .filter((value) => value.role === "toolResult"),
      });
    } finally {
      await watch.close();
    }
  }
}

export default {
  async fetch(
    request: Parameters<typeof standalone.fetch>[0],
    env: StandaloneEnv &
      StandaloneTenancyEnv & { PROBE: DurableObjectNamespace<BrowserAgent> },
    context: ExecutionContext,
  ) {
    if (new URL(request.url).pathname !== "/probe")
      return standalone.fetch(request, env, context);
    const canonical = new Request("https://oyster.test/probe", request);
    const authenticated = await (
      await standaloneTenancy(env)
    ).oyster.resolve(canonical);
    if (authenticated === null)
      return new Response("Unauthorized", { status: 401 });
    const admission = await authenticated.auth.authenticate(canonical);
    if (admission.kind !== "admitted")
      return new Response("Unauthorized", { status: admission.status });
    if (!oysterPrincipalIsOwner(admission.principal))
      return new Response("Forbidden", { status: 403 });
    const agent = await standaloneAgents(env).create(
      "Browser proof",
      "native-approved-agent",
      admission.principal,
      "owner-direct",
    );
    return Response.json({
      probe: await env.PROBE.getByName(agent.agentId).probe(),
    });
  },
};
