// A visibility change bumps the installation's authority version. The App
// Instance must be told, through the same `apply` RPC every other
// authority-changing route already uses, or every later method call keeps
// comparing against its stale cached version forever.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOyster } from "../dist/host.js";
import { computerHost } from "./computer-host.fixture.mjs";

test("an owner App method call still succeeds after a visibility change", async () => {
  const principal = {
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  };
  const host = await computerHost(principal, null, {
    api: {
      methods: {
        probe: {
          description: "A read probe used only by this test.",
          input: { type: "object" },
          output: { type: "object" },
          effect: "read",
          requires: [],
        },
      },
    },
  });
  let record = await host.installations.get("context-probe");
  assert.ok(record);
  const generation = await host.installations.generation();
  // The Instance's own view of its authority, set only by `apply`. A real
  // Instance refuses `call` the moment this disagrees with the installation's
  // current authority version.
  let appliedAuthorityVersion = null;
  const app = createOyster({
    ...host,
    installations: {
      ...host.installations,
      get: async (id) => (id === record.installationId ? record : null),
      compareAndPut: async (next, expected, expectedGeneration) => {
        if (expectedGeneration !== generation)
          return { ok: false, code: "stale_authority" };
        if (record.authority.authorityVersion !== expected)
          return { ok: false, code: "stale_authority" };
        record = next;
        return { ok: true };
      },
    },
    instances: {
      get: () => ({
        prepare: () => Promise.resolve({ ok: true, value: { kind: "passed" } }),
        apply: async (state) => {
          appliedAuthorityVersion = state.authorityVersion;
          return {
            ok: true,
            value: {
              ...state,
              stateSchema: 1,
              desiredStatus: state.status,
              status: state.status === "enabled" ? "active" : state.status,
            },
          };
        },
        call: async (facts) =>
          appliedAuthorityVersion !== null &&
          appliedAuthorityVersion === facts.selection.authorityVersion
            ? { ok: true, value: { kind: "ok", value: { probed: true } } }
            : { ok: false, code: "instance_authority_version_mismatch" },
      }),
    },
  });
  const probe = () =>
    app.request("/apps/context-probe/methods/probe", {
      method: "POST",
      headers: { Authorization: "owner", "Content-Type": "application/json" },
      body: "{}",
    });
  // Prime the Instance at its install-time authority, exactly like a real
  // install does, so the test starts from a Instance that already agrees.
  appliedAuthorityVersion = record.authority.authorityVersion;
  assert.equal((await probe()).status, 200, "A fresh install must agree");
  const authorityBeforeChange = record.authority.authorityVersion;
  const changed = await app.request(
    "/api/installations/context-probe/visibility",
    {
      method: "PUT",
      headers: {
        Authorization: "owner",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ visibility: "public" }),
    },
  );
  assert.equal(changed.status, 200, "The visibility PUT itself must succeed");
  assert.equal(record.visibility, "public");
  assert.equal(
    record.authority.authorityVersion,
    authorityBeforeChange + 1,
    "Changing visibility must bump the installation's authority version",
  );
  const response = await probe();
  const body = await response.json();
  assert.equal(
    response.status,
    200,
    `An owner method call must still succeed after a visibility change, not: ${JSON.stringify(body)}`,
  );
  assert.deepEqual(body, { probed: true });
});
