import { labComputer } from "./lab-computer.fixture.mjs";
import {
  nativeWorkflowRoot,
  nativeAppClient,
  until,
} from "./workflow-native.fixture.mjs";
import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
import process from "node:process";
import { log } from "node:console";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";

import { mkdir, readFile, writeFile } from "node:fs/promises";

import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { probeDeclaration } from "./workflow-probe/declaration.ts";

import { packRelease, installRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend as workflowsBackend } from "../../../../apps/trellis/backend/methods.ts";
import workflowsMetadata from "../../../../apps/trellis/package.json" with { type: "json" };
import { appBackend as bonsaiBackend } from "../../../../apps/bonsai/backend/methods.ts";
import bonsaiMetadata from "../../../../apps/bonsai/package.json" with { type: "json" };
import { appBackend as shedBackend } from "../../../../apps/shed/backend/methods.ts";
import shedMetadata from "../../../../apps/shed/package.json" with { type: "json" };
import { appBackend as chatBackend } from "../../../../apps/grove/backend/methods.ts";
import chatMetadata from "../../../../apps/grove/package.json" with { type: "json" };
const workflowsDeclaration = buildAppDeclaration(
  workflowsBackend,
  workflowsMetadata.fungi.app,
);
const bonsaiDeclaration = buildAppDeclaration(
  bonsaiBackend,
  bonsaiMetadata.fungi.app,
);
const shedDeclaration = buildAppDeclaration(
  shedBackend,
  shedMetadata.fungi.app,
);
const chatDeclaration = buildAppDeclaration(
  chatBackend,
  chatMetadata.fungi.app,
);

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));

// Releases and per-App artifacts are separate resources in this isolated proof.

// wrangler.celld.jsonc has no AI binding (unneeded until this proof's Agent
// Sessions); wrangler.jsonc's real preview config declares exactly this, so
// mirror it here rather than editing the shared celld config for one proof.

// Shed's real exec (the checks template's "tests" node) needs a real
// Computer process backend, the same fixture contract as
// shed-terminal-proof.mjs and storyboard.native.mjs: a private, mode-0600
// env file naming an already-running on-box lab VM (owned and torn down by
// whoever stood it up, never this script). Optional: with no
// OYSTER_PROOF_ENV_FILE, every scenario that never dispatches to Shed still
// runs; the checks-template run then fails for the known, pre-existing
// reason (no Computer backend attached) rather than being silently skipped.

// The lab vmd's /ws callback targets a fixed worker slot port baked into
// its own config at bring-up (COMPUTER_PROOF_PORT in the fixture), not
// whatever free port this script happens to pick -- picking our own means
// the guest's /ws upgrade can never reach this Worker.

// The seeded tenant lives at an HTTPS origin. Wrangler presents loopback
// requests to the Worker at that origin, as TLS termination does in production.

const gitEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  ),
  GIT_TERMINAL_PROMPT: "0",
};
// The Git step proof runs Git natively: a supplied lab VM, otherwise the
// local Computer platform container on this box.
const labVm = await labComputer({ required: false });
const nativeHost = await nativeWorkflowRoot({
  root,
  prefix: "workflows-native-",
  main: "workflows-root.fixture.ts",
  artifactBucket: "workflow-proof-app-artifacts",
  computer: labVm ?? "platform-container",
  ai: true,
});
const { work, runtime, tenantOrigin, key, origin, auth } = nativeHost;

const { publish, call, persistBytes, install, installFirstParty, approve } =
  nativeAppClient(origin, auth, { key });

/** The production MCP route controls the same runs as the installed App. */
async function proveWorkflowMcp(completedRunId, pendingRunId) {
  const client = new Client(
    { name: "Workflow control parity", version: "1" },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler("elicitation/create", () => ({
    action: "accept",
    content: { approve: true },
  }));
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    {
      requestInit: { headers: auth },
    },
  );
  await client.connect(transport);
  try {
    const execute = async (code) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return JSON.stringify(result.content);
    };
    assert.match(
      await execute('return await forage.describe({path: "workflows.status"})'),
      /runId/u,
    );
    await execute(`
      const result = await env.workflows.status({runId: ${JSON.stringify(completedRunId)}});
      if (result.kind !== "found" || result.snapshot.runId !== ${JSON.stringify(completedRunId)})
        throw new Error("MCP did not observe the App's completed run");
      const completed = await env.workflows.cancel({runId: ${JSON.stringify(completedRunId)}});
      if (completed.kind !== "terminal") throw new Error("Completed cancellation was not terminal");
      return result;
    `);
    await execute(`
      const input = {runId: ${JSON.stringify(pendingRunId)}};
      const first = await env.workflows.cancel(input);
      if (first.kind !== "cancelled") throw new Error("MCP did not cancel the active App run");
      const replay = await env.workflows.cancel(input);
      if (replay.kind !== "terminal") throw new Error("Cancellation replay was not terminal");
      const status = await env.workflows.status(input);
      if (status.kind !== "found" || status.snapshot.outcome !== "cancelled")
        throw new Error("MCP cancellation was not visible at the run owner");
      return status;
    `);
  } finally {
    try {
      await transport.terminateSession();
    } finally {
      await client.close();
    }
  }
}
let reviewServer;
let reviewBrowser;
async function answerInRunView(runId, workflowId, approved, reviewedValue) {
  if (!reviewServer) {
    const { createServer: createViteServer } = await import("vite");
    const { chromium } = await import("playwright");
    reviewServer = await createViteServer({
      root: fileURLToPath(
        new URL("../../../../apps/trellis/", import.meta.url),
      ),
      server: { host: "127.0.0.1", port: 0 },
    });
    await reviewServer.listen();
    reviewBrowser = await chromium.launch();
  }
  const width = approved ? 1440 : 390;
  const page = await reviewBrowser.newPage({
    viewport: { width, height: 960 },
  });
  const requests = [];
  const pageErrors = [];
  page.on("pageerror", (cause) => pageErrors.push(cause.message));
  await page.route("**/standalone-review-rpc/*", (route) => {
    const request = route.request();
    const method = new URL(request.url()).pathname.split("/").at(-1);
    const operation = (async () => {
      const reply = await call("trellis", method, request.postDataJSON());
      await route.fulfill({ json: reply });
    })();
    requests.push(operation);
    return operation;
  });
  const proof = await Promise.allSettled([
    (async () => {
      const { expect } = await import("playwright/test");
      const target = new URL(
        "test/standalone-review.html",
        reviewServer.resolvedUrls.local[0],
      );
      target.searchParams.set("runId", runId);
      target.searchParams.set("workflowId", workflowId);
      await page.goto(target.href);
      await page.evaluate(
        async (theme) => {
          globalThis.document.documentElement.dataset.theme = theme;
          await globalThis.document.fonts.ready;
        },
        approved ? "latte" : "mocha",
      );
      await expect(
        page.getByRole("heading", { name: "Approve this result" }),
      ).toBeVisible();
      await expect(page.locator('[aria-label="Review"] pre')).toContainText(
        reviewedValue.title,
      );
      await expect(page.locator('[aria-label="Review"] pre')).toContainText(
        reviewedValue.summary,
      );
      await expect(page.locator(".wf-run-canvas")).toBeVisible();
      await expect(
        page.getByText("Workflow input", { exact: true }),
      ).toBeVisible();
      const evidence =
        process.env.WORKFLOW_REVIEW_EVIDENCE ??
        `${root}.botanical/workflow-reviews/shots`;
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: `${evidence}/pending-${width}.png`,
        fullPage: true,
      });
      const reply = page.waitForResponse((response) =>
        response.url().endsWith("/answerReview"),
      );
      await page
        .getByRole("button", {
          name: approved ? "Approve" : "Reject",
          exact: true,
        })
        .click();
      assert.deepEqual(await (await reply).json(), { result: "accepted" });
      await expect(
        page.getByRole("heading", { name: "Approve this result" }),
      ).toHaveCount(0);
      await expect(
        page
          .locator(".wf-run-detail > header")
          .getByText("complete", { exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.wf-run-canvas [data-state="complete"]'),
      ).toBeVisible();
      await expect(
        page.locator('[aria-label="Steps"] [data-state="complete"]'),
      ).toBeVisible();
      await expect(page.locator(".wf-run-choice")).toContainText("complete");
      await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
      await expect(page.locator('[aria-label="Steps"]')).toContainText(
        approved ? "Approved" : "Rejected",
      );
      await expect(page.locator('[aria-label="Steps"] pre')).toContainText(
        reviewedValue.title,
      );
      await expect(page.locator(".wf-graph-result pre")).toContainText(
        reviewedValue.title,
      );
      await expect(
        page.getByText("No output was recorded for this step.", {
          exact: true,
        }),
      ).toHaveCount(0);
      await page.screenshot({
        path: `${evidence}/answered-${width}.png`,
        fullPage: true,
      });
      assert.deepEqual(pageErrors, []);
    })(),
  ]);
  const unrouted = await Promise.allSettled([
    page.unrouteAll({ behavior: "wait" }),
  ]);
  const cleanup = await Promise.allSettled([page.close(), ...requests]);
  const failures = [...proof, ...unrouted, ...cleanup]
    .filter((outcome) => outcome.status === "rejected")
    .map((outcome) => outcome.reason);
  if (failures.length !== 0)
    throw new AggregateError(
      failures,
      "Standalone review browser proof failed",
    );
}

