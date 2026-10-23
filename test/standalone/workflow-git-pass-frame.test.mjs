import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "cloudflare:workers" ||
      specifier === "cloudflare:workflows"
    )
      return {
        url: import.meta
          .resolve("@fungi.computer/oyster/testing/workers-runtime"),
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { StandaloneAgent } = await import("../../src/standalone/worker.ts");
const { defaultTenant, tenantScope } =
  await import("@fungi.computer/oyster/tenant");
hooks.deregister();

const origin = "https://workflow-git.invalid";

/** The real standalone root's Git host, reached as its Agent door does. */
class RootDoor extends StandaloneAgent {
  hostAt() {
    return this.hostFor(tenantScope(defaultTenant, origin));
  }
}

const bearer = (owner, digit) => "wgp." + owner + "." + digit.repeat(64);

async function standaloneGit() {
  const addressed = [];
  const presented = [];
  const env = {
    OYSTER_ORIGIN: origin,
    OYSTER_OWNER_KEY: "local-workflow-git-owner-key",
    OYSTER_COMPUTER_ID: "workspace",
    REGISTRY: {
      getByName: () => ({ selectedComputer: async () => "workspace" }),
    },
    WORKFLOW_RUNS: {
      getByName(library) {
        addressed.push(library);
        return {
          async admitWorkflowGitPass(presentedBearer, repository, scope) {
            presented.push([library, presentedBearer, repository, scope]);
            return presentedBearer.startsWith("wgp." + library + ".")
              ? {
                  kind: "actor",
                  actor: { kind: "member", memberId: "owner-" + library },
                  role: "owner",
                }
              : null;
          },
        };
      },
    },
  };
  const host = await new RootDoor({}, env).hostAt();
  assert.ok(host.git?.workflowPass);
  return { workflowPass: host.git.workflowPass, addressed, presented };
}

const target = (scope) => ({
  installationId: "bonsai",
  repository: "pond",
  scope,
});
const pond = {
  kind: "installation",
  installationId: "bonsai",
  repository: "pond",
};

// Two libraries on one Computer keep separate issuers: a bearer names and
// reaches only its own library's run owner, never the Computer's name.
test("the tenant Git door routes each library's bearer, whole, to that library's run owner", async () => {
  const f = await standaloneGit();
  assert.deepEqual(
    await f.workflowPass(bearer("library-a", "a"), target("write")),
    {
      kind: "actor",
      actor: { kind: "member", memberId: "owner-library-a" },
      role: "owner",
    },
  );
  assert.equal(
    (await f.workflowPass(bearer("library-b", "b"), target("read"))).actor
      .memberId,
    "owner-library-b",
  );
  assert.deepEqual(f.addressed, ["library-a", "library-b"]);
  assert.deepEqual(f.presented, [
    ["library-a", bearer("library-a", "a"), pond, "write"],
    ["library-b", bearer("library-b", "b"), pond, "read"],
  ]);
});

test("a malformed Workflow bearer addresses no run owner", async () => {
  const f = await standaloneGit();
  for (const malformed of [
    "wgp.library-a." + "A".repeat(64),
    "wgp.library-a." + "a".repeat(63),
    "wgp.library-a." + "a".repeat(65),
    "wgp.." + "a".repeat(64),
    "wgp.library-a",
    "wgp.library-a." + "a".repeat(64) + ".extra",
  ])
    assert.equal(await f.workflowPass(malformed, target("read")), null);
  assert.deepEqual(f.addressed, []);
});

const { workflowGitStepGrant } =
  await import("../../src/standalone/workflow-binding.ts");
const { invocationFacts } = await import("@fungi.computer/oyster/invocation");
const { instanceIds } = await import("@fungi.computer/oyster");
const { parseAppId, parseReleaseId, parseSha256Digest } =
  await import("@fungi.computer/puffball");

const stepInstanceId = instanceIds.instance.generate();
const stepAuthority = {
  instanceId: stepInstanceId,
  selection: {
    instanceId: stepInstanceId,
    owner: { kind: "installation", id: "shed" },
    appId: parseAppId("app_shed"),
    releaseId: parseReleaseId("rel_shed"),
    authorityVersion: 1,
  },
  artifactDigest: parseSha256Digest("sha256:" + "a".repeat(64)),
  grants: [{ binding: "COMPUTER", operations: ["exec"] }],
  ancestry: [],
};
const deadline = {
  deadlineAt: Date.now() + 60_000,
  grantExpiresAt: Date.now() + 60_000,
};
const stepWorkflow = {
  workflowId: "storyboard",
  runId: "run_1",
  nodeId: "save",
  armedBy: { kind: "member", memberId: "owner" },
};
const library = (installationId, capability, status = "enabled") => ({
  installationId,
  status,
  authority: {
    authorityVersion: 1,
    declaredOperationsDigest: parseSha256Digest("sha256:" + "a".repeat(64)),
    approval: null,
    approvedGrants: [
      {
        capability,
        capabilityApproved: true,
        operations: [],
        resources: "tenant-scope",
      },
    ],
  },
});
const libraries = {
  list: async () => [
    library("events-only", "workflow.arm"),
    library("disabled", "workflow.run", "disabled"),
    library("other", "workflow.run"),
    library("library", "workflow.run"),
  ],
};
const stepGrant = { teamId: "library", runId: "run_1" };

test("a member Workflow node frame's commands carry the public grant its run library admits", async () => {
  const asked = [];
  const env = {
    WORKFLOW_RUNS: {
      getByName: (libraryId) => ({
        async admitWorkflowGit(request) {
          asked.push([libraryId, request]);
          return libraryId === "library" ? stepGrant : null;
        },
      }),
    },
  };
  const frame = (facts) => ({
    facts,
    signal: new globalThis.AbortController().signal,
  });
  const node = invocationFacts.fromWorkflowNode(
    { ...stepAuthority, selection: { ...stepAuthority.selection } },
    {
      workflow: stepWorkflow,
      computerId: "computer",
      idempotencyKey: "call-1",
    },
    deadline,
  );
  assert.equal(
    await workflowGitStepGrant(env, libraries, frame(node)),
    stepGrant,
  );
  const request = {
    installationId: "shed",
    idempotencyKey: "call-1",
    workflow: stepWorkflow,
    memberId: "owner",
    computerId: "computer",
  };
  // Only enabled run libraries are asked, from the frame's own attestation.
  assert.deepEqual(asked, [
    ["other", request],
    ["library", request],
  ]);
  // A manual call is not a Workflow step and asks no library.
  const manual = invocationFacts.fromCaller(
    stepAuthority,
    {
      actor: { kind: "member", memberId: "owner" },
      computerId: "computer",
      idempotencyKey: "call-2",
    },
    deadline,
  );
  assert.equal(await workflowGitStepGrant(env, libraries, frame(manual)), null);
  assert.equal(asked.length, 2);
});
