import process from "node:process";
import { log, error } from "node:console";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { mkdir, writeFile } from "node:fs/promises";

import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import * as z from "zod";
import {
  commitDetail,
  repoDetail,
} from "../../../../apps/bonsai/shared/contract.ts";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const root = fileURLToPath(new URL("../../", import.meta.url));
// A frozen pnpm install is the only preparation required. Build the maintained
// dependency closure and generated root page before importing their outputs.
for (const args of [
  [
    "--workspace-root",
    "run",
    "turbo:run",
    "run",
    "build",
    "--filter=@fungi.computer/oyster...",
    "--concurrency=3",
    "--output-logs=errors-only",
  ],
]) {
  const prepared = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  assert.equal(prepared.status, 0, "Native push proof prerequisites failed");
}
const { grantDeclaredAppCapabilities } =
  await import("./owner-grants.fixture.mjs");
const { committedAppRecipe } =
  await import("./committed-app-recipe.fixture.mjs");
const {
  runNativeGit,
  nativeWorkflowHost,
  nativeAppClient,
  nativeFixtureWorkspace,
  until,
} = await import("./workflow-native.fixture.mjs");

const { buildAppDeclaration } =
  await import("@fungi.computer/agar/backend-declaration");
const { appBackend } =
  await import("../../../../apps/bonsai/backend/methods.ts");
const { publishSource } = await import("@fungi.computer/oyster/pack");
const { standaloneAppSet } =
  await import("@fungi.computer/oyster/standalone/app-set");
const { default: packageMetadata } = await import(
  "../../../../apps/bonsai/package.json",
  {
    with: { type: "json" },
  }
);
const appDeclaration = buildAppDeclaration(
  appBackend,
  packageMetadata.fungi.app,
);

const { work, config } = await nativeFixtureWorkspace(
  root,
  "landed-push-native-",
);

config.main = `${root}test/standalone/landed-push-git-only-root.fixture.ts`;

const nativeHost = await nativeWorkflowHost({
  root,
  work,
  config,
  oysterOrigin: "https://oyster.test",
});
const { key, provider, origin, auth } = nativeHost;

const { call, installFirstParty } = nativeAppClient(origin, auth, {
  key,
  requestMilliseconds: 60_000,
  installationMilliseconds: 60_000,
});

const redact = (text) => text.replaceAll(key, "[REDACTED]");
const gitEnvironment = { ...process.env };
delete gitEnvironment.GIT_TRACE;
delete gitEnvironment.GIT_TRACE_CURL;
delete gitEnvironment.GIT_CURL_VERBOSE;
delete gitEnvironment.GIT_TRACE_PACKET;
delete gitEnvironment.GIT_TRACE_REDACT;
function git(...args) {
  const result = spawnSync("git", args, {
    cwd: work,
    encoding: "utf8",
    env: {
      ...gitEnvironment,
    },
  });
  assert.equal(result.status, 0, redact(result.stderr));
  return result.stdout.trim();
}
/** Run git asynchronously: the native provider serves in this event loop. */

