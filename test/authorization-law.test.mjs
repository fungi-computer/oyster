/* global Response */
// The bypass law: every Oyster HTTP route goes through authorization.ts.
// A route cannot be registered without a requirement (only that module
// builds a Hono), a served host answers only its declared table, and what a
// key reaches is decided in that one module.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { fileURLToPath, URL } from "node:url";
import { computerHost } from "./computer-host.fixture.mjs";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const files = readdirSync(source, { recursive: true, encoding: "utf8" })
  .filter((path) => /\.tsx?$/u.test(path) && !path.endsWith(".d.ts"))
  .map((path) => ({
    path: relative(source, join(source, path)),
    text: readFileSync(join(source, path), "utf8"),
  }));

// Routers that are not Oyster host routes, each with why.
const ownRouters = new Map([
  // Runs on the enrolled machine, never on an Oyster.
  ["machine-link/client.ts", "local machine side of the link"],
  // Durable Object internals, reached only through a declared door.
  ["machine-link/host.ts", "machine link DO, behind the connect door"],
  ["machine-link/link.ts", "machine link DO, behind the connect door"],
  ["standalone/workflows.ts", "Workflow run DO, behind the webhook door"],
  // Mounted by the Hub with its own visitor tokens; Oyster never serves it.
  ["channels/visitor-edge.ts", "Hub-mounted embed door"],
  // Sign-in adapters: their routes are the login door itself.
  ["tenancy/auth0.ts", "sign-in adapter"],
  ["tenancy/owner-key.ts", "sign-in adapter"],
]);

/**
 * Every run-time module load in a parsed file: `import()`, `require()`, and
 * a call to anything `createRequire(...)` returned (bound to a name, or called
 * at once). Yields each load's specifier, or `null` when it is not a literal.
 */
