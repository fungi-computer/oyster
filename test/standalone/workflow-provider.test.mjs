import assert from "node:assert/strict";
import { it } from "node:test";
import { createArtifactsRestNamespace } from "@fungi.computer/burrow";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";

void it("the local provider completes real Burrow initial-token revocation before create/fork return", async (t) => {
  const provider = await workflowGitProvider();
  t.after(() => provider.close());
  const namespace = createArtifactsRestNamespace({
    accountId: "workflow-proof",
    namespace: "local",
    apiToken: "local-provider",
    fetch(input, init) {
      const request = new globalThis.Request(input, init);
      const url = new globalThis.URL(request.url);
      return globalThis.fetch(
        new globalThis.Request(
          new globalThis.URL(url.pathname + url.search, provider.origin),
          request,
        ),
      );
    },
  });
  await namespace.create("first", {
    description: "",
    setDefaultBranch: "main",
  });
  const first = await namespace.get("first");
  assert.ok(first);
  await first.fork("second", { description: "" });
  const second = await namespace.get("second");
  assert.ok(second);
  for (const name of ["first", "second"]) {
    const path = `/client/v4/accounts/workflow-proof/artifacts/namespaces/local/repos/${name}/tokens`;
    assert.equal(
      provider.requests.filter((request) => request === `GET ${path}`).length,
      2,
    );
    const response = await globalThis.fetch(
      new globalThis.URL(
        `${path}?state=all&per_page=100&page=1`,
        provider.origin,
      ),
    );
    const body = await response.json();
    assert.deepEqual(body.result_info, { total_pages: 1, total_count: 1 });
    assert.deepEqual(body.result, [
      { id: `${name}-initial`, state: "revoked" },
    ]);
  }
  const token = await first.createToken("read", 60);
  assert.ok(token.id);
  assert.ok(token.plaintext);
  assert.ok(Date.parse(token.expiresAt) > Date.now());
  assert.equal(await first.revokeToken(token.id), true);
});
