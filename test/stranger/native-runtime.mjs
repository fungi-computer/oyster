// Copied into a fresh tarball-installed consumer by qualify-packed.mjs.
// Every library import below resolves from that consumer, never the workspace.
import assert from "node:assert/strict";
import {
  OysterMcp,
  createOysterMcpOwner,
} from "@fungi.computer/oyster/workers";
import {
  createOysterGitMcpOwner,
  oysterGitRoot,
  ownerOrKeyTenancy,
} from "@fungi.computer/oyster/workers-git";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { instanceIds } from "@fungi.computer/oyster";
import { createCloudflareAppInstance } from "@fungi.computer/oyster/cloudflare";

export class PackedOysterProof extends DurableObject {
  async prove() {
    const FactoryOwner = createOysterMcpOwner(() => {
      throw new Error("A wrong namespace must not acquire a host");
    });
    const GitOwner = createOysterGitMcpOwner(
      oysterGitRoot({ tenancy: ownerOrKeyTenancy }),
    );
    for (const Owner of [OysterMcp, FactoryOwner, GitOwner]) {
      const owner = new Owner(this.ctx, this.env);
      const refused = await owner.serve(
        new globalThis.Request("https://packed.test/mcp"),
        { tenantId: "default", origin: "https://packed.test" },
      );
      assert.equal(refused.status, 404);
    }
    const instanceId = this.ctx.id.name;
    const facetCalls = [];
    const context = {
      id: this.ctx.id,
      storage: this.ctx.storage,
      facets: {
        get: (...args) => {
          assert.fail("A disabled Instance must not start its facet");
          return this.ctx.facets.get(...args);
        },
        abort: (...args) => {
          facetCalls.push(`abort:${args[0]}`);
          return this.ctx.facets.abort(...args);
        },
        delete: (...args) => {
          facetCalls.push(`delete:${args[0]}`);
          return this.ctx.facets.delete(...args);
        },
      },
    };
    const native = createCloudflareAppInstance(
      context,
      undefined,
      () => Effect.fail(new Error("No Releases in this consumer")),
      () => ({}),
    );
    const state = {
      instanceId,
      owner: { kind: "installation", id: "installation_stranger" },
      appId: "app_stranger",
      releaseId: "rel_stranger",
      authorityVersion: 2,
      status: "disabled",
    };
    const persisted = await Effect.runPromise(native.apply(state));
    assert.equal(persisted.status, "disabled");
    assert.deepEqual(await Effect.runPromise(native.inspect()), persisted);
    assert.deepEqual(facetCalls, ["abort:app"]);
    return {
      runtime: "workerd",
      cloudflareAssertions: "pass",
      sqlite: "native",
      loaderCalls: 0,
    };
  }
}

export default {
  async fetch(_request, env) {
    const proof = await env.PROOF.getByName(
      instanceIds.instance.generate(),
    ).prove();
    return globalThis.Response.json(proof);
  },
};
