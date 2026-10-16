// An App builds on Oyster's own Computer, end to end on a real on-box VM:
// the production root (wrangler dev, landed-push-root.fixture.ts) with
// Bonsai installed, a real lab vmd Computer, and Bonsai's own first-party
// source pushed into a Bonsai repository. The owner registers that source,
// starts a build of its exact commit, and the Computer clones it through
// OysterComputerEgress (a live job's read-only pass), installs packages on
// the public lane, runs the canonical builder and reports the candidate
// back; the host stores and verifies the Release, and the owner switches
// the Bonsai installation to it.
//
// Then Build on merge: the owner arms the stock Workflows template on a
// forked App's source repository (a new App with its own installation), and
// each merged Change builds that exact commit and installs it, once with
// Review before install (the run waits for the owner's approval) and once
// without (a passing build installs automatically).
//
// Requires OYSTER_PROOF_ENV_FILE (mode 0600) naming an already-running lab
// vmd and the worker slot port it calls back to. Claim that slot first.
import process from "node:process";
import { log, error } from "node:console";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import * as z from "zod";
import { parse as parseJsonc } from "jsonc-parser";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { sha256 } from "@fungi.computer/oyster/host";
import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend } from "../../../../apps/bonsai/backend/methods.ts";
import packageMetadata from "../../../../apps/bonsai/package.json" with { type: "json" };
import { workflowGitProvider } from "./workflow-git.fixture.mjs";
import { labComputer } from "./lab-computer.fixture.mjs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import * as Effect from "effect/Effect";
import { parseSourceRevision } from "@fungi.computer/puffball";
import {
  createFirstPartyAppSourceDistribution,
  createLocalCommitSourceCapture,
} from "@fungi.computer/oyster/build";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { appBackend as workflowsBackend } from "../../../../apps/trellis/backend/methods.ts";
import workflowsMetadata from "../../../../apps/trellis/package.json" with { type: "json" };

const { port, vars: computerVars } = await labComputer();

const appDeclaration = buildAppDeclaration(
  appBackend,
  packageMetadata.fungi.app,
);
const workflowsDeclaration = buildAppDeclaration(
  workflowsBackend,
  workflowsMetadata.fungi.app,
);
const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/app-build-native-`);
const config = parseJsonc(
  await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = `${root}test/standalone/landed-push-root.fixture.ts`;
config.vars = {
  ...config.vars,
  WORKFLOW_CODE_LOCAL_DEV: process.env.CELLD_PLATFORM_CELLD ? "false" : "true",
};
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
const key = randomBytes(24).toString("hex");
const provider = await workflowGitProvider();
const origin = `http://127.0.0.1:${String(port)}`;
const tenantHost = "oyster.test";
const auth = { Authorization: `Bearer ${key}` };
const vars = {
  ...computerVars,
  OYSTER_OWNER_KEY: key,
  OYSTER_ORIGIN: `https://${tenantHost}`,
  GIT_ORIGIN: provider.origin,
};
const redact = (text) =>
  Object.values(vars).reduce(
    (message, value) => message.replaceAll(value, "[REDACTED]"),
    String(text),
  );
