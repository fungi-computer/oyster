import {
  nativeWorkflowHost,
  nativeAppClient,
  nativeFixtureWorkspace,
  until,
} from "./workflow-native.fixture.mjs";
import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
import process from "node:process";
import { existsSync } from "node:fs";
import * as Schema from "effect/Schema";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { log, error } from "node:console";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { readFile } from "node:fs/promises";

import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { packRelease, installRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";

const root = fileURLToPath(new URL("../../", import.meta.url));

const { work, config } = await nativeFixtureWorkspace(
  root,
  "workflows-native-",
);

config.main = `${root}test/standalone/workflows-root.fixture.ts`;

const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";

const nativeHost = await nativeWorkflowHost({
  root,
  work,
  config,
  oysterOrigin: "https://oyster.test",
});
const { key, provider, origin, auth } = nativeHost;

const { call } = nativeAppClient(origin, auth);
async function installWorkflows() {
  const repository = fileURLToPath(new URL("../../../../", import.meta.url));
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const app = standaloneAppSet.find(
    (candidate) => candidate.installationId === "trellis",
  );
  assert.ok(app);
  const directory = `${root}.botanical/workflows-copy-release/${revision}`;
  if (!existsSync(`${directory}/release.json`))
    await packRelease({
      appId: app.appId,
      sourceDirectory: repository,
      sourceRevision: `git:${revision}`,
      packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      recipe: committedAppRecipe(repository, app, revision),
      outDirectory: directory,
    });
  const release = Schema.decodeUnknownSync(
    Schema.fromJsonString(releaseSchema),
  )(await readFile(`${directory}/release.json`, "utf8"));
  assert.equal(release.artifact.provenance.sourceRevision, `git:${revision}`);
  const response = await installRelease({
    directory,
    url: origin,
    key,
    installationId: "trellis",
  });
  assert.equal(response.status, 201, await response.text());
}

try {
  await until(
    async () =>
      globalThis
        .fetch(`${origin}/login`, {
          signal: globalThis.AbortSignal.timeout(1000),
        })
        .then(
          (r) => r.ok,
          () => false,
        ),
    (ready) => ready,
    "standalone root readiness",
  );
  await installWorkflows();
  const draft = {
    definition: {
      format: "fungi.workflow/v1",
      title: "Native saved copy",
      apps: {},
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [],
      edges: [],
      output: {},
    },
    layout: {},
  };
  const saved = await call("trellis", "saveDraft", {
    workflowId: "pond",
    expectedRevision: 0,
    draft,
  });
  assert.equal(saved.kind, "saved");
  const published = await call("trellis", "publishWorkflow", {
    workflowId: "pond",
    expectedRevision: saved.revision,
  });
  assert.equal(published.kind, "published");
  await delay(1500);
  // Force the counted native RPC path even though the saved screen copies exist.
  let cursor = null;
  for (let page = 0; ; page++) {
    assert.ok(page < 1024, "foreground reconstruction remains bounded");
    const rebuilt = await call("trellis", "rebuildCopies", { cursor });
    if (rebuilt.done) break;
    cursor = rebuilt.cursor;
  }
  const before = provider.requests.length;
  for (let repeat = 0; repeat < 2; repeat++) {
    const document = await call("trellis", "loadWorkflow", {
      workflowId: "pond",
      at: "draft",
    });
    assert.equal(document.definition.title, draft.definition.title);
    const versions = await call("trellis", "listVersions", {
      workflowId: "pond",
    });
    assert.equal(versions.length, 1);
    const listings = await call("trellis", "listWorkflows", { limit: 100 });
    assert.equal(listings.items.length, 1);
    assert.equal(listings.items[0].title, draft.definition.title);
  }
  assert.equal(
    provider.requests.length - before,
    0,
    "warm screens make zero provider calls across native facets",
  );
  log(
    `PASS saved Workflows ${runtime}: native Loader, durable SQLite, warm document/versions/list provider calls 0`,
  );
} catch (cause) {
  error(nativeHost.output().replaceAll(key, "[redacted]"));
  error(provider.requests);
  throw cause;
} finally {
  await nativeHost.close();
}
