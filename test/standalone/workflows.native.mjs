import process from "node:process";
import { log, error } from "node:console";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import * as z from "zod";
import { build } from "esbuild";
import { parse as parseJsonc } from "jsonc-parser";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { sha256 } from "@fungi.computer/oyster/host";
import { probeDeclaration } from "./workflow-probe/declaration.ts";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";
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
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/workflows-native-`);
const config = parseJsonc(
  await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = `${root}test/standalone/workflows-root.fixture.ts`;
// Releases and per-App artifacts are separate resources in this isolated proof.
config.r2_buckets = config.r2_buckets.map((bucket) =>
  bucket.binding === "APP_ARTIFACTS"
    ? { ...bucket, bucket_name: "workflow-proof-app-artifacts" }
    : bucket,
);
config.vars = {
  ...config.vars,
  WORKFLOW_CODE_LOCAL_DEV: process.env.CELLD_PLATFORM_CELLD ? "false" : "true",
};
// wrangler.celld.jsonc has no AI binding (unneeded until this proof's Agent
// Sessions); wrangler.jsonc's real preview config declares exactly this, so
// mirror it here rather than editing the shared celld config for one proof.
config.ai = { binding: "AI" };
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
const key = randomBytes(24).toString("hex");
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";
const provider = await workflowGitProvider();
// Shed's real exec (the checks template's "tests" node) needs a real
// Computer process backend, the same fixture contract as
// shed-terminal-proof.mjs and storyboard.native.mjs: a private, mode-0600
// env file naming an already-running on-box lab VM (owned and torn down by
// whoever stood it up, never this script). Optional: with no
// OYSTER_PROOF_ENV_FILE, every scenario that never dispatches to Shed still
// runs; the checks-template run then fails for the known, pre-existing
// reason (no Computer backend attached) rather than being silently skipped.
const computerVmFixturePath = process.env.OYSTER_PROOF_ENV_FILE;
let computerVmVars = {};
// The lab vmd's /ws callback targets a fixed worker slot port baked into
// its own config at bring-up (COMPUTER_PROOF_PORT in the fixture), not
// whatever free port this script happens to pick -- picking our own means
// the guest's /ws upgrade can never reach this Worker.
let fixedPort;
if (computerVmFixturePath !== undefined) {
  assert.equal((await stat(computerVmFixturePath)).mode & 0o777, 0o600);
  const computerVmFixture = z
    .object({
      COMPUTER_PROOF_PORT: z.coerce.number().int().min(1).max(65535),
      COMPUTER_VM_ORIGIN: z.url(),
      COMPUTER_VM_DEFAULT_HOST: z.string().min(1),
      COMPUTER_VM_HOSTS: z.string().min(1),
      COMPUTER_VM_SIGNING_KEY: z.string().min(1),
    })
    .safeParse(parseEnv(await readFile(computerVmFixturePath, "utf8")));
  assert.ok(
    computerVmFixture.success,
    "Computer VM fixture configuration is invalid",
  );
  const { COMPUTER_PROOF_PORT, ...computerVars } = computerVmFixture.data;
  fixedPort = COMPUTER_PROOF_PORT;
  computerVmVars = computerVars;
}
if (fixedPort !== undefined) {
  // There is exactly one worker slot the lab vmd calls back to; a
  // collision with another proof must fail loudly here, not show up 30
  // seconds later as an inexplicable /ws upgrade timeout.
  await new Promise((resolve, reject) => {
    const socket = createServer()
      .once("error", (cause) =>
        reject(
          new Error(
            `Worker slot port ${String(fixedPort)} is already bound -- coordinate with whoever holds it (CLAIMED line in claude-seams-ready.md) before retrying`,
            { cause },
          ),
        ),
      )
      .listen(fixedPort, "127.0.0.1", () => socket.close(resolve));
  });
}
const port =
  fixedPort ??
  (await new Promise((resolve) => {
    const socket = createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = socket.address();
      socket.close(() => resolve(free));
    });
  }));
const origin = `http://127.0.0.1:${port}`;
// The seeded tenant lives at an HTTPS origin. Wrangler presents loopback
// requests to the Worker at that origin, as TLS termination does in production.
const tenantHost = "oyster.test";
const tenantOrigin = `https://${tenantHost}`;
const auth = { Authorization: `Bearer ${key}` };
const gitEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  ),
  GIT_TERMINAL_PROMPT: "0",
};
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
    ...Object.entries(computerVmVars).flatMap(([name, value]) => [
      "--var",
      `${name}:${value}`,
    ]),
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

