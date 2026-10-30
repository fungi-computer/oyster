// A disposable Agent-turn catalog, not a celld/Workers runtime proof.
import assert from "node:assert/strict";
import process from "node:process";
import { GCProfiler, getHeapStatistics } from "node:v8";
import { z } from "zod";
import * as Schema from "effect/Schema";
import { Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { appJsonSchema } from "@fungi.computer/forage";
import { backgroundOriginKey } from "@fungi.computer/puffball/background-replay";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { deriveDeclaredOperations } from "../dist/apps/index.js";
import { instanceIds } from "../dist/index.js";
import { appSurfaceCache, oysterAppMethods } from "../dist/mcp.js";
import { sha256, verifyRelease } from "../dist/release.js";

const mode = z.enum(["apps", "control", "all-writes"]).parse(process.argv[2]);
// Starter installation identities: src/standalone/app-set.ts.
// Visible counts copied from each apps/<name>/backend/methods.ts appBackend
// at 73d2028539 (through its maintained definition, including imported methods).
// Effects alternate to exercise the requested ~half-write share, not the Apps'
// exact policies. Schemas deliberately match the richer regression fixture.
const starterMethods = [
  ["tourtois", 9],
  ["bonsai", 41],
  ["shed", 8],
  ["inkcap", 6],
  ["trellis", 25],
  ["prints", 8],
  ["grove", 4],
];

// Same richness as agent-catalog-memory.test.mjs and the proposal's probe.
function recordSchema(seed) {
  const field = (index) => ({
    type: "object",
    properties: {
      [`id${index}`]: { type: "string", minLength: 1, maxLength: 128 },
      [`name${index}`]: {
        type: "string",
        pattern: "^[a-z][a-z0-9-]*$",
        maxLength: 64,
      },
      [`count${index}`]: { type: "integer", minimum: 0, maximum: 1000 },
      [`state${index}`]: { enum: ["open", "closed", `s${seed}`] },
      [`tags${index}`]: {
        type: "array",
        maxItems: 32,
        items: { type: "string", maxLength: 40 },
      },
    },
    required: [`id${index}`],
    additionalProperties: false,
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    anyOf: [
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [
            `part${index}`,
            field(index),
          ]),
        ),
        additionalProperties: false,
      },
      { type: "null" },
    ],
  };
}

const files = new Map();
async function put(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await sha256(bytes);
  const artifactRef = `artifact:sha256-${digest.slice(7)}`;
  files.set(artifactRef, bytes);
  return { artifactRef, digest };
}
const artifacts = { get: async (ref) => files.get(ref) ?? null };
const backend = await put({
  runtime: { kind: "durable-facet", stateSchema: 1 },
  compatibilityDate: "2026-09-04",
  exportName: "Catalog",
  code: "export class Catalog {}",
});
const installations = [];
const declarations = [];
const familyTool = {
  tool: "sample",
  title: "Sample workflow",
  description: "Run a published workflow",
  input: recordSchema(1000),
  output: recordSchema(1001),
  call: { workflowId: "workflow-catalog" },
};
for (const [app, count] of starterMethods) {
  const methods = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `method${index}`,
      {
        description: `${app} method ${index}`,
        input: recordSchema(index),
        output: recordSchema(index + count),
        effect: mode === "all-writes" || index % 2 !== 0 ? "write" : "read",
        requires: [],
      },
    ]),
  );
  // Root-relative references must survive the direct JSON description path.
  const referenced = methods.method1.output;
  methods.method1.output = {
    $schema: referenced.$schema,
    $defs: { record: referenced.anyOf[0] },
    anyOf: [{ $ref: "#/$defs/record" }, { type: "null" }],
  };
  const api = { methods };
  if (app === "trellis") {
    api.toolFamily = { name: "flows", list: "listTools", call: "method1" };
    methods.method1.input = { type: "object" };
    methods.method1.output = { type: "object" };
    methods.listTools = {
      description: "List the published workflow tools",
      hidden: true,
      effect: "read",
      requires: [],
      input: { type: "object", additionalProperties: false },
      output: { type: "object" },
    };
  }
  const root = await put({
    format: "fungi-app-v1",
    backend: {
      ...backend,
      version: backend.digest,
      byteLength: 1,
      mediaType: "application/vnd.fungi.app-backend+json",
    },
    declaration: { capabilities: [], handlers: [], roles: [], api },
  });
  const release = Schema.decodeUnknownSync(releaseSchema)({
    releaseId: `rel_catalog${app}`,
    appId: `app_${app}`,
    artifact: {
      artifactRef: root.artifactRef,
      artifactDigest: root.digest,
      provenance: {
        sourceRevision: `git:${"b".repeat(40)}`,
        sourceTreeDigest: root.digest,
        buildRecipeDigest: root.digest,
      },
    },
  });
  const verified = await verifyRelease(artifacts, release);
  const operations = await deriveDeclaredOperations(
    release,
    verified.declaration,
    [],
  );
  installations.push({
    installationId: app,
    instanceId: instanceIds.instance.generate(),
    release,
    status: "enabled",
    visibility: "private",
    appId: release.appId,
    releasePin: "pinned",
    approvedAnonymousMethods: [],
    anonymousApproval: null,
    authority: {
      authorityVersion: 1,
      declaredOperationsDigest: operations.digest,
      approvedGrants: [],
      approval: {
        by: { kind: "member", memberId: "owner" },
        at: 1000,
        authorityVersion: 1,
      },
    },
  });
  declarations.push({ app, methods });
}

