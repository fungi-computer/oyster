// Standalone Storyboard, end to end: a real Workflows + Bonsai + Shed +
// Inkcap + Prints Worker (wrangler dev/workerd), driving the bundled
// templates/storyboard.json and templates/storyboard-save.json through the
// real App methods a user's "Run" click and review answers would use. Only
// the Workers AI provider underneath Prints is controlled (see
// storyboard-root.fixture.ts); every App method, the real Braid graph
// engine, and real Bonsai git storage run unchanged. UNVERIFIED: authored
// under a disk-capacity hold with builds paused; not yet run (see the
// report alongside this change for the specific open questions).
import process from "node:process";
import { log, error } from "node:console";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { workflowGitProvider } from "./workflow-git.fixture.mjs";
import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend as workflowsBackend } from "../../../../apps/trellis/backend/methods.ts";
import workflowsMetadata from "../../../../apps/trellis/package.json" with { type: "json" };
import { appBackend as bonsaiBackend } from "../../../../apps/bonsai/backend/methods.ts";
import bonsaiMetadata from "../../../../apps/bonsai/package.json" with { type: "json" };
import { appBackend as shedBackend } from "../../../../apps/shed/backend/methods.ts";
import shedMetadata from "../../../../apps/shed/package.json" with { type: "json" };
import { appBackend as inkcapBackend } from "../../../../apps/inkcap/backend/methods.ts";
import inkcapMetadata from "../../../../apps/inkcap/package.json" with { type: "json" };
import { appBackend as printsBackend } from "../../../../apps/prints/backend/methods.ts";
import printsMetadata from "../../../../apps/prints/package.json" with { type: "json" };

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
const inkcapDeclaration = buildAppDeclaration(
  inkcapBackend,
  inkcapMetadata.fungi.app,
);
const printsDeclaration = buildAppDeclaration(
  printsBackend,
  printsMetadata.fungi.app,
);

const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/storyboard-native-`);
const config = parseJsonc(
  await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
);
// Same boot shape as workflows.native.mjs: an isolated proof of the real
// production root, with its own storage, releases and App artifacts.
config.main = `${root}test/standalone/storyboard-root.fixture.ts`;
config.r2_buckets = config.r2_buckets.map((bucket) =>
  bucket.binding === "APP_ARTIFACTS"
    ? { ...bucket, bucket_name: "storyboard-proof-app-artifacts" }
    : bucket,
);
config.vars = {
  ...config.vars,
  WORKFLOW_CODE_LOCAL_DEV: process.env.CELLD_PLATFORM_CELLD ? "false" : "true",
};
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
const key = randomBytes(24).toString("hex");
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";
// The in-process provider below serves Bonsai's own git smart-HTTP/Artifacts
// REST on this same event loop; every git/HTTP call in this script must
// stay async, never sync, or the provider's own server can never answer
// (reviews/git-fork-push-hang-2026-10-14.md).
const provider = await workflowGitProvider();
// Save's Shed `clone`/`commitPush` need a REAL Computer process backend
// (reviews/storyboard-save-revoked-rootcause-2026-10-14.md: with none
// attached, the clone process never starts, Shed's completion poll throws,
// and the run fails). Same fixture contract as shed-terminal-proof.mjs: a
// private, mode-0600 env file naming an already-running on-box VM Computer
// backend (owned and torn down by whoever stood it up, never this script).
// Optional: the plain-Storyboard scenario below never touches a Computer
// process backend directly, so it's valid to run this script with no
// OYSTER_PROOF_ENV_FILE at all to exercise that scenario alone (the
// save-to-git scenario will then fail for the known, pre-existing reason --
// no Computer backend attached at all -- rather than being skipped).
const computerVmFixturePath = process.env.OYSTER_PROOF_ENV_FILE;
let computerVmVars = {};
// The lab vmd's /ws callback targets a fixed worker slot port baked into
// its own config at bring-up (COMPUTER_PROOF_PORT in the fixture, the same
// value shed-terminal-proof.mjs binds wrangler to), not whatever free port
// this script happens to pick. Picking our own random port here, as this
// script did before, means the guest's /ws upgrade can never reach this
// Worker -- the "/ws upgrade did not arrive within 30000ms" Opus-VM traced.
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
  // collision with another proof (e.g. Sonnet-LS's own run) must fail
  // loudly here, not show up 30 seconds later as an inexplicable /ws
  // upgrade timeout once wrangler silently can't bind it.
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
const tenantHost = "oyster.test";
const tenantOrigin = `https://${tenantHost}`;
const auth = { Authorization: `Bearer ${key}` };
const worker = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    `${root}test/standalone/storyboard-root.fixture.ts`,
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
  const deadline = Date.now() + 90_000;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await delay(250);
  }
}
/** Wait for exactly one pending review on this run and return its record. */
/**
 * Wait for exactly one pending review. runStatus's `reviews` accumulates
 * every review the run has ever opened, each wrapped as
 * {review: {runId, nodeId, iteration, ...}, status, openedAt, expiresAt};
 * an answered one stays in the array with status "delivered", it is not
 * removed. Only entries with status "pending" are still open. A
 * just-answered review's node also runs its next round asynchronously:
 * answerReview's "accepted" reply only means the answer was recorded, not
 * that the next round's review already exists, so the very next poll can
 * still observe no pending review at all for a moment. When
 * excludeIteration is given (answering a repeat round), also exclude a
 * still-pending entry that improbably kept the same iteration.
 */
