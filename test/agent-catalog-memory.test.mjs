// An Agent turn admits every installed App method into its catalog, but calls
// only a few. Compiling each method's JSON Schemas into validators during that
// capture held tens of MB per turn and reset the live Agent Durable Object's
// isolate ("exceeded its memory limit") on every message. This keeps a
// realistic catalog's retained heap small and its validation intact.
/* global TextEncoder, AbortController */
import {
  approvalHost,
  installationStore,
} from "./native-approval-host.fixture.mjs";
import assert from "node:assert/strict";
import process from "node:process";
import { Session } from "node:inspector/promises";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { invokeModuleOperation } from "@fungi.computer/mycelium/remote";
import { backgroundOriginKey } from "@fungi.computer/puffball/background-replay";
import { appJsonSchema } from "@fungi.computer/forage";
import { deriveDeclaredOperations } from "../dist/apps/index.js";
import { instanceIds } from "../dist/index.js";
import { appSurfaceCache, oysterAppMethods } from "../dist/mcp.js";
import { sha256, verifyRelease } from "../dist/release.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");
const heapMb = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1_048_576;
};

const files = new Map();
async function put(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await sha256(bytes);
  const artifactRef = `artifact:sha256-${digest.slice(7)}`;
  files.set(artifactRef, bytes);
  return { artifactRef, digest };
}

// About the size of a starter App's richer method schemas (a few KB each).
function recordSchema(seed) {
  const field = (index) => ({
    type: "object",
    properties: {
      [`id${String(index)}`]: { type: "string", minLength: 1, maxLength: 128 },
      [`name${String(index)}`]: {
        type: "string",
        pattern: "^[a-z][a-z0-9-]*$",
        maxLength: 64,
      },
      [`count${String(index)}`]: { type: "integer", minimum: 0, maximum: 1000 },
      [`state${String(index)}`]: { enum: ["open", "closed", `s${seed}`] },
      [`tags${String(index)}`]: {
        type: "array",
        maxItems: 32,
        items: { type: "string", maxLength: 40 },
      },
    },
    required: [`id${String(index)}`],
    additionalProperties: false,
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    anyOf: [
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [
            `part${String(index)}`,
            field(index),
          ]),
        ),
        additionalProperties: false,
      },
      { type: "null" },
    ],
  };
}

const methodCount = 40;
const methods = Object.fromEntries(
  Array.from({ length: methodCount }, (_, index) => [
    `method${String(index)}`,
    {
      description: `Method ${String(index)}`,
      input: recordSchema(index),
      output: recordSchema(index + methodCount),
      effect: index % 2 === 0 ? "read" : "write",
      requires: [],
    },
  ]),
);
const backend = await put({
  runtime: { kind: "durable-facet", stateSchema: 1 },
  compatibilityDate: "2026-09-04",
  exportName: "Wide",
  code: "export class Wide {}",
});
const root = await put({
  format: "fungi-app-v1",
  backend: {
    ...backend,
    version: backend.digest,
    byteLength: 1,
    mediaType: "application/vnd.fungi.app-backend+json",
  },
  declaration: { capabilities: [], handlers: [], roles: [], api: { methods } },
});
const release = {
  releaseId: "rel_wide1",
  appId: "app_wide",
  artifact: {
    artifactRef: root.artifactRef,
    artifactDigest: root.digest,
    provenance: {
      sourceRevision: `git:${"b".repeat(40)}`,
      sourceTreeDigest: root.digest,
      buildRecipeDigest: root.digest,
    },
  },
};
const artifacts = {
  get: (ref) => Promise.resolve(files.get(ref) ?? null),
  put: () => Promise.reject(new Error("read-only")),
};
const declaredOperations = await deriveDeclaredOperations(
  release,
  (await verifyRelease(artifacts, release)).declaration,
  [],
);
const installed = ["wide", "wider", "widest"].map((installationId) => ({
  installationId,
  instanceId: instanceIds.instance.generate(),
  release,
  status: "enabled",
  appId: release.appId,
  releasePin: "pinned",
  authority: {
    authorityVersion: 1,
    declaredOperationsDigest: declaredOperations.digest,
    approvedGrants: [],
    approval: {
      by: { kind: "member", memberId: "owner" },
      at: 1000,
      authorityVersion: 1,
    },
  },
}));

