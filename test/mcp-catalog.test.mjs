import {
  installationStore,
  approvalHost,
} from "./native-approval-host.fixture.mjs";
import { invokeModuleOperation } from "@fungi.computer/mycelium/remote";
import {
  backgroundOriginKey,
  admitClaimedOrigin,
} from "@fungi.computer/puffball/background-replay";
import { deriveDeclaredOperations } from "../dist/apps/index.js";
import { verifyRelease } from "../dist/release.js";
// The MCP catalog: installed Apps' methods become `env.<APP>` operations that
// run through the Instance path.
/* global TextEncoder, TextDecoder, AbortController, console, URL */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Mycelium } from "@fungi.computer/mycelium";
import { forageDiscoveryInstructions } from "@fungi.computer/mycelium/effect";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { instanceIds } from "../dist/index.js";
import {
  appSurfaceCache,
  oysterAppMethods,
  oysterMcpCatalogLoad,
} from "../dist/mcp.js";
import { sha256 } from "../dist/release.js";
import { keyAppAccess } from "../dist/authorization.js";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/ear-tag/keys/node";

// workers-git.js imports `cloudflare:workers` at module scope for its
// DurableObject base classes; this redirects it to the same plain-JS stand-in
// every other node:test file here uses, for the one import that needs it.
const workersGitHooks = registerHooks({
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
const { OysterKeys } = await import("../dist/workers-git.js");
workersGitHooks.deregister();

/** A real `OysterKeys` instance over real node:sqlite, for the stale_authority/level_too_low/hidden-until-granted proofs below. */
function realKeysStub() {
  const database = new DatabaseSync(":memory:");
  after(() => database.close());
  let counter = 0;
  const ctx = {
    id: { name: "keys" },
    storage: {
      sql: fromNodeSqlite(database),
      transactionSync: (body) => {
        const name = `mcp_catalog_test_${String(counter++)}`;
        database.exec(`SAVEPOINT ${name}`);
        try {
          const value = body();
          database.exec(`RELEASE ${name}`);
          return value;
        } catch (error) {
          database.exec(`ROLLBACK TO ${name}`);
          database.exec(`RELEASE ${name}`);
          throw error;
        }
      },
    },
  };
  return new OysterKeys(ctx, {});
}

const files = new Map();
test("standalone MCP discovers shared Workflow status and cancel without executing either", async () => {
  const snapshot = await oysterMcpCatalogLoad(
    approvalHost({
      installations: installationStore({ list: async () => [] }),
      workflows: async () => ({
        status: () => {
          throw new Error("Discovery executed status");
        },
        cancel: () => {
          throw new Error("Discovery executed cancel");
        },
      }),
    }),
  )({ actor: { kind: "member", memberId: "owner" }, role: "owner" });
  assert.equal(snapshot.grants["workflow-control"], "write");
  assert.ok(
    snapshot.sources.some((source) => source.id === "oyster-workflows"),
  );
});
async function put(bytes) {
  const digest = await sha256(bytes);
  const artifactRef = `artifact:sha256-${digest.slice(7)}`;
  files.set(artifactRef, bytes);
  return { artifactRef, digest };
}
const json = (value) => new TextEncoder().encode(JSON.stringify(value));
const backend = await put(
  json({
    runtime: { kind: "durable-facet", stateSchema: 1 },
    compatibilityDate: "2026-09-04",
    exportName: "Notes",
    code: "export class Notes {}",
  }),
);
const schema = { type: "object", properties: { text: { type: "string" } } };
const root = await put(
  json({
    format: "fungi-app-v1",
    backend: {
      ...backend,
      version: backend.digest,
      byteLength: 1,
      mediaType: "application/vnd.fungi.app-backend+json",
    },
    declaration: {
      capabilities: [],
      handlers: [],
      roles: [],
      api: {
        methods: {
          readNote: {
            description: "Read the note",
            input: { type: "object" },
            output: schema,
            effect: "read",
            requires: [],
          },
          rebuildCopies: {
            description: "Rebuild internal copies",
            hidden: true,
            input: { type: "object" },
            output: schema,
            effect: "read",
            requires: [],
          },
          saveNote: {
            description: "Save the note",
            input: schema,
            output: { type: "object" },
            effect: "write",
            requires: [],
          },
        },
      },
    },
  }),
);
const release = {
  releaseId: "rel_notes1",
  appId: "app_notes",
  artifact: {
    artifactRef: root.artifactRef,
    artifactDigest: root.digest,
    provenance: {
      sourceRevision: `git:${"a".repeat(40)}`,
      sourceTreeDigest: root.digest,
      buildRecipeDigest: root.digest,
    },
  },
};
const declaration = (
  await verifyRelease({ get: async (ref) => files.get(ref) ?? null }, release)
).declaration;
const declaredOperations = await deriveDeclaredOperations(
  release,
  declaration,
  [],
);
const installation = (installationId) => ({
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
});
const calls = [];
const installed = [installation("notes"), installation("diary")];
const host = {
  backgroundOriginKey: () => backgroundOriginKey("fixture-mcp-background-key"),
  artifacts: {
    get: (ref) => Promise.resolve(files.get(ref) ?? null),
    put: () => Promise.reject(new Error("read-only")),
  },
  installations: installationStore({
    list: () => Promise.resolve(installed),
    get: async (id) =>
      installed.find((row) => row.installationId === id) ?? null,
  }),
  instances: {
    get: () => ({
      call: (facts, api, name, input) => {
        assert.equal(facts.subject.kind, "call");
        calls.push({
          app: facts.selection.owner.id,
          name,
          input,
          context: facts.subject.context,
        });
        return Promise.resolve({
          ok: true,
          value: { kind: "ok", value: { text: "hello" } },
        });
      },
    }),
  },
};

/**
 * Wrap a bare `{level, revision, grantedBy}` fixture policy into the shape
 * `oysterAppMethods` now takes: one blanket policy for an Agent, or one key
 * grant spread across every given installation (the old fixtures' "every
 * key is write" shape) for a key. `null` for any other actor, or no policy.
 */
/** A `host.keys.live` port whose one key reaches every App, read and write. */
function allAppsKeysPort(owner = "fixture-owner") {
  return {
    live: async (keyId) => ({
      keyId,
      owner,
      grantVersion: 1,
      grants: [{ capability: "apps.use", targets: { kind: "all" } }],
    }),
  };
}

function accessFor(principal, policy, installationIds = ["notes", "diary"]) {
  if (policy === null || policy === undefined) return null;
  const { actor } = principal;
  if (actor.kind === "agent") return { kind: "agent", policy };
  if (actor.kind === "team-key")
    return {
      kind: "key",
      keyId: actor.keyId,
      byInstallation: new Map(installationIds.map((id) => [id, policy])),
    };
  return null;
}

async function run(
  principal,
  program,
  policy,
  { session, instances = host.instances, source, confirm } = {},
) {
  const results = [];
  const runtime = await Mycelium.make({
    session,
    access: { confirm },
    sources: [
      source ??
        (await oysterAppMethods(
          approvalHost({
            ...host,
            instances,
            appToolPolicy: async () => policy ?? null,
          }),
          principal,
          accessFor(principal, policy ?? null),
          appSurfaceCache(host),
        )),
    ],
    sandbox: directSandbox(async (bindings) => {
      results.push(await program(bindings));
      return null;
    }),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "call",
        name: "execute",
        arguments: { code: "return null" },
      }),
    );
    await Effect.runPromise(Stream.runCollect(prepared.execute()));
    return { results, catalog: lease.catalog };
  } finally {
    await lease.release();
    await runtime.close();
  }
}