async function persistBytes(bytes) {
  const digest = await sha256(bytes);
  const artifactRef = `artifact:sha256-${digest.slice(7)}`;
  const response = await globalThis.fetch(
    `${origin}/api/artifacts/${artifactRef}?digest=${digest}`,
    {
      method: "PUT",
      headers: auth,
      body: bytes,
    },
  );
  assert.equal(response.status, 204, await response.text());
  return { artifactRef, digest, byteLength: bytes.length, version: digest };
}
async function persist(value) {
  return persistBytes(
    new globalThis.TextEncoder().encode(JSON.stringify(value)),
  );
}
async function install(installationId, entry, exportName, declaration, ui) {
  // These are digest-verified test Releases of the real backend source. App
  // publication tooling is not under test; Workflow publication below is.
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
  const artifact = await persist(
    createAppBuild(ui ?? null, backend, declaration),
  );
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
async function until(read, accepts, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await delay(100);
  }
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
    "probe",
    "./workflow-probe/index.fixture.ts",
    "WorkflowProbe",
    probeDeclaration,
  );
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
  await install(
    "trellis",
    "../../../../apps/trellis/backend/index.ts",
    "Trellis",
    workflowsDeclaration,
    workflowsUi,
  );
  await install(
    "other",
    "../../../../apps/trellis/backend/index.ts",
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
  }
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
  const current = installations.find((row) => row.installationId === "trellis");
  assert.ok(current);
  const reapproved = await globalThis.fetch(
    `${origin}/api/installations/workflows/grants`,
    {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        authorityVersion: current.authorityVersion,
        artifactDigest: current.release.artifact.artifactDigest,
        command: { kind: "set-grants", grants: "declared" },
      }),
    },
  );
  assert.equal(reapproved.status, 200, await reapproved.text());
  const status = (runId) => call("trellis", "runStatus", { runId });
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
  assert.equal((await call("trellis", "runWorkflow", request)).kind, "replay");
  assert.deepEqual(
    await call("probe", "counts", {}),
    counts,
    "replay cannot re-execute completed App calls",
  );
  assert.deepEqual(await call("trellis", "cancel", { runId: started.runId }), {
    kind: "terminal",
  });
  assert.deepEqual(await call("other", "runStatus", { runId: started.runId }), {
    error: "not_found",
  });
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
  assert.deepEqual(await call("trellis", "cancel", { runId: pending.runId }), {
    kind: "cancelled",
  });
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
  assert.equal(codePublished.kind, "published", JSON.stringify(codePublished));
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
  const stamps = () => call("probe", "stamps", {});
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
  const drifted = await globalThis.fetch(
    `${origin}/api/installations/workflows/grants`,
    {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        authorityVersion: library.authorityVersion,
        artifactDigest: library.release.artifact.artifactDigest,
        command: { kind: "set-grants", grants: "declared" },
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
  // A real Bonsai push on this root starts the Workflow armed on git.push.
  await install(
    "bonsai",
    "../../../../apps/bonsai/backend/index.ts",
    "BonsaiApp",
    bonsaiDeclaration,
  );
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
  // Git runs asynchronously: a blocked event loop would stop draining the
  // Worker's piped logs and stall the very push under test.
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
  // A published Git step receives a pass for its declared branch only, and
  // only while its run is active.
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
        input: { type: "object", properties: {}, additionalProperties: false },
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
  const [pass] = await until(
    () => call("probe", "passes", {}),
    (rows) => rows.length === 1,
    "the Git step receives its Workflow Git pass",
  );
  // The remote is the ordinary door URL; the pass is only a bearer header.
  assert.equal(pass.remote, `${tenantOrigin}/git/bonsai/pond.git`);
  assert.match(pass.bearer, /^wgp\.workflows\.[0-9a-f]{64}$/u);
  assert.equal(pass.remote.includes(pass.bearer.slice(4)), false);
  const passRemote = new URL(new URL(pass.remote).pathname, origin);
  // As Shed runs it: command-local http.<remote>.extraHeader config only.
  const passGit = (...args) =>
    gitRunIn(
      {
        ...gitEnvironment,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${passRemote.href}.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${pass.bearer}`,
      },
      ...args,
    );
  const passSecret = pass.bearer.slice(pass.bearer.lastIndexOf(".") + 1);
  await writeFile(`${work}/checkout/board.txt`, "contact sheet\n");
  await git("add", "board.txt");
  await git(
    "-c",
    "user.name=Workflow",
    "-c",
    "user.email=workflow@test.invalid",
    "commit",
    "-qm",
    "Save storyboard",
  );
  const anonymous = await gitRun(
    "push",
    passRemote.href,
    "HEAD:refs/heads/storyboards",
  );
  assert.notEqual(anonymous.status, 0, "the remote alone grants nothing");
  const outside = await passGit(
    "push",
    passRemote.href,
    "HEAD:refs/heads/main",
  );
  assert.notEqual(outside.status, 0, "the pass is scoped to its branch");
  assert.match(outside.text, /outside the Workflow branch grant/u);
  const saved = await passGit(
    "push",
    passRemote.href,
    "HEAD:refs/heads/storyboards",
  );
  assert.equal(saved.status, 0, saved.text);
  // Bonsai observes the accepted push through its own push lifecycle.
  await until(
    async () => (await call("bonsai", "repos.get", { repo: "pond" })).refs,
    (refs) => refs.some((ref) => ref.name.endsWith("storyboards")),
    "the Save step's branch lands in Bonsai",
  );
  assert.deepEqual(await call("trellis", "cancel", { runId: saving.runId }), {
    kind: "cancelled",
  });
  await writeFile(`${work}/checkout/board.txt`, "after the run\n");
  await git(
    "-c",
    "user.name=Workflow",
    "-c",
    "user.email=workflow@test.invalid",
    "commit",
    "-qam",
    "After the run",
  );
  const ended = await passGit(
    "push",
    passRemote.href,
    "HEAD:refs/heads/storyboards",
  );
  assert.notEqual(ended.status, 0, "a finished run's pass grants nothing");
  // The pass reached no repository config, Git output or Worker log.
  const gitConfig = await readFile(`${work}/checkout/.git/config`, "utf8");
  for (const [where, text] of [
    [".git/config", gitConfig],
    ["git output", outside.text + saved.text + ended.text],
    ["Worker log", output],
  ])
    assert.equal(text.includes(passSecret), false, `pass leaked into ${where}`);
  if (runtime === "workerd")
    assert.ok(output.includes("CPU limits are not enforced in local dev"));
  // ---- Browser-driven UI proof: the real "trellis" installation, opened
  // ---- as a Tourtois-embedded App (not the vite standalone-review harness
  // ---- above). Templates -> Publish, Triggers arm on a real Bonsai Change,
  // ---- Runs badges/Started-by, Fork-as-draft, and Agent delivery.
  const templateWorkflowId = "bonsai-checks-1";
  await install(
    "shed",
    "../../../../apps/shed/backend/index.ts",
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
    "../../../../apps/grove/backend/index.ts",
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
        input: { type: "object", properties: {}, additionalProperties: false },
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
  const uiReportPublished = await publish("ui-report", uiReportDraft.revision);
  assert.equal(uiReportPublished.kind, "published");
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
        input: { type: "object", properties: {}, additionalProperties: false },
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
  assert.equal(uiScheduleDraft.kind, "saved", JSON.stringify(uiScheduleDraft));
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
  assert.equal(uiScheduleArmed.kind, "armed", JSON.stringify(uiScheduleArmed));
  let scheduleRun;
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
  // Without a real "tourtois" home installation, "/" falls back to the bare
  // Oyster installation list (no Open Apps, no real App frame) -- the real
  // Tourtois shell UI is itself a packaged release, not a lightweight
  // esbuild bundle, so install it the same way tourtois-home.browser.mjs
  // does: a real packRelease from its own app-set.ts recipe.
  const tourtoisRecipe = standaloneAppSet.find(
    (app) => app.installationId === "tourtois",
  );
  assert.ok(tourtoisRecipe, "the standalone app set declares tourtois");
  const tourtoisRelease = `${work}/tourtois-release`;
  await packRelease({
    appId: "app_tourtois",
    releaseId: "rel_tourtois",
    sourceDirectory: repository,
    sourceRevision: `git:${execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim()}`,
    packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    recipe: tourtoisRecipe.recipe,
    outDirectory: tourtoisRelease,
  });
  const tourtoisInstalled = await installRelease({
    url: origin,
    key,
    installationId: "tourtois",
    directory: tourtoisRelease,
  });
  assert.equal(tourtoisInstalled.status, 201, await tourtoisInstalled.text());
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
  try {
    await uiPage.goto(`${origin}/login`);
    await uiPage.getByLabel("Owner key").fill(key);
    await uiPage.getByRole("button", { name: "Sign in", exact: true }).click();
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
    const workflowsFrame = uiPage
      .locator('.tourtois-app-pane[aria-label="Trellis"]')
      .frameLocator(".tourtois-pane-body iframe");
    await expectUi(
      workflowsFrame.getByRole("tablist", { name: "Trellis" }),
    ).toBeVisible({ timeout: 30_000 });
    // Templates -> Bonsai checks -> Use template -> Publish -> "Published v1".
    await workflowsFrame
      .getByRole("tab", { name: "Templates", exact: true })
      .click();
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
        workflowsFrame.getByRole("button", { name: "Publish", exact: true }),
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
    await workflowsFrame
      .getByRole("button", { name: "Publish", exact: true })
      .click();
    await expectUi(
      workflowsFrame.getByRole("status").filter({ hasText: "Published v1" }),
    ).toBeVisible({ timeout: 15_000 });
    // Triggers: report to the real chat, then arm on the Change event.
    await workflowsFrame
      .getByRole("tab", { name: "Triggers", exact: true })
      .click();
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
    assert.equal(eventStatus.outcome, "terminal", JSON.stringify(eventStatus));
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
    // Runs tab: the event run's badge and Started-by, by its own workflow.
    await workflowsFrame
      .getByLabel("Workflow", { exact: true })
      .selectOption({ label: "Bonsai checks" });
    await workflowsFrame
      .getByRole("tab", { name: "Runs", exact: true })
      .click();
    const eventRow = workflowsFrame
      .locator(`[data-run-id="${eventRun.runId}"]`)
      .first();
    await expectUi(eventRow).toContainText("Event", { timeout: 15_000 });
    await eventRow.getByRole("button").click();
    await expectUi(
      workflowsFrame.locator(`.wf-run-detail[data-run-id="${eventRun.runId}"]`),
    ).toContainText("Started by change.opened");
    // Runs tab: the schedule run's badge and Started-by, by its own workflow.
    await workflowsFrame
      .getByLabel("Workflow", { exact: true })
      .selectOption({ label: "UI schedule report proof" });
    const scheduleRow = workflowsFrame
      .locator(`[data-run-id="${scheduleRun.runId}"]`)
      .first();
    await expectUi(scheduleRow).toContainText("Schedule", { timeout: 15_000 });
    await scheduleRow.getByRole("button").click();
    await expectUi(
      workflowsFrame.locator(
        `.wf-run-detail[data-run-id="${scheduleRun.runId}"]`,
      ),
    ).toContainText("Started by schedule");
    // Versions: Fork as draft, publish the fork, run it with Agent delivery.
    await workflowsFrame
      .getByLabel("Workflow", { exact: true })
      .selectOption({ label: "UI report proof" });
    await workflowsFrame
      .getByRole("tab", { name: "Editor", exact: true })
      .click();
    await workflowsFrame
      .getByRole("button", { name: "Fork workflow", exact: true })
      .click();
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
      workflowsFrame.getByRole("button", { name: "Publish", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await workflowsFrame
      .getByRole("button", { name: "Publish", exact: true })
      .click();
    await expectUi(
      workflowsFrame.getByRole("status").filter({ hasText: "Published v1" }),
    ).toBeVisible({ timeout: 15_000 });
    await workflowsFrame.getByRole("tab", { name: "Run", exact: true }).click();
    await workflowsFrame
      .getByLabel("Report to chat")
      .selectOption({ label: "Workflow report chat" });
    await workflowsFrame
      .getByRole("button", { name: "Run v1", exact: true })
      .click();
    // Running v1 switches the app to the Runs tab; the tab bar itself (not
    // an inner title, which the Workflows tabs no longer render) is the
    // stable signal that the switch happened.
    await expectUi(
      workflowsFrame.getByRole("tab", { name: "Runs", exact: true }),
    ).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    const manualRunId = await workflowsFrame
      .locator(".wf-run-detail")
      .getAttribute("data-run-id");
    assert.ok(manualRunId, "the manual run auto-selects in the Runs tab");
    await expectUi(
      workflowsFrame.locator(`[data-run-id="${manualRunId}"]`).first(),
    ).toContainText("Manual");
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
    const evidence =
      process.env.WORKFLOW_UI_EVIDENCE ?? `${root}.botanical/workflow-ui-shots`;
    await mkdir(evidence, { recursive: true });
    await uiPage.screenshot({
      path: `${evidence}/workflows-runs.png`,
      fullPage: true,
    });
    assert.deepEqual(uiPageErrors, []);
    log(
      `Browser UI proof on ${runtime}: Templates -> Publish, real Bonsai Change arm/fire, Runs badges + Started by, Fork-as-draft + Run, Agent delivery follow-ups for manual/schedule/event all confirmed`,
    );
  } finally {
    await uiPage.close();
  }

  log(
    `PASS standalone ${runtime}: real publish/run/review approve+reject/Pending/replay/cancel, Code, scheduled alarm firing with drift/re-arm/disarm, Bonsai push event trigger, Workflow Git pass for a branch-scoped Save step, and installation isolation`,
  );
} catch (cause) {
  const diagnostic = `${root}.botanical/workflow-reviews/native-${runtime}.log`;
  await mkdir(`${root}.botanical/workflow-reviews`, {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(diagnostic, output, { mode: 0o600 });
  error(
    `Native Workflow proof failed; private Worker diagnostics: ${diagnostic}`,
  );
  throw cause;
} finally {
  if (reviewBrowser) await reviewBrowser.close();
  if (reviewServer) await reviewServer.close();
  worker.kill("SIGTERM");
  await stopped;
  await provider.close();
  await rm(work, { recursive: true, force: true });
}
