// Agents drive Workflows over MCP (S8, rows 29/30).
//
// Boots the real standalone Oyster Worker exactly like workflows.native.mjs,
// plus Bonsai and a team key, then drives it through a real headless/owner
// MCP client (`@modelcontextprotocol/client`), the same way
// mcp-computer.native.mjs and Oyster's own test/mcp.native.mjs drive the
// shared MCP owner: one top-level `execute` tool whose sandbox exposes
// `env.<APP>` and `forage`.
//
// KEYS ARE EAR TAG GRANTS (oyster-ear-tag-cutover-2026-10-14.md). The team
// key below is issued with `{apps.use, selected:[workflows]}` and
// `{apps.read, selected:[bonsai]}` (packages/oyster/src/keys.ts's
// `oysterKeyVocabulary`), not a blanket policy — it only ever sees and acts
// on the installations its grants name.
//
// SOURCE CHECK (required by the brief): what source does a key-started run
// record? `"key"`, honestly — S3 landed
// (packages/oyster/src/standalone/workflow-host.ts:548-660). A key never becomes a
// member or an Agent principal: `prepare()` resolves its live grants
// (`:548-554`), filters the catalog to what they allow before compiling
// (`keyCatalogEntries`), then runs on its grantor owner's access
// (`keyInitiator.grantorMemberId`, `:608-617`) — the same shape an Agent's
// own grantor path already used. The preparation it builds is `{
// initiatedBy: { kind: "key", keyId, grantorMemberId }, source: "key" }`
// (`:646`). A key with the right grants is admitted for real, below, for
// both call shapes: direct `runWorkflow` and the `flows.*` tool-family
// sugar over the exact same admitted call
// (fix/oyster-mcp-app-tool-families). No Agent or member is ever spoofed.
//
// ROW 30 ("an Agent saves a draft"): traced to the runbook's actual
// advertised caller (section 8) — not an Oyster Agent actor, but a TEAM KEY
// over the real /mcp endpoint, building and saving a draft for the owner to
// publish later. `saveDraft` (apps/trellis/backend/library-methods.ts:
// 151-168 -> library.ts:146-182) only `requires: ["workflow.run"]` (the same
// capability this file's key's `apps.use` grant on Workflows already
// covers) and has no member/Agent-only gate. Below: the team key saves a
// real draft over MCP with honest team-key attribution, the owner sees it
// on its own real MCP connection, and it is never published or run by the
// key, so it never becomes a flows tool either. A model-driven live
// authoring proof (an actual Agent writing the draft's content) stays a
// separate, S10b rehearsal-time leg with @fungi/luna, owned by Opus-DC —
// this file proves the transport and admission, not an Agent's own
// judgment.
import process from "node:process";
import { log, error } from "node:console";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseJsonc } from "jsonc-parser";
import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { sha256 } from "@fungi.computer/oyster/host";
import { build } from "esbuild";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";
import { appBackend as workflowsBackend } from "../../../../apps/trellis/backend/methods.ts";
import workflowsMetadata from "../../../../apps/trellis/package.json" with { type: "json" };
import { appBackend as bonsaiBackend } from "../../../../apps/bonsai/backend/methods.ts";
import bonsaiMetadata from "../../../../apps/bonsai/package.json" with { type: "json" };

const workflowsDeclaration = buildAppDeclaration(
  workflowsBackend,
  workflowsMetadata.fungi.app,
);
const bonsaiDeclaration = buildAppDeclaration(
  bonsaiBackend,
  bonsaiMetadata.fungi.app,
);