test("App discovery describes the declaration and states approval results once in host instructions", async () => {
  const waitForApproval =
    "On pending_approval, tell the person it is waiting for their approval; do not retry.";
  const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
  const snapshot = await oysterMcpCatalogLoad(approvalHost(host))(owner);
  assert.ok(snapshot.instructions.includes(forageDiscoveryInstructions));
  assert.equal(
    snapshot.instructions.match(/type AppApprovalResult/gu)?.length,
    1,
  );
  assert.equal(snapshot.instructions.split(waitForApproval).length - 1, 1);
  assert.ok(
    snapshot.instructions.includes(
      '  | { kind: "refused"; reason: string; denialNote?: string };\n' +
        waitForApproval,
    ),
  );
  assert.match(
    snapshot.instructions,
    /kind: "pending_approval"; recordId: string/u,
  );
  assert.match(
    snapshot.instructions,
    /kind: "refused"; reason: string; denialNote\?: string/u,
  );
  const { catalog } = await run(owner, async () => null, null);
  const detail = catalog.describe({ path: "NOTES.saveNote" });
  assert.equal(detail.description, "Save the note\nEffect: write.");
  assert.match(
    detail.types,
    /NOTES\$saveNote_Output = Record<string, unknown>/u,
  );
  assert.doesNotMatch(detail.types, /pending_approval|refused/u);
});

test("Agent tool acquisition carries the trusted Session separately from App arguments", async () => {
  const subjects = [];
  const instances = {
    get: () => ({
      call: (facts) => {
        subjects.push(facts.subject);
        return Promise.resolve({ ok: true, value: { kind: "ok", value: {} } });
      },
    }),
  };
  const principal = { actor: { kind: "agent", agentId: "agent-one" } };
  const policy = {
    level: "write",
    revision: "agent-policy-1",
    grantedBy: "owner",
  };
  const source = await oysterAppMethods(
    approvalHost({ ...host, instances, appToolPolicy: async () => policy }),
    principal,
    { kind: "agent", policy },
    appSurfaceCache(host),
  );
  for (const sessionId of ["session-first", "session-second", undefined]) {
    await run(
      principal,
      (bindings) => bindings.NOTES.saveNote({ text: "guest-supplied-session" }),
      policy,
      { session: sessionId === undefined ? undefined : { sessionId }, source },
    );
  }
  assert.deepEqual(
    subjects.map((subject) => subject.sessionId),
    ["session-first", "session-second", undefined],
  );
  for (const subject of subjects) {
    assert.deepEqual(subject.context.actor, {
      kind: "agent",
      agentId: "agent-one",
    });
    assert.deepEqual(subject.agentPolicy, {
      policyRevision: "agent-policy-1",
      grantorMemberId: "owner",
    });
  }
});

test("owner and key tool listings omit hidden declared methods", async () => {
  for (const principal of [
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    { actor: { kind: "team-key", keyId: "agent-key" } },
  ]) {
    const { catalog } = await run(principal, () => Promise.resolve(null));
    assert.throws(
      () => catalog.describe({ path: "NOTES.rebuildCopies" }),
      /Unknown target/u,
    );
    assert.ok(catalog.describe({ path: "NOTES.readNote" }));
  }
});

test("the owner reaches discoverable App methods as env.<APP>", async () => {
  calls.length = 0;
  const { results, catalog } = await run(
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    async (bindings) => [
      await bindings.NOTES.readNote({}),
      await bindings.DIARY.saveNote({ text: "x" }),
    ],
    null,
  );
  assert.deepEqual(results, [[{ text: "hello" }, { text: "hello" }]]);
  assert.equal(calls.length, 2);
  const origin = calls[1].context.backgroundOrigin;
  assert.equal(origin.method, "saveNote");
  assert.deepEqual(calls[1].context, {
    computerId: null,
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
    backgroundLane: "member:owner",
    backgroundOrigin: origin,
  });
  assert.deepEqual(
    await admitClaimedOrigin(
      await host.backgroundOriginKey(),
      {
        instanceId: installed.find((row) => row.installationId === "diary")
          .instanceId,
        lane: "member:owner",
        admitted: ["saveNote"],
      },
      origin,
    ),
    { kind: "admitted" },
  );
  assert.ok(catalog.describe({ path: "NOTES.saveNote" }));
});

test("a captured tool policy changes snapshot identity independently of module grants", async () => {
  const rows = [installation("notes")];
  const capturedHost = {
    ...host,
    installations: installationStore({ list: async () => rows }),
  };
  const versions = [];
  for (const policy of [
    { level: "read", revision: "policy-1", grantedBy: "fixture-owner" },
    { level: "write", revision: "policy-1", grantedBy: "fixture-owner" },
    { level: "write", revision: "policy-2", grantedBy: "fixture-owner" },
    { level: "write", revision: "policy-2", grantedBy: "another-approver" },
  ]) {
    const source = await oysterAppMethods(
      approvalHost(capturedHost),
      { actor: { kind: "team-key", keyId: "reader" } },
      {
        kind: "key",
        keyId: "reader",
        byInstallation: new Map([["notes", policy]]),
      },
      appSurfaceCache(host),
    );
    // The module's grant follows the key's own captured level now, not a
    // hardcoded "write": this is the S2 fix ("every key is write" was red).
    assert.deepEqual(source.grants, { "oyster-app:notes": policy.level });
    const lease = await source.acquire({
      signal: new AbortController().signal,
      invalidate: () => assert.fail("Unexpected invalidation"),
    });
    versions.push(lease.snapshot.version);
    await lease.release();
  }
  assert.equal(new Set(versions).size, 4);
});