async function push(token, remote) {
  const { status, stdout, stderr } = await runNativeGit(
    ["push", remote, "main"],
    {
      cwd: `${work}/checkout`,
      env: {
        ...gitEnvironment,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
      },
    },
  );
  const text = stdout + stderr;
  return { status, output: redact(text.replaceAll(token, "[REDACTED]")) };
}
/** Read one native provider ref. */
async function remoteRef(remote, ref) {
  const { status, stdout, stderr } = await runNativeGit(
    ["ls-remote", remote, ref],
    { cwd: work, env: gitEnvironment },
  );
  assert.equal(status, 0, redact(stderr));
  return stdout.trim();
}
try {
  await nativeHost.ready({
    milliseconds: 60_000,
    interval: 100,
    label: "Production root did not become ready",
    requestMilliseconds: 2_000,
    boundRequestToDeadline: true,
  });
  // The starter installer's first act: the owner route publishes Tourtois's
  // editable source as this Oyster's template through the Registry's own
  // Artifacts namespace, over the same native Git provider.
  const [tourtois] = standaloneAppSet;
  assert.equal(tourtois?.installationId, "tourtois");
  const repository = fileURLToPath(new URL("../../../../", import.meta.url));
  const head = git("-C", repository, "rev-parse", "HEAD");
  const publish = async () => {
    const response = await publishSource({
      appId: tourtois.appId,
      entry: committedAppRecipe(repository, tourtois, head).entry,
      repositoryPath: repository,
      sourceRevision: `git:${head}`,
      recipe: committedAppRecipe(repository, tourtois, head),
      url: origin,
      key,
    });
    const text = await response.text();
    assert.equal(response.status, 200, `Tourtois source publish: ${text}`);
    return JSON.parse(text);
  };
  const published = await publish();
  assert.equal(published.kind, "recorded");
  assert.equal(published.receipt.sourceRevision, `git:${head}`);
  assert.ok(
    provider.requests.includes(
      "POST /git/templates/template-tourtois.git/git-receive-pack",
    ),
    "The template push reaches the native provider",
  );
  assert.equal(await publish().then((replay) => replay.kind), "existing");
  const template = await remoteRef(
    `${provider.origin}/git/template-tourtois.git`,
    "refs/heads/main",
  );
  assert.equal(
    `git:${template.split("\t")[0]}`,
    published.receipt.seedRevision,
    "The provider template main is the recorded seed",
  );
  log(
    "PASS owner route publishes the Tourtois source template on the provider",
  );
  await installFirstParty("bonsai", appDeclaration);
  await grantDeclaredAppCapabilities({
    origin,
    installationId: "bonsai",
    headers: auth,
  });
  await call("bonsai", "repos.create", { name: "pond" });
  await mkdir(`${work}/checkout`);
  git("-C", "checkout", "init", "-q", "-b", "main");
  await writeFile(`${work}/checkout/hello.txt`, "hello\n");
  git("-C", "checkout", "add", "hello.txt");
  git(
    "-C",
    "checkout",
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@test.invalid",
    "commit",
    "-qm",
    "Start pond",
  );
  const remote = `${origin}/git/bonsai/pond.git`;
  const pushed = await push(key, remote);
  assert.equal(
    pushed.status,
    0,
    `Ordinary owner git push failed: ${pushed.output}; provider Git requests: ${provider.requests.filter((request) => request.includes("/git/")).length}`,
  );
  const advertised = await globalThis.fetch(
    `${remote}/info/refs?service=git-receive-pack`,
    { headers: auth },
  );
  assert.equal(
    advertised.status,
    200,
    "Owner receive-pack advertisement refused",
  );
  const expected = git("-C", "checkout", "rev-parse", "HEAD");
  const detail = await call("bonsai", "repos.get", { repo: "pond" });
  assert.ok(
    detail.refs.some((ref) => ref.hash === expected),
    "Native provider did not retain the owner's commit",
  );
  assert.ok(
    provider.requests.some((request) => request.includes("git-receive-pack")),
    "Owner push never reached native Git",
  );
  const createdKey = await globalThis.fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "ada",
      grants: [{ capability: "apps.use", targets: { kind: "all" } }],
    }),
  });
  assert.equal(createdKey.status, 201, "Could not create the actual Agent key");
  const agent = z
    .object({
      plaintext: z.string(),
      key: z.object({ keyId: z.string() }),
    })
    .parse(await createdKey.json());
  // The key's own grants (apps.use, all) are its App access now, never a
  // stored approval; the installation's approvals stay the ceiling for
  // HTTP and MCP alike.
  const listAs = (headers) =>
    globalThis.fetch(`${origin}/apps/bonsai/methods/repos.list`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
      signal: globalThis.AbortSignal.timeout(30_000),
    });
  const keyAuth = { Authorization: `Bearer ${agent.plaintext}` };
  const keyed = await listAs(keyAuth);
  const keyedText = await keyed.text();
  assert.equal(keyed.status, 200, `Key repos.list: ${keyedText}`);
  assert.match(keyedText, /"pond"/u);
  // A headless client shaped like `claude -p`: a bare elicitation capability,
  // and every elicitation cancelled because no person can answer it. This
  // session stays open until the key is revoked below.
  const mcp = new Client(
    { name: "Bonsai key proof", version: "1" },
    { capabilities: { elicitation: {} } },
  );
  let elicited = 0;
  mcp.setRequestHandler("elicitation/create", () => {
    elicited += 1;
    return { action: "cancel" };
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    { requestInit: { headers: keyAuth } },
  );
  const executeAsKey = async (code) => {
    const result = await mcp.callTool({
      name: "execute",
      arguments: { code },
    });
    return { isError: result.isError, text: JSON.stringify(result.content) };
  };
  const layout = { view: "overview", placements: [] };
  await mcp.connect(transport);
  const listed = await executeAsKey("return await env.BONSAI.repos.list({})");
  assert.notEqual(listed.isError, true, listed.text);
  assert.match(listed.text, /pond/u);
  // The key's own apps.use grant is its write confirmation.
  const layoutSaved = await executeAsKey(
    `return await env.BONSAI.insights.layout.save({ repo: "pond", tiles: ${JSON.stringify(layout)} })`,
  );
  assert.notEqual(layoutSaved.isError, true, layoutSaved.text);
  assert.equal(elicited, 0, "An owner-approved key's App write is not asked");
  assert.equal((await listAs({})).status, 401, "Anonymous repos.list");
  assert.equal(
    (
      await globalThis.fetch(`${origin}/api/keys/revoke`, {
        method: "POST",
        headers: { ...keyAuth, "Content-Type": "application/json" },
        body: JSON.stringify({
          keyId: agent.key.keyId,
          requestId: "req-key-self-revoke",
        }),
      })
    ).status,
    403,
    "A key cannot revoke keys",
  );
  log("PASS owner-created key repos.list over HTTP and MCP; anonymous 401");
  const forksOf = async (repo) => {
    const response = await globalThis.fetch(
      `${origin}/apps/bonsai/methods/repos.get`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ repo }),
      },
    );
    assert.equal(response.status, 200);
    return repoDetail.parse(await response.json()).repo.forks;
  };
  // Each key is its own identity under the ADR (keys never become a member),
  // named by its keyId: it may push only to its own fork, repo--<keyId>, and
  // is refused on the canonical repository and on another key's fork.
  const ownFork = await call("bonsai", "repos.fork", { repo: "pond" }, keyAuth);
  assert.equal(ownFork.name, "pond--ada");
  assert.equal(ownFork.owner, "ada");
  assert.ok((await forksOf("pond")).includes("pond--ada"));
  // The fork starts as a copy of the canonical head, so push a real new
  // commit, not a no-op, to prove the push actually reaches native Git.
  await writeFile(`${work}/checkout/ada.txt`, "ada\n");
  git("-C", "checkout", "add", "ada.txt");
  git(
    "-C",
    "checkout",
    "-c",
    "user.name=Ada",
    "-c",
    "user.email=ada@test.invalid",
    "commit",
    "-qm",
    "Ada's fork work",
  );
  const ownForkRemote = `${origin}/git/bonsai/pond--ada.git`;
  const beforeOwnFork = provider.requests.length;
  const ownForkPush = await push(agent.plaintext, ownForkRemote);
  assert.equal(
    ownForkPush.status,
    0,
    `A key must push to its own fork: ${ownForkPush.output}`,
  );
  const ownForkRequests = provider.requests.slice(beforeOwnFork);
  assert.ok(
    ownForkRequests.some((request) => request.includes("git-receive-pack")),
    "Own-fork key push never reached native Git",
  );
  const ownForkHead = git("-C", "checkout", "rev-parse", "HEAD");
  // Under load, repos.get can run before the native provider's own
  // receive-pack has settled the ref; retry instead of asserting once.
  await until(
    () => call("bonsai", "repos.get", { repo: "pond--ada" }),
    (detail) => detail.refs.some((ref) => ref.hash === ownForkHead),
    "Native provider did not retain the key's own-fork push",
  );
  log("PASS a key pushes to its own fork over the real native Git path");
  // Bonsai's own domain refusal crosses the generic method dispatch typed:
  // the canonical repository still has a fork, so deletion is a conflict.
  const refusedDelete = await globalThis.fetch(
    `${origin}/apps/bonsai/methods/repos.delete`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "pond" }),
      signal: globalThis.AbortSignal.timeout(30_000),
    },
  );
  const refusedDeleteText = await refusedDelete.text();
  assert.equal(
    refusedDelete.status,
    409,
    `repos.delete with forks must be a typed conflict: ${refusedDeleteText}`,
  );
  assert.equal(JSON.parse(refusedDeleteText).error, "conflict");
  assert.ok(
    (await forksOf("pond")).includes("pond--ada"),
    "A refused deletion keeps the repository and its fork",
  );
  log(
    "PASS repos.delete with a fork returns 409 conflict through the method route",
  );
  const otherKey = await globalThis.fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "mallory",
      grants: [{ capability: "apps.use", targets: { kind: "all" } }],
    }),
  });
  assert.equal(otherKey.status, 201, "Could not create the other Agent key");
  const mallory = z
    .object({
      plaintext: z.string(),
      key: z.object({ keyId: z.string() }),
    })
    .parse(await otherKey.json());
  const malloryFork = await call(
    "bonsai",
    "repos.fork",
    { repo: "pond" },
    { Authorization: `Bearer ${mallory.plaintext}` },
  );
  assert.equal(malloryFork.name, "pond--mallory");
  const otherForkRemote = `${origin}/git/bonsai/pond--mallory.git`;
  const beforeOtherFork = provider.requests.length;
  const otherForkPush = await push(agent.plaintext, otherForkRemote);
  assert.notEqual(
    otherForkPush.status,
    0,
    "A key must not push to another key's fork",
  );
  assert.ok(
    otherForkPush.output.includes("Writer cannot push to this repository"),
    `Other key's fork push must be refused by the App: ${otherForkPush.output}`,
  );
  const otherForkRequests = provider.requests.slice(beforeOtherFork);
  assert.ok(
    !otherForkRequests.some((request) => request.includes("git-receive-pack")),
    `Refused other-fork push must not write to the provider: ${otherForkRequests.join(", ")}`,
  );
  const revokedMallory = await globalThis.fetch(`${origin}/api/keys/revoke`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      keyId: mallory.key.keyId,
      requestId: "req-mallory-revoke",
    }),
  });
  assert.equal(revokedMallory.status, 200, await revokedMallory.text());
  log(
    "PASS a key is refused pushing to another key's fork over the real native Git path",
  );
  await writeFile(`${work}/checkout/agent.txt`, "agent\n");
  git("-C", "checkout", "add", "agent.txt");
  git(
    "-C",
    "checkout",
    "-c",
    "user.name=Ada",
    "-c",
    "user.email=ada@test.invalid",
    "commit",
    "-qm",
    "Agent canonical attempt",
  );
  const beforeDenied = provider.requests.length;
  const denied = await push(agent.plaintext, remote);
  assert.notEqual(
    denied.status,
    0,
    "Agent must not push to the canonical repository",
  );
  assert.ok(
    denied.output.includes("Writer cannot push to this repository"),
    `Agent canonical push must be refused by the App: ${denied.output}`,
  );
  const deniedRequests = provider.requests.slice(beforeDenied);
  assert.ok(
    !deniedRequests.some((request) => request.includes("git-receive-pack")),
    `Refused Agent push must not write to the provider: ${deniedRequests.join(", ")}`,
  );
  const revoked = await globalThis.fetch(`${origin}/api/keys/revoke`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      keyId: agent.key.keyId,
      requestId: "req-key-owner-revoke",
    }),
  });
  assert.equal(revoked.status, 200, await revoked.text());
  assert.equal((await listAs(keyAuth)).status, 401, "Revoked key repos.list");
  await assert.rejects(
    new Client({ name: "Bonsai revoked key", version: "1" }).connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: keyAuth },
      }),
    ),
    "A revoked key opens no MCP session",
  );
  // The session opened before revocation cannot write: the very next call
  // re-admits the key and is refused, and the App state is unchanged. The
  // key's own fork from earlier (pond--ada) already exists; this must not
  // add or remove any fork.
  const forksBefore = await forksOf("pond");
  try {
    await assert.rejects(
      executeAsKey('return await env.BONSAI.repos.fork({ repo: "pond" })'),
      "A revoked key's open MCP session cannot write",
    );
  } finally {
    await mcp.close();
  }
  assert.deepEqual(
    await forksOf("pond"),
    forksBefore,
    "Refused write left the fork set unchanged",
  );
  log("PASS revoked key refused over HTTP and MCP, including its open session");
  // M1: a member save crosses the real host route, sealed origin, frame-close
  // wake, OysterBackground admission and revoked-until-admitted GIT binding.
  // The client never calls files.sync; only the host-armed replay may commit.
  const read = await call("bonsai", "files.read", {
    repo: "pond",
    ref: "main",
    path: "hello.txt",
  });
  assert.equal(read.text, "hello\n");
  assert.equal(read.commit, expected);
  const saved = await call("bonsai", "files.save", {
    repo: "pond",
    branch: "main",
    path: "hello.txt",
    baseBlob: read.blob,
    baseCommit: read.commit,
    text: "hello from Inkcap\n",
    revision: read.version,
  });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  assert.equal(saved.state, "pending");
  const syncDeadline = Date.now() + 60_000;
  let synced = read;
  while (synced.commit === expected || synced.pending !== undefined) {
    assert.ok(
      Date.now() < syncDeadline,
      `The host wake never synced the saved edit: ${JSON.stringify(synced)}`,
    );
    await delay(250);
    synced = await call("bonsai", "files.read", {
      repo: "pond",
      ref: "main",
      path: "hello.txt",
    });
  }
  assert.equal(synced.text, "hello from Inkcap\n");
  assert.equal(synced.version, saved.revision);
  const landed = commitDetail.parse(
    await call("bonsai", "commits.get", { repo: "pond", hash: synced.commit }),
  );
  assert.deepEqual(
    landed.commit.parents,
    [expected],
    "The member edit must commit directly on the base head",
  );
  assert.match(
    landed.commit.author.email,
    /@bonsai\.invalid$/u,
    "The member, not a host or seed identity, authors the synced edit",
  );
  log(
    "PASS member files.save through the production host route synced by the host-armed replay wake alone",
  );
  // A real accepted main push starts the retained Workflow. This runtime has
  // no attached backend (the fixture uses the real fleet creation projection):
  // it must stop honestly at the hosted boundary, not run
  // an App build locally or manufacture an installed Release.
  const appRepo = "app-boundary";
  const appRemote = origin + "/git/bonsai/" + appRepo + ".git";
  await call("bonsai", "repos.create", { name: appRepo });
  await writeFile(
    work + "/checkout/package.json",
    JSON.stringify({
      name: "native-build-boundary",
      fungi: {
        appId: "app_boundary",
        build: {
          entry: "index.html",
          backend: null,
          maxOutputBytes: 1048576,
        },
      },
    }),
  );
  await writeFile(
    work + "/checkout/index.html",
    "<!doctype html><h1>Boundary seed</h1>",
  );
  git("-C", "checkout", "add", "package.json", "index.html");
  git(
    "-C",
    "checkout",
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@test.invalid",
    "commit",
    "-qm",
    "Commit the App source",
  );
  const seedPush = await push(key, appRemote);
  assert.equal(seedPush.status, 0, seedPush.output);
  const registered = await call("bonsai", "apps.register", { repo: appRepo });
  assert.equal(registered.appId, "app_boundary");
  const before = await call("bonsai", "apps.buildWorkflowRuns", {});
  assert.ok("runs" in before, JSON.stringify(before));
  const previousRuns = new Set(before.runs.map((run) => run.runId));
  await writeFile(
    work + "/checkout/index.html",
    "<!doctype html><h1>Accepted main</h1>",
  );
  git("-C", "checkout", "add", "index.html");
  git(
    "-C",
    "checkout",
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@test.invalid",
    "commit",
    "-qm",
    "Push registered App main",
  );
  const acceptedHead = git("-C", "checkout", "rev-parse", "HEAD");
  const appPush = await push(key, appRemote);
  assert.equal(appPush.status, 0, appPush.output);
  const workflowDeadline = Date.now() + 60_000;
  let automatic;
  let finished;
  let lastListed;
  let lastStatus;
  while (finished === undefined) {
    assert.equal(
      nativeHost.exitCode,
      null,
      "Oyster exited during the build Workflow",
    );
    assert.ok(
      Date.now() < workflowDeadline,
      "Accepted main never reached the hosted-backend boundary: " +
        JSON.stringify({ lastListed, lastStatus }),
    );
    const listed = await call("bonsai", "apps.buildWorkflowRuns", {});
    lastListed = listed;
    assert.ok("runs" in listed, JSON.stringify(listed));
    automatic = listed.runs.find(
      (run) => run.source === "event" && !previousRuns.has(run.runId),
    );
    if (automatic !== undefined) {
      const status = await call("bonsai", "apps.buildWorkflowRun", {
        runId: automatic.runId,
      });
      lastStatus = status;
      if ("outcome" in status && status.outcome !== "active") finished = status;
    }
    if (finished === undefined) await delay(250);
  }
  assert.equal(automatic.workflowId, "bonsai-build-on-merge");
  assert.equal(automatic.initiatedBy.kind, "member");
  assert.ok(
    finished.events.some(
      (event) => event.nodeId === "build" && event.state === "failed",
    ),
    JSON.stringify(finished),
  );
  assert.match(
    JSON.stringify(finished),
    /No hosted build backend is attached to this Computer/u,
  );
  assert.ok(
    !finished.events.some(
      (event) =>
        ["verify", "install"].includes(event.nodeId) &&
        event.state === "complete",
    ),
    JSON.stringify(finished),
  );
  // The owner build door exposes the closed reason; the Workflow records its
  // caller-facing refusal. Neither preflight may create a job or installation.
  const refused = await globalThis.fetch(origin + "/api/builds", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: "app_boundary",
      sourceRevision: "git:" + acceptedHead,
    }),
  });
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), {
    code: "no_backend",
    error: "No hosted build backend is attached to this Computer",
  });
  assert.equal(
    await call("bonsai", "apps.buildStatus", { repo: appRepo }),
    null,
  );
  const inventory = await globalThis.fetch(origin + "/api/installations", {
    headers: auth,
  });
  assert.equal(inventory.status, 200);
  assert.ok(
    !(await inventory.json()).some((item) => item.installationId === appRepo),
  );
  log(
    "PASS accepted main → retained Workflow → build step refuses no_backend; no local build, job or install",
  );
  log(
    "PASS ordinary owner git push and receive-pack advertisement through production Oyster root into installed real Bonsai backend/native Git provider",
  );
} catch (cause) {
  error(redact(nativeHost.output()));
  throw cause;
} finally {
  await nativeHost.close();
}