const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/mcp-workflows-native-`);
const config = parseJsonc(
  await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = `${root}test/standalone/workflows-root.fixture.ts`;
config.r2_buckets = config.r2_buckets.map((bucket) =>
  bucket.binding === "APP_ARTIFACTS"
    ? { ...bucket, bucket_name: "mcp-workflows-proof-app-artifacts" }
    : bucket,
);
config.vars = {
  ...config.vars,
  WORKFLOW_CODE_LOCAL_DEV: process.env.CELLD_PLATFORM_CELLD ? "false" : "true",
};
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
const key = randomBytes(24).toString("hex");
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";
const provider = await workflowGitProvider();
const port = await new Promise((resolve) => {
  const socket = createServer().listen(0, "127.0.0.1", () => {
    const { port: free } = socket.address();
    socket.close(() => resolve(free));
  });
});
const origin = `http://127.0.0.1:${port}`;
const tenantHost = "oyster.test";
const tenantOrigin = `https://${tenantHost}`;
const auth = { Authorization: `Bearer ${key}` };
const worker = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    `${root}test/standalone/workflows-root.fixture.ts`,
    "--config",
    `${work}/wrangler.json`,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    `${work}/state`,
    "--local-upstream",
    tenantHost,
    "--upstream-protocol",
    "https",
    "--var",
    `OYSTER_OWNER_KEY:${key}`,
    "--var",
    `OYSTER_ORIGIN:${tenantOrigin}`,
    "--var",
    `GIT_ORIGIN:${provider.origin}`,
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
let output = "";
worker.stdout.on("data", (chunk) => {
  output += chunk;
});
worker.stderr.on("data", (chunk) => {
  output += chunk;
});
const stopped = new Promise((resolve) => worker.once("exit", resolve));

async function call(installation, method, input) {
  const response = await globalThis.fetch(
    `${origin}/apps/${installation}/methods/${method}`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: globalThis.AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, `${installation}.${method}: ${text}`);
  return JSON.parse(text);
}

async function persist(value) {
  const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
  const digest = await sha256(bytes);
  const artifactRef = `artifact:sha256-${digest.slice(7)}`;
  const response = await globalThis.fetch(
    `${origin}/api/artifacts/${artifactRef}?digest=${digest}`,
    { method: "PUT", headers: auth, body: bytes },
  );
  assert.equal(response.status, 204, await response.text());
  return { artifactRef, digest, byteLength: bytes.length, version: digest };
}

async function install(installationId, entry, exportName, declaration) {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    write: false,
    minify: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*"],
    target: "es2022",
  });
  const backend = {
    ...(await persist({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName,
      code: bundled.outputFiles[0].text,
    })),
    mediaType: backendMediaType,
  };
  const artifact = await persist(createAppBuild(null, backend, declaration));
  const release = {
    appId: `app_${installationId}`,
    releaseId: `rel_${installationId}`,
    artifact: {
      artifactRef: artifact.artifactRef,
      artifactDigest: artifact.digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: artifact.digest,
        buildRecipeDigest: artifact.digest,
      },
    },
  };
  const response = await globalThis.fetch(`${origin}/api/installations`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ installationId, release }),
  });
  assert.equal(response.status, 201, await response.text());
}

/** Publication finishes in the App's background lane; wait for its commit. */
async function publish(workflowId, expectedRevision) {
  const reply = await call("trellis", "publishWorkflow", {
    workflowId,
    expectedRevision,
  });
  if (reply.kind !== "publishing") return reply;
  return until(
    () =>
      call("trellis", "publicationStatus", {
        workflowId,
        publicationId: reply.publicationId,
      }),
    (status) => status.kind !== "publishing",
    `${workflowId} publication`,
  );
}
async function until(read, accepts, label) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await delay(100);
  }
}

/** `execute`'s MCP content array holds one text block whose own `text` is
 * the App method's JSON-stringified return value. `unwrap` reaches that
 * inner JSON string once (for a plain substring/regex check); `reply`
 * parses it into the real returned value. */
function unwrap(contentText) {
  return JSON.parse(contentText)[0].text;
}
function reply(contentText) {
  return JSON.parse(unwrap(contentText));
}
/** The dynamic family call's intended shape, once wired: `{ runId }`. */
const startedByTool = z.object({ runId: z.string().min(1) });

/** `headless` is shaped like `claude -p`: a bare elicitation capability that
 * cancels every confirmation, as mcp-computer.native.mjs's `connect` does. A
 * non-headless client auto-accepts, so an owner's own writes (which always
 * ask: packages/mycelium/src/mcp-catalog.ts `approvedWrites` is only ever
 * populated for an agent's or key's own approved write policy, never for the
 * owner) still go through. */