test("captured App tools refuse missing approval provenance and changed live policy before dispatch", async () => {
  for (const nextPolicy of [
    null,
    { level: "write", revision: "old-policy-without-approver" },
    { level: "read", revision: "approved-2", grantedBy: "owner" },
    { level: "write", revision: "approved-1", grantedBy: "different-member" },
  ]) {
    calls.length = 0;
    const approved = {
      level: "write",
      revision: "approved-1",
      grantedBy: "owner",
    };
    let current = approved;
    const source = await oysterAppMethods(
      approvalHost({ ...host, appToolPolicy: async () => current }),
      { actor: { kind: "agent", agentId: "morel" } },
      { kind: "agent", policy: approved },
      appSurfaceCache(host),
    );
    const runtime = await Mycelium.make({
      sources: [source],
      sandbox: directSandbox(async (bindings) => {
        current = nextPolicy;
        await assert.rejects(
          bindings.NOTES.readNote({}),
          /App method refused: (not_approved|stale_authority)/u,
        );
        return null;
      }),
    });
    const lease = await runtime.acquire();
    try {
      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: "approval-change",
          name: "execute",
          arguments: { code: "return null" },
        }),
      );
      await Effect.runPromise(Stream.runCollect(prepared.execute()));
      assert.equal(calls.length, 0);
    } finally {
      await lease.release();
      await runtime.close();
    }
  }
});

test("a member's captured App method refuses changed installation authority after approval", async () => {
  for (const changed of [
    (current) => ({
      ...current,
      authority: {
        ...current.authority,
        authorityVersion: current.authority.authorityVersion + 1,
      },
    }),
    (current) => ({
      ...current,
      release: { ...current.release, releaseId: "rel_replaced_after_approval" },
    }),
  ]) {
    calls.length = 0;
    let current = installation("notes");
    const source = await oysterAppMethods(
      approvalHost({
        ...host,
        installations: installationStore({
          list: async () => [current],
          get: async () => current,
        }),
      }),
      { actor: { kind: "member", memberId: "owner" }, role: "owner" },
      null,
      appSurfaceCache(host),
    );
    let asked = 0;
    const runtime = await Mycelium.make({
      sources: [source],
      access: {
        grants: source.grants,
        confirmWrites: true,
        confirm: async () => {
          asked++;
          current = changed(current);
          return true;
        },
      },
      sandbox: directSandbox(async (bindings) => {
        assert.deepEqual(
          await bindings.NOTES.saveNote({ text: "stale approval" }),
          { kind: "refused", reason: "fenced" },
        );
        return null;
      }),
    });
    const lease = await runtime.acquire();
    try {
      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: "changed-installation",
          name: "execute",
          arguments: { code: "return null" },
        }),
      );
      await Effect.runPromise(Stream.runCollect(prepared.execute()));
      assert.equal(asked, 1);
      assert.equal(calls.length, 0);
    } finally {
      await lease.release();
      await runtime.close();
    }
  }
});

test("a module write grant cannot substitute for the host's Agent/key tool policy", async () => {
  calls.length = 0;
  const { results } = await run(
    { actor: { kind: "team-key", keyId: "unapproved-key" } },
    async (bindings) => {
      try {
        await bindings.NOTES.readNote({});
        return "unexpected admission";
      } catch (error) {
        return error.message;
      }
    },
    null,
  );
  assert.deepEqual(results, ["App method refused: not_approved"]);
  assert.equal(calls.length, 0);
});

test("MCP snapshots grant exactly their modules and change with installation authority", async () => {
  let rows = [installation("notes")];
  const load = oysterMcpCatalogLoad(
    approvalHost({
      ...host,
      installations: installationStore({ list: async () => rows }),
      keys: allAppsKeysPort(),
    }),
  );
  const principal = { actor: { kind: "team-key", keyId: "agent-key" } };
  const first = await load(principal);
  assert.deepEqual(first.grants, { "oyster-app:notes": "write" });
  assert.equal(first.sources.length, 1);
  const context = {
    signal: new AbortController().signal,
    invalidate: () =>
      assert.fail("A captured snapshot has no live invalidation"),
  };
  const acquired = await first.sources[0].acquire(context);
  assert.equal(acquired.snapshot.modules.length, 1);
  let previous = acquired.snapshot.version;
  await acquired.release();
  for (const update of [
    (current) => ({
      ...current,
      authority: {
        ...current.authority,
        authorityVersion: current.authority.authorityVersion + 1,
      },
    }),
    (current) => ({
      ...current,
      release: { ...current.release, releaseId: "rel_notes2" },
    }),
    (current) => ({ ...current, status: "disabled" }),
  ]) {
    rows = [update(rows[0])];
    const next = await load(principal);
    const current = await next.sources[0].acquire(context);
    assert.notEqual(current.snapshot.version, previous);
    previous = current.snapshot.version;
    if (rows[0].status === "disabled") {
      assert.deepEqual(next.grants, {});
      assert.deepEqual(current.snapshot.modules, []);
    }
    await current.release();
  }
});

