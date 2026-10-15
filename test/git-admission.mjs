/* global console, TextEncoder, TextDecoder, AbortController */
import assert from "node:assert/strict";
import { createAdmittedGit } from "../src/git.ts";

const calls = [];
const line = `${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\0report-status\n`;
const body = new TextEncoder().encode(
  (line.length + 4).toString(16).padStart(4, "0") + line + "0000",
);
const git = createAdmittedGit({
  installationId: "installation_a",
  store: {
    exchange: async () => {
      calls.push("provider");
      return { status: 200, headers: {}, body: new Uint8Array() };
    },
    refs: async () => [],
  },
  grants: {
    admits: async () => {
      calls.push("grant");
      return true;
    },
  },
  policy: {
    authorize: async () => {
      calls.push("policy");
      return {
        allowed: false,
        refused: [{ ref: "refs/heads/main", message: "open a Change" }],
      };
    },
  },
  journal: {
    tip: async () => null,
    record: async () => {
      calls.push("journal");
    },
  },
});
const response = await git.push(
  { kind: "actor", actor: { kind: "agent", agentId: "agent_morel" } },
  "notes",
  {
    service: "receive-pack",
    phase: "exchange",
    headers: {},
    body,
  },
);
assert.equal(response.status, 200);
assert.match(
  new TextDecoder().decode(response.body),
  /ng refs\/heads\/main open a Change/,
);
assert.deepEqual(calls, ["grant", "policy"]);
console.log("Git admission whole-push refusal: PASS");

// Git probes a chunked push with a lone flush: a write grant, no provider call.
calls.length = 0;
const probe = await git.push(
  { kind: "actor", actor: { kind: "agent", agentId: "agent_morel" } },
  "notes",
  {
    service: "receive-pack",
    phase: "exchange",
    headers: {},
    body: new TextEncoder().encode("0000"),
  },
);
assert.equal(probe.status, 200);
assert.equal(probe.body.byteLength, 0);
assert.deepEqual(calls, ["grant"]);
console.log("Git admission chunked-push probe: PASS");

const writer = {
  kind: "actor",
  actor: { kind: "agent", agentId: "agent_morel" },
};
const request = {
  service: "receive-pack",
  phase: "exchange",
  headers: {},
  body,
};
const report = new TextEncoder().encode(
  "000eunpack ok\n0017ok refs/heads/main\n0000",
);
function acceptedFixture(overrides = {}) {
  const calls = [];
  const facts = [];
  const ports = {
    installationId: "installation_a",
    store: {
      exchange: async () => {
        calls.push("provider");
        return { status: 200, headers: {}, body: report };
      },
      refs: async () => [],
    },
    grants: {
      admits: async () => {
        calls.push("grant");
        return true;
      },
    },
    policy: {
      authorize: async () => {
        calls.push("policy");
        return { allowed: true };
      },
    },
    journal: {
      tip: async () => {
        calls.push("tip");
        return null;
      },
      record: async (fact) => {
        calls.push("journal");
        facts.push(fact);
      },
    },
    ...overrides,
  };
  return { git: createAdmittedGit(ports), calls, facts };
}
{
  const fixture = acceptedFixture();
  const result = await fixture.git.push(writer, "notes", request);
  assert.equal(result.status, 200);
  assert.deepEqual(fixture.calls, [
    "grant",
    "policy",
    "tip",
    "grant",
    "provider",
    "journal",
  ]);
  assert.equal(fixture.facts.length, 1);
  const { eventId, ...fact } = fixture.facts[0];
  assert.ok(eventId);
  assert.deepEqual(fact, {
    repository: "notes",
    writer,
    updates: [
      { ref: "refs/heads/main", before: "0".repeat(40), after: "a".repeat(40) },
    ],
  });
}
{
  const fixture = acceptedFixture();
  const result = await fixture.git.push(
    {
      ...writer,
      workflow: {
        workflowId: "workflow_a",
        runId: "run_a",
        nodeId: "node_a",
        armedBy: { kind: "member", memberId: "member_a" },
        branches: ["refs/heads/work"],
      },
    },
    "notes",
    request,
  );
  assert.match(
    new TextDecoder().decode(result.body),
    /ng refs\/heads\/main outside the Workflow branch grant/,
  );
  assert.deepEqual(fixture.calls, ["grant"]);
}
{
  const fixture = acceptedFixture();
  await fixture.git
    .binding({ kind: "member", memberId: "member_a" })
    .exchange("notes", request);
  assert.deepEqual(fixture.calls, [
    "grant",
    "tip",
    "grant",
    "provider",
    "journal",
  ]);
  assert.deepEqual(fixture.facts[0].writer, {
    kind: "installation",
    installationId: "installation_a",
    onBehalfOf: { kind: "member", memberId: "member_a" },
  });
}
{
  const unavailable = new Error("journal unavailable");
  const fixture = acceptedFixture({
    journal: {
      tip: async () => null,
      record: async () => {
        throw unavailable;
      },
    },
  });
  await assert.rejects(
    fixture.git.push(writer, "notes", request),
    (error) => error === unavailable,
  );
  assert.equal(fixture.calls.filter((call) => call === "provider").length, 1);
}
{
  let live = true;
  const fixture = acceptedFixture({
    grants: { admits: async () => live },
    policy: {
      authorize: async () => {
        live = false;
        return { allowed: true };
      },
    },
  });
  await assert.rejects(
    fixture.git.push(writer, "notes", request),
    /host grant refused/,
  );
  assert.ok(!fixture.calls.includes("provider"));
}
{
  const controller = new AbortController();
  const expired = new Error("Invocation expired during Git admission");
  let admissions = 0;
  const fixture = acceptedFixture({
    beforeProvider: () => controller.signal.throwIfAborted(),
    grants: {
      admits: async () => {
        admissions++;
        if (admissions === 2) {
          await Promise.resolve();
          controller.abort(expired);
        }
        return true;
      },
    },
  });
  await assert.rejects(
    fixture.git
      .binding({ kind: "member", memberId: "member_a" })
      .exchange("notes", request),
    (error) => error === expired,
  );
  assert.equal(fixture.calls.includes("provider"), false);
  assert.equal(fixture.facts.length, 0);
}
console.log(
  "Git admission actor, Workflow ceiling, installation writes, revocation and durable journal: PASS",
);
