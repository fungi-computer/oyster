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

/** One scripted Agent turn: the model runs `code` through the execute tool, then replies. */
function turn(code: readonly string[], reply: string) {
  return [
    fauxAssistantMessage(fauxToolCall("execute", { code: code.join("\n") }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(reply),
  ];
}

// Only the model is deterministic. The standalone Agent's tool sources, the
// Worker Loader sandbox and the real BROWSER binding run unchanged.
export class BrowserAgent extends StandaloneAgent {
  private readonly faux = fauxModel([]);

  protected override modelSource(): StandaloneModelSource {
    const faux = this.faux;
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

  /** Run one scripted turn in a Session and return the tool results it added. */
  private async run(
    sessionId: string,
    requestId: string,
    responses: ReturnType<typeof turn>,
    existing: boolean,
  ) {
    this.faux.setResponses(responses);
    const session = (await this.shiitake()).session(sessionId);
    const before = existing ? (await session.read()).messages.length : 0;
    const accepted = await this.sendFromApp(sessionId, sessionId, {
      text: "Continue.",
      requestId,
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
      return {
        terminal: snapshot.terminals.find(
          ({ commandId }) => commandId === accepted.commandId,
        ),
        results: snapshot.messages
          .slice(before)
          .map(({ value }) => value)
          .filter((value) => value.role === "toolResult"),
      };
    } finally {
      await watch.close();
    }
  }

  async probe() {
    return JSON.stringify(
      await this.run(
        "browser-proof",
        "browser-proof-command",
        turn(
          [
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
          ],
          "Browsed the page.",
        ),
        false,
      ),
    );
  }

  /** Open a page and hand it to the person; the paused lease refuses a drive. */
  async handoffProbe() {
    return JSON.stringify(
      await this.run(
        "handoff-proof",
        "handoff-proof-open",
        turn(
          [
            `const opened = await env.cloudBrowser.open({ url: ${JSON.stringify(BROWSED_PAGE)} });`,
            'const handed = await env.cloudBrowser.handoff({ leaseId: opened.leaseId, reason: "sign in" });',
            "const whilePaused = await env.cloudBrowser",
            "  .snapshot({ leaseId: opened.leaseId })",
            '  .then(() => "drove", (error) => String(error?.message ?? error));',
            "return { leaseId: opened.leaseId, handed, whilePaused };",
          ],
          "Waiting for the person.",
        ),
        false,
      ),
    );
  }

  /** The Agent's next drive of the same lease, after the person's answer. */
  async driveProbe(leaseId: string) {
    return JSON.stringify(
      await this.run(
        "handoff-proof",
        "handoff-proof-drive",
        turn(
          [
            `const page = await env.cloudBrowser.snapshot({ leaseId: ${JSON.stringify(leaseId)} });`,
            `const closed = await env.cloudBrowser.close({ leaseId: ${JSON.stringify(leaseId)} });`,
            "return { tree: page.tree, closed: closed.closed };",
          ],
          "Continued.",
        ),
        true,
      ),
    );
  }
}

export default {
  async fetch(
    request: Parameters<typeof standalone.fetch>[0],
    env: StandaloneEnv &
      StandaloneTenancyEnv & { PROBE: DurableObjectNamespace<BrowserAgent> },
    context: ExecutionContext,
  ) {
    const { pathname, searchParams } = new URL(request.url);
    if (!pathname.startsWith("/probe"))
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
    if (pathname === "/probe/drive") {
      const agentId = searchParams.get("agentId") ?? "";
      const leaseId = searchParams.get("leaseId") ?? "";
      return Response.json({
        probe: await env.PROBE.getByName(agentId).driveProbe(leaseId),
      });
    }
    const agent = await standaloneAgents(env).create(
      "Browser proof",
      "native-approved-agent",
      admission.principal,
      "owner-direct",
    );
    if (pathname === "/probe/handoff")
      return Response.json({
        agentId: agent.agentId,
        probe: await env.PROBE.getByName(agent.agentId).handoffProbe(),
      });
    return Response.json({
      probe: await env.PROBE.getByName(agent.agentId).probe(),
    });
  },
};
