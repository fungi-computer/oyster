import assert from "node:assert/strict";
import { test } from "node:test";
import { createArtifactsRestNamespace } from "@fungi.computer/burrow";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";

test("local Git provider honors repository identity and initial-token revocation", async () => {
  const provider = await workflowGitProvider();
  try {
    const namespace = createArtifactsRestNamespace({
      accountId: "workflow-proof",
      namespace: "local",
      apiToken: "local-provider",
      fetch: (input, init) => {
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
    const created = await namespace.create("fixture-contract", {
      setDefaultBranch: "main",
    });
    assert.equal(created.name, "fixture-contract");
    const repository = await namespace.get("fixture-contract");
    assert.equal((await repository.info()).name, "fixture-contract");
    assert.equal(
      await repository.revokeToken(created.token),
      false,
      "The parser already revoked the automatically issued token",
    );
    const minted = await repository.createToken("read", 60);
    assert.ok(minted.id);
    assert.ok(minted.expiresAt);
    assert.equal(await repository.revokeToken(minted.id), true);
  } finally {
    await provider.close();
  }
});