async function awaitReview(runId, label, excludeIteration) {
  const pendingReviews = (status) =>
    status.reviews.filter(
      (entry) =>
        entry.status === "pending" &&
        entry.review.iteration !== excludeIteration,
    );
  const status = await until(
    () => call("trellis", "runStatus", { runId }),
    (value) => Array.isArray(value.reviews) && pendingReviews(value).length > 0,
    label,
  );
  const pending = pendingReviews(status);
  assert.equal(
    pending.length,
    1,
    `${label}: ${JSON.stringify(status.reviews)}`,
  );
  return pending[0].review;
}
/**
 * files.list returns {ref, commit, paths, truncated} or, while its copy is
 * still being built, {kind:"rebuilding"} (packages/agar/src/roles/files.ts).
 * Drive the same foreground rebuildCopies page loop git-push.native.mjs and
 * workflows-read-copies.native.mjs use, then retry once.
 */
async function readFileList(repo, ref) {
  const first = await call("bonsai", "files.list", { repo, ref });
  if (first.kind !== "rebuilding") return first;
  let page = { done: false, cursor: null };
  while (!page.done) {
    page = await call("bonsai", "rebuildCopies", { cursor: page.cursor });
  }
  const retried = await call("bonsai", "files.list", { repo, ref });
  assert.notEqual(
    retried.kind,
    "rebuilding",
    "files.list did not finish rebuilding",
  );
  return retried;
}
async function answer(review, answerValue) {
  const reply = await call("trellis", "answerReview", {
    runId: review.runId,
    nodeId: review.nodeId,
    iteration: review.iteration,
    answer: answerValue,
  });
  assert.equal(reply.result, "accepted", JSON.stringify(reply));
}

