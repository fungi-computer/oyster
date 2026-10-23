import { installationStore } from "./native-approval-host.fixture.mjs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import * as Schema from "effect/Schema";
import { defaultTenant, tenantScope, tenantIdSchema } from "../dist/tenant.js";
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "cloudflare:workers"
      ? {
          url: new URL("../dist/testing/workers-runtime.js", import.meta.url)
            .href,
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createOysterGitWorker, createOysterGitMcpOwner, oysterGitRoot } =
  await import("../dist/workers-git.js");
hooks.deregister();

export function ownerFrontends({ beforeHost } = {}) {
  const scope = tenantScope(defaultTenant, "https://oyster.test");
  const scopes = new Map([[scope.origin, scope]]);
  let principal = {
    actor: { kind: "member", memberId: "member-proof" },
    role: "owner",
  };
  let refusal;
  const auth = {
    authenticate: async () => refusal ?? { kind: "admitted", principal },
    resolve: async (actor) =>
      actor.kind === "member" &&
      principal.actor.kind === "member" &&
      actor.memberId === principal.actor.memberId
        ? principal
        : null,
  };
  const root = oysterGitRoot({
    tenancy: () => ({
      resolve: async (request) => {
        const selected = scopes.get(new URL(request.url).origin);
        return selected === undefined ? null : { scope: selected, auth };
      },
    }),
  });
  const Owner = createOysterGitMcpOwner({
    ...root,
    hostFor: async (env, selected) => {
      await beforeHost?.();
      return root.hostFor(env, selected);
    },
  });
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  let owner;
  const owners = new Map();
  const databases = new Map([[scope.durableName("mcp"), database]]);
  const registries = new Map();
  const env = {
    OYSTER_ORIGIN: scope.origin,
    OYSTER_OWNER_KEY: "unused-fixture-owner-key-24",
    RELEASES: {},
    LOADER: {},
    INSTANCES: {},
    KEYS: {},
    REGISTRY: {
      getByName: (name) => {
        if (!registries.has(name))
          registries.set(name, installationStore({ list: async () => [] }));
        return registries.get(name);
      },
    },
    MCP: {
      getByName: (name) => {
        if (!owners.has(name)) {
          const sqlite = new DatabaseSync(":memory:");
          databases.set(name, sqlite);
          owners.set(
            name,
            new Owner({ id: { name }, storage: fromNodeSqlite(sqlite) }, env),
          );
        }
        return owners.get(name);
      },
    },
  };
  const reconstruct = () => {
    owner = new Owner({ id: { name: scope.durableName("mcp") }, storage }, env);
    owners.set(scope.durableName("mcp"), owner);
  };
  reconstruct();
  const first = createOysterGitWorker(root);
  const second = createOysterGitWorker(root);
  return {
    first: {
      app: { fetch: (request) => first.fetch(request, env, {}) },
    },
    second: {
      app: { fetch: (request) => second.fetch(request, { ...env }, {}) },
    },
    reconstruct,
    populateCache: async () => {
      // More tenants than the existing frontend cache holds; retire the first.
      for (let at = 0; at < 33; at++) {
        const selected = tenantScope(
          Schema.decodeUnknownSync(tenantIdSchema)(`tenant-${at}`),
          `https://tenant-${at}.test`,
        );
        scopes.set(selected.origin, selected);
        const response = await first.fetch(
          new globalThis.Request(`${selected.origin}/mcp`),
          env,
          {},
        );
        if (response.status !== 404)
          throw new Error("Expected an uninitialized tenant session");
      }
    },
    setPrincipal: (value) => {
      principal = value;
    },
    refuse: (value) => {
      refusal = value;
    },
    withoutBinding: (request) =>
      second.fetch(request, { ...env, MCP: undefined }, {}),
    wrongPin: (request) =>
      owner.serve(request, {
        tenantId: scope.tenantId,
        origin: "https://elsewhere.test",
      }),
    close: () => {
      for (const sqlite of databases.values()) sqlite.close();
    },
  };
}
