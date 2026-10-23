import { log, error } from "node:console";
import assert from "node:assert/strict";

import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { workflowNativeFixture } from "./workflow-native.fixture.mjs";
import { appBackend as bonsaiBackend } from "../../../../apps/bonsai/backend/methods.ts";
import bonsaiMetadata from "../../../../apps/bonsai/package.json" with { type: "json" };
const bonsaiDeclaration = buildAppDeclaration(
  bonsaiBackend,
  bonsaiMetadata.fungi.app,
);
const fixture = await workflowNativeFixture({
  main: "workflows-root.fixture.ts",
  oysterOrigin: "https://oyster.test",
});
const { provider, runtime, call, installFirstParty } = fixture;
try {
  await installFirstParty("bonsai", bonsaiDeclaration);
  await fixture.approve("bonsai");
  assert.deepEqual(await call("bonsai", "repos.list", {}), { repos: [] });
  const before = provider.requests.length;
  const created = await call("bonsai", "repos.create", {
    name: "pond",
    description: "Native provider proof",
  });
  assert.equal(created.name, "pond");
  assert.ok(
    provider.requests.length > before,
    "the native command path reaches the local provider",
  );
  const repos = await call("bonsai", "repos.list", {});
  assert.equal(repos.repos[0].name, "pond");
  log(
    `PASS ${runtime}: native Bonsai repos.create reaches local provider and persists its result`,
  );
} catch (cause) {
  error(fixture.diagnostics());
  throw cause;
} finally {
  await fixture.close();
}
