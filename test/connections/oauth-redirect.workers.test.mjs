import { env, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  ConnectionsError,
  createConnections,
  createSealedCustody,
} from "@fungi.computer/veil/connections";

const mcp = "https://mcp.example.com/mcp";
const callback = "https://oyster.example.com/api/connections/callback";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** An authorization server whose discovery, registration and token answers are plain. */
function remote(options = {}) {
  const seen = [];
  const fetch = (request) => {
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.host}${url.pathname}`);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return Promise.resolve(
        json({
          resource: mcp,
          authorization_servers: ["https://auth.example.com"],
        }),
      );
    switch (url.pathname) {
      case "/.well-known/oauth-authorization-server":
        return Promise.resolve(
          json({
            issuer: "https://auth.example.com",
            authorization_endpoint: "https://auth.example.com/authorize",
            token_endpoint: "https://auth.example.com/token",
            registration_endpoint: "https://auth.example.com/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            authorization_response_iss_parameter_supported: true,
          }),
        );
      case "/register":
        return Promise.resolve(
          json({ redirect_uris: [callback], client_id: "dcr-1" }, 201),
        );
      case "/token":
        return Promise.resolve(
          options.redirectTokens === true
            ? new Response(null, {
                status: 302,
                headers: { location: "https://evil.example/token" },
              })
            : json({
                access_token: "access-1",
                token_type: "Bearer",
                refresh_token: "refresh-1",
                expires_in: 3600,
              }),
        );
      default:
        return Promise.resolve(new Response("not found", { status: 404 }));
    }
  };
  return { fetch, seen };
}

/** Connections on a Durable Object's SQLite, with the sealed custody an owner holds. */
async function withConnections(world, owner, body) {
  // Each test owns its Durable Object: a repeated request id would replay the first attempt.
  const stub = env.OWNER.get(env.OWNER.idFromName(owner));
  return runInDurableObject(stub, async (_instance, state) => {
    const vault = new Map();
    let counter = 0;
    const connections = createConnections({
      ownerId: "owner-1",
      store: state.storage,
      custody: createSealedCustody({
        vault: {
          put: ({ secret }) => {
            counter += 1;
            const id = `cred-${String(counter)}`;
            vault.set(id, secret);
            return Promise.resolve({ credentialId: id });
          },
          withSecret: (id, action) => {
            const secret = vault.get(id);
            return secret === undefined
              ? Promise.reject(new Error("absent"))
              : Promise.resolve(action(secret));
          },
          remove: (id) =>
            Promise.resolve(vault.delete(id) ? "deleted" : "absent"),
        },
        send: world.fetch,
      }),
      authorize: (actor) => actor === "owner",
      oauth: { callbackUrl: callback, fetch: world.fetch },
      clock: () => Date.now(),
      ids: () => `id${String((counter += 1))}`,
    });
    return body(connections);
  });
}

const begin = (connections) =>
  Effect.runPromise(
    connections.begin("owner", {
      requestId: "req-1",
      name: "Docs",
      surface: { kind: "mcp", url: mcp },
      credential: { kind: "oauth", clientId: undefined },
      secret: undefined,
    }),
  );

const approve = (authorizeUrl) => {
  const query = new URL(authorizeUrl).searchParams;
  return {
    state: query.get("state") ?? "",
    code: "code-1",
    iss: "https://auth.example.com",
  };
};

describe("OAuth Connection flow on workerd", () => {
  it("discovers, registers and exchanges a token without a redirect: error request", async () => {
    const world = remote();
    await withConnections(world, "owner-ok", async (connections) => {
      const started = await begin(connections);
      await Effect.runPromise(
        connections.complete("owner", approve(started.authorizeUrl ?? "")),
      );
    });
    expect(world.seen).toContain("POST auth.example.com/register");
    expect(world.seen).toContain("POST auth.example.com/token");
  });

  it("refuses a redirecting token endpoint with a plain error", async () => {
    const world = remote({ redirectTokens: true });
    const failure = await withConnections(
      world,
      "owner-redirect",
      async (connections) => {
        const started = await begin(connections);
        return Effect.runPromise(
          connections
            .complete("owner", approve(started.authorizeUrl ?? ""))
            .pipe(Effect.flip),
        );
      },
    );
    expect(failure).toBeInstanceOf(ConnectionsError);
    expect(failure.code).toBe("invalid_response");
    expect(world.seen).toContain("POST auth.example.com/token");
    expect(world.seen.some((entry) => entry.includes("evil.example"))).toBe(
      false,
    );
  });
});
