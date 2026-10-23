import { nativeMcpConnector } from "../native-mcp-client.fixture.mjs";
import {
  nativeArtifactBucket,
  nativeWorkflowHost,
  nativeAppClient,
  nativeFixtureWorkspace,
  until,
} from "./workflow-native.fixture.mjs";
// Real owner and scoped team-key MCP sessions against Standalone Trellis and
// Bonsai. The installed "trellis" module is env.TRELLIS; forage discovers the
// published flows family through that same catalog.
//
// Drafts, direct runs and flows-family runs use each session's actual authority.
// MCP adds no outer write confirmation for the owner or a granted key. Completed
// runs retain honest member/key attribution and the real grantor's identity.
//
// This qualifies transport and admission, not model-driven Agent authoring,
// App publication provenance or a physical Computer VM.
import process from "node:process";
import { log } from "node:console";
import { test } from "node:test";
import assert from "node:assert/strict";

import { URL, fileURLToPath } from "node:url";

import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";

import { z } from "zod";

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

const { work, config } = await nativeFixtureWorkspace(
  root,
  "mcp-workflows-native-",
);

config.main = `${root}test/standalone/workflows-root.fixture.ts`;
nativeArtifactBucket(config, "mcp-workflows-proof-app-artifacts");

const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";

const tenantHost = "oyster.test";
const tenantOrigin = `https://${tenantHost}`;

const nativeHost = await nativeWorkflowHost({
  root,
  work,
  config,
  oysterOrigin: tenantOrigin,
});
const { key, origin, auth } = nativeHost;

const { call, installFirstParty, publish, approve } = nativeAppClient(
  origin,
  auth,
  { key, installationMilliseconds: 60_000 },
);

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
async function readRun(session, runId) {
  const raw = await session.execute(
    `return await env.TRELLIS.runStatus({ runId: ${JSON.stringify(runId)} })`,
  );
  assert.notEqual(raw.isError, true, raw.text);
  return reply(raw.text);
}
/** The dynamic family call's intended shape, once wired: `{ runId }`. */
const startedByTool = z.object({ runId: z.string().min(1) });

/** The two clients differ only in handling explicit operation-level confirmation.
 * The MCP transport does not force confirmation for every write. */
const connectMcp = nativeMcpConnector({ origin, name: "mcp-workflows proof" });

try {
  await nativeHost.ready();
  await installFirstParty("trellis", workflowsDeclaration);
  await installFirstParty("bonsai", bonsaiDeclaration);
  await approve("trellis");
  await approve("bonsai");
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
      `return await env.TRELLIS.saveDraft({ workflowId: ${JSON.stringify(draftOnlyId)}, expectedRevision: 0, draft: { definition: ${JSON.stringify({ ...definition, title: "MCP flows draft-only proof" })}, layout: {} } })`,
    );
    assert.notEqual(savedDraft.isError, true, savedDraft.text);
    assert.equal(reply(savedDraft.text).kind, "saved", savedDraft.text);
    // The owner sees the saved draft back.
    const loaded = await owner.execute(
      `return await env.TRELLIS.loadWorkflow({ workflowId: ${JSON.stringify(draftOnlyId)}, at: "draft" })`,
    );
    assert.notEqual(loaded.isError, true, loaded.text);
    assert.match(unwrap(loaded.text), /MCP flows draft-only proof/u);
    // The library listing finds both the published tool and the draft.
    const listed = await owner.execute(
      "return await env.TRELLIS.listWorkflows({})",
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
      `return await env.TRELLIS.runWorkflow({ workflowId: ${JSON.stringify(workflowId)}, commit: ${JSON.stringify(published.commit)}, requestId: "owner-mcp-run", bindings: { bonsai: "bonsai" }, input: { names: [" owner run "] } })`,
    );
    assert.notEqual(startedRaw.isError, true, startedRaw.text);
    const started = reply(startedRaw.text);
    assert.equal(started.kind, "started", JSON.stringify(started));
    const runStatus = () => readRun(owner, started.runId);
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
    assert.equal(owner.asked(), 0, "MCP adds no outer write confirmation");

    // The owner's listRuns shows this run.
    const runsRaw = await owner.execute(
      `return await env.TRELLIS.listRuns({ workflowId: ${JSON.stringify(workflowId)} })`,
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
  await test("owner MCP: env.TRELLIS.flows.mcpFlowsProof() is a real, second run that reaches terminal", async () => {
    const dynamic = await owner.execute(
      'return await env.TRELLIS.flows.mcpFlowsProof({ names: [" owner flows "] })',
    );
    assert.notEqual(dynamic.isError, true, dynamic.text);
    const { runId } = startedByTool.parse(reply(dynamic.text));
    const runStatus = () => readRun(owner, runId);
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
      "return await env.TRELLIS.catalog({})",
    );
    assert.notEqual(catalog.isError, true, catalog.text);
    assert.equal(teamClient.asked(), 0, "a granted key's read is never asked");
  });

  await test("team key MCP: saveDraft is honest team-key attribution, the owner sees it, no publish or run by the key", async () => {
    const saved = await teamClient.execute(
      `return await env.TRELLIS.saveDraft({ workflowId: ${JSON.stringify(teamKeyDraftId)}, expectedRevision: 0, draft: { definition: ${JSON.stringify({ ...definition, title: "Team key draft proof" })}, layout: {} } })`,
    );
    assert.notEqual(saved.isError, true, saved.text);
    assert.equal(reply(saved.text).kind, "saved", saved.text);
    assert.equal(
      teamClient.asked(),
      0,
      "a granted key's saveDraft is never asked for confirmation",
    );
    // The owner, over its own real MCP connection, sees the key's draft.
    const loaded = await owner.execute(
      `return await env.TRELLIS.loadWorkflow({ workflowId: ${JSON.stringify(teamKeyDraftId)}, at: "draft" })`,
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
      `return await env.TRELLIS.runWorkflow({ workflowId: ${JSON.stringify(workflowId)}, commit: ${JSON.stringify(published.commit)}, requestId: "team-key-run", bindings: { bonsai: "bonsai" }, input: { names: [" key run "] } })`,
    );
    assert.notEqual(direct.isError, true, direct.text);
    const directStarted = reply(direct.text);
    assert.equal(directStarted.kind, "started", JSON.stringify(directStarted));

    const viaFamily = await teamClient.execute(
      'return await env.TRELLIS.flows.mcpFlowsProof({ names: [" key flows "] })',
    );
    assert.notEqual(viaFamily.isError, true, viaFamily.text);
    const familyStarted = startedByTool.parse(reply(viaFamily.text));

    assert.equal(
      teamClient.asked(),
      0,
      "a granted key's write skips elicitation entirely, start to finish",
    );

    // Both reach terminal for real, through the key's own access.
    const runStatus = (runId) => readRun(teamClient, runId);
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
  await nativeHost.recordFailure({
    diagnostic: `${root}.botanical/workflow-reviews/native-mcp-workflows-${runtime}.log`,
    description: "Native MCP Workflow proof failed",
  });
  throw cause;
} finally {
  await nativeHost.close();
}
