import {
  standaloneTenancy,
  type StandaloneTenancyEnv,
} from "../../src/standalone/tenancy.js";
export { StandaloneTenants } from "../../src/standalone/tenancy.js";
export { OysterKeys } from "@fungi.computer/oyster/workers-git";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { standaloneAgents } from "../../src/standalone/agents.js";
import standalone, {
  StandaloneAgent,
  type StandaloneEnv,
} from "../../src/standalone/worker.js";
export { AgentDirectory } from "../../src/standalone/agents.js";
import { oysterPrincipalIsOwner } from "@fungi.computer/oyster/host";

export { OysterRegistry, OysterInstance } from "@fungi.computer/oyster/workers";

// Only the model is deterministic. The inherited agent options, installed
// App tools, Shiitake runtime and Worker Loader sandbox run unchanged.
export class SandboxAgent extends StandaloneAgent {
  protected override modelSource() {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("execute", {
          code: 'if ("AGENT_DIRECTORY" in env) throw new Error("host directory leaked"); await env.NOTES.saveNote({text: "from the agent sandbox"}); return await env.NOTES.readNote({});',
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Saved and read the note."),
    ]);
    return {
      acquire: () =>
        Promise.resolve({
          model: faux.getModel(),
          stream: faux.provider.streamSimple.bind(faux.provider),
          release: () => Promise.resolve(),
        }),
    };
  }

  async probe() {
    const session = (await this.shiitake()).session("sandbox-proof");
    const accepted = await this.sendFromApp("notes", "sandbox-proof", {
      text: "Save a note through the App tools and read it back.",
      requestId: "sandbox-proof-command",
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

// Real Luna composition: Session creation acquires no provider inference.
export class LunaAgent extends StandaloneAgent {}

export default {
  async fetch(
    request: Parameters<typeof standalone.fetch>[0],
    env: StandaloneEnv &
      StandaloneTenancyEnv & {
        PROBE: DurableObjectNamespace<SandboxAgent>;
        LUNA: DurableObjectNamespace<LunaAgent>;
      },
    context: ExecutionContext,
  ) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/luna/")) {
      if (
        request.headers.get("Authorization") !==
        `Bearer ${env.OYSTER_OWNER_KEY}`
      )
        return new Response("Unauthorized", { status: 401 });
      url.pathname = url.pathname.slice("/luna".length);
      return env.LUNA.getByName("owner-luna").fetch(new Request(url, request));
    }
    if (url.pathname === "/probe") {
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
      const agents = standaloneAgents(env);
      const agent = await agents.create(
        "Sandbox proof",
        "native-approved-agent",
        admission.principal,
        "owner-direct",
      );
      const policy = await agents.appToolPolicy({
        kind: "agent",
        agentId: agent.agentId,
      });
      const probe = await env.PROBE.getByName(agent.agentId).probe();
      return Response.json({
        probe,
        policy,
        owner: await (await standaloneTenancy(env)).owner(),
      });
    }
    // Installation consent runs through the same root the Agent's tools use.
    return standalone.fetch(request, env, context);
  },
};
