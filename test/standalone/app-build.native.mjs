import { grantDeclaredAppCapabilities } from "./owner-grants.fixture.mjs";
import {
  nativeLabAppHost,
  nativeAppClient,
} from "./workflow-native.fixture.mjs";
import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
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
// Then an accepted main merge on the registered fork starts Bonsai's retained
// build/verify/install Workflow without trigger arming or a review step.
//
// This lab qualification requires an explicitly supplied, already-authorized
// OYSTER_PROOF_ENV_FILE. No VM/lab slot is available in this writing lane.
// Installed-Release acceptance uses the separately authorized throwaway hosted
// preview runner at the exact bundle SHA; this script does not create a slot.
import { log, error } from "node:console";
import assert from "node:assert/strict";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend } from "../../../../apps/bonsai/backend/methods.ts";
import packageMetadata from "../../../../apps/bonsai/package.json" with { type: "json" };

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { parseSourceRevision } from "@fungi.computer/puffball";
import {
  createFirstPartyAppSourceDistribution,
  createLocalCommitSourceCapture,
} from "@fungi.computer/oyster/build";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";

const appDeclaration = buildAppDeclaration(
  appBackend,
  packageMetadata.fungi.app,
);
const root = fileURLToPath(new URL("../../", import.meta.url));

// Redacted worker log, kept after the run for diagnosis.

const nativeHost = await nativeLabAppHost(root, "app-build-native");
const { work, key, origin, auth, redact, git: hostGit } = nativeHost;

const { call, installFirstParty } = nativeAppClient(origin, auth, {
  key,
  requestMilliseconds: 120_000,
  installationMilliseconds: 120_000,
});

const timings = {};
try {
  await nativeHost.ready();
  log("step: Oyster ready; installing Bonsai");
  await installFirstParty("bonsai", appDeclaration);
  await grantDeclaredAppCapabilities({
    origin,
    installationId: "bonsai",
    headers: auth,
  });

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
          entry: committedAppRecipe(repository, bonsai, revision).entry,
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
  const registered = await call("bonsai", "apps.register", {
    repo: "bonsai-source",
  });
  assert.deepEqual(registered, {
    appId: bonsai.appId,
    sourceRevision: "git:" + head,
  });
  const started = Date.now();
  const build = await owner("POST", "/api/builds", {
    appId: "app_bonsai",
    sourceRevision: `git:${head}`,
  });
  assert.equal(build.status, 202, JSON.stringify(build.body));
  log(`step: build ${build.body.jobId} started for ${build.body.releaseId}`);
  let view = build.body;
  while (view.status === "running") {
    assert.equal(nativeHost.exitCode, null, "Standalone Oyster exited");
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
    nativeHost.output(),
    /"lane":"internal-git"/u,
    "The build clone and report used the build lanes",
  );
  assert.match(
    nativeHost.output(),
    /"lane":"public"/u,
    "Packages came over the public lane",
  );

  // No arming/configuration step: registration plus an accepted main update
  // starts the retained Workflow under the host's lifecycle authority.
  const fork = { appId: "app_mybonsai", installationId: "my-bonsai" };
  await call("bonsai", "repos.create", { name: "my-bonsai" });
  // This copy is a distinct App: commit its identity, not a registration override.
  // Preserve every other npm and fungi field in the projected manifest.
  const forkPackagePath = join(work, "checkout", "package.json");
  const forkPackage = JSON.parse(await readFile(forkPackagePath, "utf8"));
  await writeFile(
    forkPackagePath,
    JSON.stringify(
      {
        ...forkPackage,
        fungi: { ...forkPackage.fungi, appId: fork.appId },
      },
      null,
      2,
    ) + "\n",
  );
  await hostGit("-C", "checkout", "add", "package.json");
  await hostGit(
    "-C",
    "checkout",
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@test.invalid",
    "commit",
    "-qm",
    "Give the copied App its own identity",
  );
  const forkHead = await hostGit("-C", "checkout", "rev-parse", "HEAD");
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
  const forkSource = await call("bonsai", "apps.register", {
    repo: "my-bonsai",
  });
  assert.deepEqual(forkSource, {
    appId: fork.appId,
    sourceRevision: "git:" + forkHead,
  });
  const until = async (read, accepts, label, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      assert.equal(nativeHost.exitCode, null, "Standalone Oyster exited");
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
  const beforeMerge = await call("bonsai", "apps.buildWorkflowRuns", {});
  assert.ok("runs" in beforeMerge, JSON.stringify(beforeMerge));
  const previousRuns = new Set(beforeMerge.runs.map((run) => run.runId));
  {
    const workflowId = "bonsai-build-on-merge";
    // An edit lands on the fork's main through a merged Change.
    const branch = "edit-main";
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

    const listed = await until(
      () => call("bonsai", "apps.buildWorkflowRuns", {}),
      (reply) =>
        "runs" in reply &&
        reply.runs.some(
          (run) => run.source === "event" && !previousRuns.has(run.runId),
        ),
      "the accepted merge starts the retained build Workflow",
      60_000,
    );
    const run = listed.runs.find(
      (row) => row.source === "event" && !previousRuns.has(row.runId),
    );
    assert.ok(run, JSON.stringify(listed));
    const buildStarted = Date.now();
    const finished = await until(
      () => call("bonsai", "apps.buildWorkflowRun", { runId: run.runId }),
      (value) => "outcome" in value && value.outcome !== "active",
      "build, verify and install finish",
      960_000,
    );
    timings[workflowId] = Date.now() - buildStarted;
    assert.equal(finished.outcome, "terminal", JSON.stringify(finished));
    assert.equal(finished.error, null, JSON.stringify(finished));
    for (const nodeId of ["build", "verify", "install"])
      assert.ok(
        finished.events.some(
          (event) => event.nodeId === nodeId && event.state === "complete",
        ),
        JSON.stringify(finished),
      );
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
    assert.deepEqual(finished.reviews, []);
    // The host-owned run carries no owner credential.
    const record = JSON.stringify([run, finished]);
    assert.ok(!record.includes(key), "The run record carries no owner key");
    assert.doesNotMatch(record, /obp\.|uploadGrant|Authorization/u);
    log(
      `step: ${workflowId} installed ${installed.release.releaseId} in ${String(timings[workflowId])}ms`,
    );
  }
  log(
    `PASS app build native proof ${JSON.stringify(timings)} ${view.release.releaseId}`,
  );
} catch (cause) {
  error(redact(nativeHost.output()));
  throw cause;
} finally {
  await nativeHost.close();
}
