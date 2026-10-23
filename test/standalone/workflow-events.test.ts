import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import * as S from "effect/Schema";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  createTeamWorkflowTriggers,
  createTriggerPlans,
  workflowInstallationAuthoritySchema,
} from "@fungi.computer/braid/runtime";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import type { AppEventFact } from "@fungi.computer/puffball/app-event-facts";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import type { HostRecipientEvent } from "@fungi.computer/oyster/event-recipients";
import { createStandaloneWorkflowEvents } from "../../src/standalone/workflow-events.js";
import type { TriggerAdmission } from "../../src/standalone/workflow-schedules.js";
import { standaloneTriggerErrors } from "../../src/standalone/workflow-trigger-host.js";
import {
  deliverWorkflowEvent,
  workflowEventRecipients,
} from "../../src/standalone/workflow-binding.js";

const installationAuthority = workflowInstallationAuthoritySchema.parse({
  selection: {
    instanceId: "instance_library",
    owner: { kind: "installation", id: "library" },
    appId: "app_trellis",
    releaseId: "rel_trellis",
    authorityVersion: 3,
  },
  artifactDigest: "sha256:" + "c".repeat(64),
});
const target = {
  workflowId: "pushed",
  commit: "a".repeat(40),
  digest: S.decodeUnknownSync(sha256DigestSchema)("sha256:" + "b".repeat(64)),
  triggerId: "pushed",
  bindings: { bonsai: "bonsai" },
};

function fixture(
  context: AppMethodCallContext,
  agentAuthority: TriggerAdmission["authority"] = null,
) {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const unexpected = (): never => {
    throw new Error("Refused control reached a trigger port");
  };
  const admissions: string[] = [];
  const triggers = createTeamWorkflowTriggers({
    runs: {
      member: unexpected,
      memberComputer: unexpected,
      catalog: unexpected,
      admitDelivery: unexpected,
      triggerPlans: createTriggerPlans(storage.sql),
      startCachedGraph: unexpected,
    },
    published: { resolve: unexpected },
    source: unexpected,
    admit: unexpected,
    readAgentAccess: unexpected,
    admitGitAccess: unexpected,
    launch: unexpected,
    errors: standaloneTriggerErrors,
  });
  const adapter = createStandaloneWorkflowEvents({
    sql: storage.sql,
    triggers,
    teamId: () => "library",
    commit: (body) => Promise.resolve(storage.transactionSync(body)),
    authorize: () => Promise.resolve(),
    admitInvocation: (packet: string, operation: string) => {
      expect(packet).toBe("protected-frame");
      admissions.push(operation);
      return Promise.resolve({
        libraryId: "library",
        context,
        authority:
          context.actor.kind === "member"
            ? {
                armer: { armedBy: context.actor.memberId, armedVia: null },
                principal: context.actor,
              }
            : agentAuthority,
        installationAuthority,
      });
    },
  });
  return {
    adapter,
    storage,
    admissions,
    close: () => {
      database.close();
    },
  };
}

it("refuses an event arm without a selected Computer before the router", async () => {
  const f = fixture({
    actor: { kind: "member", memberId: "owner" },
    computerId: null,
  });
  try {
    await expect(f.adapter.arm("protected-frame", target)).resolves.toEqual({
      kind: "refused",
      reason: "Select a Computer before arming an event trigger",
    });
    expect(f.admissions).toEqual(["armEventTrigger"]);
  } finally {
    f.close();
  }
});

it("refuses an Agent arming an event trigger without admitted approval", async () => {
  const f = fixture({
    actor: { kind: "agent", agentId: "agent" },
    computerId: "computer",
  });
  try {
    await expect(f.adapter.arm("protected-frame", target)).resolves.toEqual({
      error: "not_granted",
    });
  } finally {
    f.close();
  }
});

it("an approved Agent can list and disarm App-event triggers under its grantor", async () => {
  const f = fixture(
    {
      actor: { kind: "agent", agentId: "agent" },
      computerId: "computer",
    },
    {
      armer: {
        armedBy: "owner",
        armedVia: {
          kind: "policy",
          agentId: "agent",
          policyRevision: "approval:1",
          grantorMemberId: "owner",
        },
      },
      principal: { kind: "agent", agentId: "agent", grantorMemberId: "owner" },
    },
  );
  try {
    await expect(f.adapter.list("protected-frame")).resolves.toEqual({
      eventTriggers: [],
    });
    await expect(
      f.adapter.disarm("protected-frame", { eventTriggerId: "missing" }),
    ).resolves.toEqual({ kind: "not_found" });
    expect(f.admissions).toEqual(["eventTriggers", "disarmEventTrigger"]);
  } finally {
    f.close();
  }
});

const event: HostRecipientEvent = {
  source: {
    installationId: "bonsai",
    appId: "app_bonsai",
    releaseId: "rel_bonsai",
  },
  type: "git.push",
  eventId: "event_1",
  payload: {
    type: "git.push",
    timestamp: "2026-10-13T12:00:00Z",
    data: { ref: "x" },
  },
};
const library = (
  installationId: string,
  status: "enabled" | "disabled",
  capability: "workflow.arm" | "workflow.run",
) => ({
  installationId,
  status,
  authority: {
    authorityVersion: 1,
    declaredOperationsDigest: S.decodeSync(sha256DigestSchema)(
      `sha256:${"a".repeat(64)}`,
    ),
    approval: null,
    approvedGrants: [
      {
        capability,
        capabilityApproved: true as const,
        operations: [],
        resources: "tenant-scope" as const,
      },
    ],
  },
});

it("names only enabled libraries approved to arm as event recipients", async () => {
  await expect(
    workflowEventRecipients({
      list: () =>
        Promise.resolve([
          library("library", "enabled", "workflow.arm"),
          library("disabled", "disabled", "workflow.arm"),
          library("runner", "enabled", "workflow.run"),
        ]),
    }),
  ).resolves.toEqual(["library"]);
});

it("delivers one recorded event to its library as the host-attested fact", async () => {
  const delivered: [string, AppEventFact][] = [];
  await deliverWorkflowEvent(
    {
      WORKFLOW_RUNS: {
        getByName: (name: string) => ({
          deliverEvent: (fact: AppEventFact) => {
            delivered.push([name, fact]);
            return Promise.resolve("accepted" as const);
          },
        }),
      },
    },
    "library",
    event,
  );
  expect(delivered).toEqual([
    [
      "library",
      {
        type: "git.push",
        payload: event.payload,
        eventId: "event_1",
        installationId: "bonsai",
        appId: "app_bonsai",
        releaseId: "rel_bonsai",
      },
    ],
  ]);
});