let snapshots = 0;
let listings = 0;
const policy = {
  level: "write",
  revision: "catalog-policy",
  grantedBy: "owner",
};
const principal = { actor: { kind: "agent", agentId: "agent-catalog" } };
const host = {
  artifacts,
  backgroundOriginKey: () => backgroundOriginKey("catalog-proof-origin-key"),
  installations: {
    list: async () => installations,
    get: async (id) =>
      installations.find((row) => row.installationId === id) ?? null,
    generation: async () => {
      snapshots++;
      process.stderr.write(`catalog snapshot ${snapshots}\n`);
      return "catalog-generation";
    },
  },
  instances: {
    get: () => ({
      call: async (_facts, _api, method) => {
        assert.equal(
          method,
          "listTools",
          "capture invokes only the family listing",
        );
        listings++;
        return {
          ok: true,
          value: { kind: "ok", value: { kind: "ready", tools: [familyTool] } },
        };
      },
    }),
  },
  appToolPolicy: async () => policy,
};
const surfaces = appSurfaceCache(host);

globalThis.gc();
globalThis.gc();
const baseline = getHeapStatistics().used_heap_size;
const profiler = new GCProfiler();
profiler.start();
let runtime;
let lease;
let retained;
let end;
let profile;
try {
  const options =
    mode === "control"
      ? {
          modules: declarations.map(({ app, methods }) =>
            Mycelium.module({
              id: `oyster-app:${app}`,
              name: app.toUpperCase(),
              description: app,
              operations: Object.fromEntries([
                ...Object.entries(methods)
                  .filter(([, method]) => method.hidden !== true)
                  .map(([name, method]) => [
                    name,
                    Mycelium.operation({
                      replay: "unsafe",
                      description: `${method.description}\nEffect: ${method.effect}.`,
                      input: appJsonSchema(method.input),
                      output: appJsonSchema(method.output),
                      execute: async () => null,
                    }),
                  ]),
                ...(app === "trellis"
                  ? [
                      [
                        "flows.sample",
                        Mycelium.operation({
                          replay: "unsafe",
                          description: `${familyTool.title}\n${familyTool.description}\nEffect: write.`,
                          input: appJsonSchema(familyTool.input),
                          output: appJsonSchema(familyTool.output),
                          execute: async () => null,
                        }),
                      ],
                    ]
                  : []),
              ]),
            }),
          ),
        }
      : {
          sources: [
            await oysterAppMethods(
              host,
              principal,
              { kind: "agent", policy },
              surfaces,
            ),
          ],
        };
  // This is the ordinary Shiitake acquisition path. source-runtime.ts calls
  // compileSurface -> Forage.createCatalog before exposing this lease.
  runtime = await Mycelium.make({
    ...options,
    session: { sessionId: "session-catalog-proof" },
    sandbox: directSandbox(async () => null),
  });
  lease = await runtime.acquire();
  const write = lease.catalog.describe({ path: "BONSAI.method1" });
  assert.match(write.types, /part0/u);
  const namespace = lease.catalog.describe({
    path: "TRELLIS.flows",
    detail: "index",
  });
  assert.match(JSON.stringify(namespace), /sample/u);
  assert.match(
    lease.catalog.describe({ path: "TRELLIS.flows.sample" }).types,
    /part0/u,
  );
  // Keep the compiled lease LIVE across GC; measuring after close hid its cost.
  globalThis.gc();
  globalThis.gc();
  end = getHeapStatistics().used_heap_size;
  retained = end - baseline;
} finally {
  profile = profiler.stop();
}
// Native structured GC statistics catch synchronous compilation peaks that
// timer/microtask polling misses. The final forced GC captures the last tail.
const peak = Math.max(
  baseline,
  end,
  ...profile.statistics.map((gc) => gc.beforeGC.heapStatistics.usedHeapSize),
);
const reclaimed = profile.statistics.reduce(
  (sum, gc) =>
    sum +
    gc.beforeGC.heapStatistics.usedHeapSize -
    gc.afterGC.heapStatistics.usedHeapSize,
  0,
);
console.log(
  JSON.stringify({
    mode,
    starterMethods,
    flags: process.execArgv,
    methods: starterMethods.reduce((sum, [, count]) => sum + count, 0) + 1,
    writes:
      starterMethods.reduce(
        (sum, [, count]) =>
          sum + (mode === "all-writes" ? count : Math.floor(count / 2)),
        0,
      ) + 1,
    baseline,
    peak,
    peakDelta: peak - baseline,
    retained,
    allocation: end - baseline + reclaimed,
    snapshots,
    listings,
  }),
);
await lease.release();
await runtime.close();
