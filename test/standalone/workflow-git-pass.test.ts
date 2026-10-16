import { expect, it } from "vitest";
import { instanceIds } from "@fungi.computer/oyster";
import {
  parseAppId,
  parseReleaseId,
  parseSha256Digest,
} from "@fungi.computer/puffball";
import {
  invocationFacts,
  type InvocationFacts,
} from "@fungi.computer/oyster/invocation";
import type { WorkflowGitPassResult } from "@fungi.computer/agar/computer-contracts";
import {
  openWorkflowGitPass,
  type WorkflowGitPassRequest,
} from "../../src/standalone/workflow-binding.js";

const instanceId = instanceIds.instance.generate();
const authority = {
  instanceId,
  selection: {
    instanceId,
    owner: { kind: "installation" as const, id: "shed" },
    appId: parseAppId("app_shed"),
    releaseId: parseReleaseId("rel_shed"),
    authorityVersion: 1,
  },
  artifactDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
  grants: [{ binding: "COMPUTER" as const, operations: ["workflowGitPass"] }],
  ancestry: [],
};
const deadline = {
  deadlineAt: Date.now() + 60_000,
  grantExpiresAt: Date.now() + 60_000,
};
const workflow = {
  workflowId: "storyboard",
  runId: "run_1",
  nodeId: "save",
  armedBy: { kind: "member" as const, memberId: "owner" },
};
const nodeFacts = (computerId: string | null) =>
  invocationFacts.fromWorkflowNode(
    { ...authority, selection: { ...authority.selection } },
    { workflow, computerId, idempotencyKey: "call-1" },
    deadline,
  );
const pass: WorkflowGitPassResult = {
  passId: "pass",
  remote: "https://workflow-pass:secret@oyster.test/git/bonsai/pond.git",
  expiresAt: Date.now() + 60_000,
};
const library = (
  installationId: string,
  capability: "workflow.run" | "workflow.arm",
) => ({
  installationId,
  status: "enabled" as const,
  approvedGrants: [
    {
      capability,
      capabilityApproved: true as const,
      operations: [],
      resources: "tenant-scope" as const,
    },
  ],
});

function env(answers: Record<string, WorkflowGitPassResult | null>) {
  const asked: [string, WorkflowGitPassRequest][] = [];
  return {
    asked,
    env: {
      OYSTER_COMPUTER_ID: "computer",
      WORKFLOW_RUNS: {
        getByName: (name: string) => ({
          openWorkflowGitPass: (request: WorkflowGitPassRequest) => {
            asked.push([name, request]);
            return Promise.resolve(answers[name] ?? null);
          },
        }),
      },
    },
  };
}
const libraries = {
  list: () =>
    Promise.resolve([
      library("other", "workflow.run"),
      library("library", "workflow.run"),
      library("events-only", "workflow.arm"),
    ]),
};
const frame = (facts: InvocationFacts) => ({
  facts,
  signal: new AbortController().signal,
});

it("asks run libraries with only the frame's attested Workflow, call key, member and Computer", async () => {
  const f = env({ library: pass });
  await expect(
    openWorkflowGitPass(f.env, libraries, frame(nodeFacts("computer")), [{}]),
  ).resolves.toEqual(pass);
  const request = {
    installationId: "shed",
    idempotencyKey: "call-1",
    workflow,
    memberId: "owner",
    computerId: "computer",
  };
  expect(f.asked).toEqual([
    ["other", request],
    ["library", request],
  ]);
});

it("refuses a pass request no library dispatched", async () => {
  await expect(
    openWorkflowGitPass(env({}).env, libraries, frame(nodeFacts("computer")), [
      {},
    ]),
  ).rejects.toMatchObject({ code: "revoked" });
});

it("refuses a frame on another Computer or with App-supplied arguments before any library", async () => {
  const f = env({ library: pass });
  await expect(
    openWorkflowGitPass(f.env, libraries, frame(nodeFacts("elsewhere")), [{}]),
  ).rejects.toMatchObject({ code: "revoked" });
  await expect(
    openWorkflowGitPass(f.env, libraries, frame(nodeFacts("computer")), [
      { repository: "pond" },
    ]),
  ).rejects.toThrow();
  expect(f.asked).toEqual([]);
});

it("refuses a frame that is not a published Workflow node", async () => {
  const f = env({ library: pass });
  const manual = invocationFacts.fromCaller(
    authority,
    {
      actor: { kind: "member", memberId: "owner" },
      computerId: "computer",
      idempotencyKey: "call-1",
    },
    deadline,
  );
  await expect(
    openWorkflowGitPass(f.env, libraries, frame(manual), [{}]),
  ).rejects.toMatchObject({ code: "revoked" });
  expect(f.asked).toEqual([]);
});
