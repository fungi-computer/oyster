import {
  connectGuest,
  expectPublicDownload,
} from "./computer-egress-guest.fixture.mjs";
import {
  nativeWorkflowRoot,
  nativeAppClient,
} from "./workflow-native.fixture.mjs";
// Standalone Oyster's Computer egress, end to end on real local containers: the
// production root (landed-push-root.fixture.ts) with real Bonsai installed,
// proof-owned fleet Computers, and a guest `git` reaching
// https://oyster.test over the container's HTTPS interception -> ComputerDO ->
// OysterComputerEgress -> this Worker's own default export. Public package
// downloads follow each Computer's live switch and the global override;
// origin Git keeps its separate credential policy.
//
// Uses the same owned local-container fixture as the native Workflow proof;
// no shared lab VM, callback slot or provider credentials are required.

import { log, error } from "node:console";
import assert from "node:assert/strict";

import { mkdir, readFile, writeFile } from "node:fs/promises";

import { URL, fileURLToPath } from "node:url";

import * as z from "zod";

import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { teamComputerSchema } from "@fungi.computer/nacre/workbench";
import { appBackend } from "../../../../apps/bonsai/backend/methods.ts";
import packageMetadata from "../../../../apps/bonsai/package.json" with { type: "json" };

const appDeclaration = buildAppDeclaration(
  appBackend,
  packageMetadata.fungi.app,
);
const root = fileURLToPath(new URL("../../", import.meta.url));

const nativeHost = await nativeWorkflowRoot({
  root,
  prefix: "computer-egress-native-",
  main: "landed-push-root.fixture.ts",
  artifactBucket: "computer-egress-native-app-artifacts",
  computer: "platform-container",
  computerInstances: 2,
});
const {
  work,
  tenantHost,
  key,
  origin,
  auth,
  redact,
  git: hostGit,
} = nativeHost;

const { call, installFirstParty, approve } = nativeAppClient(origin, auth, {
  key,
  requestMilliseconds: 120_000,
  installationMilliseconds: 120_000,
});

const jsonAuth = {
  ...auth,
  Accept: "application/json",
  "Content-Type": "application/json",
};
const settingUrl = (computerId) =>
  `${origin}/api/computers/${encodeURIComponent(computerId)}/internet-access`;

async function createComputer(name) {
  const response = await globalThis.fetch(`${origin}/api/computers`, {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ name, requestId: `egress-${name}` }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return teamComputerSchema.parse(await response.json()).computerId;
}

async function internetAccess(computerId, enabled) {
  const request = {
    method: enabled === undefined ? "GET" : "PUT",
    headers: jsonAuth,
  };
  if (enabled !== undefined) request.body = JSON.stringify({ enabled });
  const response = await globalThis.fetch(settingUrl(computerId), request);
  assert.equal(response.status, 200, await response.clone().text());
  return z.strictObject({ enabled: z.boolean() }).parse(await response.json())
    .enabled;
}

const timings = {};
try {
  await nativeHost.ready();
  log("step: Oyster ready; installing Bonsai");
  await installFirstParty("bonsai", appDeclaration);
  await approve("bonsai");
  log("step: Bonsai installed; creating pond");
  await call("bonsai", "repos.create", { name: "pond" });
  // One commit from the host, through the same door, so ls-remote has a ref.
  await mkdir(`${work}/checkout`);
  await hostGit("-C", "checkout", "init", "-q", "-b", "main");
  await writeFile(`${work}/checkout/hello.txt`, "hello\n");
  await hostGit("-C", "checkout", "add", "hello.txt");
  await hostGit(
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
  await hostGit(
    "-C",
    "checkout",
    "-c",
    `http.extraHeader=Authorization: Bearer ${key}`,
    "push",
    "-q",
    `${origin}/git/bonsai/pond.git`,
    "main",
  );
  const head = await hostGit("-C", "checkout", "rev-parse", "HEAD");
  log("step: pond seeded from the host; connecting MCP");

  const computerA = await createComputer("Egress A");
  const computerB = await createComputer("Egress B");
  assert.notEqual(computerA, computerB);
  assert.equal(await internetAccess(computerA), true);
  assert.equal(await internetAccess(computerB), true);
  assert.equal(await internetAccess(computerA, false), false);
  const refusedWrite = await globalThis.fetch(settingUrl(computerA), {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled: true }),
    redirect: "manual",
  });
  assert.ok([401, 403].includes(refusedWrite.status));
  assert.equal(await internetAccess(computerA), false);
  assert.equal(await internetAccess(computerB), true);

  const connection = await connectGuest(nativeHost, computerA);
  const { guest } = connection;
  try {
    const remote = `https://${tenantHost}/git/bonsai/pond.git`;
    const listed = await guest(
      `git -c "http.extraHeader=Authorization: Bearer ${key}" ls-remote ${remote}`,
    );
    timings.lsRemote = listed.ms;
    assert.match(listed.text, new RegExp(`${head}\\s+refs/heads/main`, "u"));
    assert.match(listed.text, /exit=0/u);
    log(`PASS guest git ls-remote ${remote} -> ${head} (${listed.ms}ms)`);

    // No credential: the egress adds none, so the door challenges.
    const anonymous = await guest(`git ls-remote ${remote}`);
    assert.doesNotMatch(anonymous.text, /exit=0/u);
    assert.doesNotMatch(anonymous.text, new RegExp(head, "u"));
    log("PASS guest git without a credential is challenged by Oyster's door");

    for (const outside of [
      "https://example.com/",
      "https://github.com/git/git.git/info/refs?service=git-upload-pack",
      `https://${tenantHost}/api/installations`,
    ]) {
      const refused = await guest(
        `curl -sS -o /dev/null -w "status=%{http_code}" ${JSON.stringify(outside)}`,
      );
      assert.match(refused.text, /status=403/u, `${outside}: ${refused.text}`);
      log(`PASS guest ${outside} refused by the egress gateway (403)`);
    }
  } finally {
    await connection.close();
  }
  assert.match(
    nativeHost.output(),
    /"event":"computer\.egress".*"lane":"origin-git"/u,
    "The gateway recorded the admitted Oyster Git lane",
  );

  await expectPublicDownload(nativeHost, computerA, 403);
  await expectPublicDownload(nativeHost, computerB, 200);
  assert.equal(await internetAccess(computerA, true), true);
  assert.equal(await internetAccess(computerB, false), false);
  await expectPublicDownload(nativeHost, computerA, 200);
  await expectPublicDownload(nativeHost, computerB, 403);
  assert.equal(await internetAccess(computerA, false), false);
  assert.equal(await internetAccess(computerB, true), true);

  await nativeHost.restart();
  assert.equal(await internetAccess(computerA), false);
  assert.equal(await internetAccess(computerB), true);
  await expectPublicDownload(nativeHost, computerA, 403);
  await expectPublicDownload(nativeHost, computerB, 200);
  log("PASS per-Computer settings and actual egress survive Worker restart");

  // The operator override changes only this proof's disposable local config.
  const configPath = `${work}/wrangler.json`;
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.vars.COMPUTER_PUBLIC_EGRESS = "disabled";
  await writeFile(configPath, JSON.stringify(config));
  await nativeHost.restart();
  assert.equal(await internetAccess(computerB), true);
  await expectPublicDownload(nativeHost, computerB, 403);
  log("PASS global off overrides a persisted Computer-on setting");
  log(
    `PASS computer egress native proof (${nativeHost.runtime}) ${JSON.stringify(timings)}`,
  );
} catch (cause) {
  error(redact(nativeHost.output()));
  throw cause;
} finally {
  await nativeHost.close();
}
