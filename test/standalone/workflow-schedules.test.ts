import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as S from "effect/Schema";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  createTeamWorkflowTriggers,
  createWorkflowRunAuthority,
  createWorkflowCeilingCapture,
  createTriggerPlans,
  armedWorkflowTriggerSchema,
  compileForMember,
  workflowInstallationAuthoritySchema,
  type WorkflowInstallationAuthority,
} from "@fungi.computer/braid/runtime";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import { contentDigest, type WorkflowDefinition } from "@fungi.computer/braid";
import { createStandaloneWorkflowSchedules } from "../../src/standalone/workflow-schedules.js";
import {
  createStandaloneWorkflowTriggerHost,
  standaloneTriggerErrors,
} from "../../src/standalone/workflow-trigger-host.js";
import { workflowFrameMethods } from "../../src/standalone/workflow-binding.js";

const installationAuthority: WorkflowInstallationAuthority =
  workflowInstallationAuthoritySchema.parse({
    selection: {
      instanceId: "instance_library",
      owner: { kind: "installation", id: "library" },
      appId: "app_trellis",
      releaseId: "rel_trellis",
      authorityVersion: 3,
    },
    artifactDigest: "sha256:" + "c".repeat(64),
  });

function fixture(context: AppMethodCallContext) {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const unexpected = (): never => {
    throw new Error("Missing Computer reached a trigger host port");
  };
  const admissions: string[] = [];
  const authorization: { memberId: string; installationId: string }[] = [];
  const wakes: (number | null)[] = [];
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
  const adapter = createStandaloneWorkflowSchedules({
    sql: storage.sql,
    triggers,
    teamId: () => "library",
    now: () => Date.parse("2026-10-13T12:00:00Z"),
    commit: (body) => Promise.resolve(storage.transactionSync(body)),
    authorize: (memberId, installationId) => {
      authorization.push({ memberId, installationId });
      return Promise.resolve();
    },
    wake: (due) => {
      wakes.push(due);
      return Promise.resolve();
    },
    reportFailure: unexpected,
    admitInvocation: (packet: string, operation: string) => {
      expect(packet).toBe("protected-frame");
      admissions.push(operation);
      return Promise.resolve({
        libraryId: "library",
        context,
        installationAuthority,
      });
    },
  });
  return {
    adapter,
    triggers,
    storage,
    admissions,
    authorization,
    wakes,
    close: () => {
      database.close();
    },
  };
}
const target = {
  workflowId: "scheduled-echo",
  commit: "a".repeat(40),
  digest: S.decodeUnknownSync(sha256DigestSchema)("sha256:" + "b".repeat(64)),
  triggerId: "clock",
  bindings: {},
};
const decodeArm = (overrides: Readonly<Record<string, string | undefined>>) =>
  workflowFrameMethods.WORKFLOWS.armSchedule?.decodeArgs([
    { ...target, ...overrides },
  ]);

it("refuses an admitted member without a selected Computer before trigger admission", async () => {
  const f = fixture({
    actor: { kind: "member", memberId: "owner" },
    computerId: null,
  });
  try {
    await expect(f.adapter.arm("protected-frame", target)).resolves.toEqual({
      kind: "refused",
      reason: "Select a Computer before arming a schedule",
    });
    expect(f.adapter.nextWake()).toBeNull();
    expect(f.admissions).toEqual(["armSchedule"]);
    expect(f.authorization).toEqual([]);
    expect(f.wakes).toEqual([]);
  } finally {
    f.close();
  }
});

it.each(["computerId", "installationId", "installationAuthority", "armedBy"])(
  "the WORKFLOWS binding refuses a guest %s selector at its boundary",
  (selector) => {
    expect(decodeArm({})).toEqual([target]);
    expect(() => decodeArm({ [selector]: "guest-selected" })).toThrow();
  },
);

it.each([undefined, "not-a-digest"])(
  "the WORKFLOWS binding refuses a missing or malformed private digest (%s)",
  (digest) => {
    expect(() => decodeArm({ digest })).toThrow();
  },
);