test("the MCP loader exposes dotted App methods as nested operations under one captured grant", async () => {
  const build = JSON.parse(
    new TextDecoder().decode(files.get(root.artifactRef)),
  );
  const read = build.declaration.api.methods.readNote;
  build.declaration.api.methods = {
    "repos.list": read,
    "files.read": read,
    "files.history.read": read,
  };
  const dotted = await put(json(build));
  const row = {
    ...installation("bonsai"),
    release: {
      ...release,
      artifact: {
        ...release.artifact,
        artifactRef: dotted.artifactRef,
        artifactDigest: dotted.digest,
      },
    },
  };
  row.authority.declaredOperationsDigest = (
    await deriveDeclaredOperations(row.release, build.declaration, [])
  ).digest;
  let captures = 0;
  const calls = [];
  const load = oysterMcpCatalogLoad(
    approvalHost({
      ...host,
      keys: allAppsKeysPort(),
      installations: installationStore({
        list: async () => {
          captures += 1;
          return [row];
        },
        get: async () => row,
      }),
      instances: {
        get: () => ({
          call: async (facts, api, name) => {
            assert.equal(facts.subject.kind, "call");
            calls.push({ name, context: facts.subject.context });
            return { ok: true, value: { kind: "ok", value: { text: name } } };
          },
        }),
      },
    }),
  );
  const snapshot = await load({ actor: { kind: "team-key", keyId: "morel" } });
  assert.match(snapshot.instructions, /env\.BONSAI\.repos\.list\(\{\}\)/u);
  assert.equal(captures, 1);
  assert.deepEqual(snapshot.grants, { "oyster-app:bonsai": "write" });
  const runtime = await Mycelium.make({
    sources: snapshot.sources,
    access: { grants: snapshot.grants },
    // Direct callbacks use the flat transport table; the guest exposes nested paths.
    sandbox: directSandbox(async (bindings) => {
      assert.deepEqual(await bindings.BONSAI["repos.list"]({}), {
        text: "repos.list",
      });
      assert.deepEqual(await bindings.BONSAI["files.read"]({}), {
        text: "files.read",
      });
      assert.deepEqual(await bindings.BONSAI["files.history.read"]({}), {
        text: "files.history.read",
      });
      return null;
    }),
  });
  const lease = await runtime.acquire();
  try {
    for (const name of Object.keys(build.declaration.api.methods))
      assert.ok(lease.catalog.describe({ path: `BONSAI.${name}` }));
    assert.equal(
      lease.catalog.describe({ path: "BONSAI.repos.list" }).usage,
      "await env.BONSAI.repos.list({ ... })",
    );
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "dotted",
        name: "execute",
        arguments: { code: "return null" },
      }),
    );
    await Effect.runPromise(Stream.runCollect(prepared.execute()));
    assert.deepEqual(
      calls.map(({ name }) => name),
      ["repos.list", "files.read", "files.history.read"],
    );
    for (const { context } of calls)
      assert.deepEqual(context, {
        computerId: null,
        actor: { kind: "team-key", keyId: "morel" },
      });
    assert.equal(
      captures,
      1,
      "tool execution uses the MCP loader's single capture",
    );
  } finally {
    await lease.release();
    await runtime.close();
  }
  for (const names of [
    ["files", "files.read"],
    ["files.read", "files"],
  ]) {
    build.declaration.api.methods = Object.fromEntries(
      names.map((name) => [name, read]),
    );
    const collision = await put(json(build));
    row.release = {
      ...row.release,
      artifact: {
        ...row.release.artifact,
        artifactRef: collision.artifactRef,
        artifactDigest: collision.digest,
      },
    };
    await assert.rejects(
      load({ actor: { kind: "team-key", keyId: "morel" } }),
      /Invalid App root/u,
    );
  }
});

test("human and key App calls do not acquire an Agent policy receipt", async () => {
  const subjects = [];
  const instances = {
    get: () => ({
      call: (facts) => {
        subjects.push(facts.subject);
        return Promise.resolve({ ok: true, value: { kind: "ok", value: {} } });
      },
    }),
  };
  const policy = {
    level: "write",
    revision: "policy-for-tools",
    grantedBy: "owner",
  };
  // A key's captured access must be exactly what keyAppAccess itself would
  // derive from this fixture key, so the call-time fresh re-check (which
  // always recomputes it the same way) never sees a mismatch.
  const fixtureKey = {
    keyId: "key-one",
    owner: "owner",
    grantVersion: 1,
    grants: [{ capability: "apps.use", targets: { kind: "all" } }],
  };
  for (const principal of [
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    { actor: { kind: "team-key", keyId: "key-one" } },
  ]) {
    const access =
      principal.actor.kind === "team-key"
        ? {
            kind: "key",
            keyId: fixtureKey.keyId,
            byInstallation: new Map(
              ["notes", "diary"].map((id) => [
                id,
                keyAppAccess(fixtureKey, id),
              ]),
            ),
          }
        : null;
    const source = await oysterAppMethods(
      approvalHost({
        ...host,
        instances,
        appToolPolicy: async () => policy,
        keys: { live: async () => fixtureKey },
      }),
      principal,
      access,
      appSurfaceCache(host),
    );
    await run(
      principal,
      (bindings) =>
        bindings.NOTES.saveNote({ text: "guest policy is not authority" }),
      null,
      { source },
    );
  }
  assert.equal(subjects.length, 2);
  for (const subject of subjects) assert.equal(subject.agentPolicy, undefined);
});