try {
  await until(
    async () => {
      try {
        return (await globalThis.fetch(`${origin}/`)).status < 500;
      } catch {
        return false;
      }
    },
    (ready) => ready,
    "Worker boot",
  );

  await install(
    "trellis",
    "../../../../apps/trellis/backend/index.ts",
    "Trellis",
    workflowsDeclaration,
  );
  // "BonsaiApp", not "Bonsai": the bundled backend's own code already
  // declares a type/binding named Bonsai (apps/bonsai/backend/methods.ts),
  // and reusing that exact name as the generated facet class's exportName
  // collides with it, causing every call to crash with a TypeError deep in
  // backend_execution (confirmed by bisecting against this exact change;
  // workflows.native.mjs and workflow-provider.native.mjs already use
  // "BonsaiApp" for the same install).
  await install(
    "bonsai",
    "../../../../apps/bonsai/backend/index.ts",
    "BonsaiApp",
    bonsaiDeclaration,
  );
  await install(
    "shed",
    "../../../../apps/shed/backend/index.ts",
    "Shed",
    shedDeclaration,
  );
  await install(
    "inkcap",
    "../../../../apps/inkcap/backend/index.ts",
    "Inkcap",
    inkcapDeclaration,
  );
  await install(
    "prints",
    "../../../../apps/prints/backend/index.ts",
    "Prints",
    printsDeclaration,
  );

  // --- Plain Storyboard: 2 beats, Regenerate (with a note) then Keep and
  // animate on the first beat, Keep on the second; Map order holds; the run
  // completes with an image and an mp4 (rows 43, 45). ---
  const storyboardTemplate = JSON.parse(
    await readFile(
      new URL(
        "../../../../apps/trellis/templates/storyboard.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const storyboardDraft = await call("trellis", "saveDraft", {
    workflowId: "storyboard-plain",
    expectedRevision: 0,
    draft: {
      definition: storyboardTemplate.definition,
      layout: storyboardTemplate.layout,
    },
  });
  assert.equal(storyboardDraft.kind, "saved", JSON.stringify(storyboardDraft));
  const storyboardPublished = await publish(
    "storyboard-plain",
    storyboardDraft.revision,
  );
  assert.equal(
    storyboardPublished.kind,
    "published",
    JSON.stringify(storyboardPublished),
  );

  const beats = ["A peaceful koi pond at dawn", "A fox arrives at the pond"];
  const started = await call("trellis", "runWorkflow", {
    requestId: "storyboard-plain-run",
    workflowId: "storyboard-plain",
    commit: storyboardPublished.commit,
    bindings: { prints: "prints" },
    input: { beats },
  });
  assert.equal(started.kind, "started", JSON.stringify(started));
  const { runId } = started;

  // Beat 1, round 1: Regenerate with a note.
  const beat1Round1 = await awaitReview(runId, "beat 1 round 1 review");
  assert.deepEqual(beat1Round1.choices?.slice().sort(), [
    "animate",
    "keep",
    "redo",
    "reject",
  ]);
  await answer(beat1Round1, { choice: "redo", note: "Try a warmer palette" });

  // Beat 1, round 2: Keep and animate.
  const beat1Round2 = await awaitReview(
    runId,
    "beat 1 round 2 review",
    beat1Round1.iteration,
  );
  assert.notEqual(beat1Round2.iteration, beat1Round1.iteration);
  await answer(beat1Round2, { choice: "animate" });

  // Beat 2, round 1 (map order holds: beat 2's review only appears after
  // beat 1's subgraph, including its animate clip, has finished).
  const beat2Round1 = await awaitReview(
    runId,
    "beat 2 round 1 review",
    beat1Round2.iteration,
  );
  await answer(beat2Round1, { choice: "keep" });

  const finished = await until(
    () => call("trellis", "runStatus", { runId }),
    (status) => status.outcome === "terminal",
    "storyboard-plain completion",
  );
  assert.equal(finished.error, null, JSON.stringify(finished.error));
  const plainOutput = finished.output;
  assert.equal(plainOutput.shots.length, 2);
  assert.equal(plainOutput.shots[0].beat, beats[0], "Map order: beat 1 first");
  assert.equal(plainOutput.shots[1].beat, beats[1], "Map order: beat 2 second");
  assert.ok(
    plainOutput.shots[0].panel?.destination?.path,
    "beat 1 has a generated image",
  );
  assert.ok(
    plainOutput.shots[0].clip?.destination?.path?.endsWith(".mp4"),
    "beat 1 was animated into an mp4",
  );
  assert.ok(
    plainOutput.shots[1].panel?.destination?.path,
    "beat 2 has a generated image",
  );
  assert.equal(
    plainOutput.shots[1].clip,
    undefined,
    "beat 2 was only kept, not animated",
  );
  log(
    `PASS storyboard-plain ${runtime}: 2 beats, redo+animate on beat 1, keep on beat 2, Map order held, image+mp4 produced`,
  );

  // --- Storyboard + Save to git: clone Bonsai repo "storyboard", then
  // storyboards/<saveId>/contact-sheet.md matches byte for byte (row 44). ---
  const repoCreated = await call("bonsai", "repos.create", {
    name: "storyboard",
    description: "",
  });
  assert.ok(!repoCreated.error, JSON.stringify(repoCreated));

  const saveTemplate = JSON.parse(
    await readFile(
      new URL(
        "../../../../apps/trellis/templates/storyboard-save.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const saveDraft = await call("trellis", "saveDraft", {
    workflowId: "storyboard-save",
    expectedRevision: 0,
    draft: { definition: saveTemplate.definition, layout: saveTemplate.layout },
  });
  assert.equal(saveDraft.kind, "saved", JSON.stringify(saveDraft));
  const savePublished = await publish("storyboard-save", saveDraft.revision);
  assert.equal(savePublished.kind, "published", JSON.stringify(savePublished));

  const saveBeats = [
    "A lantern in the forest",
    "A deer steps into the clearing",
  ];
  const saveStarted = await call("trellis", "runWorkflow", {
    requestId: "storyboard-save-run",
    workflowId: "storyboard-save",
    commit: savePublished.commit,
    bindings: {
      prints: "prints",
      bonsai: "bonsai",
      shed: "shed",
      inkcap: "inkcap",
    },
    input: {
      beats: saveBeats,
      repository: "storyboard",
      branch: "storyboard-drafts",
    },
  });
  assert.equal(saveStarted.kind, "started", JSON.stringify(saveStarted));
  const saveRunId = saveStarted.runId;

  // Keep every review on this run, so it reaches the Save step quickly.
  let previousIteration;
  for (let round = 0; round < saveBeats.length; round++) {
    const review = await awaitReview(
      saveRunId,
      `save run beat ${round + 1} review`,
      previousIteration,
    );
    await answer(review, { choice: "keep" });
    previousIteration = review.iteration;
  }
  const saveFinished = await until(
    () => call("trellis", "runStatus", { runId: saveRunId }),
    (status) => status.outcome === "terminal",
    "storyboard-save completion",
  );
  assert.equal(saveFinished.error, null, JSON.stringify(saveFinished.error));
  const saveOutput = saveFinished.output;
  assert.ok(!saveOutput.save?.error, JSON.stringify(saveOutput.save));
  assert.equal(saveOutput.save?.exitCode, 0, JSON.stringify(saveOutput.save));
  const contactSheet = z.string().min(1).parse(saveOutput.contactSheet);

  const listed = await readFileList("storyboard", "storyboard-drafts");
  const sheetPath = listed.paths.find((path) =>
    /^storyboards\/[^/]+\/contact-sheet\.md$/u.test(path),
  );
  assert.ok(
    sheetPath,
    `no storyboards/<saveId>/contact-sheet.md in: ${JSON.stringify(listed)}`,
  );
  const landed = await call("bonsai", "files.read", {
    repo: "storyboard",
    ref: "storyboard-drafts",
    path: sheetPath,
  });
  assert.notEqual(
    landed.kind,
    "rebuilding",
    `files.read did not finish rebuilding: ${JSON.stringify(landed)}`,
  );
  assert.equal(
    landed.text,
    contactSheet,
    "the committed contact sheet must match the run's own output byte for byte",
  );
  log(
    `PASS storyboard-save ${runtime}: cloned Bonsai repo "storyboard", ${sheetPath} matches the run's contactSheet exactly`,
  );
} catch (cause) {
  // The Worker's stdout/stderr listeners are async; give the last chunks
  // (often the actual stack trace for the failing request) time to land
  // before the diagnostic is written.
  await delay(500);
  const diagnostic = `${root}.botanical/workflow-reviews/storyboard-native-${runtime}.log`;
  await mkdir(`${root}.botanical/workflow-reviews`, {
    recursive: true,
    mode: 0o700,
  });
  // Wrangler may echo --var values; redact the Computer VM signing key
  // before this (already private, 0o600) diagnostic is written, the same
  // precaution shed-terminal-proof.mjs takes for the same fixture.
  const redacted = Object.values(computerVmVars).reduce(
    (text, value) => text.replaceAll(value, "<redacted>"),
    output,
  );
  await writeFile(diagnostic, redacted, { mode: 0o600 });
  error(
    `Standalone Storyboard proof failed; private Worker diagnostics: ${diagnostic}`,
  );
  throw cause;
} finally {
  worker.kill("SIGTERM");
  await stopped;
  await provider.close();
  await rm(work, { recursive: true, force: true });
}