it("refuses an Agent even when its protected context names a Computer", async () => {
  const f = fixture({
    actor: { kind: "agent", agentId: "agent" },
    computerId: "protected-computer",
  });
  try {
    await expect(f.adapter.arm("protected-frame", target)).resolves.toEqual({
      error: "not_granted",
    });
    expect(f.authorization).toEqual([]);
    expect(f.wakes).toEqual([]);
  } finally {
    f.close();
  }
});

it("uses admitted member and library scope for listing and disarming", async () => {
  const f = fixture({
    actor: { kind: "member", memberId: "owner" },
    computerId: null,
  });
  try {
    await expect(f.adapter.list("protected-frame")).resolves.toEqual({
      schedules: [],
    });
    await expect(
      f.adapter.disarm("protected-frame", { scheduleId: "missing" }),
    ).resolves.toEqual({ kind: "not_found" });
    expect(f.admissions).toEqual(["schedules", "disarmSchedule"]);
    expect(f.authorization).toEqual([
      { memberId: "owner", installationId: "library" },
      { memberId: "owner", installationId: "library" },
    ]);
  } finally {
    f.close();
  }
});

it("arms as the owner with the admitted frame's installation pin", async () => {
  const f = fixture({
    actor: { kind: "member", memberId: "owner" },
    computerId: "protected-computer",
  });
  const arm = vi.spyOn(f.triggers, "arm");
  try {
    await expect(f.adapter.arm("protected-frame", target)).rejects.toThrow(
      "Missing Computer reached a trigger host port",
    );
    expect(arm).toHaveBeenCalledWith(
      { armedBy: "owner", armedVia: null },
      { ...target, installationId: "library" },
      "protected-computer",
      installationAuthority,
    );
  } finally {
    arm.mockRestore();
    f.close();
  }
});

it("feeds the shared run owner from current authority readers and refuses revoked armers", async () => {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const unexpected = (): never => {
    throw new Error("Authority lookup reached a run or provider operation");
  };
  let currentVersion: number | null = 7;
  let catalogReads = 0;
  const authority = createWorkflowRunAuthority({
    member: () =>
      Promise.resolve(
        currentVersion === null ? null : { membershipVersion: currentVersion },
      ),
    memberComputer: () => Promise.resolve(true),
    catalog: () => {
      catalogReads++;
      return Promise.resolve([]);
    },
    admitAgent: unexpected,
    capture: createWorkflowCeilingCapture({
      node: unexpected,
      git: unexpected,
    }),
    denied: () => new Error("denied"),
  });
  const host = createStandaloneWorkflowTriggerHost({
    admitDelivery: unexpected,
    authority,
    runs: {
      sql: storage.sql,
      transactionSync: (body) => storage.transactionSync(body),
      teamId: () => "library",
    },
    triggers: {
      published: { resolve: unexpected },
      source: unexpected,
      admit: unexpected,
      readAgentAccess: unexpected,
      admitGitAccess: unexpected,
      launch: unexpected,
    },
    recordCaller: unexpected,
  });
  try {
    await expect(host.runs.member("owner")).resolves.toEqual({
      membershipVersion: 7,
    });
    await expect(host.runs.catalog("owner")).resolves.toEqual([]);
    expect(catalogReads).toBe(1);
    const started = await host.runs.startGraph(
      "owner",
      {
        requestId: "current-authority-capture",
        definition: {
          format: "fungi.workflow/v1",
          title: "Authority capture",
          apps: {},
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          nodes: [],
          edges: [],
          output: {},
        },
        bindings: {},
        input: {},
      },
      "computer",
    );
    if (started.kind !== "started")
      throw new Error("Current authority failed to start");
    expect(host.runs.graph.read(started.runId)?.ceiling).toEqual({
      nodes: [],
      nodeGitAccess: [],
    });
    const readsBeforeRevocation = catalogReads;
    currentVersion = null;
    await expect(host.runs.member("owner")).rejects.toThrow("denied");
    await expect(host.runs.memberComputer("owner", "computer")).resolves.toBe(
      false,
    );
    await expect(host.runs.catalog("owner")).rejects.toThrow("denied");
    expect(catalogReads).toBe(readsBeforeRevocation);
  } finally {
    database.close();
  }
});