const worker = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    `${root}test/standalone/landed-push-root.fixture.ts`,
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
    ...Object.entries(vars).flatMap(([name, value]) => [
      "--var",
      `${name}:${value}`,
    ]),
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
let output = "";
// Redacted worker log, kept after the run for diagnosis.
const workerLog = `${root}.botanical/app-build-native.log`;
await writeFile(workerLog, "");
const capture = (chunk) => {
  output += chunk;
  void appendFile(workerLog, redact(chunk));
};
worker.stdout.on("data", capture);
worker.stderr.on("data", capture);
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
    {
      method: "PUT",
      headers: auth,
      body: bytes,
      signal: globalThis.AbortSignal.timeout(120_000),
    },
  );
  assert.equal(response.status, 204, await response.text());
  return { artifactRef, digest, byteLength: bytes.length, version: digest };
}
/** Install a digest-verified test Release of one App's real backend source. */
async function installApp(installationId, entry, exportName, declaration) {
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
  log("step: backend persisted");
  const artifact = await persist(createAppBuild(null, backend, declaration));
  log("step: build persisted; installing");
  const response = await globalThis.fetch(`${origin}/api/installations`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      installationId,
      release: {
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
      },
    }),
    signal: globalThis.AbortSignal.timeout(120_000),
  });
  assert.equal(response.status, 201, await response.text());
}
// Always async: the in-process Git provider answers on this event loop.
async function hostGit(...args) {
  const child = spawn("git", args, {
    cwd: work,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(status, 0, redact(stderr));
  return stdout.trim();
}

const timings = {};
try {
  const deadline = Date.now() + 90_000;
  while (
    !(await globalThis
      .fetch(`${origin}/login`, {
        signal: globalThis.AbortSignal.timeout(2_000),
      })
      .then(
        (response) => response.ok,
        () => false,
      ))
  ) {
    assert.equal(worker.exitCode, null, "Standalone Oyster exited");
    assert.ok(Date.now() < deadline, "Standalone Oyster did not start");
    await delay(200);
  }
  log("step: Oyster ready; installing Bonsai");
  await installApp(
    "bonsai",
    "../../../../apps/bonsai/backend/index.ts",
    "BonsaiApp",
    appDeclaration,
  );

  const bonsai = standaloneAppSet.find(
    (app) => app.installationId === "bonsai",
  );
  assert.ok(bonsai, "The standalone App set includes Bonsai");
  log("step: Bonsai installed; pushing Bonsai's own source");
  await call("bonsai", "repos.create", { name: "bonsai-source" });
  const repository = `${root}../..`;
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const distribution = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* createLocalCommitSourceCapture(
          repository,
          parseSourceRevision(`git:${revision}`),
        ).capture();
        return yield* createFirstPartyAppSourceDistribution({
          appId: bonsai.appId,
          entry: bonsai.recipe.entry,
          source,
        });
      }),
    ),
  );
  for (const file of distribution.files) {
    const path = `${work}/checkout/${file.path}`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents);
  }
  await hostGit("-C", "checkout", "init", "-q", "-b", "main");
  await hostGit("-C", "checkout", "add", "-A");
  await hostGit(
    "-C",
    "checkout",
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@test.invalid",
    "commit",
    "-qm",
    "Bonsai source",
  );
  await hostGit(
    "-C",
    "checkout",
    "-c",
    `http.extraHeader=Authorization: Bearer ${key}`,
    "-c",
    "http.postBuffer=268435456",
    "push",
    "-q",
    `${origin}/git/bonsai/bonsai-source.git`,
    "main",
  );
  const head = await hostGit("-C", "checkout", "rev-parse", "HEAD");
  log(`step: pushed ${String(distribution.files.length)} files at ${head}`);

  const owner = async (method, path, body) => {
    const response = await globalThis.fetch(`${origin}${path}`, {
      method,
      headers: { ...auth, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: globalThis.AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const registered = await owner("PUT", "/api/apps/app_bonsai/build-source", {
    installationId: "bonsai",
    repository: "bonsai-source",
    recipe: bonsai.recipe,
  });
  assert.equal(registered.status, 204, JSON.stringify(registered.body));
  const started = Date.now();
  const build = await owner("POST", "/api/builds", {
    appId: "app_bonsai",
    sourceRevision: `git:${head}`,
  });
  assert.equal(build.status, 202, JSON.stringify(build.body));
  log(`step: build ${build.body.jobId} started for ${build.body.releaseId}`);
  let view = build.body;
  while (view.status === "running") {
    assert.equal(worker.exitCode, null, "Standalone Oyster exited");
    assert.ok(Date.now() - started < 960_000, "Build did not finish");
    await delay(5_000);
    view = (await owner("GET", `/api/builds/${build.body.jobId}`)).body;
  }
  timings.build = Date.now() - started;
  log(
    `step: build ${view.status} in ${String(timings.build)}ms ${view.detail ?? ""}`,
  );
  assert.equal(view.status, "succeeded", redact(JSON.stringify(view)));
  assert.equal(view.release.artifact.provenance.sourceRevision, `git:${head}`);
  const switched = await owner(
    "PUT",
    "/api/installations/bonsai/release",
    view.release,
  );
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  const installed = await owner("GET", "/api/installations");
  const current = installed.body.find(
    (installation) => installation.installationId === "bonsai",
  );
  assert.equal(current.release.releaseId, view.release.releaseId);
  assert.match(
    output,
    /"lane":"internal-git"/u,
    "The build clone and report used the build lanes",
  );
  assert.match(
    output,
    /"lane":"public"/u,
    "Packages came over the public lane",
  );

  // Build on merge (C1): the stock Workflows template, armed by the owner on
  // a forked App's source repository, builds each merged commit and installs
  // it on that App's own installation, once through the review step and once
  // automatically.
  await installApp(
    "trellis",
    "../../../../apps/trellis/backend/index.ts",
    "Trellis",
    workflowsDeclaration,
  );
  const fork = { appId: "app_mybonsai", installationId: "my-bonsai" };
  await call("bonsai", "repos.create", { name: "my-bonsai" });
  await hostGit(
    "-C",
    "checkout",
    "-c",
    `http.extraHeader=Authorization: Bearer ${key}`,
    "-c",
    "http.postBuffer=268435456",
    "push",
    "-q",
    `${origin}/git/bonsai/my-bonsai.git`,
    "main",
  );
  const forkSource = await owner(
    "PUT",
    `/api/apps/${fork.appId}/build-source`,
    {
      installationId: "bonsai",
      repository: "my-bonsai",
      recipe: bonsai.recipe,
    },
  );
  assert.equal(forkSource.status, 204, JSON.stringify(forkSource.body));
  const template = z
    .object({ definition: z.json(), layout: z.json() })
    .parse(
      JSON.parse(
        await readFile(
          new URL(
            "../../../../apps/trellis/templates/bonsai-build-on-merge.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  const catalog = (await call("trellis", "catalog", {})).apps.find(
    (item) => item.installationId === "bonsai",
  );
  assert.ok(catalog?.events?.["change.merged"], JSON.stringify(catalog));
  const until = async (read, accepts, label, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      assert.equal(worker.exitCode, null, "Standalone Oyster exited");
      const value = await read();
      if (accepts(value)) return value;
      assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
      await delay(1_000);
    }
  };
  // A push of a whole App tree exceeds one read-copy frame, so Bonsai's
  // views answer "rebuilding" until foreground pages recover them; drive
  // those pages as the Bonsai UI does, then read the repository.
  const recovered = async (repo) => {
    const cursors = [];
    for (let cursor = null, done = false; !done;) {
      assert.ok(
        cursors.length < 200,
        `Bonsai's copies did not recover: ${JSON.stringify(cursors.slice(-5))}`,
      );
      const page = await call("bonsai", "rebuildCopies", { cursor });
      cursor = page.cursor;
      done = page.done;
      cursors.push(cursor);
    }
    return call("bonsai", "repos.get", { repo });
  };
  let edits = 0;
  for (const reviewBeforeInstall of [true, false]) {
    const workflowId = reviewBeforeInstall
      ? "build-on-merge-review"
      : "build-on-merge-auto";
    // The owner's arm-time choices: this App, its repository, its
    // installation and the Review before install setting.
    const definition = globalThis.structuredClone(template.definition);
    for (const node of definition.nodes)
      if (node.kind === "app")
        node.methodDigest = catalog.methods[node.method].digest;
    const [trigger] = definition.triggers;
    trigger.eventDigest = catalog.events["change.merged"].digest;
    trigger.when.tests[0].right = { literal: "my-bonsai" };
    trigger.input.appId = { literal: fork.appId };
    trigger.input.installationId = { literal: fork.installationId };
    trigger.input.reviewBeforeInstall = { literal: reviewBeforeInstall };
    const draft = await call("trellis", "saveDraft", {
      workflowId,
      expectedRevision: 0,
      draft: { definition, layout: template.layout },
    });
    assert.equal(draft.kind, "saved", JSON.stringify(draft));
    let published = await call("trellis", "publishWorkflow", {
      workflowId,
      expectedRevision: draft.revision,
    });
    if (published.kind === "publishing")
      published = await until(
        () =>
          call("trellis", "publicationStatus", {
            workflowId,
            publicationId: published.publicationId,
          }),
        (status) => status.kind !== "publishing",
        `${workflowId} publication`,
        60_000,
      );
    assert.equal(published.kind, "published", JSON.stringify(published));
    const armed = await call("trellis", "armEventTrigger", {
      workflowId,
      commit: published.commit,
      triggerId: trigger.id,
      bindings: { bonsai: "bonsai" },
    });
    assert.equal(armed.kind, "armed", JSON.stringify(armed));

    // An edit lands on the fork's main through a merged Change.
    edits += 1;
    const branch = `edit-${String(edits)}`;
    await hostGit("-C", "checkout", "checkout", "-qB", branch, "main");
    await writeFile(`${work}/checkout/BUILD-ON-MERGE.txt`, `edit ${branch}\n`);
    await hostGit("-C", "checkout", "add", "BUILD-ON-MERGE.txt");
    await hostGit(
      "-C",
      "checkout",
      "-c",
      "user.name=Owner",
      "-c",
      "user.email=owner@test.invalid",
      "commit",
      "-qm",
      `Edit ${branch}`,
    );
    const proposed = await hostGit("-C", "checkout", "rev-parse", "HEAD");
    await hostGit(
      "-C",
      "checkout",
      "-c",
      `http.extraHeader=Authorization: Bearer ${key}`,
      "push",
      "-q",
      `${origin}/git/bonsai/my-bonsai.git`,
      `${branch}:refs/heads/${branch}`,
    );
    await until(
      () => recovered("my-bonsai"),
      (detail) =>
        detail.refs?.some(
          (ref) => ref.name === `refs/heads/${branch}` && ref.hash === proposed,
        ),
      `${branch} lands in Bonsai`,
      60_000,
    );
    const change = await call("bonsai", "changes.open", {
      repo: "my-bonsai",
      sourceRef: branch,
      targetRef: "main",
      title: `Build on merge ${branch}`,
    });
    assert.ok(!("error" in change), JSON.stringify(change));
    await call("bonsai", "changes.merge", {
      repo: "my-bonsai",
      number: change.number,
      head: proposed,
    });
    const merged = await until(
      () =>
        call("bonsai", "changes.get", {
          repo: "my-bonsai",
          number: change.number,
        }),
      (detail) =>
        "change" in detail &&
        (detail.change.state === "merged" ||
          detail.change.mergeFailure !== undefined),
      `Change #${String(change.number)} merges`,
      120_000,
    );
    assert.equal(merged.change.state, "merged", JSON.stringify(merged));
    const mergedCommit = merged.change.mergedCommit;
    await hostGit("-C", "checkout", "checkout", "-q", "main");
    await hostGit("-C", "checkout", "merge", "-q", "--ff-only", proposed);
    log(`step: ${branch} merged at ${mergedCommit}; awaiting ${workflowId}`);

    const [run] = await until(
      () => call("trellis", "listRuns", { workflowId }),
      (rows) => rows.some((row) => row.source === "event"),
      `the merge starts ${workflowId}`,
      60_000,
    );
    const status = () => call("trellis", "runStatus", { runId: run.runId });
    const buildStarted = Date.now();
    if (reviewBeforeInstall) {
      await until(
        status,
        (value) => {
          assert.notEqual(value.outcome, "terminal", JSON.stringify(value));
          return value.reviews.some((row) => row.status === "pending");
        },
        `${workflowId} waits for review after a passing build`,
        960_000,
      );
      const before = (await owner("GET", "/api/installations")).body;
      assert.ok(
        !before.some((row) => row.installationId === fork.installationId),
        "Nothing installs before the owner approves",
      );
      assert.deepEqual(
        await call("trellis", "answerReview", {
          runId: run.runId,
          nodeId: "review",
          iteration: "0",
          answer: { approved: true },
        }),
        { result: "accepted" },
      );
    }
    const finished = await until(
      status,
      (value) => value.outcome !== "active",
      `${workflowId} finishes`,
      960_000,
    );
    timings[workflowId] = Date.now() - buildStarted;
    assert.equal(finished.outcome, "terminal", JSON.stringify(finished));
    assert.equal(finished.error, null, JSON.stringify(finished));
    const installations = (await owner("GET", "/api/installations")).body;
    const installed = installations.find(
      (row) => row.installationId === fork.installationId,
    );
    assert.ok(installed, JSON.stringify(installations));
    assert.equal(installed.release.appId, fork.appId);
    // The installed Release is the exact merged commit's build.
    assert.equal(
      installed.release.artifact.provenance.sourceRevision,
      `git:${mergedCommit}`,
    );
    assert.equal(
      finished.reviews.length,
      reviewBeforeInstall ? 1 : 0,
      JSON.stringify(finished.reviews),
    );
    // The run holds no key: it ran as the owner who armed it.
    const record = JSON.stringify([run, finished]);
    assert.ok(!record.includes(key), "The run record carries no owner key");
    assert.doesNotMatch(record, /obp\.|uploadGrant|Authorization/u);
    assert.deepEqual(
      await call("trellis", "disarmEventTrigger", {
        eventTriggerId: armed.eventTriggerId,
      }),
      { kind: "disarmed" },
    );
    log(
      `step: ${workflowId} installed ${installed.release.releaseId} in ${String(timings[workflowId])}ms`,
    );
  }
  log(
    `PASS app build native proof ${JSON.stringify(timings)} ${view.release.releaseId}`,
  );
} catch (cause) {
  error(redact(output));
  throw cause;
} finally {
  worker.kill("SIGTERM");
  await stopped;
  await provider.close();
  await rm(work, { recursive: true, force: true });
}