const policy = {
  level: "write",
  revision: "wide-policy",
  grantedBy: "owner",
};
const principal = { actor: { kind: "agent", agentId: "agent-wide" } };
function catalogHost(
  instances = {
    get: () => {
      throw new Error("Capturing a catalog calls no App");
    },
  },
) {
  return approvalHost({
    backgroundOriginKey: () => backgroundOriginKey("catalog-proof-origin-key"),
    artifacts,
    installations: installationStore({
      list: () => Promise.resolve(installed),
      get: async (id) =>
        installed.find((row) => row.installationId === id) ?? null,
    }),
    instances,
    appToolPolicy: async () => policy,
  });
}

test("an Agent's App catalog capture keeps validators uncompiled until called", async () => {
  const host = catalogHost();
  const generation = host.installations.generation;
  let captures = 0;
  host.installations.generation = () => {
    captures++;
    return generation();
  };
  const before = heapMb();
  const source = await oysterAppMethods(
    host,
    principal,
    { kind: "agent", policy },
    appSurfaceCache(host),
  );
  // A turn captures the catalog with its Session, as Shiitake does.
  const acquired = await source.acquire({
    signal: new AbortController().signal,
    session: { sessionId: "session-wide" },
  });
  const retained = heapMb() - before;
  assert.equal(acquired.snapshot.modules.length, installed.length);
  // Compiling every method's schemas eagerly retained over 30 MB here.
  assert.ok(retained < 8, `catalog capture retained ${retained.toFixed(1)} MB`);
  await acquired.release();
  assert.equal(captures, 1, "one snapshot per Agent acquisition");
});

async function buildCatalog(options) {
  const runtime = await Mycelium.make({
    ...options,
    session: { sessionId: "session-wide" },
    sandbox: directSandbox(async () => null),
  });
  try {
    const lease = await runtime.acquire();
    try {
      assert.match(
        lease.catalog.describe({ path: "WIDE.method1" }).types,
        /part0/u,
      );
    } finally {
      await lease.release();
    }
  } finally {
    await runtime.close();
  }
}

const builds = 3;
async function measureBuilds(build) {
  const inspector = new Session();
  inspector.connect();
  const before = heapMb();
  // Keep samples for garbage collected during the build too: post-GC heap
  // alone missed the write-output union's transient validator graphs.
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16_384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  let profile;
  let retained;
  try {
    for (let index = 0; index < builds; index++) await build();
    retained = heapMb() - before;
  } finally {
    ({ profile } = await inspector.post("HeapProfiler.stopSampling"));
    inspector.disconnect();
  }
  const allocated = (node) =>
    node.selfSize +
    node.children.reduce((sum, child) => sum + allocated(child), 0);
  return { bytesPerBuild: allocated(profile.head) / builds, retained };
}

test("mixed read/write App catalogs retain less than 8 MB and report allocation against JSON-only", async (t) => {
  const host = catalogHost();
  const surfaces = appSurfaceCache(host);
  const actual = await measureBuilds(async () => {
    // The real Agent creates its Oyster source inside each turn's acquire.
    const source = await oysterAppMethods(
      host,
      principal,
      { kind: "agent", policy },
      surfaces,
    );
    await buildCatalog({ sources: [source] });
  });
  // Retained shape control: the same 120 method declarations, one module
  // layer straight from JSON data. No Oyster captures or approval unions.
  // Fresh modules each build prevent Forage's schema-facts cache from turning
  // this into a warmed-rendering control. Both sides build the real catalog.
  const control = await measureBuilds(() =>
    buildCatalog({
      modules: installed.map((installation) =>
        Mycelium.module({
          id: `oyster-app:${installation.installationId}`,
          name: installation.installationId.toUpperCase(),
          description: installation.installationId,
          operations: Object.fromEntries(
            Object.entries(methods).map(([name, method]) => [
              name,
              Mycelium.operation({
                description: `${method.description}\nEffect: ${method.effect}.`,
                input: appJsonSchema(method.input),
                output: appJsonSchema(method.output),
                execute: async () => null,
              }),
            ]),
          ),
        }),
      ),
    }),
  );
  t.diagnostic(
    `${String(builds)} builds/side; App ${actual.bytesPerBuild.toFixed(0)}, JSON-only ${control.bytesPerBuild.toFixed(0)} sampled allocation bytes/build; ${actual.retained.toFixed(1)} MB retained`,
  );
  // Sampled cumulative allocation is telemetry, not the isolate's peak heap.
  // Peak and live retention remain shipping gates in the cold capped proof.
  t.diagnostic(
    `${(actual.bytesPerBuild / control.bytesPerBuild).toFixed(2)}x JSON-only sampled allocation (measurement, not a gate)`,
  );
  assert.ok(
    actual.retained < 8,
    `catalog builds retained ${actual.retained.toFixed(1)} MB`,
  );
});