it("carries a standalone schedule's declared chat onto every run it fires", async () => {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const unexpected = (): never => {
    throw new Error("Unexpected trigger port");
  };
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Nightly",
    apps: {},
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [],
    edges: [],
    output: {},
    triggers: [
      {
        id: "nightly",
        on: "schedule",
        cron: { expression: "0 6 * * *", timeZone: "UTC" },
        input: {},
      },
    ],
  };
  const publisher = {
    installationId: "library",
    appId: "app_trellis",
    displayName: "Trellis",
    methods: {},
    capabilities: ["workflow.publish" as const],
    workflowPublishGranted: true,
  };
  const authority = createWorkflowRunAuthority({
    member: () => Promise.resolve({ membershipVersion: 1 }),
    memberComputer: () => Promise.resolve(true),
    catalog: () => Promise.resolve([publisher]),
    admitAgent: unexpected,
    capture: createWorkflowCeilingCapture({
      node: unexpected,
      git: unexpected,
    }),
    denied: () => new Error("denied"),
  });
  const callers: string[] = [];
  const host = createStandaloneWorkflowTriggerHost({
    admitDelivery: (_memberId, delivery) =>
      Promise.resolve(delivery.agentId === "agent_reports"),
    authority,
    runs: {
      sql: storage.sql,
      transactionSync: (body) => storage.transactionSync(body),
      teamId: () => "library",
    },
    triggers: {
      published: { resolve: unexpected },
      source: unexpected,
      admit: () => Promise.resolve(installationAuthority),
      readAgentAccess: unexpected,
      admitGitAccess: unexpected,
      launch: () => Promise.resolve(),
    },
    recordCaller: (runId) => {
      callers.push(runId);
    },
  });
  try {
    const delivery = { agentId: "agent_reports", sessionId: "session_one" };
    const binding = armedWorkflowTriggerSchema.parse({
      installationId: "library",
      workflowId: "nightly",
      commit: "a".repeat(40),
      digest: await contentDigest(definition),
      triggerId: "nightly",
      bindings: {},
      delivery,
      armedBy: "owner",
      armedVia: null,
      grantorMembershipVersion: 1,
      installationAuthority,
      computerId: "computer",
    });
    const compiled = await compileForMember([publisher], {
      requestId: "compile",
      definition,
      bindings: {},
      input: {},
    });
    if (compiled.kind !== "compiled") throw new Error("Plan did not compile");
    host.runs.triggerPlans.put(binding, compiled.plan);
    const started = await host.triggers.fire(binding, "library/nightly", {
      scheduledAt: "2026-10-14T06:00:00.000Z",
      eventId: "nightly-1",
    });
    if (started.kind !== "started") throw new Error(JSON.stringify(started));
    expect(host.runs.graph.read(started.runId)?.delivery).toEqual(delivery);
    expect(callers).toEqual([started.runId]);
  } finally {
    database.close();
  }
});

it("refuses the Hub-only reviewer port instead of inventing authority", async () => {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const unexpected = (): never => {
    throw new Error("unexpected");
  };
  const host = createStandaloneWorkflowTriggerHost({
    admitDelivery: unexpected,
    authority: createWorkflowRunAuthority({
      member: unexpected,
      memberComputer: unexpected,
      catalog: unexpected,
      admitAgent: unexpected,
      capture: createWorkflowCeilingCapture({
        node: unexpected,
        git: unexpected,
      }),
      denied: () => new Error("denied"),
    }),
    runs: {
      sql: storage.sql,
      transactionSync: (body) => storage.transactionSync(body),
      teamId: () => "library",
    },
    triggers: {
      published: { resolve: unexpected },
      source: unexpected,
      admit: unexpected,
      readAgentAccess: unexpected,
      admitGitAccess: unexpected,
      launch: unexpected,
    },
    recordCaller: unexpected,
  });
  try {
    await expect(
      host.runs.callWorkflowApp("owner", {
        runId: "run",
        nodeId: "node",
        iteration: "0",
        idempotencyKey: "key",
        installationId: "installation",
        appId: "app",
        method: "method",
        methodDigest: "digest",
        input: {},
        computerId: null,
        bindingCeiling: [],
      }),
    ).resolves.toEqual({ kind: "refused", code: "not_granted" });
    await expect(host.runs.reviewer("owner")).rejects.toThrow(
      "Standalone Workflows has no Team reviewer",
    );
  } finally {
    database.close();
  }
});
