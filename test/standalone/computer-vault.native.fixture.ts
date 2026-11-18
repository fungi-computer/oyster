/**
 * The Vault lane proof's fixture: the agent-computers fixture (only the model
 * is deterministic) plus one fake upstream API and owner-only proof doors for
 * the directory's host-only secret methods. The Agent, its Computers, the
 * gateway, the references and Veil's sealed custody are the production ones.
 *
 * The fake upstream answers the Worker's own fetch to its one hostname, after
 * Veil placed the value: it echoes the request's credential headers back (a
 * debug endpoint, the mirror attack) and redirects `/v1/redirect` elsewhere.
 * It keeps only whether each request carried the stored value, never the value.
 */
import * as z from "zod";
import base from "./agent-computers.native.fixture.js";
import { defaultTenant, tenantScope } from "../../src/tenant.js";
import { agentDirectoryForScope } from "../../src/standalone/agent-directory.js";
import type { StandaloneEnv } from "../../src/standalone/worker.js";

export * from "./agent-computers.native.fixture.js";

const vaultEchoHost = "vault-echo.fungi.computer";

const placedValues = new Set<string>();
const upstream: { path: string; placed: boolean }[] = [];
const workerFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== vaultEchoHost) return workerFetch(request);
  const authorization = request.headers.get("authorization") ?? "";
  upstream.push({
    path: url.pathname,
    placed: [...placedValues].some((value) => authorization.includes(value)),
  });
  if (url.pathname === "/v1/redirect")
    return new Response(null, {
      status: 302,
      headers: { location: "https://example.com/v1/collect" },
    });
  return Response.json(
    { echoed: { authorization }, path: url.pathname },
    { headers: { "x-echo": authorization } },
  );
};

const secretInput = z.strictObject({
  name: z.string(),
  secret: z.string(),
  agentId: z.string(),
});

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/vault-proof/"))
      return base.fetch(request, env, context);
    const directory = agentDirectoryForScope(
      env,
      tenantScope(defaultTenant, env.OYSTER_ORIGIN),
    );
    if (url.pathname === "/vault-proof/upstream")
      return Response.json(upstream);
    const body = await request.json();
    if (url.pathname === "/vault-proof/secret") {
      const input = secretInput.parse(body);
      placedValues.add(input.secret);
      const added = await directory.addSecret({
        name: input.name,
        destinations: [
          { host: vaultEchoHost, pathPrefix: "/v1", methods: ["GET", "POST"] },
        ],
        placement: "bearer",
        secret: input.secret,
      });
      if (!("connectionId" in added))
        return Response.json(added, { status: 409 });
      await directory.grantSecret(added.connectionId, {
        kind: "agent",
        id: input.agentId,
      });
      return Response.json(added);
    }
    const { connectionId, agentId } = z
      .strictObject({ connectionId: z.string(), agentId: z.string() })
      .parse(body);
    if (url.pathname === "/vault-proof/revoke") {
      await directory.ungrantSecret(connectionId, {
        kind: "agent",
        id: agentId,
      });
      return Response.json({ revoked: true });
    }
    if (url.pathname === "/vault-proof/usage")
      return Response.json(await directory.secretUsage(connectionId));
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<StandaloneEnv>;