const context = () => ({
  executionId: "catalog-validation",
  toolCallId: "catalog-call",
  signal: new AbortController().signal,
  deadlineAt: Date.now() + 30_000,
});

test("App calls validate input and declared output while accepting host approval results", async () => {
  let readCalls = 0;
  let readOutput = null;
  const host = catalogHost({
    get: () => ({
      call: async () => {
        readCalls++;
        return { ok: true, value: { kind: "ok", value: readOutput } };
      },
    }),
  });
  const pending = {
    kind: "pending_approval",
    recordId: "approval-wide",
    description: {
      title: "Wide write",
      inputBytes: 4,
      inputSha256: "b".repeat(64),
    },
  };
  let approval = pending;
  // Faithful host-port outcomes; the native approval suites own ledger policy
  // and dispatch. This seam proves the acquired operation's output decoder.
  host.approvals = { submit: async () => approval };
  const source = await oysterAppMethods(
    host,
    principal,
    { kind: "agent", policy },
    appSurfaceCache(host),
  );
  const acquired = await source.acquire({
    signal: new AbortController().signal,
    session: { sessionId: "session-wide" },
  });
  try {
    const module = acquired.snapshot.modules[0];
    const invoke = (method, input) =>
      invokeModuleOperation(module, method, input, context());
    await assert.rejects(
      invoke("method0", "not declared"),
      (error) =>
        error.name === "InvalidOperationInput" && error.issues.length > 0,
    );
    assert.equal(readCalls, 0, "invalid input never reaches the App");
    assert.equal(await invoke("method0", null), null);
    readOutput = "not declared";
    await assert.rejects(invoke("method0", null), {
      _tag: "BadResponse",
      reason: "Capability output failed its declared schema",
    });
    assert.deepEqual(await invoke("method1", null), pending);
    approval = {
      kind: "refused",
      reason: "declined",
      denialNote: "Please leave this unchanged.",
    };
    assert.deepEqual(await invoke("method1", null), approval);
    approval = { kind: "applied", output: null };
    assert.equal(await invoke("method1", null), null);
    approval = { kind: "applied", output: "not declared" };
    await assert.rejects(invoke("method1", null), {
      _tag: "BadResponse",
      reason: "Capability output failed its declared schema",
    });
  } finally {
    await acquired.release();
  }
});

test("calling distinct methods across turns leaves no validator graphs on the Release cache", async (t) => {
  const host = catalogHost({
    get: () => ({
      call: async () => ({
        ok: true,
        value: { kind: "ok", value: null },
      }),
    }),
  });
  const surfaces = appSurfaceCache(host);
  await surfaces(release);
  const turn = async () => {
    const source = await oysterAppMethods(
      host,
      principal,
      { kind: "agent", policy },
      surfaces,
    );
    const acquired = await source.acquire({
      signal: new AbortController().signal,
      session: { sessionId: "session-wide" },
    });
    try {
      for (const module of acquired.snapshot.modules)
        for (let index = 0; index < methodCount; index += 2)
          await invokeModuleOperation(
            module,
            `method${String(index)}`,
            null,
            context(),
          );
    } finally {
      await acquired.release();
    }
  };
  const before = heapMb();
  await turn();
  await turn();
  const retained = heapMb() - before;
  t.diagnostic(
    `called 20 distinct methods in two turns; ${retained.toFixed(1)} MB retained`,
  );
  assert.ok(
    retained < 4,
    `called-method validators retained ${retained.toFixed(1)} MB`,
  );
});
