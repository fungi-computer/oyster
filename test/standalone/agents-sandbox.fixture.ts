import { fauxModel } from "@fungi.computer/mule/testing";
import type { StandaloneModelSource } from "../../src/standalone/agents.js";
import {
  standaloneTenancy,
  type StandaloneTenancyEnv,
} from "../../src/standalone/tenancy.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { standaloneAgents } from "../../src/standalone/agents.js";
import standalone, {
  StandaloneAgent as NativeAgent,
  type StandaloneEnv,
} from "../../src/standalone/worker.js";
import { oysterPrincipalIsOwner } from "@fungi.computer/oyster/authorization";

// The standalone root's own Durable Object classes, as its Wrangler config
// binds them (the root's workspace reads StandaloneRegistry.selectedComputer).
export * from "../../src/standalone/worker.js";

// Only the model is deterministic. The inherited agent options, installed
// App tools, Shiitake runtime and Worker Loader sandbox run unchanged.
export class SandboxAgent extends NativeAgent {
  protected override modelSource(): StandaloneModelSource {
    const faux = fauxModel([]);
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
          retryable: () => false,
          model: faux.model,
          stream: (model, context, options) =>
            faux.stream(model, context, options),
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

// The same deterministic-model seam, with the production tool lease, App
// admission and native Computer unchanged. Only this first prompt uses Shed.
export class StandaloneAgent extends NativeAgent {
  protected override modelSource(): StandaloneModelSource {
    const faux = fauxModel([]);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("execute", {
          code: `await forage.describe({path: "SHED.runCommand"});
return await env.SHED.runCommand({
  command: "mkdir /tmp/oyster-first-shed && printf 'oyster-first-shed\\n'",
  timeoutMs: 10000
});`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Shed first reply completed."),
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
}

// Real Luna composition: Session creation acquires no provider inference.
export class LunaAgent extends NativeAgent {}

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
