import standalone, {
  StandaloneAgent as NativeAgent,
  type StandaloneEnv,
} from "../../src/standalone/worker.js";
import { AgentModelRefused } from "../../src/standalone/agent-model-choice.js";
import { standaloneAgents } from "../../src/standalone/agents.js";
import { standaloneTenancy } from "../../src/standalone/tenancy.js";
import { oysterPrincipalIsOwner } from "../../src/host.js";

export * from "../../src/standalone/worker.js";

/** The real Agent with a proof-only read of its acquired model door. */
export class StandaloneAgent extends NativeAgent {
  async probeModel() {
    const source = this.modelSource();
    try {
      const lease = await source.acquire({
        sessionId: "model-proof",
        preference: null,
        signal: new AbortController().signal,
      });
      try {
        return {
          choice: await this.readModelChoice(),
          provider: lease.model.provider,
          model: lease.model.id,
        };
      } finally {
        await lease.release();
      }
    } catch (error) {
      if (error instanceof AgentModelRefused) return { error: error.reason };
      throw error;
    }
  }
}

export default {
  async fetch(
    request: Parameters<typeof standalone.fetch>[0],
    env: StandaloneEnv & {
      MODEL_PROOF: DurableObjectNamespace<StandaloneAgent>;
    },
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/model-proof-create") {
      const canonical = new Request(
        "https://oyster.test/model-proof-create",
        request,
      );
      const authenticated = await (
        await standaloneTenancy(env)
      ).oyster.resolve(canonical);
      if (authenticated === null)
        return new Response("Unauthorized", { status: 401 });
      const admission = await authenticated.auth.authenticate(canonical);
      if (
        admission.kind !== "admitted" ||
        !oysterPrincipalIsOwner(admission.principal)
      )
        return new Response("Forbidden", { status: 403 });
      const name = url.searchParams.get("name");
      if (name !== "First" && name !== "Second")
        return new Response("Invalid proof Agent", { status: 400 });
      return Response.json(
        await standaloneAgents(env).create(
          name,
          `model-choice-${name.toLowerCase()}`,
          admission.principal,
          "owner-direct",
        ),
      );
    }
    if (url.pathname.startsWith("/model-proof/")) {
      if (
        request.headers.get("Authorization") !==
        `Bearer ${env.OYSTER_OWNER_KEY}`
      )
        return new Response("Forbidden", { status: 403 });
      const id = url.pathname.slice("/model-proof/".length);
      const result = await env.MODEL_PROOF.getByName(id).probeModel();
      return Response.json(result, { status: "error" in result ? 409 : 200 });
    }
    return standalone.fetch(request, env, context);
  },
};
