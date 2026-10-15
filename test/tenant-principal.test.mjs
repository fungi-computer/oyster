import assert from "node:assert/strict";
import test from "node:test";
import { createOyster } from "../dist/host.js";
import { computerHost } from "./computer-host.fixture.mjs";

for (const role of ["owner", "member"]) {
  test(`tenant ${role} retains its canonical caller and only owners manage the host`, async () => {
    const principal = {
      actor: { kind: "member", memberId: "stored-member" },
      role,
    };
    const host = await computerHost(principal, "fixed-computer");
    const app = createOyster({
      ...host,
      workbench: { directory: async () => ({ installations: [] }) },
    });
    const directory = await app.request("/api/workbench/directory");
    assert.equal(directory.status, role === "owner" ? 200 : 403);
    const response = await app.request("/apps/context-probe/methods/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ...principal,
      computerId: "fixed-computer",
    });
  });
}
for (const actor of [
  { kind: "agent", agentId: "stored-agent" },
  { kind: "team-key", keyId: "stored-key" },
]) {
  test(`canonical ${actor.kind} retains its own actor and cannot manage the host`, async () => {
    const host = await computerHost({ actor }, "fixed-computer");
    if (actor.kind === "agent")
      host.appToolPolicy = () => ({
        level: "read",
        revision: "canonical-context-read-1",
        grantedBy: "fixture-owner",
      });
    else
      host.keys = {
        live: async (keyId) => ({
          keyId,
          owner: "fixture-owner",
          grantVersion: 1,
          grants: [{ capability: "apps.read", targets: { kind: "all" } }],
        }),
      };
    const app = createOyster(host);
    assert.equal((await app.request("/api/workbench/directory")).status, 403);
    const response = await app.request("/apps/context-probe/methods/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      actor,
      computerId: "fixed-computer",
    });
  });
}

for (const status of [404, 429]) {
  test(`tenant refusal ${status} is preserved before visitor fallback or HTML login redirect`, async () => {
    const host = await computerHost(
      { actor: { kind: "member", memberId: "owner" }, role: "owner" },
      null,
    );
    const app = createOyster({
      ...host,
      auth: {
        authenticate: async () => ({ kind: "refused", status, retryAfter: 9 }),
      },
    });
    for (const path of ["/", "/api/installations"]) {
      const response = await app.request(path, {
        headers: { Accept: "text/html" },
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("Retry-After"), "9");
      assert.equal(response.headers.get("Location"), null);
    }
  });
}