// Agent management is a host capability route (packages/oyster/src/host.ts):
// it requires an X-Oyster-Installation naming an installation whose OWN
// declaration includes agent.manage/agent.read/agent.send. "chat" (Grove)
// is installed below for exactly this -- see its install() call.
const capabilityAuth = { ...auth, "X-Oyster-Installation": "chat" };
/** The owner's generic Agent + Session creation, as Grove's own routes do it. */
async function createAgent(name, requestId) {
  const response = await globalThis.fetch(`${origin}/agents`, {
    method: "POST",
    headers: { ...capabilityAuth, "Content-Type": "application/json" },
    body: JSON.stringify({ name, requestId }),
  });
  // packages/oyster/src/agents.ts's POST /agents replies with a plain
  // Response.json (no status override), so 200 -- unlike session creation
  // below, which explicitly replies 201.
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}
async function createAgentSession(agentId, requestId) {
  const response = await globalThis.fetch(
    `${origin}/agents/${agentId}/sessions`,
    {
      method: "POST",
      headers: { ...capabilityAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text);
}
/** A user-set title, so the Session carries a recognizable name into the Inbox. */
async function titleAgentSession(agentId, sessionId, title) {
  const response = await globalThis.fetch(
    `${origin}/agents/${agentId}/sessions/${sessionId}/command`,
    {
      method: "POST",
      headers: { ...capabilityAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ command: { type: "title", title } }),
    },
  );
  assert.equal(response.status, 204, await response.text());
}
async function readAgentSession(agentId, sessionId) {
  const response = await globalThis.fetch(
    `${origin}/agents/${agentId}/sessions/${sessionId}`,
    { headers: capabilityAuth },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}
const stepFailures = [];
let allStepsAttempted = false;
async function step(name, body) {
  try {
    await body();
    log(
      JSON.stringify({
        proof: "standalone-workflow-step",
        step: name,
        status: "passed",
      }),
    );
  } catch (cause) {
    stepFailures.push({ name, cause });
    log(
      JSON.stringify({
        proof: "standalone-workflow-step",
        step: name,
        status: "failed",
      }),
    );
  }
}
const status = (runId) => call("trellis", "runStatus", { runId });
const stamps = () => call("probe", "stamps", {});
// Git runs asynchronously so the Worker's piped logs keep draining.
const gitRunIn = async (env, ...args) => {
  const child = spawn("git", ["-C", `${work}/checkout`, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    text += chunk;
  });
  const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 60_000);
  const status = await new Promise((resolve) => child.once("exit", resolve));
  globalThis.clearTimeout(timer);
  return { status, text: text.replaceAll(key, "[key]") };
};
const gitRun = (...args) => gitRunIn(gitEnvironment, ...args);
const git = async (...args) => {
  const { status, text } = await gitRun(...args);
  assert.equal(status, 0, text);
};
try {
  await nativeHost.ready();
  await install(
    "probe",
    new URL("./workflow-probe/index.fixture.ts", import.meta.url),
    "WorkflowProbe",
    probeDeclaration,
  );
  // Installing is not consent: the owner approves each App's declared grants.
  await approve("probe");
  // The real built UI, so this one installation is also the Tourtois-embedded
  // App the browser proof below opens — not a second, UI-less copy.
  const workflowsUi = {
    ...(await persistBytes(
      await readFile(
        fileURLToPath(
          new URL("../../../../apps/trellis/dist/index.html", import.meta.url),
        ),
      ),
    )),
    mediaType: "text/html; charset=utf-8",
  };
  await installFirstParty("trellis", workflowsDeclaration, workflowsUi);
  await approve("trellis");
  await install(
    "other",
    new URL("../../../../apps/trellis/backend/index.ts", import.meta.url),
    "Trellis",
    workflowsDeclaration,
  );
  const catalog = await call("trellis", "catalog", {});
  const selected = catalog.apps.find((item) => item.installationId === "probe");
  assert.ok(
    selected,
    "real installed probe is visible in the Workflow catalog",
  );
  const reviewedValue = {
    title: "Lanterns after rain",
    summary:
      "A traveler crosses the lantern-lit garden. A bird lifts from the wet branches, then the traveler finds the light waiting at home.",
  };
  const reviewDefinition = {
    format: "fungi.workflow/v1",
    title: "Standalone human review",
    apps: {},
    input: {
      type: "object",
      properties: {
        proposal: {
          type: "object",
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
          },
          required: ["title", "summary"],
          additionalProperties: false,
        },
      },
      required: ["proposal"],
      additionalProperties: false,
    },
    nodes: [
      {
        id: "look",
        kind: "review",
        title: "Approve this result",
        show: [{ node: "$input", port: "proposal" }],
        reviewers: "runner",
        timeout: 60_000,
      },
    ],
    edges: [],
    output: {
      reviewed: { node: "look", port: "approved" },
      choice: { node: "look", port: "choice" },
      note: { node: "look", port: "note" },
    },
  };
  for (const approved of [true, false]) {
    await step(`review-${approved ? "approve" : "reject"}`, async () => {
      const reviewDraft = await call("trellis", "saveDraft", {
        workflowId: `review-${approved ? "approve" : "reject"}-proof`,
        expectedRevision: 0,
        draft: {
          definition: {
            ...reviewDefinition,
            output: {
              ...reviewDefinition.output,
              reviewed: {
                node: "look",
                port: approved ? "approved" : "rejected",
              },
            },
          },
          layout: {},
        },
      });
      assert.equal(reviewDraft.kind, "saved");
      const reviewPublished = await publish(
        `review-${approved ? "approve" : "reject"}-proof`,
        reviewDraft.revision,
      );
      assert.equal(reviewPublished.kind, "published");
      const reviewStarted = await call("trellis", "runWorkflow", {
        workflowId: `review-${approved ? "approve" : "reject"}-proof`,
        commit: reviewPublished.commit,
        requestId: `review-owner-${approved ? "approve" : "reject"}`,
        bindings: {},
        input: { proposal: reviewedValue },
      });
      assert.equal(reviewStarted.kind, "started");
      const reviewStatus = () =>
        call("trellis", "runStatus", { runId: reviewStarted.runId });
      const waitingReview = await until(
        reviewStatus,
        (value) => {
          assert.notEqual(value.status, "errored", JSON.stringify(value));
          return (
            value.reviews.some((row) => row.status === "pending") &&
            value.events.some(
              (event) => event.nodeId === "look" && event.state === "waiting",
            )
          );
        },
        "standalone review waiting",
      );
      assert.equal(waitingReview.reviews.length, 1);
      if (process.env.OYSTER_REVIEW_VISUALS === "1") {
        await answerInRunView(
          reviewStarted.runId,
          `review-${approved ? "approve" : "reject"}-proof`,
          approved,
          reviewedValue,
        );
      } else {
        assert.deepEqual(
          await call("trellis", "answerReview", {
            runId: reviewStarted.runId,
            nodeId: "look",
            iteration: "0",
            answer: { approved },
          }),
          { result: "accepted" },
        );
      }
      const reviewCompleted = await until(
        reviewStatus,
        (value) => {
          assert.notEqual(value.status, "errored", JSON.stringify(value));
          return value.status === "complete";
        },
        `standalone review resumes on ${approved ? "approval" : "rejection"}`,
      );
      assert.deepEqual(reviewCompleted.output, {
        reviewed: reviewedValue,
        choice: approved ? "approved" : "rejected",
        note: "",
      });
      assert.equal(reviewCompleted.reviews[0].status, "delivered");
    });
  }
  await step("pending-replay-cancel-isolation-mcp", async () => {
    const definition = {
      format: "fungi.workflow/v1",
      title: "Standalone Pending proof",
      apps: { probe: { appId: "app_probe", role: "probe" } },
      input: {
        type: "object",
        properties: { wait: { type: "boolean" } },
        required: ["wait"],
        additionalProperties: false,
      },
      nodes: [
        {
          id: "poll",
          kind: "app",
          app: "probe",
          method: "poll",
          methodDigest: selected.methods.poll.digest,
          values: {
            text: { literal: "published on standalone" },
            wait: { from: { node: "$input", port: "wait" } },
          },
        },
      ],
      edges: [],
      output: {
        text: { node: "poll", port: "text" },
        calls: { node: "poll", port: "calls" },
        keys: { node: "poll", port: "keys" },
      },
    };
    const draft = await call("trellis", "saveDraft", {
      workflowId: "pending",
      expectedRevision: 0,
      draft: { definition, layout: {} },
    });
    assert.equal(draft.kind, "saved", JSON.stringify(draft));
    const request = {
      workflowId: "pending",
      version: 1,
      requestId: "success",
      bindings: { probe: "probe" },
      input: { wait: false },
    };
    assert.deepEqual(await call("trellis", "runWorkflow", request), {
      error: "not_found",
    });
    const published = await publish("pending", draft.revision);
    assert.equal(published.kind, "published", JSON.stringify(published));
    const started = await call("trellis", "runWorkflow", request);
    assert.equal(started.kind, "started", JSON.stringify(started));
    const installations = await (
      await globalThis.fetch(`${origin}/api/installations`, { headers: auth })
    ).json();
    const current = installations.find(
      (row) => row.installationId === "trellis",
    );
    assert.ok(current);
    const reapproval = await (
      await globalThis.fetch(origin + "/api/installations/trellis/grants", {
        headers: { ...auth, Accept: "application/json" },
      })
    ).json();
    const reapproved = await globalThis.fetch(
      `${origin}/api/installations/trellis/grants`,
      {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          storeGeneration: reapproval.storeGeneration,
          authorityVersion: reapproval.permissions.authority.authorityVersion,
          artifactDigest: current.release.artifact.artifactDigest,
          command: {
            kind: "change-grants",
            changes: reapproval.permissions.declaredOperations.capabilities.map(
              ({ capability, operations }) => ({
                capability,
                grant: { operations, resources: "tenant-scope" },
              }),
            ),
          },
        }),
      },
    );
    assert.equal(reapproved.status, 200, await reapproved.text());
    const completed = await until(
      () => status(started.runId),
      (value) => {
        assert.notEqual(value.status, "errored", JSON.stringify(value));
        return value.status === "complete";
      },
      "completed Pending run",
    );
    assert.equal(completed.outcome, "terminal");
    assert.equal(completed.output.text, "published on standalone");
    assert.equal(completed.output.calls, 3);
    assert.equal(
      new Set(completed.output.keys).size,
      1,
      "polls reuse a stable App call key",
    );
    assert.deepEqual(
      completed.events
        .filter((event) => event.state === "running")
        .map((event) => event.poll),
      [0, 1, 2],
    );
    assert.deepEqual(
      completed.events
        .filter((event) => event.state === "waiting")
        .map((event) => event.poll),
      [0, 1],
    );
    const counts = await call("probe", "counts", {});
    assert.equal(
      (await call("trellis", "runWorkflow", request)).kind,
      "replay",
    );
    assert.deepEqual(
      await call("probe", "counts", {}),
      counts,
      "replay cannot re-execute completed App calls",
    );
    assert.deepEqual(
      await call("trellis", "cancel", { runId: started.runId }),
      {
        kind: "terminal",
      },
    );
    assert.deepEqual(
      await call("other", "runStatus", { runId: started.runId }),
      {
        error: "not_found",
      },
    );
    assert.deepEqual(await call("other", "cancel", { runId: started.runId }), {
      kind: "refused",
      reason: "denied",
    });
    const pending = await call("trellis", "runWorkflow", {
      ...request,
      requestId: "cancel",
      input: { wait: true },
    });
    assert.equal(pending.kind, "started");
    await until(
      () => status(pending.runId),
      (value) => value.events.some((event) => event.state === "waiting"),
      "Pending before cancel",
    );
    await proveWorkflowMcp(started.runId, pending.runId);
    assert.deepEqual(
      await call("trellis", "cancel", { runId: pending.runId }),
      {
        kind: "terminal",
      },
    );
    const afterCancel = await call("probe", "counts", {});
    await delay(2200);
    assert.deepEqual(
      await call("probe", "counts", {}),
      afterCancel,
      "terminated instance cannot poll again",
    );
    const cancelled = await status(pending.runId);
    assert.equal(cancelled.outcome, "cancelled");
    assert.equal(cancelled.output, null);
    assert.ok(!cancelled.events.some((event) => event.state === "complete"));
  });
  await step("code-replay", async () => {
    const names = { type: "array", items: { type: "string" }, maxItems: 50 };
    const codeDefinition = {
      format: "fungi.workflow/v1",
      title: "Standalone Code proof",
      apps: {},
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
      ],
      edges: [],
      output: { names: { node: "trim", port: "value" } },
    };
    const codeDraft = await call("trellis", "saveDraft", {
      workflowId: "code",
      expectedRevision: 0,
      draft: { definition: codeDefinition, layout: {} },
    });
    assert.equal(codeDraft.kind, "saved", JSON.stringify(codeDraft));
    const codePublished = await publish("code", codeDraft.revision);
    assert.equal(
      codePublished.kind,
      "published",
      JSON.stringify(codePublished),
    );
    const codeRequest = {
      workflowId: "code",
      commit: codePublished.commit,
      requestId: "code-success",
      bindings: {},
      input: { names: [" Garden ", " Moss "] },
    };
    const codeStarted = await call("trellis", "runWorkflow", codeRequest);
    assert.equal(codeStarted.kind, "started", JSON.stringify(codeStarted));
    const codeCompleted = await until(
      () => status(codeStarted.runId),
      (value) => {
        assert.notEqual(value.status, "errored", JSON.stringify(value));
        return value.status === "complete";
      },
      "published Code completion",
    );
    assert.deepEqual(codeCompleted.output, { names: ["Garden", "Moss"] });
    assert.equal(codeCompleted.outcome, "terminal");
    assert.equal(
      (await call("trellis", "runWorkflow", codeRequest)).kind,
      "replay",
    );
    assert.deepEqual(
      (await status(codeStarted.runId)).events,
      codeCompleted.events,
    );
  });
  await step("schedule-fire-drift-rearm-disarm", async () => {
    // Scheduled triggers fire from the host alarm as the arming owner, pause on
    // installation drift, recover on re-arm and stop on disarm.
    const scheduledDraft = await call("trellis", "saveDraft", {
      workflowId: "scheduled",
      expectedRevision: 0,
      draft: {
        definition: {
          format: "fungi.workflow/v1",
          title: "Standalone schedule proof",
          apps: { probe: { appId: "app_probe", role: "probe" } },
          input: {
            type: "object",
            properties: {
              scheduledAt: { type: "string" },
              eventId: { type: "string" },
            },
            required: ["scheduledAt", "eventId"],
            additionalProperties: false,
          },
          nodes: [
            {
              id: "stamp",
              kind: "app",
              app: "probe",
              method: "stamp",
              methodDigest: selected.methods.stamp.digest,
              values: { at: { from: { node: "$input", port: "scheduledAt" } } },
            },
          ],
          edges: [],
          output: { at: { node: "stamp", port: "at" } },
          triggers: [
            {
              id: "clock",
              on: "schedule",
              cron: { expression: "*/5 * * * *", timeZone: "UTC" },
            },
          ],
        },
        layout: {},
      },
    });
    assert.equal(scheduledDraft.kind, "saved", JSON.stringify(scheduledDraft));
    const scheduledPublished = await publish(
      "scheduled",
      scheduledDraft.revision,
    );
    assert.equal(scheduledPublished.kind, "published");
    const scheduleTarget = {
      workflowId: "scheduled",
      commit: scheduledPublished.commit,
      triggerId: "clock",
      bindings: { probe: "probe" },
    };
    const triggers = async (scheduleId) =>
      (await call("trellis", "listTriggers", {})).schedules.find(
        (row) => row.scheduleId === scheduleId,
      );
    assert.deepEqual(await stamps(), []);
    const armed = await call("trellis", "arm", scheduleTarget);
    assert.equal(armed.kind, "armed", JSON.stringify(armed));
    const fired = await until(
      stamps,
      (rows) => rows.length >= 2,
      "two scheduled deliveries from the host alarm",
    );
    for (const row of fired) {
      const caller = JSON.parse(row.caller);
      assert.equal(caller.actor.kind, "member");
      assert.equal(caller.workflow.workflowId, "scheduled");
      assert.deepEqual(caller.workflow.armedBy, caller.actor);
    }
    assert.equal(new Set(fired.map((row) => row.at)).size, fired.length);
    assert.deepEqual(
      { ...(await triggers(armed.scheduleId)), nextDueAt: 0 },
      {
        scheduleId: armed.scheduleId,
        installationId: "trellis",
        workflowId: "scheduled",
        triggerId: "clock",
        nextDueAt: 0,
        state: "active",
        lastError: null,
      },
    );
    const settled = async (label) => {
      // A run admitted just before a state change may still finish.
      await delay(5000);
      const before = (await stamps()).length;
      await delay(5000);
      assert.equal((await stamps()).length, before, label);
    };
    const library = (
      await (
        await globalThis.fetch(`${origin}/api/installations`, { headers: auth })
      ).json()
    ).find((row) => row.installationId === "trellis");
    const drift = await (
      await globalThis.fetch(origin + "/api/installations/trellis/grants", {
        headers: { ...auth, Accept: "application/json" },
      })
    ).json();
    const drifted = await globalThis.fetch(
      `${origin}/api/installations/trellis/grants`,
      {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          storeGeneration: drift.storeGeneration,
          authorityVersion: drift.permissions.authority.authorityVersion,
          artifactDigest: library.release.artifact.artifactDigest,
          command: {
            kind: "change-grants",
            changes: drift.permissions.declaredOperations.capabilities.map(
              ({ capability, operations }) => ({
                capability,
                grant: { operations, resources: "tenant-scope" },
              }),
            ),
          },
        }),
      },
    );
    assert.equal(drifted.status, 200, await drifted.text());
    const paused = await until(
      () => triggers(armed.scheduleId),
      (row) => row?.state === "paused",
      "installation drift pauses the armed schedule",
    );
    assert.equal(
      paused.lastError,
      "The Workflows installation changed; re-arm this trigger",
    );
    await settled("a paused schedule never fires");
    const beforeRearm = (await stamps()).length;
    assert.deepEqual(await call("trellis", "arm", scheduleTarget), armed);
    await until(
      stamps,
      (rows) => rows.length > beforeRearm,
      "the re-armed schedule fires on the current installation",
    );
    assert.deepEqual(
      await call("trellis", "disarm", { scheduleId: armed.scheduleId }),
      { kind: "disarmed" },
    );
    assert.equal((await triggers(armed.scheduleId)).state, "cancelled");
    await settled("a disarmed schedule never fires");
  });
  await step("bonsai-push-event", async () => {
    // A real Bonsai push on this root starts the Workflow armed on git.push.
    await installFirstParty("bonsai", bonsaiDeclaration);
    await approve("bonsai");
    await call("bonsai", "repos.create", { name: "pond" });
    const bonsaiCatalog = (await call("trellis", "catalog", {})).apps.find(
      (item) => item.installationId === "bonsai",
    );
    assert.ok(
      bonsaiCatalog?.events?.["git.push"],
      "the standalone catalog lists Bonsai's declared git.push event",
    );
    const pushedDraft = await call("trellis", "saveDraft", {
      workflowId: "pushed",
      expectedRevision: 0,
      draft: {
        definition: {
          format: "fungi.workflow/v1",
          title: "Standalone push proof",
          apps: {
            bonsai: { appId: "app_bonsai" },
            probe: { appId: "app_probe", role: "probe" },
          },
          input: {
            type: "object",
            properties: { repository: { type: "string" } },
            required: ["repository"],
            additionalProperties: false,
          },
          nodes: [
            {
              id: "stamp",
              kind: "app",
              app: "probe",
              method: "stamp",
              methodDigest: selected.methods.stamp.digest,
              values: { at: { from: { node: "$input", port: "repository" } } },
            },
          ],
          edges: [],
          output: { at: { node: "stamp", port: "at" } },
          triggers: [
            {
              id: "pushed",
              on: "event",
              app: "bonsai",
              event: "git.push",
              eventDigest: bonsaiCatalog.events["git.push"].digest,
              input: {
                repository: {
                  from: { node: "$input", port: "payload" },
                  path: "/data/repository/name",
                },
              },
            },
          ],
        },
        layout: {},
      },
    });
    assert.equal(pushedDraft.kind, "saved", JSON.stringify(pushedDraft));
    const pushedPublished = await publish("pushed", pushedDraft.revision);
    assert.equal(pushedPublished.kind, "published");
    const eventArmed = await call("trellis", "armEventTrigger", {
      workflowId: "pushed",
      commit: pushedPublished.commit,
      triggerId: "pushed",
      bindings: { bonsai: "bonsai", probe: "probe" },
    });
    assert.equal(eventArmed.kind, "armed", JSON.stringify(eventArmed));
    const pushedStamps = async () =>
      (await stamps()).filter(
        (row) => JSON.parse(row.caller).workflow.workflowId === "pushed",
      );
    assert.deepEqual(await pushedStamps(), []);
    await mkdir(`${work}/checkout`);
    await git("init", "-q", "-b", "main");
    await writeFile(`${work}/checkout/hello.txt`, "hello\n");
    await git("add", "hello.txt");
    await git(
      "-c",
      "user.name=Owner",
      "-c",
      "user.email=owner@test.invalid",
      "commit",
      "-qm",
      "Start pond",
    );
    await git(
      "-c",
      `http.extraHeader=Authorization: Bearer ${key}`,
      "push",
      `${origin}/git/bonsai/pond.git`,
      "main",
    );
    const delivered = await until(
      pushedStamps,
      (rows) => rows.length === 1,
      "the Bonsai push starts the armed Workflow",
    );
    assert.equal(delivered[0].at, "pond");
    const pushCaller = JSON.parse(delivered[0].caller);
    assert.equal(pushCaller.actor.kind, "member");
    assert.deepEqual(pushCaller.workflow.armedBy, pushCaller.actor);
    const listedEvents = await call("trellis", "eventTriggers", {});
    assert.deepEqual(
      listedEvents.eventTriggers.map((row) => [row.workflowId, row.state]),
      [["pushed", "active"]],
    );
    assert.deepEqual(
      await call("trellis", "disarmEventTrigger", {
        eventTriggerId: eventArmed.eventTriggerId,
      }),
      { kind: "disarmed" },
    );
  });
  await step("workflow-git-native-carriage-and-close", async () => {
    // A published Git step's native commands receive a credential for its
    // declared branch only, and only while each command runs.
    const saverDraft = await call("trellis", "saveDraft", {
      workflowId: "saver",
      expectedRevision: 0,
      draft: {
        definition: {
          format: "fungi.workflow/v1",
          title: "Standalone Git step proof",
          apps: {
            probe: { appId: "app_probe", role: "probe" },
            bonsai: { appId: "app_bonsai" },
          },
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          nodes: [
            {
              id: "save",
              kind: "app",
              app: "probe",
              method: "save",
              methodDigest: selected.methods.save.digest,
              values: {},
              gitAccess: {
                binding: "bonsai",
                repository: "pond",
                branches: ["refs/heads/storyboards"],
              },
            },
            {
              id: "hold",
              kind: "app",
              app: "probe",
              method: "poll",
              methodDigest: selected.methods.poll.digest,
              values: {
                text: { literal: "holding the run open" },
                wait: { from: { node: "save", port: "saved" } },
              },
            },
          ],
          edges: [],
          output: { text: { node: "hold", port: "text" } },
          triggers: [
            {
              id: "clock",
              on: "schedule",
              cron: { expression: "*/5 * * * *", timeZone: "UTC" },
            },
          ],
        },
        layout: {},
      },
    });
    assert.equal(saverDraft.kind, "saved", JSON.stringify(saverDraft));
    const saverPublished = await publish("saver", saverDraft.revision);
    assert.equal(saverPublished.kind, "published");
    // Arming a trigger on a Workflow with a Git step mints that step's pass
    // through this host's existing Workflow Git pass store (B-4/W-2): the
    // stale stub used to refuse every such arm with a misleading "You do not
    // have Git write access" denial.
    const saverArmed = await call("trellis", "arm", {
      workflowId: "saver",
      commit: saverPublished.commit,
      triggerId: "clock",
      bindings: { probe: "probe", bonsai: "bonsai" },
    });
    assert.equal(saverArmed.kind, "armed", JSON.stringify(saverArmed));
    assert.deepEqual(
      await call("trellis", "disarm", {
        scheduleId: saverArmed.scheduleId,
      }),
      { kind: "disarmed" },
    );
    const saving = await call("trellis", "runWorkflow", {
      workflowId: "saver",
      commit: saverPublished.commit,
      requestId: "save-once",
      bindings: { probe: "probe", bonsai: "bonsai" },
      input: {},
    });
    assert.equal(saving.kind, "started", JSON.stringify(saving));
    const [save] = await until(
      () => call("probe", "saves", {}),
      (rows) => rows.length === 1,
      "the Git step's native commands report their pushes",
    );
    // Each native command carried its own credential, only for its branch.
    assert.notEqual(save.outside, 0, "the credential is scoped to its branch");
    assert.equal(save.saved, 0, "the Git step pushes its granted branch");
    // Bonsai observes the accepted push through its own push lifecycle.
    const storyboards = async () =>
      (await call("bonsai", "repos.get", { repo: "pond" })).refs.find((ref) =>
        ref.name.endsWith("storyboards"),
      )?.hash;
    const savedHash = await until(
      storyboards,
      (hash) => hash !== undefined,
      "the Save step's branch lands in Bonsai",
    );
    // The step's App call has returned; its still-live child process keeps
    // its own credential and pushes again.
    await until(
      storyboards,
      (hash) => hash !== undefined && hash !== savedHash,
      "a live child pushes after its App call returned",
    );
    // The ordinary remote alone grants nothing.
    const pondRemote = new URL(
      new URL(`${tenantOrigin}/git/bonsai/pond.git`).pathname,
      origin,
    );
    const anonymous = await gitRun(
      "push",
      pondRemote.href,
      "HEAD:refs/heads/storyboards",
    );
    assert.notEqual(anonymous.status, 0, "the remote alone grants nothing");
    assert.deepEqual(await call("trellis", "cancel", { runId: saving.runId }), {
      kind: "cancelled",
    });
    // No credential reached probe storage, host Git output or the Worker log.
    const credential = /wgp\.[^.\s]+\.[0-9a-f]{64}/u;
    for (const [where, text] of [
      ["probe storage", JSON.stringify(await call("probe", "saves", {}))],
      ["git output", anonymous.text],
      ["Worker log", nativeHost.output()],
    ])
      assert.doesNotMatch(text, credential, `credential leaked into ${where}`);
    if (runtime === "workerd")
      assert.ok(
        nativeHost
          .output()
          .includes("CPU limits are not enforced in local dev"),
      );
  });
  // ---- Browser-driven UI proof: the real "trellis" installation, opened
  // ---- as a Tourtois-embedded App (not the vite standalone-review harness
  // ---- above). Templates -> Publish, Triggers arm on a real Bonsai Change,
  // ---- Runs badges/Started-by, Fork-as-draft, and Agent delivery.
  const templateWorkflowId = "bonsai-checks-1";
  await install(
    "shed",
    new URL("../../../../apps/shed/backend/index.ts", import.meta.url),
    "Shed",
    shedDeclaration,
  );
  // Agent management is a host capability route gated on the calling
  // installation's OWN declared capabilities (packages/oyster/src/apps/
  // gate.ts's "capability-route" admission); "chat" (Grove) is the real App
  // that declares agent.manage, so it is the real installation to call it
  // through, not a fixture -- the demo Team runs with Grove installed too.
  await install(
    "chat",
    new URL("../../../../apps/grove/backend/index.ts", import.meta.url),
    "Grove",
    chatDeclaration,
  );
  const agent = await createAgent("Report chat", "ui-report-agent");
  const session = await createAgentSession(agent.agentId, "ui-report-session");
  await titleAgentSession(
    agent.agentId,
    session.sessionId,
    "Workflow report chat",
  );
  const delivery = { agentId: agent.agentId, sessionId: session.sessionId };
  const followUpReaches = (runId) =>
    until(
      () => readAgentSession(agent.agentId, session.sessionId),
      (read) => JSON.stringify(read).includes(`run ${runId})`),
      `the run ${runId}'s follow-up reaches the report chat`,
    );
  await step("ui-report-publication", async () => {
    // A tiny, App-free workflow so the UI's Fork/Run/Agent-delivery path is
    // provable with no Bonsai or Shed execution in the loop.
    const uiReportDraft = await call("trellis", "saveDraft", {
      workflowId: "ui-report",
      expectedRevision: 0,
      draft: {
        definition: {
          format: "fungi.workflow/v1",
          title: "UI report proof",
          apps: {},
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          nodes: [
            {
              id: "stamp",
              kind: "code",
              input: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              output: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
                additionalProperties: false,
              },
              source: "return { ok: true };",
              values: {},
            },
          ],
          edges: [],
          output: { ok: { node: "stamp", port: "ok" } },
        },
        layout: {},
      },
    });
    assert.equal(uiReportDraft.kind, "saved", JSON.stringify(uiReportDraft));
    const uiReportPublished = await publish(
      "ui-report",
      uiReportDraft.revision,
    );
    assert.equal(uiReportPublished.kind, "published");
  });
  let scheduleRun;
  await step("agent-schedule-delivery", async () => {
    // A second, App-free workflow proves the schedule leg of Agent delivery
    // without depending on the Change/Shed path below.
    const uiScheduleDraft = await call("trellis", "saveDraft", {
      workflowId: "ui-schedule-report",
      expectedRevision: 0,
      draft: {
        definition: {
          format: "fungi.workflow/v1",
          title: "UI schedule report proof",
          apps: {},
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          nodes: [
            {
              id: "stamp",
              kind: "code",
              input: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              output: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
                additionalProperties: false,
              },
              source: "return { ok: true };",
              values: {},
            },
          ],
          edges: [],
          output: { ok: { node: "stamp", port: "ok" } },
          triggers: [
            {
              id: "clock",
              on: "schedule",
              cron: { expression: "*/5 * * * *", timeZone: "UTC" },
              // Without an explicit (even empty) input mapping, a schedule
              // trigger's run input defaults to {scheduledAt, eventId}
              // (packages/braid/src/triggers.ts), which this workflow's
              // strict empty input schema refuses on every real fire.
              input: {},
            },
          ],
        },
        layout: {},
      },
    });
    assert.equal(
      uiScheduleDraft.kind,
      "saved",
      JSON.stringify(uiScheduleDraft),
    );
    const uiSchedulePublished = await publish(
      "ui-schedule-report",
      uiScheduleDraft.revision,
    );
    assert.equal(uiSchedulePublished.kind, "published");
    const uiScheduleArmed = await call("trellis", "arm", {
      workflowId: "ui-schedule-report",
      commit: uiSchedulePublished.commit,
      triggerId: "clock",
      bindings: {},
      delivery,
    });
    assert.equal(
      uiScheduleArmed.kind,
      "armed",
      JSON.stringify(uiScheduleArmed),
    );
    try {
      scheduleRun = await until(
        () => call("trellis", "listRuns", { workflowId: "ui-schedule-report" }),
        (rows) => rows.length > 0,
        "the armed schedule starts ui-schedule-report",
      ).then((rows) => rows[0]);
    } catch (cause) {
      // A paused/refused schedule (e.g. its trigger input mapping disagrees
      // with the workflow's declared input) never shows up as a run; surface
      // its live state so a real failure here is diagnosable, not a bare
      // "stayed empty" timeout.
      const live = await call("trellis", "listTriggers", {});
      throw new Error(
        `ui-schedule-report never fired; live schedule state: ${JSON.stringify(live)}`,
        { cause },
      );
    }
    assert.equal(scheduleRun.source, "schedule");
    // ui-schedule-report is App-free: no Shed, no network step. A failure to
    // finish and report is a real regression, never a flaky external leg.
    let scheduleFailure;
    try {
      const scheduleStatus = await until(
        () => call("trellis", "runStatus", { runId: scheduleRun.runId }),
        (status) => status.outcome !== "active",
        "the scheduled run reaches a terminal outcome",
      );
      assert.equal(
        scheduleStatus.outcome,
        "terminal",
        JSON.stringify(scheduleStatus),
      );
      assert.deepEqual(scheduleStatus.output, { ok: true });
      await followUpReaches(scheduleRun.runId);
    } catch (cause) {
      // Record it for the finally's cleanup below, then rethrow immediately:
      // the finally still runs before this propagates, and this is itself the
      // real failure (never a silently swallowed one).
      scheduleFailure = cause;
      throw cause;
    } finally {
      // Ordinary cleanup: disarm regardless of the outcome above, but never let
      // a cleanup problem hide a real failure already captured from the try.
      await call("trellis", "disarm", {
        scheduleId: uiScheduleArmed.scheduleId,
      }).then(
        (result) => {
          if (scheduleFailure === undefined)
            assert.deepEqual(result, { kind: "disarmed" });
        },
        (cause) => {
          if (scheduleFailure === undefined) scheduleFailure = cause;
          else log(`Schedule disarm cleanup also failed: ${cause.message}`);
        },
      );
    }
    if (scheduleFailure !== undefined) throw scheduleFailure;
  });
  await step("trusted-home-release-and-consent", async () => {
    // Without a real "tourtois" home installation, "/" falls back to the bare
    // Oyster installation list (no Open Apps, no real App frame) -- the real
    // Tourtois shell UI is itself a packaged release, not a lightweight
    // esbuild bundle, so install it the same way tourtois-home.browser.mjs
    // does: a real packRelease from its own committed package manifest.
    const tourtoisRecipe = standaloneAppSet.find(
      (app) => app.installationId === "tourtois",
    );
    assert.ok(tourtoisRecipe, "the standalone app set declares tourtois");
    const tourtoisRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const tourtoisRelease = `${work}/tourtois-release`;
    await packRelease({
      appId: "app_tourtois",
      releaseId: "rel_tourtois",
      sourceDirectory: repository,
      sourceRevision: "git:" + tourtoisRevision,
      packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      recipe: committedAppRecipe(repository, tourtoisRecipe, tourtoisRevision),
      outDirectory: tourtoisRelease,
    });
    const tourtoisInstalled = await installRelease({
      url: origin,
      key,
      installationId: "tourtois",
      directory: tourtoisRelease,
    });
    assert.equal(tourtoisInstalled.status, 201, await tourtoisInstalled.text());
    const homeConfiguration = async () => {
      const response = await globalThis.fetch(`${origin}/apps/tourtois/`, {
        headers: { ...auth, Accept: "application/json" },
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal(
      (await homeConfiguration()).workbench,
      false,
      "installing the shell is not owner consent to its trusted host access",
    );
    await approve("tourtois");
    const approvedHome = await homeConfiguration();
    assert.equal(
      approvedHome.workbench,
      true,
      "the owner approved the trusted home shell",
    );
    assert.ok(
      approvedHome.shellModuleUrl,
      "the real home Release supplies its shell module",
    );
  });
  if (!reviewBrowser) {
    const { chromium } = await import("playwright");
    reviewBrowser = await chromium.launch();
  }
  const { expect: expectUi } = await import("playwright/test");
  const uiPage = await reviewBrowser.newPage({
    viewport: { width: 390, height: 844 },
  });
  const uiPageErrors = [];
  uiPage.on("pageerror", (cause) => uiPageErrors.push(cause.message));
  const workflowsPane = uiPage.locator(
    '.tourtois-app-pane[aria-label="Trellis"]',
  );
  const workflowsFrame = workflowsPane.frameLocator(
    ".tourtois-pane-body iframe",
  );
  // Trellis publishes navigation into its host header; content stays framed.
  const chooseScope = async (name) => {
    const scope = workflowsPane.locator('[data-caps-window-crumb="scope"]');
    // On a phone, Editor's Draft leaves Scope as a hidden ancestor. Use the
    // host's ordinary Back action to return home, including after a failed leg.
    if (!(await scope.isVisible())) {
      await workflowsPane
        .getByRole("button", { name: "Back in Trellis", exact: true })
        .click();
      await expectUi(scope).toBeVisible();
    }
    await scope.click();
    await uiPage.getByRole("menuitem", { name, exact: true }).click();
  };
  const chooseTool = async (name) => {
    await workflowsPane.locator('[data-caps-window-crumb="tool"]').click();
    await uiPage.getByRole("menuitem", { name, exact: true }).click();
  };
  const chooseWorkflow = async (workflowId) => {
    await chooseScope("All workflows…");
    await workflowsFrame.locator(`[data-workflow-id="${workflowId}"]`).click();
  };
  try {
    await step("shell-open-trellis", async () => {
      await uiPage.goto(`${origin}/login`);
      await uiPage.getByLabel("Owner key").fill(key);
      await uiPage
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await uiPage.goto(origin);
      try {
        const openApps = uiPage.getByRole("button", {
          name: "Open Apps",
          exact: true,
        });
        // The "other" installation is also named "Trellis" (no UI, so it
        // renders as an unavailable, opacity-55 grid item); pick the real one.
        if (await openApps.isVisible()) {
          await openApps.click();
          await uiPage
            .getByRole("group", { name: "Team Apps", exact: true })
            .locator(
              'button.caps-app-grid-item:not(.opacity-55)[aria-label="Trellis"]',
            )
            .click();
        } else {
          await uiPage
            .locator(".tourtois-gill-body")
            .locator(
              'button.caps-app-grid-item:not(.opacity-55)[aria-label="Trellis"]',
            )
            .click();
        }
      } catch (cause) {
        const evidence =
          process.env.WORKFLOW_UI_EVIDENCE ??
          `${root}.botanical/workflow-ui-shots`;
        await mkdir(evidence, { recursive: true });
        await uiPage.screenshot({
          path: `${evidence}/open-app-failure.png`,
          fullPage: true,
        });
        await writeFile(
          `${evidence}/open-app-failure.html`,
          await uiPage.content(),
        );
        throw cause;
      }
      await expectUi(workflowsFrame.locator("main.wf-runs")).toBeVisible({
        timeout: 30_000,
      });
      await expectUi(
        uiPage
          .locator('.tourtois-app-pane[aria-label="Trellis"]')
          .locator('[data-caps-window-crumb="scope"]'),
      ).toHaveText("All runs");
      await expectUi(
        workflowsFrame.locator("main.wf-runs [data-run-id]").first(),
      ).toBeVisible();
    });
    await step("ui-template-publish-change-checks-event-run", async () => {
      // Templates -> Bonsai checks -> Use template -> Publish version 1.
      await chooseScope("Templates");
      // A structural filter on the card's own heading, not a loose text match:
      // "Bonsai checks" also appears in the template's own description text,
      // and a bare hasText match can resolve to more than one element (or
      // flip between zero and one) while the template list is still settling.
      const bonsaiCard = workflowsFrame.locator(".caps-card").filter({
        has: workflowsFrame.getByRole("heading", {
          name: "Bonsai checks",
          exact: true,
        }),
      });
      await expectUi(bonsaiCard).toBeVisible();
      await bonsaiCard
        .getByRole("button", { name: "Use template", exact: true })
        .click();
      try {
        await expectUi(
          workflowsPane.getByRole("button", { name: "Publish", exact: true }),
        ).toBeVisible({ timeout: 15_000 });
      } catch (cause) {
        const evidence =
          process.env.WORKFLOW_UI_EVIDENCE ??
          `${root}.botanical/workflow-ui-shots`;
        await mkdir(evidence, { recursive: true });
        await uiPage.screenshot({
          path: `${evidence}/use-template-failure.png`,
          fullPage: true,
        });
        await writeFile(
          `${evidence}/use-template-failure.html`,
          await workflowsFrame.locator("body").innerHTML(),
        );
        throw cause;
      }
      await workflowsPane
        .getByRole("button", { name: "Publish", exact: true })
        .click();
      await expectUi(
        workflowsPane.getByRole("button", { name: "Run", exact: true }),
      ).toBeEnabled({ timeout: 15_000 });
      await workflowsPane.locator('[data-caps-window-crumb="version"]').click();
      const publishedVersion = uiPage.getByRole("menuitem", { name: /^v1 / });
      await expectUi(publishedVersion).toBeVisible();
      await publishedVersion.press("Escape");
      // Triggers: report to the real chat, then arm on the Change event.
      await chooseTool("Triggers");
      await expectUi(
        workflowsFrame.locator('[data-trigger-id="opened"]'),
      ).toBeVisible({ timeout: 15_000 });
      await workflowsFrame
        .getByLabel("Report to chat")
        .selectOption({ label: "Workflow report chat" });
      await workflowsFrame.getByRole("switch", { name: "Arm opened" }).click();
      await expectUi(
        workflowsFrame.locator('[data-trigger-id="opened"]').getByText("Armed"),
      ).toBeVisible({ timeout: 15_000 });
      // A real Bonsai Change (fork + push + open), never a bare push: the
      // template's own triggers fire on Change lifecycle events, not git.push.
      await call("bonsai", "repos.create", { name: "checks" });
      const pushAsOwner = (from, remoteRef) =>
        git(
          "-c",
          `http.extraHeader=Authorization: Bearer ${key}`,
          "push",
          `${origin}/git/bonsai/checks.git`,
          `${from}:refs/heads/${remoteRef}`,
        );
      await pushAsOwner("HEAD", "main");
      await git("checkout", "-qb", "ui-checks-feature");
      await writeFile(
        `${work}/checkout/package.json`,
        JSON.stringify({
          name: "checks",
          version: "1.0.0",
          private: true,
          scripts: { test: 'node -e "process.exit(0)"' },
        }),
      );
      await git("add", "package.json");
      await git(
        "-c",
        "user.name=Owner",
        "-c",
        "user.email=owner@test.invalid",
        "commit",
        "-qm",
        "Add a fast-passing test",
      );
      const featureHead = (await gitRun("rev-parse", "HEAD")).text.trim();
      await pushAsOwner("HEAD", "ui-checks-feature");
      // Bonsai observes the accepted push through its own push lifecycle (the
      // same reason the earlier "pond" push waits before acting on it); open
      // the Change only once the branch is visible, not on a bare race.
      await until(
        () => call("bonsai", "repos.get", { repo: "checks" }),
        (repoDetail) =>
          repoDetail.refs?.some(
            (ref) =>
              ref.name === "refs/heads/ui-checks-feature" &&
              ref.hash === featureHead,
          ),
        "the feature branch push lands in Bonsai",
      );
      const changeOpened = await call("bonsai", "changes.open", {
        repo: "checks",
        sourceRef: "ui-checks-feature",
        targetRef: "main",
        title: "Checks proof",
      });
      assert.ok(!("error" in changeOpened), JSON.stringify(changeOpened));
      const eventRuns = await until(
        () => call("trellis", "listRuns", { workflowId: templateWorkflowId }),
        (rows) => rows.some((row) => row.source === "event"),
        "the armed Bonsai Change trigger starts the checks workflow",
      );
      const eventRun = eventRuns.find((row) => row.source === "event");
      assert.equal(eventRun.triggerId, "opened");
      await until(
        () => call("trellis", "runStatus", { runId: eventRun.runId }),
        (status) => JSON.stringify(status.events).includes(featureHead),
        "the Change event's head reaches the checks workflow's change node",
      );
      // The real checks journey runs through Shed; assert its real outcome
      // against the real producer. The template's declared output is
      // reported.value, i.e. checks.report's own OUTPUT -- {kind: "recorded" |
      // "moved" | "settled" | "refused"} (apps/bonsai/shared/contract.ts's
      // checkReportResult) -- never a "passed"/"failed" status; that status is
      // the Check's own persisted field, read back through Bonsai's existing
      // changes.get, not invented from the run's output.
      const eventStatus = await until(
        () => call("trellis", "runStatus", { runId: eventRun.runId }),
        (status) => status.outcome !== "active",
        "the checks run reaches a terminal outcome",
      );
      assert.equal(
        eventStatus.outcome,
        "terminal",
        JSON.stringify(eventStatus),
      );
      assert.equal(eventStatus.error, null, JSON.stringify(eventStatus));
      assert.equal(
        eventStatus.output?.report?.kind,
        "recorded",
        JSON.stringify(eventStatus),
      );
      const checksDetail = await call("bonsai", "changes.get", {
        repo: "checks",
        number: changeOpened.number,
      });
      const tests = checksDetail.review?.checks?.find(
        (item) => item.head === featureHead && item.name === "tests",
      );
      assert.ok(tests, JSON.stringify(checksDetail));
      // The pushed repo's test script exits 0, so the real Check settles passed.
      assert.equal(tests.status, "passed", JSON.stringify(tests));
      await followUpReaches(eventRun.runId);
      // Select this workflow's Runs through the host's Scope and Tool.
      await chooseWorkflow(templateWorkflowId);
      await chooseTool("Runs");
      const eventRow = workflowsFrame
        .locator(`[data-run-id="${eventRun.runId}"]`)
        .first();
      await expectUi(eventRow).toContainText("Event", { timeout: 15_000 });
      await eventRow.getByRole("button").click();
      await expectUi(
        workflowsFrame.locator(
          `.wf-run-detail[data-run-id="${eventRun.runId}"]`,
        ),
      ).toContainText("Started by change.opened");
    });
    await step("ui-schedule-run", async () => {
      assert.ok(scheduleRun, "the scheduled delivery step produced a real run");
      // Independent of whichever scope the preceding event journey reached.
      await chooseWorkflow("ui-schedule-report");
      await chooseTool("Runs");
      const scheduleRow = workflowsFrame
        .locator(`[data-run-id="${scheduleRun.runId}"]`)
        .first();
      await expectUi(scheduleRow).toContainText("Schedule", {
        timeout: 15_000,
      });
      await scheduleRow.getByRole("button").click();
      await expectUi(
        workflowsFrame.locator(
          `.wf-run-detail[data-run-id="${scheduleRun.runId}"]`,
        ),
      ).toContainText("Started by schedule");
    });
    await step("ui-fork-publish-manual-run-delivery", async () => {
      // Fork as draft from the host menu, then run with Agent delivery.
      await chooseWorkflow("ui-report");
      await chooseTool("Editor");
      await workflowsPane
        .getByRole("button", { name: "More", exact: true })
        .click();
      await uiPage.getByRole("menuitem", { name: "Fork", exact: true }).click();
      await expectUi(
        workflowsFrame.getByText("Fork a published workflow"),
      ).toBeVisible({ timeout: 15_000 });
      await workflowsFrame.getByLabel("New workflow ID").fill("ui-report-fork");
      await workflowsFrame
        .getByRole("button", { name: "Fork as draft", exact: true })
        .click();
      await workflowsFrame
        .getByRole("button", { name: "Open draft", exact: true })
        .click();
      await expectUi(
        workflowsPane.getByRole("button", { name: "Publish", exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await workflowsPane
        .getByRole("button", { name: "Publish", exact: true })
        .click();
      await expectUi(
        workflowsPane.getByRole("button", { name: "Run", exact: true }),
      ).toBeEnabled({ timeout: 15_000 });
      await workflowsPane.locator('[data-caps-window-crumb="version"]').click();
      const publishedVersion = uiPage.getByRole("menuitem", { name: /^v1 / });
      await expectUi(publishedVersion).toBeVisible();
      await publishedVersion.press("Escape");
      await workflowsPane
        .getByRole("button", { name: "Run", exact: true })
        .click();
      await workflowsFrame
        .getByLabel("Report to chat")
        .selectOption({ label: "Workflow report chat" });
      await workflowsFrame
        .getByRole("button", { name: "Run v1", exact: true })
        .click();
      // Running v1 selects Runs in the host header and the real run in content.
      await expectUi(
        workflowsPane.locator('[data-caps-window-crumb="tool"]'),
      ).toContainText("Runs", { timeout: 15_000 });
      const manualRunId = await workflowsFrame
        .locator(".wf-run-detail")
        .getAttribute("data-run-id");
      assert.ok(manualRunId, "the manual run auto-selects in Runs");
      const manualRuns = await call("trellis", "listRuns", {
        workflowId: "ui-report-fork",
      });
      assert.equal(
        manualRuns.find((run) => run.runId === manualRunId)?.source,
        "manual",
        "the selected run has a real manual source",
      );
      await expectUi(
        workflowsFrame.locator(`.wf-run-detail[data-run-id="${manualRunId}"]`),
      ).toContainText("Started by You");
      const manualStatus = await until(
        () => call("trellis", "runStatus", { runId: manualRunId }),
        (status) => status.outcome !== "active",
        "the manual run reaches a terminal outcome",
      );
      // ui-report-fork is App-free too: the delivery-arrival proof stays
      // separate from execution success, so assert the run actually succeeded.
      assert.equal(
        manualStatus.outcome,
        "terminal",
        JSON.stringify(manualStatus),
      );
      assert.deepEqual(manualStatus.output, { ok: true });
      await followUpReaches(manualRunId);
    });
    const evidence =
      process.env.WORKFLOW_UI_EVIDENCE ?? `${root}.botanical/workflow-ui-shots`;
    await mkdir(evidence, { recursive: true });
    await uiPage.screenshot({
      path: `${evidence}/workflows-runs.png`,
      fullPage: true,
    });
    await step("browser-page-errors", async () => {
      assert.deepEqual(uiPageErrors, []);
    });
  } finally {
    await uiPage.close();
  }

  allStepsAttempted = true;
  if (stepFailures.length > 0)
    throw new AggregateError(
      stepFailures.map(({ cause }) => cause),
      `Standalone Workflow steps failed: ${stepFailures.map(({ name }) => name).join(", ")}`,
    );
  log(
    `Browser UI proof on ${runtime}: Templates -> Publish, real Bonsai Change arm/fire, Runs badges + Started by, Fork-as-draft + Run, Agent delivery follow-ups for manual/schedule/event all confirmed`,
  );
  log(
    `PASS standalone ${runtime}: real publish/run/review approve+reject/Pending/replay/cancel, Code, scheduled alarm firing with drift/re-arm/disarm, Bonsai push event trigger, Workflow Git pass for a branch-scoped Save step, and installation isolation`,
  );
} catch (cause) {
  log(
    JSON.stringify({
      proof: "standalone-workflow-failure-summary",
      failedSteps: [
        ...stepFailures.map(({ name }) => name),
        ...(!allStepsAttempted ? ["shared-fixture"] : []),
      ],
      allStepsAttempted,
    }),
  );
  await nativeHost.recordFailure({
    diagnostic: `${root}.botanical/workflow-reviews/native-${runtime}.log`,
    description: "Native Workflow proof failed",
  });
  throw cause;
} finally {
  if (reviewBrowser) await reviewBrowser.close();
  if (reviewServer) await reviewServer.close();
  await nativeHost.close();
}