test("the MCP catalog adds the host's Computer for a caller with Computer access, leaving App methods unchanged", async () => {
  const computerCalls = [];
  const advertised = [
    {
      id: "exec",
      name: "exec",
      kind: "runtime",
      description: "Run one command.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  ];
  const computerHost = {
    ...host,
    computerId: "workspace-one",
    computer: (principal) =>
      "role" in principal && principal.role === "owner"
        ? {
            getCapabilities: async () => advertised,
            call: async (capabilityId, input) => {
              computerCalls.push({ principal, capabilityId, input });
              return { stdout: "ran" };
            },
          }
        : null,
  };
  const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
  const withComputer = await oysterMcpCatalogLoad(approvalHost(computerHost))(
    owner,
  );
  const appsOnly = await oysterMcpCatalogLoad(approvalHost(host))(owner);
  assert.deepEqual(withComputer.grants, {
    ...appsOnly.grants,
    "computer:workspace-one": "write",
  });
  assert.equal(withComputer.sources.length, 2);
  assert.match(withComputer.instructions, /env\.computers\.workspace/u);
  assert.ok(withComputer.instructions.includes(forageDiscoveryInstructions));

  const context = {
    signal: new AbortController().signal,
    invalidate: () => assert.fail("A captured snapshot has no invalidation"),
  };
  const [apps, plain] = await Promise.all([
    withComputer.sources[0].acquire(context),
    appsOnly.sources[0].acquire(context),
  ]);
  assert.equal(apps.snapshot.version, plain.snapshot.version);
  assert.deepEqual(
    apps.snapshot.modules.map((module) => module.id),
    plain.snapshot.modules.map((module) => module.id),
  );
  await Promise.all([apps.release(), plain.release()]);

  const { results: refusedWithoutPerson, catalog } = await run(
    owner,
    // The direct sandbox receives flat module bindings; codemode nests them.
    (bindings) => bindings.workspace.exec({ command: "ls" }),
    null,
    { source: withComputer.sources[1] },
  );
  assert.ok(catalog.describe({ path: "computers.workspace.exec" }));
  assert.deepEqual(refusedWithoutPerson, [
    {
      refused: true,
      module: "computer:workspace-one",
      operation: "exec",
      reason: "confirmation-unavailable",
      message:
        "computer:workspace-one.exec needs a person's approval, and no one can be asked here.",
    },
  ]);
  assert.deepEqual(computerCalls, []);
  const approved = [];
  const { results } = await run(
    owner,
    (bindings) => bindings.workspace.exec({ command: "ls" }),
    null,
    {
      source: withComputer.sources[1],
      confirm: (request) => {
        approved.push(request.operation);
        return Promise.resolve(true);
      },
    },
  );
  assert.deepEqual(approved, ["exec"]);
  assert.deepEqual(results, [{ stdout: "ran" }]);
  assert.deepEqual(computerCalls, [
    { principal: owner, capabilityId: "exec", input: { command: "ls" } },
  ]);

  // Without Computer access the catalog is exactly the App catalog.
  const key = { actor: { kind: "team-key", keyId: "reader" } };
  const refused = await oysterMcpCatalogLoad(approvalHost(computerHost))(key);
  const keyApps = await oysterMcpCatalogLoad(approvalHost(host))(key);
  assert.deepEqual(refused.grants, keyApps.grants);
  assert.equal(refused.sources.length, 1);
  assert.equal(refused.instructions, keyApps.instructions);
});

test("a key's current App grants remain independent of Computer and owner authority", async () => {
  // A key's App access is its own Ear Tag grants now, not a stored policy;
  // mutate the level this one fixture key's grants admit instead.
  let level = "write";
  const computerHost = {
    ...host,
    computerId: "workspace-one",
    computer: () => ({
      getCapabilities: async () => [],
      call: async () => assert.fail("The loader never calls the Computer"),
    }),
    keys: {
      live: async (keyId) =>
        level === null
          ? null
          : {
              keyId,
              owner: "owner",
              grantVersion: 1,
              grants: [
                {
                  capability: level === "write" ? "apps.use" : "apps.read",
                  targets: { kind: "all" },
                },
              ],
            },
    },
  };
  const load = oysterMcpCatalogLoad(approvalHost(computerHost));
  const key = { actor: { kind: "team-key", keyId: "one" } };
  const approved = await load(key);
  const appModules = Object.keys(approved.grants).filter((id) =>
    id.startsWith("oyster-app:"),
  );
  assert.ok(appModules.length > 0);
  assert.ok("computer:workspace-one" in approved.grants);
  for (const id of appModules) assert.equal(approved.grants[id], "write");

  level = "read";
  const readOnly = await load(key);
  for (const id of appModules) assert.equal(readOnly.grants[id], "read");
  level = null;
  const ungranted = await load(key);
  assert.deepEqual(
    Object.keys(ungranted.grants).filter((id) => id.startsWith("oyster-app:")),
    [],
  );

  const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
  const ownerCatalog = await load(owner);
  for (const id of appModules) assert.equal(ownerCatalog.grants[id], "write");
});

const toolInput = {
  type: "object",
  properties: { beats: { type: "array", items: { type: "string" } } },
  required: ["beats"],
  additionalProperties: false,
};
const toolOutput = {
  type: "object",
  properties: { runId: { type: "string" } },
  required: ["runId"],
};
/** One installed App declaring the same `{name:"flows", list, call}` tool
 * family shape the real Trellis App declares, for a fake Instance to
 * answer. Each test supplies its own `instances.get` behavior. */
async function flowsRow(installationId) {
  const backend = await put(
    json({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "Flows",
      code: "export class Flows {}",
    }),
  );
  const root = await put(
    json({
      format: "fungi-app-v1",
      backend: {
        ...backend,
        version: backend.digest,
        byteLength: 1,
        mediaType: "application/vnd.fungi.app-backend+json",
      },
      declaration: {
        capabilities: [],
        handlers: [],
        roles: [],
        api: {
          toolFamily: { name: "flows", list: "listFlows", call: "runFlow" },
          methods: {
            listFlows: {
              description: "List published Workflow tools",
              hidden: true,
              effect: "read",
              requires: [],
              input: { type: "object" },
              // A permissive JSON Schema: forage's own signed-listing codec
              // (familyInventory) does the real structural validation below.
              output: {},
            },
            runFlow: {
              description: "Run a published Workflow",
              effect: "write",
              requires: [],
              input: { type: "object" },
              output: { type: "object" },
            },
          },
        },
      },
    }),
  );
  const release = {
    releaseId: `rel_${installationId}`,
    appId: `app_${installationId}`,
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
  const declaration = (
    await verifyRelease({ get: async (ref) => files.get(ref) ?? null }, release)
  ).declaration;
  const declaredOperations = await deriveDeclaredOperations(
    release,
    declaration,
    [],
  );
  return {
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
  };
}
/** A ready listing with exactly one tool, carrying opaque `call` data the
 * App alone resolved (its own pinned identity and App-to-App bindings). */
function flowsListing(
  call = { workflowId: "storyboard", version: 1, bindings: {} },
) {
  return {
    kind: "ready",
    tools: [
      {
        workflowId: "storyboard",
        tool: "storyboard",
        title: "Storyboard",
        description: "Draw the supplied beats",
        version: 1,
        commit: "a".repeat(40),
        input: toolInput,
        output: toolOutput,
        call,
      },
    ],
  };
}

test("a published Workflow's tool family tool forwards the App's own call data verbatim, including a real App-to-App binding", async () => {
  const row = await flowsRow("flows");
  let published = false;
  const runCalls = [];
  // The App resolved its own "repo" role to an installed Bonsai-like App;
  // Oyster must forward this exactly as given, never invent or default it.
  const call = {
    workflowId: "repoList",
    version: 2,
    bindings: { repo: "bonsai-main" },
  };
  const flowsHost = {
    ...host,
    installations: installationStore({
      list: async () => [row],
      get: async () => row,
    }),
    instances: {
      get: () => ({
        call: async (facts, api, name, input) => {
          assert.equal(facts.subject.kind, "call");
          if (name === "listFlows")
            return {
              ok: true,
              value: {
                kind: "ok",
                value: published ? flowsListing(call) : { kind: "unindexed" },
              },
            };
          if (name === "runFlow") {
            runCalls.push(input);
            return {
              ok: true,
              value: { kind: "ok", value: { kind: "started", runId: "run-1" } },
            };
          }
          throw new Error(`unexpected method ${name}`);
        },
      }),
    },
  };
  const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };

  // Absent before publish: the App's own signed listing says "unindexed".
  {
    const source = await oysterAppMethods(
      approvalHost(flowsHost),
      owner,
      null,
      appSurfaceCache(host),
    );
    const { catalog } = await run(owner, () => Promise.resolve(null), null, {
      source,
    });
    assert.throws(
      () => catalog.describe({ path: "FLOWS.flows.storyboard" }),
      /Unknown target/u,
    );
  }

  published = true;

  // Listed and described, with the published Workflow's own input schema,
  // once the App's listing reports it ready; then callable through the exact
  // same admitted call that every other App method makes, compiling a real App node
  // because Oyster forwarded the App's own resolved binding unchanged.
  const source = await oysterAppMethods(
    approvalHost(flowsHost),
    owner,
    null,
    appSurfaceCache(host),
  );
  const { catalog, results } = await run(
    owner,
    (bindings) =>
      bindings.FLOWS["flows.storyboard"]({ beats: ["A quiet garden"] }),
    null,
    { source },
  );
  const described = catalog.describe({ path: "FLOWS.flows.storyboard" });
  assert.match(described.types, /beats/u);
  assert.deepEqual(results, [{ kind: "started", runId: "run-1" }]);
  assert.equal(runCalls.length, 1);
  const [sent] = runCalls;
  // A minted Cairn ID of the host's own tool-family-call family: never a
  // caller-chosen or replayable value; everything else is the App's own
  // `call` data, forwarded exactly, plus the caller's own `input`.
  assert.match(sent.requestId, /^call_[a-z0-9]{21}$/u);
  assert.deepEqual(sent, {
    requestId: sent.requestId,
    ...call,
    input: { beats: ["A quiet garden"] },
  });

  // Unpublish (the App's listing reverts to "unindexed") removes the tool.
  published = false;
  const unpublishedSource = await oysterAppMethods(
    approvalHost(flowsHost),
    owner,
    null,
    appSurfaceCache(host),
  );
  const { catalog: unpublishedCatalog } = await run(
    owner,
    () => Promise.resolve(null),
    null,
    { source: unpublishedSource },
  );
  assert.throws(
    () => unpublishedCatalog.describe({ path: "FLOWS.flows.storyboard" }),
    /Unknown target/u,
  );
});

test("an owner-approved Agent caller can list and call a tool family tool", async () => {
  const row = await flowsRow("flows");
  const runCalls = [];
  const policy = {
    level: "write",
    revision: "agent-policy-flows",
    grantedBy: "owner",
  };
  const flowsHost = {
    ...host,
    installations: installationStore({
      list: async () => [row],
      get: async () => row,
    }),
    appToolPolicy: async () => policy,
    instances: {
      get: () => ({
        call: async (facts, api, name, input) => {
          if (name === "listFlows")
            return { ok: true, value: { kind: "ok", value: flowsListing() } };
          if (name === "runFlow") {
            runCalls.push(input);
            return {
              ok: true,
              value: {
                kind: "ok",
                value: { kind: "started", runId: "run-agent" },
              },
            };
          }
          throw new Error(`unexpected method ${name}`);
        },
      }),
    },
  };
  const agent = { actor: { kind: "agent", agentId: "gardener" } };
  const source = await oysterAppMethods(
    approvalHost(flowsHost),
    agent,
    {
      kind: "agent",
      policy,
    },
    appSurfaceCache(host),
  );
  const { catalog, results } = await run(
    agent,
    (bindings) => bindings.FLOWS["flows.storyboard"]({ beats: ["x"] }),
    policy,
    { source },
  );
  assert.ok(catalog.describe({ path: "FLOWS.flows.storyboard" }));
  assert.deepEqual(results, [{ kind: "started", runId: "run-agent" }]);
  assert.equal(runCalls.length, 1);
});

test("the host's minted requestId always wins over anything a row's own call data names `requestId`, and is fresh on every call", async () => {
  const row = await flowsRow("flows");
  const runCalls = [];
  // A hostile or merely careless row that also names `requestId`: were it
  // spread after the host's own, every call would replay the same run.
  const call = {
    workflowId: "storyboard",
    version: 1,
    requestId: "same-id-always",
  };
  const flowsHost = {
    ...host,
    installations: installationStore({
      list: async () => [row],
      get: async () => row,
    }),
    instances: {
      get: () => ({
        call: async (facts, api, name, input) => {
          if (name === "listFlows")
            return {
              ok: true,
              value: { kind: "ok", value: flowsListing(call) },
            };
          if (name === "runFlow") {
            runCalls.push(input);
            return {
              ok: true,
              value: { kind: "ok", value: { kind: "started", runId: "run-1" } },
            };
          }
          throw new Error(`unexpected method ${name}`);
        },
      }),
    },
  };
  const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
  const source = await oysterAppMethods(
    approvalHost(flowsHost),
    owner,
    null,
    appSurfaceCache(host),
  );
  await run(
    owner,
    async (bindings) => {
      await bindings.FLOWS["flows.storyboard"]({ beats: ["a"] });
      await bindings.FLOWS["flows.storyboard"]({ beats: ["b"] });
      return null;
    },
    null,
    { source },
  );
  assert.equal(runCalls.length, 2);
  const [first, second] = runCalls;
  for (const sent of [first, second]) {
    assert.notEqual(sent.requestId, "same-id-always");
    assert.match(sent.requestId, /^call_[a-z0-9]{21}$/u);
  }
  assert.notEqual(first.requestId, second.requestId);
});

test("a team key is listed a tool family tool, but the declaring App's own refusal of team keys stops its call, with no run", async () => {
  const row = await flowsRow("flows");
  const runCalls = [];
  // The owner's key carries apps.use on this App at Oyster's layer, so
  // listing and the admitted dispatch both succeed; the refusal below is
  // this fake App's *own* simulated business rule (a handler that refuses
  // any team-key actor outright), never Oyster's own policy gate -- a
  // worked example that an App's own rule is distinct from Oyster's, not a
  // claim about any particular App (Bonsai's Workflows admits a
  // sufficiently-granted key's run; see packages/oyster/src/standalone/workflow-host.ts).
  const fixtureKey = {
    keyId: "ci-key",
    owner: "owner",
    grantVersion: 1,
    grants: [{ capability: "apps.use", targets: { kind: "all" } }],
  };
  const flowsHost = {
    ...host,
    installations: installationStore({
      list: async () => [row],
      get: async () => row,
    }),
    keys: { live: async () => fixtureKey },
    instances: {
      get: () => ({
        call: async (facts, api, name, input) => {
          if (name === "listFlows")
            return { ok: true, value: { kind: "ok", value: flowsListing() } };
          if (name === "runFlow") {
            runCalls.push(input);
            return facts.subject.context.actor.kind === "team-key"
              ? { ok: false, code: "not_granted" }
              : {
                  ok: true,
                  value: {
                    kind: "ok",
                    value: { kind: "started", runId: "should-not-run" },
                  },
                };
          }
          throw new Error(`unexpected method ${name}`);
        },
      }),
    },
  };
  const key = { actor: { kind: "team-key", keyId: "ci-key" } };
  // The captured access must be exactly what keyAppAccess itself would
  // derive from this fixture key, so the call-time fresh re-check never
  // sees a mismatch and reports "stale_authority" instead of the App's own
  // refusal this test is actually about.
  const access = {
    kind: "key",
    keyId: fixtureKey.keyId,
    byInstallation: new Map([["flows", keyAppAccess(fixtureKey, "flows")]]),
  };
  const source = await oysterAppMethods(
    approvalHost(flowsHost),
    key,
    access,
    appSurfaceCache(host),
  );
  const { catalog, results } = await run(
    key,
    (bindings) => bindings.FLOWS["flows.storyboard"]({ beats: ["x"] }),
    null,
    { source },
  );
  // Listed: the key sees the tool exist and its schema.
  assert.ok(catalog.describe({ path: "FLOWS.flows.storyboard" }));
  // The module invocation threw after entering the Instance call. No attested
  // zero-effect completion reached the approval host, so it records unknown,
  // not a host-side denial and not a retry of the effect.
  assert.deepEqual(results, [{ kind: "refused", reason: "outcome-unknown" }]);
  assert.equal(runCalls.length, 1);
});

test("one App's bad tool-family listing withholds only that App's family tools, never the whole MCP catalog", async () => {
  const good = await flowsRow("flows");
  const bad = await flowsRow("broken-flows");
  for (const [label, brokenListFlows] of [
    [
      "a thrown Instance error",
      async () => {
        throw new Error("Instance crashed");
      },
    ],
    [
      "a reply forage's signed-listing codec rejects",
      async () => ({
        ok: true,
        value: {
          kind: "ok",
          value: { kind: "ready", tools: [{ not: "a valid row" }] },
        },
      }),
    ],
  ]) {
    const flowsHost = {
      ...host,
      installations: installationStore({
        list: async () => [good, bad],
        get: async (id) =>
          [good, bad].find((item) => item.installationId === id) ?? null,
      }),
      instances: {
        get: (instanceId) => ({
          call: async (facts, api, name) => {
            if (instanceId === bad.instanceId && name === "listFlows")
              return brokenListFlows();
            if (name === "listFlows")
              return { ok: true, value: { kind: "ok", value: flowsListing() } };
            if (name === "runFlow")
              return {
                ok: true,
                value: {
                  kind: "ok",
                  value: { kind: "started", runId: "run-1" },
                },
              };
            throw new Error(`unexpected method ${name}`);
          },
        }),
      },
    };
    const owner = {
      actor: { kind: "member", memberId: "owner" },
      role: "owner",
    };
    // Neither failure shape is an ordinary closed refusal, so each is
    // reported through Oyster's existing "AppInstance failure" diagnostic.
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    let catalog;
    try {
      ({ catalog } = await run(owner, () => Promise.resolve(null), null, {
        source: await oysterAppMethods(
          approvalHost(flowsHost),
          owner,
          null,
          appSurfaceCache(host),
        ),
      }));
    } finally {
      console.error = originalError;
    }
    assert.equal(logged.length, 1, `${label}: exactly one failure is reported`);
    assert.deepEqual(logged[0][0], "AppInstance failure");
    assert.equal(
      logged[0][1].installationId,
      "broken-flows",
      `${label}: the report names the failing App, not the healthy one`,
    );
    // The healthy App's family tool is unaffected.
    assert.ok(
      catalog.describe({ path: "FLOWS.flows.storyboard" }),
      `${label}: the healthy App's family tool still lists`,
    );
    // The broken App has no family tools, but it is still a module (its
    // ordinary ``listWorkflowTools``-shaped App continues to exist).
    assert.throws(
      () => catalog.describe({ path: "BROKEN_FLOWS.flows.storyboard" }),
      /Unknown target/u,
      `${label}: the broken App's family tool is withheld, not crashed into`,
    );
  }
});

test("an ordinary closed refusal from a tool family's listing stays quiet, unlike an unexpected failure", async () => {
  const row = await flowsRow("flows");
  const flowsHost = {
    ...host,
    installations: installationStore({
      list: async () => [row],
      get: async () => row,
    }),
    instances: {
      get: () => ({
        call: async (facts, api, name) => {
          if (name === "listFlows") return { ok: false, code: "not_approved" };
          throw new Error(`unexpected method ${name}`);
        },
      }),
    },
  };
  const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const { catalog } = await run(owner, () => Promise.resolve(null), null, {
      source: await oysterAppMethods(
        approvalHost(flowsHost),
        owner,
        null,
        appSurfaceCache(host),
      ),
    });
    assert.throws(
      () => catalog.describe({ path: "FLOWS.flows.storyboard" }),
      /Unknown target/u,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(
    logged.length,
    0,
    "an ordinary closed refusal is never reported",
  );
});

test("each App acquisition lists a tool family once, never during grants discovery", async () => {
  const row = await flowsRow("flows");
  let listCalls = 0;
  const flowsHost = {
    ...host,
    installations: installationStore({
      list: async () => [row],
      get: async () => row,
    }),
    instances: {
      get: () => ({
        call: async (facts, api, name) => {
          if (name === "listFlows") {
            listCalls++;
            return { ok: true, value: { kind: "ok", value: flowsListing() } };
          }
          throw new Error(`unexpected method ${name}`);
        },
      }),
    },
  };
  const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
  const source = await oysterAppMethods(
    approvalHost(flowsHost),
    owner,
    null,
    appSurfaceCache(host),
  );
  assert.equal(listCalls, 0, "grants discovery does not call an App");
  const acquired = await source.acquire({
    signal: new AbortController().signal,
    session: { sessionId: "session-one" },
    invalidate: () => assert.fail("Unexpected invalidation"),
  });
  try {
    assert.equal(listCalls, 1, "the session's single capture lists once");
  } finally {
    await acquired.release();
  }
  const next = await source.acquire({
    signal: new AbortController().signal,
    invalidate: () => assert.fail("Unexpected invalidation"),
  });
  try {
    assert.equal(listCalls, 2, "another acquisition gets a fresh listing");
  } finally {
    await next.release();
  }
});

test("a key's read-only selected grant reads once and returns a typed read-only refusal without a write", async () => {
  const before = calls.length;
  const stub = realKeysStub();
  const issued = await stub.issue("owner", {
    name: "reader-key",
    grants: [
      {
        capability: "apps.read",
        targets: { kind: "selected", ids: ["notes"] },
      },
    ],
  });
  assert.equal(issued.kind, "ok");
  const keyHost = { ...host, keys: { live: (keyId) => stub.live(keyId) } };
  const principal = { actor: { kind: "team-key", keyId: "reader-key" } };
  const liveKey = await stub.live("reader-key");
  const source = await oysterAppMethods(
    approvalHost(keyHost),
    principal,
    {
      kind: "key",
      keyId: "reader-key",
      byInstallation: new Map([["notes", keyAppAccess(liveKey, "notes")]]),
    },
    appSurfaceCache(host),
  );
  assert.deepEqual(source.grants, { "oyster-app:notes": "read" });
  const runtime = await Mycelium.make({
    sources: [source],
    sandbox: directSandbox(async (bindings) => {
      assert.deepEqual(await bindings.NOTES.readNote({}), { text: "hello" });
      assert.deepEqual(
        await bindings.NOTES.saveNote({ text: "denied write" }),
        { kind: "refused", reason: "read-only" },
      );
      return null;
    }),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "level-too-low",
        name: "execute",
        arguments: { code: "return null" },
      }),
    );
    await Effect.runPromise(Stream.runCollect(prepared.execute()));
    assert.deepEqual(
      calls.slice(before).map(({ name }) => name),
      ["readNote"],
    );
  } finally {
    await lease.release();
    await runtime.close();
  }
});

test("an installation added after a key's selected grant stays absent from its catalog, not merely refused", async () => {
  const stub = realKeysStub();
  await stub.issue("owner", {
    name: "notes-only-key",
    grants: [
      { capability: "apps.use", targets: { kind: "selected", ids: ["notes"] } },
    ],
  });
  const load = oysterMcpCatalogLoad(
    approvalHost({
      ...host,
      keys: { live: (keyId) => stub.live(keyId) },
    }),
  );
  const principal = { actor: { kind: "team-key", keyId: "notes-only-key" } };
  const snapshot = await load(principal);
  assert.deepEqual(Object.keys(snapshot.grants), ["oyster-app:notes"]);
  assert.equal(snapshot.sources.length, 1);
  const acquired = await snapshot.sources[0].acquire({
    signal: new AbortController().signal,
    invalidate: () => assert.fail("no live invalidation in this proof"),
  });
  // A module registration is an opaque Mycelium handle with no visible `id`
  // field; the grants-keys assertion above is what proves identity, so this
  // only needs to confirm the acquired snapshot carries exactly that one
  // module, not a second (refused) one for the un-granted installation.
  assert.equal(acquired.snapshot.modules.length, 1);
  await acquired.release();
});

test("a captured MCP catalog gives stale_authority once the key behind it is revoked", async () => {
  const stub = realKeysStub();
  const issued = await stub.issue("owner", {
    name: "revocable-key",
    grants: [{ capability: "apps.use", targets: { kind: "all" } }],
  });
  assert.equal(issued.kind, "ok");
  const keyHost = {
    ...host,
    keys: { live: (keyId) => stub.live(keyId) },
  };
  const load = oysterMcpCatalogLoad(approvalHost(keyHost));
  const principal = { actor: { kind: "team-key", keyId: "revocable-key" } };
  const snapshot = await load(principal);
  assert.deepEqual(
    Object.entries(snapshot.grants)
      .filter(([id]) => id.startsWith("oyster-app:"))
      .sort(),
    [
      ["oyster-app:diary", "write"],
      ["oyster-app:notes", "write"],
    ],
  );
  const revoked = await stub.revoke(
    "owner",
    "req-stale-authority",
    "revocable-key",
  );
  assert.equal(revoked.kind, "ok");
  const runtime = await Mycelium.make({
    sources: snapshot.sources,
    sandbox: directSandbox(async (bindings) => {
      await assert.rejects(
        bindings.NOTES.readNote({}),
        /App method refused: stale_authority/u,
      );
      return null;
    }),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "stale-after-revoke",
        name: "execute",
        arguments: { code: "return null" },
      }),
    );
    await Effect.runPromise(Stream.runCollect(prepared.execute()));
  } finally {
    await lease.release();
    await runtime.close();
  }
});