async function connectMcp(credential, headless) {
  const client = new Client(
    { name: "mcp-workflows proof", version: "1" },
    { capabilities: { elicitation: headless ? {} : { form: {} } } },
  );
  let asked = 0;
  client.setRequestHandler("elicitation/create", () => {
    asked += 1;
    return headless
      ? { action: "cancel" }
      : { action: "accept", content: { approve: true } };
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${credential}` } } },
  );
  await client.connect(transport);
  const execute = async (code) => {
    const result = await client.callTool({
      name: "execute",
      arguments: { code },
    });
    return { ...result, text: JSON.stringify(result.content) };
  };
  return {
    client,
    execute,
    asked: () => asked,
    close: async () => {
      await transport.terminateSession();
      await client.close();
    },
  };
}

try {
  await until(
    async () =>
      globalThis.fetch(`${origin}/login`).then(
        (r) => r.ok,
        () => false,
      ),
    (ready) => ready,
    "standalone root readiness",
  );
  await install(
    "trellis",
    "../../../../apps/trellis/backend/index.ts",
    "Trellis",
    workflowsDeclaration,
  );
  await install(
    "bonsai",
    "../../../../apps/bonsai/backend/index.ts",
    "BonsaiApp",
    bonsaiDeclaration,
  );
  await call("bonsai", "repos.create", { name: "pond" });

  // A published Workflow with a REAL Bonsai App node (the demo "Repo list"
  // shape: .botanical/contest/demo-repo-list.mts), not just a self-contained
  // code node: compiling it needs a real `bindings.bonsai`. A tool-family
  // call that always sends `bindings: {}` cannot compile this — exactly the
  // bindings bug the CTO flagged in fix/oyster-mcp-app-tool-families.
  const bonsaiCatalog = (await call("trellis", "catalog", {})).apps.find(
    (row) => row.installationId === "bonsai",
  );
  assert.ok(bonsaiCatalog, "Bonsai is visible in the Workflow catalog");
  const repoListDigest = z
    .string()
    .min(1)
    .parse(bonsaiCatalog.methods["repos.list"].digest);
  const names = { type: "array", items: { type: "string" }, maxItems: 50 };
  const definition = {
    format: "fungi.workflow/v1",
    title: "MCP flows proof",
    description: "Trim each name in the input list; list the Bonsai repos.",
    apps: { bonsai: { appId: "app_bonsai" } },
    input: {
      type: "object",
      properties: { names },
      required: ["names"],
      additionalProperties: false,
    },
    nodes: [
      {
        id: "trim",
        kind: "code",
        source:
          "const names = await env.INPUT.read({}); return names.map(name => name.trim());",
        input: names,
        output: names,
        values: { value: { from: { node: "$input", port: "names" } } },
      },
      {
        id: "list",
        kind: "app",
        app: "bonsai",
        method: "repos.list",
        methodDigest: repoListDigest,
        values: {},
      },
    ],
    edges: [],
    output: {
      names: { node: "trim", port: "value" },
      repos: { node: "list", port: "repos" },
    },
  };
  const workflowId = "mcp-flows-proof";
  const draft = await call("trellis", "saveDraft", {
    workflowId,
    expectedRevision: 0,
    draft: { definition, layout: {} },
  });
  assert.equal(draft.kind, "saved", JSON.stringify(draft));
  const published = await publish(workflowId, draft.revision);
  assert.equal(published.kind, "published", JSON.stringify(published));

  // A second, unpublished draft, saved over MCP by the owner below: it must
  // never show up as a runnable tool.
  const draftOnlyId = "mcp-flows-draft-only";

  // Row 30's real caller (runbook section 8, traced by Shiitake): a team
  // key over the real /mcp endpoint builds and saves a draft; the owner
  // later publishes. saveDraft (library-methods.ts:151-168 ->
  // library.ts:146-182) only requires "workflow.run" (the same capability
  // the key already has, below) and has no member/Agent-only gate — unlike
  // runWorkflow's workflow-host.ts:582 check. A team-key actor saves this
  // one for real, with no publish or run by the key.
  const teamKeyDraftId = "mcp-flows-team-key-draft";

  // A team key, created through the real owner-only route. This is the key a
  // headless MCP client authenticates with below.
  const created = await globalThis.fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "mcp-workflows-proof",
      // Ear Tag grants (oyster-ear-tag-cutover-2026-10-14.md, S5): apps.use
      // on Workflows so it can save drafts and start runs; apps.read on
      // Bonsai so a run reaching its real App node still compiles.
      grants: [
        {
          capability: "apps.use",
          targets: { kind: "selected", ids: ["trellis"] },
        },
        {
          capability: "apps.read",
          targets: { kind: "selected", ids: ["bonsai"] },
        },
      ],
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const createdKey = await created.json();
  const teamKey = createdKey.plaintext;
  const teamKeyId = createdKey.key.keyId;
  // Ear Tag's own nanoid alphabet (packages/cairn/src/nanoid.ts), not hex.
  assert.match(teamKey, /^oyk_[a-z0-9]{32}$/u);

  // --- The owner over MCP: saveDraft, listWorkflows, a real run to terminal. ---
  const owner = await connectMcp(key, false);
  const teamClient = await connectMcp(teamKey, true);
  let ownerMemberId;

  await test("owner MCP: exactly one tool, execute, is exposed", async () => {
    assert.deepEqual(
      (await owner.client.listTools()).tools.map(({ name }) => name),
      ["execute"],
    );
  });

  await test("owner MCP: saveDraft / loadWorkflow / listWorkflows round trip", async () => {
    const savedDraft = await owner.execute(
      `return await env.WORKFLOWS.saveDraft({ workflowId: ${JSON.stringify(draftOnlyId)}, expectedRevision: 0, draft: { definition: ${JSON.stringify({ ...definition, title: "MCP flows draft-only proof" })}, layout: {} } })`,
    );
    assert.notEqual(savedDraft.isError, true, savedDraft.text);
    assert.equal(reply(savedDraft.text).kind, "saved", savedDraft.text);
    // The owner sees the saved draft back.
    const loaded = await owner.execute(
      `return await env.WORKFLOWS.loadWorkflow({ workflowId: ${JSON.stringify(draftOnlyId)}, at: "draft" })`,
    );
    assert.notEqual(loaded.isError, true, loaded.text);
    assert.match(unwrap(loaded.text), /MCP flows draft-only proof/u);
    // The library listing finds both the published tool and the draft.
    const listed = await owner.execute(
      "return await env.WORKFLOWS.listWorkflows({})",
    );
    assert.notEqual(listed.isError, true, listed.text);
    const library = reply(listed.text).items.map((row) => row.workflowId);
    assert.ok(library.includes(workflowId), JSON.stringify(library));
    assert.ok(library.includes(draftOnlyId), JSON.stringify(library));
  });

  await test("owner MCP: a direct runWorkflow run reaches terminal and listRuns shows it", async () => {
    // A real run, over MCP, through the plain runWorkflow method (not the
    // flows.* sugar, exercised separately below): it reaches terminal.
    const startedRaw = await owner.execute(
      `return await env.WORKFLOWS.runWorkflow({ workflowId: ${JSON.stringify(workflowId)}, commit: ${JSON.stringify(published.commit)}, requestId: "owner-mcp-run", bindings: { bonsai: "bonsai" }, input: { names: [" owner run "] } })`,
    );
    assert.notEqual(startedRaw.isError, true, startedRaw.text);
    const started = reply(startedRaw.text);
    assert.equal(started.kind, "started", JSON.stringify(started));
    const runStatus = async () => {
      const raw = await owner.execute(
        `return await env.WORKFLOWS.runStatus({ runId: ${JSON.stringify(started.runId)} })`,
      );
      assert.notEqual(raw.isError, true, raw.text);
      return reply(raw.text);
    };
    const completed = await until(
      runStatus,
      (value) => {
        assert.notEqual(value.status, "errored", JSON.stringify(value));
        return value.status === "complete";
      },
      "owner MCP run reaches terminal",
    );
    assert.deepEqual(completed.output.names, ["owner run"]);
    assert.deepEqual(
      completed.output.repos.map((row) => row.name),
      ["pond"],
      "the real Bonsai App node executed and returned the real repo",
    );
    // The owner's own write asked for (and auto-accepted) confirmation: a
    // true headless client, below, never gets this far on its own calls
    // because Mycelium's `approvedWrites` is only ever populated for an
    // agent's or key's own pre-approved policy (packages/mycelium/src/
    // mcp-catalog.ts:28-30), never for the owner.
    assert.ok(
      owner.asked() >= 1,
      "the owner's own writes ask for confirmation",
    );

    // The owner's listRuns shows this run.
    const runsRaw = await owner.execute(
      `return await env.WORKFLOWS.listRuns({ workflowId: ${JSON.stringify(workflowId)} })`,
    );
    assert.notEqual(runsRaw.isError, true, runsRaw.text);
    const runs = reply(runsRaw.text);
    const own = runs.find((row) => row.runId === started.runId);
    assert.ok(own, "the owner's listRuns shows the run it started");
    assert.deepEqual(own.initiatedBy.kind, "member");
    // Captured for the key test below: a key's run must be granted by this
    // same real tenant member, never a spoofed or literal "owner" string.
    ownerMemberId = own.initiatedBy.memberId;
  });

  // fix/oyster-mcp-app-tool-families wires the published Workflow in as a
  // discoverable tool for anyone who could already run it: the owner can.
  await test("owner MCP: forage.search('flows') lists the published tool", async () => {
    const search = await owner.execute(
      'return await forage.search({ query: "flows" })',
    );
    assert.notEqual(search.isError, true, search.text);
    const found = unwrap(search.text);
    assert.match(found, /flows\.mcpFlowsProof/u);
    assert.doesNotMatch(found, new RegExp(draftOnlyId, "u"));
  });
  await test("owner MCP: env.WORKFLOWS.flows.mcpFlowsProof() is a real, second run that reaches terminal", async () => {
    const dynamic = await owner.execute(
      'return await env.WORKFLOWS.flows.mcpFlowsProof({ names: [" owner flows "] })',
    );
    assert.notEqual(dynamic.isError, true, dynamic.text);
    const { runId } = startedByTool.parse(reply(dynamic.text));
    const runStatus = async () => {
      const raw = await owner.execute(
        `return await env.WORKFLOWS.runStatus({ runId: ${JSON.stringify(runId)} })`,
      );
      assert.notEqual(raw.isError, true, raw.text);
      return reply(raw.text);
    };
    const completed = await until(
      runStatus,
      (value) => {
        assert.notEqual(value.status, "errored", JSON.stringify(value));
        return value.status === "complete";
      },
      "owner flows.mcpFlowsProof() run reaches terminal",
    );
    // The same real Bonsai App node, compiled through the tool family's
    // own resolved bindings (fix/oyster-mcp-app-tool-families's
    // resolveBindings), not a guessed bindings: {}.
    assert.deepEqual(completed.output.names, ["owner flows"]);
    assert.deepEqual(
      completed.output.repos.map((row) => row.name),
      ["pond"],
      "the real Bonsai App node executed through the dynamic tool too",
    );
  });

  await test("team key MCP: has real App access to an ordinary method (catalog)", async () => {
    // The key has real, working access to an ordinary Workflow method:
    // this App-tool-policy path is not broken for every method, only for
    // starting a run (below).
    const catalog = await teamClient.execute(
      "return await env.WORKFLOWS.catalog({})",
    );
    assert.notEqual(catalog.isError, true, catalog.text);
    assert.equal(
      teamClient.asked(),
      0,
      "a pre-approved key's read is never asked",
    );
  });

  await test("team key MCP: saveDraft is honest team-key attribution, the owner sees it, no publish or run by the key", async () => {
    const saved = await teamClient.execute(
      `return await env.WORKFLOWS.saveDraft({ workflowId: ${JSON.stringify(teamKeyDraftId)}, expectedRevision: 0, draft: { definition: ${JSON.stringify({ ...definition, title: "Team key draft proof" })}, layout: {} } })`,
    );
    assert.notEqual(saved.isError, true, saved.text);
    assert.equal(reply(saved.text).kind, "saved", saved.text);
    assert.equal(
      teamClient.asked(),
      0,
      "a pre-approved key's saveDraft is never asked for confirmation",
    );
    // The owner, over its own real MCP connection, sees the key's draft.
    const loaded = await owner.execute(
      `return await env.WORKFLOWS.loadWorkflow({ workflowId: ${JSON.stringify(teamKeyDraftId)}, at: "draft" })`,
    );
    assert.notEqual(loaded.isError, true, loaded.text);
    assert.match(unwrap(loaded.text), /Team key draft proof/u);
    // Never published and never run by the key: it stays off the family
    // listing (the App's own listWorkflowTools method, direct HTTP).
    const tools = await call("trellis", "listWorkflowTools", {});
    assert.equal(tools.kind, "ready", JSON.stringify(tools));
    assert.ok(
      !tools.tools.some((tool) => tool.workflowId === teamKeyDraftId),
      "an unpublished, key-saved draft is never a flows tool",
    );
  });

  // Discovery is not admission: the key already has real catalog access
  // (above), so it can list the family's published tool too.
  await test("team key MCP: forage.search('flows') lists the published tool", async () => {
    const search = await teamClient.execute(
      'return await forage.search({ query: "flows" })',
    );
    assert.notEqual(search.isError, true, search.text);
    assert.match(unwrap(search.text), /flows\.mcpFlowsProof/u);
  });

  await test('team key MCP: both runWorkflow and flows.mcpFlowsProof are ALLOWED, with no elicitation, source "key"', async () => {
    // S3 landed (oyster-ear-tag-cutover-2026-10-14.md): a key with apps.use
    // on Workflows and apps.read on Bonsai runs on the grantor owner's
    // access, limited by the key's own grants. It never becomes a member
    // or an Agent; workflow-host.ts admits it as its own initiator kind,
    // "key", with the run's source recorded honestly as "key" too — not
    // spoofed into "manual" or "agent".
    assert.ok(
      ownerMemberId,
      "ownerMemberId was captured from the earlier owner run",
    );
    const direct = await teamClient.execute(
      `return await env.WORKFLOWS.runWorkflow({ workflowId: ${JSON.stringify(workflowId)}, commit: ${JSON.stringify(published.commit)}, requestId: "team-key-run", bindings: { bonsai: "bonsai" }, input: { names: [" key run "] } })`,
    );
    assert.notEqual(direct.isError, true, direct.text);
    const directStarted = reply(direct.text);
    assert.equal(directStarted.kind, "started", JSON.stringify(directStarted));

    const viaFamily = await teamClient.execute(
      'return await env.WORKFLOWS.flows.mcpFlowsProof({ names: [" key flows "] })',
    );
    assert.notEqual(viaFamily.isError, true, viaFamily.text);
    const familyStarted = startedByTool.parse(reply(viaFamily.text));

    assert.equal(
      teamClient.asked(),
      0,
      "a pre-approved key's write skips elicitation entirely, start to finish",
    );

    // Both reach terminal for real, through the key's own access.
    const runStatus = async (runId) => {
      const raw = await teamClient.execute(
        `return await env.WORKFLOWS.runStatus({ runId: ${JSON.stringify(runId)} })`,
      );
      assert.notEqual(raw.isError, true, raw.text);
      return reply(raw.text);
    };
    const terminal = (runId, label) =>
      until(
        () => runStatus(runId),
        (value) => {
          assert.notEqual(value.status, "errored", JSON.stringify(value));
          return value.status === "complete";
        },
        label,
      );
    const directCompleted = await terminal(
      directStarted.runId,
      "key-started direct run reaches terminal",
    );
    assert.deepEqual(directCompleted.output.names, ["key run"]);
    assert.deepEqual(
      directCompleted.output.repos.map((row) => row.name),
      ["pond"],
    );
    const familyCompleted = await terminal(
      familyStarted.runId,
      "key-started flows.mcpFlowsProof run reaches terminal",
    );
    assert.deepEqual(familyCompleted.output.names, ["key flows"]);
    assert.deepEqual(
      familyCompleted.output.repos.map((row) => row.name),
      ["pond"],
    );

    // listRuns shows both, with honest key attribution: source "key" and
    // initiatedBy {kind:"key", keyId, grantorMemberId: the owner}.
    const runs = (await call("trellis", "listRuns", { workflowId })).filter(
      (row) =>
        row.runId === directStarted.runId || row.runId === familyStarted.runId,
    );
    assert.equal(runs.length, 2, JSON.stringify(runs));
    for (const row of runs) {
      assert.equal(row.source, "key", JSON.stringify(row));
      assert.deepEqual(row.initiatedBy, {
        kind: "key",
        keyId: teamKeyId,
        grantorMemberId: ownerMemberId,
      });
    }
  });

  await owner.close();
  await teamClient.close();
  log(
    `DONE standalone ${runtime}: see the individual node:test results above.`,
  );
} catch (cause) {
  const diagnostic = `${root}.botanical/workflow-reviews/native-mcp-workflows-${runtime}.log`;
  await mkdir(`${root}.botanical/workflow-reviews`, {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(diagnostic, output, { mode: 0o600 });
  error(
    `Native MCP Workflow proof failed; private Worker diagnostics: ${diagnostic}`,
  );
  throw cause;
} finally {
  worker.kill("SIGTERM");
  await stopped;
  await provider.close();
  await rm(work, { recursive: true, force: true });
}