function moduleLoads(source) {
  const loaders = new Set(["require"]);
  const isCreateRequire = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "createRequire";
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isCreateRequire(node.initializer)
    )
      loaders.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const loads = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && loaders.has(callee.text)) ||
        isCreateRequire(callee)
      ) {
        const [specifier] = node.arguments;
        loads.push(
          specifier !== undefined && ts.isStringLiteralLike(specifier)
            ? specifier.text
            : null,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return loads;
}

/** Whether a source file can reach a Hono router entry point, by import binding. */
function importsRouter(path, text) {
  const router = (specifier) =>
    /^hono(?:\/(?:tiny|quick|hono-base|hono))?$/u.test(specifier);
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let reaches = false;
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      router(node.moduleSpecifier.text) &&
      node.importClause !== undefined &&
      !node.importClause.isTypeOnly
    ) {
      const { name, namedBindings } = node.importClause;
      if (
        name !== undefined ||
        (namedBindings !== undefined &&
          (ts.isNamespaceImport(namedBindings) ||
            namedBindings.elements.some((element) => !element.isTypeOnly)))
      )
        reaches = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return (
    reaches ||
    moduleLoads(source).some(
      (specifier) => specifier === null || router(specifier),
    )
  );
}

// Build-sandbox programs: they run on the build Computer, never in the Oyster
// host, and load the App's own toolchain by computed path.
const buildPrograms = new Set(["build/snapshot-programs/dependency-build.ts"]);

// Browser bundles: never part of the HTTP host (`commands.mount` is UI).
const browserCode = new Set(["page/mount.ts"]);

test("only authorization.ts builds a router for the Oyster host", () => {
  const offenders = files
    .filter(({ path }) => path !== "authorization.ts" && !ownRouters.has(path))
    .filter(
      ({ text }) =>
        // Any router construction, through any name or namespace.
        /\bnew\s+(?:[A-Za-z_$][\w$]*\.)?Hono\b/u.test(text) ||
        // Any value import of a router entry point (`hono`, `hono/tiny`,
        // `hono/quick`), named, default or namespace; type imports are fine.
        /import\s+(?!type\b)[^;]*?from\s*["']hono(?:\/(?:tiny|quick))?["']/u.test(
          text,
        ),
    )
    .map(({ path }) => path);
  assert.deepEqual(offenders, []);
  // The same law by import binding, parsed: static or dynamic, any name.
  const parsed = files
    .filter(
      ({ path }) =>
        path !== "authorization.ts" &&
        !ownRouters.has(path) &&
        !buildPrograms.has(path),
    )
    .filter(({ path, text }) => importsRouter(path, text))
    .map(({ path }) => path);
  assert.deepEqual(parsed, []);
  for (const text of [
    'const { Hono: H } = await import("hono");',
    'import { Hono as R } from "hono/hono-base";',
    'import * as h from "hono/tiny";',
    "const m = await import(specifier);",
    'const { Hono } = require("hono");',
    'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nconst { Hono } = r("hono/tiny");',
  ])
    assert.ok(importsRouter("probe.ts", text), text);
  assert.ok(!importsRouter("probe.ts", 'import type { Context } from "hono";'));
  // Every allowed router still exists, so the list cannot rot into a loophole.
  for (const path of ownRouters.keys())
    assert.ok(
      files.some(
        (file) => file.path === path && /\bnew Hono\b/u.test(file.text),
      ),
      `${path} no longer builds its own router; drop it from the list`,
    );
});

test("what a key reaches is decided only in authorization.ts", () => {
  const decisions =
    /\bfunction\s+(keyAppAccess|keyAgentAccess|keyAllowsComputerUse|allowsMachineEnrollment|reachesAgent|reachesComputer|reachesInstallation|appToolAccess)\b/u;
  const offenders = files
    .filter(
      ({ path, text }) => path !== "authorization.ts" && decisions.test(text),
    )
    .map(({ path }) => path);
  assert.deepEqual(offenders, []);
  // Key grants are read through the vocabulary only by the decision module.
  const grantReaders = files
    .filter(
      ({ path, text }) =>
        path !== "authorization.ts" &&
        path !== "keys.ts" &&
        /oysterKeyVocabulary\.grantsAllow/u.test(text),
    )
    .map(({ path }) => path);
  assert.deepEqual(grantReaders, []);
});

test("no route trusts a path prefix or a middleware for its authority", () => {
  // Router composition (`use`, `mount`, `route`, `basePath`) could answer a
  // path no route declares; only authorization.ts composes a router.
  const composes = /\.(?:use|mount|route|basePath)\(/u;
  const offenders = files
    .filter(
      ({ path }) =>
        path !== "authorization.ts" &&
        !ownRouters.has(path) &&
        !browserCode.has(path),
    )
    .filter(({ text }) => composes.test(text))
    .map(({ path }) => path);
  assert.deepEqual(offenders, []);
});

// The functions that serve a table with a caller-chosen principal.
const servers = ["serveHost", "serveDoors", "serveCapability"];
/** Whether a module specifier names the authorization module. */
const isAuthorization = (specifier) =>
  /(?:^|\/)authorization(?:\.[cm]?[jt]s)?$/u.test(specifier);

/**
 * What one source file can reach of the serving functions, by import
 * binding, parsed with the TypeScript compiler (never by call text): a named
 * import under any alias, a namespace or default import, any dynamic import
 * of the module (or of a specifier it cannot read), and any re-export.
 */
function servingReach(path, text) {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bound = new Set();
  const reExported = new Set();
  // Local names bound to a serving function, so a later re-export is seen.
  const locals = new Map();
  const every = (into) => {
    for (const name of servers) into.add(name);
  };
  const named = (elements, into) => {
    for (const element of elements)
      if (!element.isTypeOnly) {
        const name = (element.propertyName ?? element.name).text;
        if (servers.includes(name)) into.add(name);
      }
  };
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isAuthorization(node.moduleSpecifier.text) &&
      node.importClause !== undefined &&
      !node.importClause.isTypeOnly
    ) {
      const { name, namedBindings } = node.importClause;
      if (name !== undefined) every(bound);
      if (namedBindings !== undefined)
        if (ts.isNamespaceImport(namedBindings)) every(bound);
        else {
          named(namedBindings.elements, bound);
          for (const element of namedBindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (servers.includes(imported))
              locals.set(element.name.text, imported);
          }
        }
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const from = node.moduleSpecifier;
      const fromAuthorization =
        from !== undefined &&
        ts.isStringLiteral(from) &&
        isAuthorization(from.text);
      if (fromAuthorization) {
        const clause = node.exportClause;
        if (clause === undefined || ts.isNamespaceExport(clause)) {
          every(bound);
          every(reExported);
        } else {
          named(clause.elements, bound);
          named(clause.elements, reExported);
        }
      } else if (
        from === undefined &&
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
      )
        // A local re-export of a binding this file imported, under any name.
        for (const element of node.exportClause.elements) {
          const local = (element.propertyName ?? element.name).text;
          const imported = locals.get(local);
          if (imported !== undefined) reExported.add(imported);
          if (servers.includes(local)) reExported.add(local);
        }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (
    moduleLoads(source).some(
      (specifier) => specifier === null || isAuthorization(specifier),
    )
  )
    every(bound);
  return {
    bound: servers.filter((name) => bound.has(name)),
    reExported: servers.filter((name) => reExported.has(name)),
  };
}
const servingBindings = (path, text) => servingReach(path, text).bound;
/**
 * In a root, every reference to an imported serving function that is not
 * the callee of a call: an export, an assignment, an argument, a property
 * value, a member access. Each is a hand-off past the law.
 */
function servingHandOffs(path, text) {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const locals = new Set();
  for (const statement of source.statements)
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      isAuthorization(statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings)
    )
      for (const element of statement.importClause.namedBindings.elements)
        if (servers.includes((element.propertyName ?? element.name).text))
          locals.add(element.name.text);
  const handOffs = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && locals.has(node.text)) {
      const parent = node.parent;
      const called = ts.isCallExpression(parent) && parent.expression === node;
      if (!called)
        handOffs.push(
          `${node.text} at ${String(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)}`,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return handOffs;
}

test("the serving law sees every way a file can reach a serving function", () => {
  const reaches = {
    'import { serveCapability as serveRoutes } from "./authorization.js";\nserveRoutes(t, p);':
      ["serveCapability"],
    // A dynamic import reaches the whole module, whatever it destructures.
    'const { serveHost: s } = await import("../authorization.js");\ns(t, a, p);':
      ["serveHost", "serveDoors", "serveCapability"],
    'export { serveHost as serveTenant } from "./authorization.js";': [
      "serveHost",
    ],
    'import * as authz from "./authorization.js";\nauthz["serve" + "Host"](t, a, p);':
      ["serveHost", "serveDoors", "serveCapability"],
    'const m = await import("./authorization.js");\nm.serveDoors(t);': [
      "serveHost",
      "serveDoors",
      "serveCapability",
    ],
    'export * from "./authorization.js";': [
      "serveHost",
      "serveDoors",
      "serveCapability",
    ],
    'import { serveDoors } from "./authorization.js";\nserveDoors (t);': [
      "serveDoors",
    ],
    // CommonJS loading reaches the whole module, like a dynamic import.
    'const { serveHost } = require("./authorization.js");': [
      "serveHost",
      "serveDoors",
      "serveCapability",
    ],
    'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload("../authorization.js").serveDoors(t);':
      ["serveHost", "serveDoors", "serveCapability"],
    'import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("./authorization.js");':
      ["serveHost", "serveDoors", "serveCapability"],
    // A comment naming a serving function reaches nothing.
    "// serveDoors serves this table.\nexport const x = 1;": [],
  };
  for (const [text, expected] of Object.entries(reaches))
    assert.deepEqual(
      servingBindings("standalone/probe.ts", text),
      expected,
      text,
    );
  // A re-export, from the module or of a local binding, is seen as one.
  for (const text of [
    'export { serveHost as serveTenant } from "./authorization.js";',
    'export * from "./authorization.js";',
    'import { serveDoors as d } from "./authorization.js";\nexport { d as serveDoors };',
  ])
    assert.ok(servingReach("probe.ts", text).reExported.length > 0, text);
  // In a root, a serving function is only ever called, never handed on.
  const root = 'import { serveHost } from "./authorization.js";\n';
  for (const text of [
    "export const s = serveHost;",
    "const s = serveHost;",
    "register(serveHost);",
    "const ports = { serve: serveHost };",
    "const ports = { serveHost };",
    "export default serveHost;",
    "let s; s = serveHost;",
    "serveHost.call(null, t, a, p);",
  ])
    assert.ok(servingHandOffs("host.ts", root + text).length > 0, text);
  assert.deepEqual(
    servingHandOffs("host.ts", root + "serveHost(t, a, p);"),
    [],
  );
});

test("only the composition roots serve a table", () => {
  // Who serves with which principal: the tenant host and its capability
  // dispatch, and the Worker top's doors.
  const allowed = {
    "host.ts": ["serveHost", "serveCapability"],
    "standalone/worker.ts": ["serveDoors"],
  };
  const reached = Object.fromEntries(
    files
      .filter(
        ({ path }) => path !== "authorization.ts" && !buildPrograms.has(path),
      )
      .map(({ path, text }) => [path, servingBindings(path, text)])
      .filter(([, names]) => names.length > 0),
  );
  assert.deepEqual(reached, allowed);
  // Each exempt build program still loads by computed path, and imports
  // nothing from the host; otherwise it drops off the list.
  for (const path of buildPrograms) {
    const file = files.find((candidate) => candidate.path === path);
    assert.ok(file, `${path} is gone; drop it from the list`);
    assert.ok(/createRequire/u.test(file.text), path);
    assert.deepEqual(
      servingReach(path, file.text.replaceAll(/createRequire|require\(/gu, "_"))
        .bound,
      [],
      path,
    );
  }
  // A root only ever calls the serving functions it imports.
  for (const path of Object.keys(allowed)) {
    const file = files.find((candidate) => candidate.path === path);
    assert.ok(file, path);
    assert.deepEqual(servingHandOffs(path, file.text), [], path);
  }
  // No module hands a serving function on, under any name.
  const reExports = files
    .filter(({ path }) => path !== "authorization.ts")
    .filter(({ path, text }) => servingReach(path, text).reExported.length > 0)
    .map(({ path }) => path);
  assert.deepEqual(reExports, []);
});

// workers-git.js imports `cloudflare:workers` for its Durable Object bases.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: new URL("../dist/testing/workers-runtime.js", import.meta.url)
          .href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { oysterGitOwnerRoutes } = await import("../dist/workers-git.js");
const { tenantScope, defaultTenant } = await import("../dist/tenant.js");
const { standaloneOwnerRoutes } =
  await import("../dist/standalone/owner-routes.js");
const { standaloneWorkerRoutes } =
  await import("../dist/standalone/worker-routes.js");
const { standaloneWorkflowWebhookRoutes } =
  await import("../dist/standalone/workflow-webhooks.js");
const { workersMedia } = await import("../dist/standalone/media.js");
hooks.deregister();
const { oysterRouteTable } = await import("../dist/host.js");
const { agentCapabilities } = await import("../dist/agents.js");
const { fileCapabilities } = await import("../dist/files.js");
const { approvalCapability } = await import("../dist/approval-capability.js");
const { capabilityFixture } = await import("../dist/testing/index.js");
const {
  Requirement,
  owner,
  publicRoute,
  routes,
  serveCapability,
  serveDoors,
  serveHost,
} = await import("../dist/authorization.js");
const { createOyster } = await import("../dist/host.js");

const kinds = new Set([
  "public",
  "door",
  "owner",
  "member",
  "app",
  "apps",
  "agent",
  "agents",
  "computer",
]);

// Owner custody that never rides an App: keys, webhooks, consent, install
// status, Agent models, tool approval and MCP servers.
const directOwnerPaths = [
  /^\/api\/keys(?:\/|$)/u,
  /^\/api\/webhooks(?:\/|$)/u,
  /^\/api\/installations\/:installationId\/(?:grants|status)$/u,
  /^\/api\/agent-models\//u,
  /^\/api\/agent-policies\//u,
  /^\/api\/agent-mcp-servers(?:\/|$)/u,
];

/** A host composed with every Oyster-owned table the standalone root serves. */
async function composedHostOptions() {
  const unused = () => assert.fail("the law test never calls an adapter");
  const agents = new Proxy({}, { get: () => unused });
  const files = new Proxy({}, { get: () => unused });
  const scope = tenantScope(defaultTenant, "https://oyster.test");
  const base = await computerHost(
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    "host-workspace",
    {},
    [
      ...agentCapabilities(agents),
      ...fileCapabilities(files),
      approvalCapability(() => agents),
      ...workersMedia({}, { computerId: "host-workspace", files }),
    ],
  );
  // The standalone root's own owner table, through the same functions the
  // Worker composes (`standalone/worker.ts`, `oysterGitWorkerHost`).
  const ownerRoutes = oysterGitOwnerRoutes(
    {},
    scope,
    standaloneOwnerRoutes({}, scope, unused),
    agents,
  );
  // Who signs in comes from the fixture header: the owner, a member, or no one.
  const auth = {
    ...base.auth,
    authenticate: async (request) => {
      switch (request.headers.get("x-who")) {
        case "member":
          return {
            kind: "admitted",
            principal: {
              actor: { kind: "member", memberId: "guest" },
              role: "member",
            },
          };
        case "anonymous":
          return { kind: "refused", status: 401 };
        default:
          return {
            kind: "admitted",
            principal: {
              actor: { kind: "member", memberId: "owner" },
              role: "owner",
            },
          };
      }
    },
  };
  return {
    ...base,
    auth,
    ownerRoutes,
    mcp: { handleRequest: unused },
    git: { writerOf: unused, git: unused },
  };
}

async function composedHost() {
  return oysterRouteTable(await composedHostOptions());
}

test("a composed host serves exactly its declared table", async () => {
  const table = await composedHost();
  const declared = table.declarations();
  for (const route of declared)
    assert.ok(kinds.has(route.requirement.kind), `${route.path} is undeclared`);
  // Public routes and doors say why they need no Oyster principal.
  for (const route of declared)
    if (
      route.requirement.kind === "public" ||
      route.requirement.kind === "door"
    )
      assert.ok(route.requirement.reason, `${route.path} names no reason`);
  // `/*` is the host's response decorators (timing, no-index); `serve`
  // keeps each route's status and body, and refuses one that answers.
  const served = new Set(
    table
      .serve()
      .servedPaths()
      .filter((path) => path !== "/*"),
  );
  const paths = new Set(declared.map((route) => route.path));
  assert.deepEqual(
    [...served].filter((path) => !paths.has(path)),
    [],
  );
  assert.deepEqual(
    [...paths].filter((path) => !served.has(path)),
    [],
  );
  // Every standalone owner table is composed here.
  for (const owned of [
    "/api/computers",
    "/api/builds",
    "/api/apps/:appId/source",
    "/api/agents/:agentId/computers/:operation",
    "/api/installations/:installationId/workflows/webhooks",
  ])
    assert.ok(paths.has(owned), `${owned} is not composed`);
  // Every host /api route is the owner's.
  for (const route of declared)
    if (route.path.startsWith("/api/"))
      assert.equal(route.requirement.kind, "owner", route.path);
  // Custody that never rides an App is exactly `direct`.
  for (const route of declared)
    if (directOwnerPaths.some((pattern) => pattern.test(route.path)))
      assert.deepEqual(
        route.requirement,
        { kind: "owner", via: "direct" },
        route.path,
      );
  // An undeclared path is not served, even to the owner.
  const response = await table
    .serve()
    .request("https://oyster.test/api/undeclared");
  assert.equal(response.status, 404);
});

test("the real host refuses App-mediated requests to direct owner custody", async () => {
  const table = await composedHost();
  const app = table.serve();
  const direct = table
    .declarations()
    .filter((route) =>
      directOwnerPaths.some((pattern) => pattern.test(route.path)),
    );
  assert.ok(direct.length >= 12, "every direct custody route is composed");
  for (const route of direct) {
    const path = route.path.replaceAll(/:[A-Za-z]+/gu, "probe");
    const methods = route.methods === "ALL" ? ["GET", "POST"] : route.methods;
    for (const method of methods) {
      const response = await app.request(`https://oyster.test${path}`, {
        method,
        headers: { "X-Oyster-Installation": "context-probe" },
      });
      assert.equal(response.status, 403, `${method} ${route.path}`);
      assert.deepEqual(
        await response.json(),
        { error: "Owner direct only" },
        `${method} ${route.path}`,
      );
    }
  }
});

test("every host /api route's owner reach is classified", async () => {
  // A new owner route fails here until someone chooses its reach: "direct"
  // for custody that never rides an App, "direct-or-app" otherwise.
  const table = await composedHost();
  const classified = table
    .declarations()
    .filter((route) => route.path.startsWith("/api/"))
    .map(
      (route) =>
        `${route.methods === "ALL" ? "ALL" : route.methods.join("|")} ${route.path} ${route.requirement.via}`,
    );
  assert.deepEqual(classified, [
    "GET /api/keys direct",
    "POST /api/keys direct",
    "POST /api/keys/revoke direct",
    "POST /api/webhooks direct",
    "GET /api/webhooks direct",
    "GET /api/webhooks/:id/deliveries direct",
    "DELETE /api/webhooks/:id direct",
    "GET|POST /api/apps/:appId/source.git/:suffix{info/refs|git-upload-pack|git-receive-pack} direct-or-app",
    "PUT /api/apps/:appId/source direct-or-app",
    "POST /api/builds direct-or-app",
    "GET /api/builds/:jobId direct-or-app",
    "GET /api/workbench/directory direct-or-app",
    "GET /api/computers direct-or-app",
    "GET /api/workbench/computers direct-or-app",
    "POST /api/computers direct-or-app",
    "POST /api/computers/:computerId/start direct-or-app",
    "GET /api/computers/:computerId/internet-access direct-or-app",
    "PUT /api/computers/:computerId/internet-access direct-or-app",
    "GET /api/computers/:computerId direct-or-app",
    "PUT /api/computers/selected direct-or-app",
    "POST /api/agents/:agentId/computers/:operation direct-or-app",
    "POST /api/installations/:installationId/workflows/webhooks direct-or-app",
    "GET /api/agent-models/:agentId direct",
    "PUT /api/agent-models/:agentId direct",
    "GET /api/agent-policies/:agentId direct",
    "PUT /api/agent-policies/:agentId direct",
    "GET /api/agent-mcp-servers direct",
    "POST /api/agent-mcp-servers/:agentId direct",
    "DELETE /api/agent-mcp-servers/:agentId/:serverId direct",
    "GET /api/workbench/directory direct-or-app",
    "ALL /api/workbench/storage/:installationId/:operation direct-or-app",
    "GET /api/installations direct-or-app",
    "PUT /api/artifacts/:artifactRef direct-or-app",
    "POST /api/installations direct-or-app",
    "GET /api/installations/:installationId/status direct",
    "GET /api/installations/:installationId/grants direct",
    "PUT /api/installations/:installationId/grants direct",
    "PUT /api/installations/:installationId/release direct-or-app",
    "DELETE /api/installations/:installationId direct-or-app",
  ]);
});

test("every host /api route refuses anyone but the owner", async () => {
  const table = await composedHost();
  const app = table.serve();
  const api = table
    .declarations()
    .filter((route) => route.path.startsWith("/api/"));
  assert.ok(api.length >= 30, "every owner table is composed");
  for (const route of api) {
    const path = route.path
      .replaceAll(/:[A-Za-z]+\{[^}]*\}/gu, "info/refs")
      .replaceAll(/:[A-Za-z]+/gu, "probe");
    const methods = route.methods === "ALL" ? ["GET", "POST"] : route.methods;
    for (const method of methods)
      for (const [who, status] of [
        ["anonymous", 401],
        ["member", 403],
      ]) {
        const response = await app.request(`https://oyster.test${path}`, {
          method,
          headers: { "x-who": who },
        });
        assert.equal(response.status, status, `${who} ${method} ${route.path}`);
      }
  }
});

// Oyster is owner-only (Levi 10-28): an anonymous request reaches only
// sign-in, robots.txt and digest-pinned bytes. Doors verify their own
// credential (MCP, Git, signed webhooks, the posted owner key).
const anonymousPublicPaths = [
  "/_oyster/assets/*",
  "/login",
  "/robots.txt",
  "/ui-entry/:installationId/:releaseId/shell.js",
  "/ui/:installationId/:releaseId/*",
];

test("no requirement admits an anonymous request outside sign-in, robots.txt and assets", async () => {
  const table = await composedHost();
  const declared = table.declarations();
  assert.deepEqual(
    declared
      .filter((route) => route.requirement.kind === "public")
      .map((route) => route.path)
      .sort(),
    anonymousPublicPaths,
  );
  const app = table.serve();
  for (const route of declared) {
    if (
      route.requirement.kind === "public" ||
      route.requirement.kind === "door"
    )
      continue;
    const path = route.path
      .replaceAll(/:[A-Za-z]+\{[^}]*\}/gu, "info/refs")
      .replaceAll(/:[A-Za-z]+/gu, "probe")
      .replaceAll("*", "probe");
    const methods = route.methods === "ALL" ? ["GET", "POST"] : route.methods;
    for (const method of methods)
      for (const accept of ["application/json", "text/html"]) {
        const response = await app.request(`https://oyster.test${path}`, {
          method,
          headers: { "x-who": "anonymous", Accept: accept },
        });
        const browserPage = method === "GET" && accept === "text/html";
        assert.equal(
          response.status,
          browserPage ? 302 : 401,
          `${method} ${route.path} (${accept})`,
        );
        if (browserPage)
          assert.equal(response.headers.get("Location"), "/login", route.path);
      }
  }
});

test("Files and Media need computer.use for a key and refuse an Agent", async () => {
  const grants = {
    app: [{ capability: "apps.use", targets: { kind: "all" } }],
    computer: [
      { capability: "apps.use", targets: { kind: "all" } },
      { capability: "computer.use", targets: { kind: "all" } },
    ],
  };
  const source = {
    list: async () => ({ path: "/", entries: [], nextOffset: null }),
    read: async () => new globalThis.TextEncoder().encode("workspace"),
    write: () => assert.fail("reads never write"),
    mkdir: () => assert.fail("reads never write"),
    replace: () => assert.fail("reads never write"),
  };
  const principalOf = (request) => {
    const who = request.headers.get("x-who");
    return who === "agent"
      ? { actor: { kind: "agent", agentId: "agent_a" } }
      : { actor: { kind: "team-key", keyId: who } };
  };
  const options = {
    authenticate: async (request) => ({
      kind: "admitted",
      principal: principalOf(request),
    }),
    liveKey: async (keyId) =>
      grants[keyId] === undefined
        ? null
        : { keyId, owner: "owner", grantVersion: 1, grants: grants[keyId] },
  };
  const files = await capabilityFixture({
    ...options,
    capabilities: ["computer.readFile"],
    fileSource: source,
  });
  const media = await capabilityFixture({
    ...options,
    capabilities: ["media.generation"],
    adapters: workersMedia(
      {
        AI: { run: () => assert.fail("a refused key never reaches the model") },
      },
      { computerId: "workspace", files: source },
    ),
  });
  const call = (fixture, path, who) =>
    fixture.app.request(`https://oyster.test${path}`, {
      headers: { "X-Oyster-Installation": "capability-fixture", "x-who": who },
    });
  assert.equal(
    (await call(files, "/files/content?path=/a", "app")).status,
    403,
  );
  assert.equal(
    (await call(files, "/files/content?path=/a", "revoked")).status,
    403,
  );
  assert.equal((await call(media, "/media/describe", "app")).status, 403);
  const granted = await call(files, "/files/content?path=/a", "computer");
  assert.equal(granted.status, 200);
  assert.equal(await granted.text(), "workspace");
  // An Agent principal never reaches Files or Media over HTTP.
  assert.equal(
    (await call(files, "/files/content?path=/a", "agent")).status,
    403,
  );
  assert.equal((await call(media, "/media/describe", "agent")).status, 403);
});

test("only minted requirements register; a copy or look-alike throws", () => {
  const minted = owner("direct");
  // A spread copies the object's own fields, never its private mint record.
  const forgeries = [
    { ...minted, admit: () => Promise.resolve(null) },
    { ...publicRoute("fixture"), kind: "owner" },
    {
      kind: "public",
      reason: "forged",
      declared: { kind: "public", reason: "forged" },
      admit: () => Promise.resolve(null),
    },
    Object.create(Requirement.prototype),
  ];
  for (const forged of forgeries)
    assert.throws(
      () => routes().get("/api/keys", forged, () => new Response("forged")),
      /did not mint/u,
    );
  // The class refuses a caller without the module's mint token.
  assert.throws(
    () =>
      new Requirement(Symbol("forged"), { kind: "public" }, () =>
        Promise.resolve(null),
      ),
    /Only authorization.ts mints/u,
  );
  // A declaration's label comes from the mint record.
  const declared = routes()
    .get("/api/keys", minted, () => new Response("keys"))
    .declarations();
  assert.deepEqual(declared[0]?.requirement, { kind: "owner", via: "direct" });
});

test("inside a capability table every request is App-mediated", async () => {
  const capability = serveCapability(
    routes()
      .get("/direct", owner("direct"), () => new Response("direct"))
      .get(
        "/either",
        owner("direct-or-app"),
        (_context, { origin }) => new Response(origin),
      ),
    { liveKey: async () => null, appToolPolicy: () => null },
  );
  // The dispatcher's admission, as a browser socket admitted by query
  // parameter (no header) presents it.
  const admission = {
    principal: { actor: { kind: "member", memberId: "owner" }, role: "owner" },
  };
  const direct = await capability.request(
    "https://oyster.test/direct",
    {},
    admission,
  );
  assert.equal(direct.status, 403);
  const either = await capability.request(
    "https://oyster.test/either",
    {},
    admission,
  );
  assert.equal(await either.text(), "app");
});

// A route that would leak if its requirement could be bent.
const secretTable = (requirement) =>
  routes().post("/api/keys", requirement, () => new Response("SECRET"));
const anonymous = () => Promise.resolve({ kind: "refused", status: 401 });
const noPorts = { liveKey: async () => null, appToolPolicy: () => null };
const forgedOwner = async () => ({
  principal: { actor: { kind: "member", memberId: "owner" }, role: "owner" },
  origin: "owner-direct",
});
/** Try a mutation; a frozen requirement refuses it, which is the point. */
const attempt = (mutate) => {
  try {
    mutate();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
};

test("a minted requirement cannot be bent after minting", async () => {
  const overridden = owner("direct");
  attempt(() => {
    overridden.admit = forgedOwner;
  });
  const reprototyped = owner("direct");
  attempt(() => Object.setPrototypeOf(reprototyped, { admit: forgedOwner }));
  const relabelled = publicRoute("fixture");
  attempt(() =>
    Object.assign(relabelled.declared ?? {}, { kind: "owner", via: "direct" }),
  );
  const redefined = owner("direct");
  attempt(() =>
    Object.defineProperty(redefined, "declared", {
      get: () => ({ kind: "public", reason: "forged" }),
    }),
  );
  for (const requirement of [overridden, reprototyped, redefined]) {
    const table = secretTable(requirement);
    assert.deepEqual(table.declarations()[0]?.requirement, {
      kind: "owner",
      via: "direct",
    });
    const response = await serveHost(table, anonymous, noPorts).request(
      "https://oyster.test/api/keys",
      { method: "POST" },
    );
    assert.equal(response.status, 401);
  }
  // The public route keeps its own label and nothing more.
  assert.deepEqual(secretTable(relabelled).declarations()[0]?.requirement, {
    kind: "public",
    reason: "fixture",
  });
  assert.ok(Object.isFrozen(owner("direct")));
});

const ownerPrincipal = {
  actor: { kind: "member", memberId: "owner" },
  role: "owner",
};
const alwaysOwner = async () => ({
  kind: "admitted",
  principal: ownerPrincipal,
});

test("only tables routes() built can be included or served", async () => {
  const real = secretTable(owner("direct"));
  const lying = {
    ...real,
    serve: (principal, ports, options) =>
      secretTable(publicRoute("forged")).serve(principal, ports, options),
    declarations: () => real.declarations(),
  };
  const forging = {
    ...real,
    serve: (_principal, ports, options) =>
      real.serve(alwaysOwner, ports, options),
  };
  for (const forged of [lying, forging, Object.create(real)]) {
    assert.throws(() => routes().include(forged), /routes\(\) did not build/u);
    assert.throws(
      () => serveHost(forged, anonymous, noPorts),
      /routes\(\) did not build/u,
    );
    assert.throws(
      () => serveCapability(forged, noPorts),
      /routes\(\) did not build/u,
    );
    assert.throws(() => serveDoors(forged), /routes\(\) did not build/u);
  }
  // A table offers no way to serve itself with a principal of its choosing.
  assert.equal(real.serve, undefined);
  assert.ok(Object.isFrozen(real));
});

test("a served table is a fetch-only view, never a router", async () => {
  const served = serveHost(secretTable(owner("direct")), anonymous, noPorts);
  for (const name of ["use", "mount", "route", "basePath", "all", "on", "get"])
    assert.equal(served[name], undefined, name);
  assert.ok(Object.isFrozen(served));
  const response = await served.request("https://oyster.test/api/keys", {
    method: "POST",
  });
  assert.equal(response.status, 401);
});

test("serve refuses an option it does not know", () => {
  const table = secretTable(owner("direct"));
  for (const options of [
    { around: [async (_context, next) => next()] },
    { mediated: () => false },
  ])
    assert.throws(
      () => serveHost(table, anonymous, noPorts, options),
      /option/u,
    );
});

test("the real host and Worker serve nothing undeclared under /api", async () => {
  const host = createOyster(await composedHostOptions());
  for (const name of ["use", "mount", "route", "basePath"])
    assert.equal(host[name], undefined, name);
  const top = serveDoors(
    standaloneWorkerRoutes({
      machineLink: async () => new Response("link"),
      workflowWebhooks: standaloneWorkflowWebhookRoutes(
        { WORKFLOW_RUNS: { getByName: () => assert.fail("no delivery") } },
        async () => null,
      ),
      tenant: (request) => host.fetch(request),
    }),
  );
  for (const path of [
    "/api/undeclared",
    "/api/mounted/x",
    "/api/keys/extra",
    "/api/installations/probe/undeclared",
  ])
    for (const served of [host, top]) {
      const response = await served.request(`https://oyster.test${path}`, {
        headers: { "x-who": "owner" },
      });
      assert.equal(response.status, 404, path);
    }
  // The Worker's own /api doors are exactly the signed and device doors.
  const doors = standaloneWorkerRoutes({
    machineLink: async () => new Response("link"),
    workflowWebhooks: standaloneWorkflowWebhookRoutes(
      { WORKFLOW_RUNS: { getByName: () => assert.fail("no delivery") } },
      async () => null,
    ),
    tenant: async () => new Response("tenant"),
  })
    .declarations()
    .filter((route) => route.path.startsWith("/api/"))
    .map((route) => [route.path, route.requirement.kind]);
  assert.deepEqual(doors, [
    ["/api/teams/:teamId/local/mesh/:deviceId/connect", "door"],
    [
      "/api/installations/:installationId/workflows/webhooks/:bindingId",
      "door",
    ],
  ]);
});