test("repeated MCP catalog loads verify each installed Release once, still reading installation authority fresh", async () => {
  const artifactReads = [];
  let listed = 0;
  const load = oysterMcpCatalogLoad(
    approvalHost({
      ...host,
      keys: allAppsKeysPort(),
      artifacts: {
        ...host.artifacts,
        get: (ref) => {
          artifactReads.push(ref);
          return host.artifacts.get(ref);
        },
      },
      installations: installationStore({
        ...host.installations,
        list: () => {
          listed += 1;
          return host.installations.list();
        },
      }),
    }),
  );
  const principal = { actor: { kind: "team-key", keyId: "morel" } };
  const first = await load(principal);
  const readsAfterFirst = artifactReads.length;
  assert.ok(readsAfterFirst > 0);
  for (let index = 0; index < 3; index += 1) {
    const again = await load(principal);
    assert.deepEqual(again.grants, first.grants);
  }
  assert.equal(
    artifactReads.length,
    readsAfterFirst,
    "one shared Release is verified once, not per load or per installation",
  );
  assert.equal(listed, 4, "installation authority is read on every load");
});

test("generation belongs to the store incarnation, not a catalog read or row revision", async () => {
  let rows = [];
  const store = installationStore({ list: () => Promise.resolve(rows) });
  const first = await store.generation();
  assert.ok(first.length > 0);
  rows = [installation("notes")];
  await store.list();
  assert.equal(await store.generation(), first);
  const replacement = installationStore({ list: () => Promise.resolve(rows) });
  assert.notEqual(await replacement.generation(), first);
});

test("two writes in one host execution remain distinct and replay by the same ordinal without redispatch", async () => {
  calls.length = 0;
  const selected = installation("notes");
  const source = await oysterAppMethods(
    approvalHost({
      ...host,
      installations: installationStore({ list: async () => [selected] }),
    }),
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    null,
    appSurfaceCache(host),
  );
  // As Mycelium's execute does: one execution, a fresh frozen context per
  // operation call carrying that call's position.
  const context = (operationOrdinal) => ({
    executionId: "fixture-ordinal-replay",
    toolCallId: "fixture-tool-call",
    operationOrdinal,
    signal: new AbortController().signal,
    deadlineAt: null,
  });
  const lease = await source.acquire({
    signal: new AbortController().signal,
    invalidate: () => assert.fail("Unexpected invalidation"),
  });
  try {
    assert.equal(lease.snapshot.modules.length, 1);
    const [notes] = lease.snapshot.modules;
    assert.ok(notes);
    const a = await invokeModuleOperation(
      notes,
      "saveNote",
      { text: "a" },
      context(0),
    );
    const b = await invokeModuleOperation(
      notes,
      "saveNote",
      { text: "b" },
      context(1),
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(
      await invokeModuleOperation(notes, "saveNote", { text: "a" }, context(0)),
      a,
    );
    assert.deepEqual(
      await invokeModuleOperation(notes, "saveNote", { text: "b" }, context(1)),
      b,
    );
    assert.equal(calls.length, 2, "replay cannot dispatch either effect again");
  } finally {
    await lease.release();
  }
});
