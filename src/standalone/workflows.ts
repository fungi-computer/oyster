import type { GraphStartRequest } from "@fungi.computer/braid/runtime";
import { createCodemodeSandbox } from "@fungi.computer/mycelium/workers";
import { DurableObject } from "cloudflare:workers";
import * as S from "effect/Schema";
import {
  GraphWorkflow,
  type GraphRunEnding,
  type GraphWorkflowBindings,
} from "@fungi.computer/braid/cloudflare";
import {
  type GraphReview,
  type GraphParams,
  type NodeCall,
  type NodeEvent,
  type NodeDispatcher,
} from "@fungi.computer/braid";
import { standaloneTenancy, type StandaloneTenancyEnv } from "./tenancy.js";
import {
  createStandaloneWorkflowGitAccess,
  createStandaloneWorkflowRootAuthority,
} from "./workflow-root-authority.js";
import { createStandaloneWorkflowHost } from "./workflow-host.js";
import {
  createStandaloneWorkflowSchedules,
  type ScheduleOperation,
} from "./workflow-schedules.js";
import {
  createStandaloneWorkflowEvents,
  type EventTriggerOperation,
} from "./workflow-events.js";
import type { AppEventFact } from "@fungi.computer/puffball/app-event-facts";
import {
  createStandaloneWorkflowTriggerHost,
  standaloneTriggerErrors,
} from "./workflow-trigger-host.js";
import {
  createWorkflowPublishedDefinitionPort,
  readPublishedWorkflow,
  type ScheduleListInput,
} from "@fungi.computer/workflows-wire";

import type { InvocationFacts } from "../invocation.js";
import { workflowAgentAuthority } from "../workflow-agent-authority.js";
import type {
  OysterGitWorkerEnv,
  OysterGitWorkerHost,
} from "../workers-git.js";
import {
  defaultTenant,
  tenantScope,
  type TenantPrincipal,
  type TenantScope,
} from "../tenant.js";
import { AppInstanceError } from "../index.js";
import type { GitWriter, RepositoryRef } from "@fungi.computer/agar/git";
import {
  createWorkflowGitPasses,
  createWorkflowGitPassStore,
  workflowGitPassWriter,
  type WorkflowGitCredential,
  type WorkflowGitPassGrant,
  workflowRunReport,
  wireRunInitiator,
  type WorkflowRunDelivery,
  type WorkflowRunEnding,
} from "@fungi.computer/braid/runtime";
import { canonicalJson } from "@fungi.computer/braid";

import {
  runKey,
  reviewKey,
  workflowGitPassRequestSchema,
  type EventDisarmInput,
  type WorkflowGitPassRequest,
  type TriggerArmTarget,
  type ScheduleDisarmInput,
} from "./workflow-binding.js";
import type { StandaloneComputerEnv } from "./computer.js";
import type { StandaloneAgentsEnv } from "./agents.js";
import { agentDirectoryForScope } from "./agent-directory.js";
import type { OysterMediaEnv } from "./media.js";
import {
  createWorkflowWebhooks,
  workflowWebhookCommandSchema,
  workflowWebhookControlResponse,
} from "../webhooks.js";
import { workflowWebhookRefusal } from "../webhook-ingress.js";
import { Hono } from "hono";

export type StandaloneWorkflowEnv = OysterGitWorkerEnv &
  StandaloneComputerEnv &
  StandaloneAgentsEnv &
  OysterMediaEnv &
  StandaloneTenancyEnv &
  GraphWorkflowBindings & {
    WORKFLOW_RUNS: DurableObjectNamespace<StandaloneWorkflowRunsBase>;
    WORKFLOW_WEBHOOK_HOST_RATE?: Pick<RateLimit, "limit">;
    WORKFLOW_WEBHOOK_BINDING_RATE?: Pick<RateLimit, "limit">;
    /** Trusted configuration; absent admission closes the new webhook surface. */
    WORKFLOW_WEBHOOK_POLICY?: {
      limits: Parameters<typeof createWorkflowWebhooks>[0]["limits"];
      concurrency: Parameters<
        typeof createWorkflowWebhooks
      >[0]["abuse"]["concurrency"];
    };
  };
/** Schedule time and the native alarm instant that delivers a due time. */
export type StandaloneScheduleClock = Readonly<{
  now(): number;
  alarmAt(due: number): number;
}>;
/** SQLite and the native Workflow binding belong to this standalone host; its root supplies `hostFor`. */
export abstract class StandaloneWorkflowRunsBase<
  Env extends StandaloneWorkflowEnv = StandaloneWorkflowEnv,
> extends DurableObject<Env> {
  private readonly composed;
  /** Schedule time and its native alarm instant; production is the wall clock. */
  protected readonly scheduleClock: StandaloneScheduleClock = {
    now: () => Date.now(),
    alarmAt: (due) => due,
  };
  private readonly owner;
  /** The deployable root's host for one tenant; Workflow runs use the default tenant. */
  protected abstract hostFor(scope: TenantScope): Promise<OysterGitWorkerHost>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // This object is named by its Workflows library installation; the alarm
    // and App events have no library frame, so the first admitted trigger
    // control records that name.
    ctx.storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS standalone_workflow_library (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), installation_id TEXT NOT NULL
    ) STRICT`);
    this.composed = ctx.blockConcurrencyWhile(async () => {
      const shared = await standaloneTenancy(env);
      const host = await this.hostFor(
        tenantScope(defaultTenant, env.OYSTER_ORIGIN),
      );
      const agentToolPolicy = async (agentId: string) =>
        (await host.appToolPolicy?.({ kind: "agent", agentId })) ?? null;
      // A key's App access is its own grants (Ear Tag), read through
      // `host.keys.live`, never through `appToolPolicy`.
      const keyLive = async (keyId: string) =>
        (await host.keys?.live(keyId)) ?? null;
      // The one owner reaches every Agent; the report needs one that exists.
      const admitDelivery = (
        _memberId: string,
        delivery: WorkflowRunDelivery,
      ) =>
        agentDirectoryForScope(
          env,
          tenantScope(defaultTenant, env.OYSTER_ORIGIN),
        ).has(delivery.agentId);
      const owner: ReturnType<typeof createStandaloneWorkflowHost> =
        createStandaloneWorkflowHost(ctx.storage, host, {
          async lifecycleMember() {
            const member = await shared.owner();
            return member === null
              ? null
              : {
                  memberId: member.actor.memberId,
                  membershipVersion: member.membershipVersion,
                };
          },
          authority(libraryInstallationId) {
            return createStandaloneWorkflowRootAuthority({
              shared,
              host,
              libraryInstallationId,
              catalogHost: owner,
              agentToolPolicy,
              keyLive,
            });
          },
          admitDelivery,
        });
      const triggersFor = (libraryId: string) => {
        const authority = createStandaloneWorkflowRootAuthority({
          shared,
          host,
          libraryInstallationId: libraryId,
          catalogHost: owner,
          agentToolPolicy,
          keyLive,
        });
        const admitTrigger = async (
          memberId: string,
          installationId: string,
          computerId: string,
        ) => {
          await authority.member(memberId);
          if (
            installationId !== libraryId ||
            !(await authority.memberComputer(memberId, computerId))
          )
            throw standaloneTriggerErrors.denied();
          return owner.triggerAuthority(installationId);
        };
        const triggers = createStandaloneWorkflowTriggerHost({
          authority,
          admitDelivery,
          runs: {
            sql: ctx.storage.sql,
            transactionSync: (body) => ctx.storage.transactionSync(body),
            teamId: () => libraryId,
            now: () => this.scheduleClock.now(),
          },
          triggers: {
            published: createWorkflowPublishedDefinitionPort((git) => ({
              published: (workflowId, at) =>
                readPublishedWorkflow(git, workflowId, at),
            })),
            admit: async (memberId, installationId, computerId) =>
              (await admitTrigger(memberId, installationId, computerId)).pin,
            async source(memberId, installationId, computerId) {
              const { installation } = await admitTrigger(
                memberId,
                installationId,
                computerId,
              );
              return (await host.git.git(installation)).binding({
                kind: "member",
                memberId,
              });
            },
            readAgentAccess: async (lookup) => {
              if (lookup.kind !== "policy") return null;
              const policy = await agentToolPolicy(lookup.agentId);
              return policy === null
                ? null
                : {
                    kind: "policy",
                    agentId: lookup.agentId,
                    policyRevision: policy.revision,
                    grantorMemberId: policy.grantedBy,
                    level: policy.level,
                  };
            },
            // The member's current Workflows Git policy; mints no pass itself.
            admitGitAccess: async (memberId, repository, scope) => {
              if (!(await gitAccess(libraryId)(memberId, repository, scope)))
                throw standaloneTriggerErrors.denied();
            },
            launch: (run) => this.launch(libraryId, run),
          },
          recordCaller: (runId, memberId, computerId) => {
            owner.recordTriggerCaller(runId, memberId, computerId);
          },
        });
        const controls = {
          sql: ctx.storage.sql,
          triggers: triggers.triggers,
          teamId: () => libraryId,
          commit: <A>(body: () => A) =>
            Promise.resolve(ctx.storage.transactionSync(body)),
          async authorize(memberId: string, installationId: string) {
            await authority.member(memberId);
            if (installationId !== libraryId)
              throw standaloneTriggerErrors.denied();
          },
          admitInvocation: async (
            facts: InvocationFacts,
            operation: string,
          ) => {
            const admitted = await owner.admitInvocation(facts, operation);
            if (admitted.libraryId !== libraryId)
              throw new AppInstanceError("revoked");
            return {
              ...admitted,
              authority: await workflowAgentAuthority(
                facts,
                operation,
                agentToolPolicy,
              ),
            };
          },
        };
        let webhooks: ReturnType<
          typeof createWorkflowWebhooks<TenantPrincipal>
        > | null = null;
        const wake = async () => {
          const due = [
            schedules.nextWake(),
            webhooks?.nextWake() ?? null,
          ].filter((value): value is number => value !== null);
          if (due.length === 0) await ctx.storage.deleteAlarm();
          else
            await ctx.storage.setAlarm(
              this.scheduleClock.alarmAt(Math.min(...due)),
            );
        };
        const schedules = createStandaloneWorkflowSchedules<InvocationFacts>({
          ...controls,
          now: () => this.scheduleClock.now(),
          wake,
          reportFailure: ({ source, cause }) => {
            console.error("Standalone Workflow schedule failed", source, cause);
          },
        });
        if (
          env.WORKFLOW_WEBHOOK_HOST_RATE !== undefined &&
          env.WORKFLOW_WEBHOOK_BINDING_RATE !== undefined &&
          env.WORKFLOW_WEBHOOK_POLICY !== undefined
        )
          webhooks = createWorkflowWebhooks<TenantPrincipal>({
            sql: ctx.storage.sql,
            transactionSync: (body) => ctx.storage.transactionSync(body),
            now: () => this.scheduleClock.now(),
            scope: { host: env.OYSTER_ORIGIN, tenant: libraryId },
            owner: async (principal) => {
              const current = await shared.owner();
              return principal.actor.kind === "member" &&
                current?.actor.memberId === principal.actor.memberId
                ? principal.actor.memberId
                : null;
            },
            runs: triggers.runs,
            triggers: triggers.triggers,
            launch: async (run) => {
              const stored = triggers.runs.graph.read(run.runId);
              if (stored === null)
                throw new Error("Reserved Workflow run is missing");
              // Recover the existing run's dispatch context after a crash between
              // durable admission and the standalone adapter's caller write.
              owner.recordTriggerCaller(
                run.runId,
                stored.actorId,
                stored.computerId,
              );
              await this.launch(libraryId, run);
            },
            abuse: {
              hostRate: env.WORKFLOW_WEBHOOK_HOST_RATE,
              bindingRate: env.WORKFLOW_WEBHOOK_BINDING_RATE,
              concurrency: env.WORKFLOW_WEBHOOK_POLICY.concurrency,
            },
            limits: env.WORKFLOW_WEBHOOK_POLICY.limits,
            wake,
            reportFailure: () => {
              console.error("Standalone Workflow webhook failed");
            },
          });
        return {
          schedules,
          webhooks,
          events: createStandaloneWorkflowEvents<InvocationFacts>(controls),
        };
      };
      let library: ReturnType<typeof triggersFor> | null = null;
      const libraryTriggers = (libraryId: string) => {
        this.nameLibrary(libraryId);
        return (library ??= triggersFor(libraryId));
      };
      const computerId = host.computerId;
      // Passes live with the run owner that records the Git steps they serve.
      const passStore = createWorkflowGitPassStore({
        sql: ctx.storage.sql,
        transactionSync: (body) => ctx.storage.transactionSync(body),
        ownerId: () => this.libraryId(),
        computerId: () => computerId,
        remote: (repository) => {
          const libraryId = this.libraryId();
          if (repository.kind !== "installation" || libraryId === null)
            throw new AppInstanceError("revoked");
          // The tenant's ordinary smart-HTTP door; the credential never
          // enters the URL and travels only as the bearer header.
          return new URL(
            `/git/${repository.installationId}/${repository.repository}.git`,
            env.OYSTER_ORIGIN,
          ).href;
        },
        denied: () => new AppInstanceError("revoked"),
      });
      const gitAccess = (libraryId: string) =>
        createStandaloneWorkflowGitAccess({
          shared,
          host,
          libraryInstallationId: libraryId,
          catalogHost: owner,
        });
      const gitPasses = (libraryId: string) => {
        const access = gitAccess(libraryId);
        return createWorkflowGitPasses({
          denied: () => new AppInstanceError("revoked"),
          admitNode: (context, target) => {
            const node = owner.gitNode(context.idempotencyKey);
            return node?.teamId === libraryId &&
              node.installationId === target.installationId &&
              node.method === target.method
              ? node
              : null;
          },
          async admitMemberGitAccess(memberId, repository, scope) {
            if (!(await access(memberId, repository, scope)))
              throw new AppInstanceError("revoked");
          },
          revoke: (_computer, input) => {
            passStore.revokeWorkflowRunGitPasses(input);
            return Promise.resolve();
          },
          // Revocation runs in this object when the run ends; nothing is queued.
          pending: () => [],
          acknowledge: () => undefined,
        });
      };
      return {
        owner,
        libraryTriggers,
        passStore,
        gitAccess,
        gitPasses,
        computerId,
      };
    });
    ctx.waitUntil(
      this.composed.then(async ({ libraryTriggers }) => {
        const libraryId = this.libraryId();
        if (libraryId !== null)
          await libraryTriggers(libraryId).webhooks?.recover();
      }),
    );
    this.owner = this.composed.then(({ owner }) => owner);
  }
  /** Record the library this object serves; another name is a revocation. */
  private nameLibrary(libraryId: string): void {
    const named = this.libraryId();
    if (named !== null && named !== libraryId)
      throw new AppInstanceError("revoked");
    if (named === null)
      this.ctx.storage.sql.exec(
        "INSERT INTO standalone_workflow_library(singleton,installation_id) VALUES(1,?)",
        libraryId,
      );
  }
  /**
   * Admit the Git step a node frame is executing: its public grant, never a
   * credential. Null when this library dispatched no such step; a step that
   * does not match the frame's attested Workflow, member and Computer is a
   * revocation. Only NEW native admission then issues, through issueWorkflowGit.
   */
  async admitWorkflowGit(
    raw: WorkflowGitPassRequest,
  ): Promise<WorkflowGitPassGrant | null> {
    const request = workflowGitPassRequestSchema.parse(raw);
    const { owner, gitPasses } = await this.composed;
    const libraryId = this.libraryId();
    const node = owner.gitNode(request.idempotencyKey);
    if (libraryId === null || node === null) return null;
    if (
      node.teamId !== libraryId ||
      node.installationId !== request.installationId ||
      node.memberId !== request.memberId ||
      node.computerId !== request.computerId ||
      node.context.workflowId !== request.workflow.workflowId ||
      node.context.runId !== request.workflow.runId ||
      node.context.nodeId !== request.workflow.nodeId ||
      canonicalJson(node.context.armedBy) !==
        canonicalJson(request.workflow.armedBy)
    )
      throw new AppInstanceError("revoked");
    return gitPasses(libraryId).admitWorkflowGit(node.context, {
      installationId: node.installationId,
      method: node.method,
    });
  }
  /** One fresh credential for a NEW native invocation of an admitted step. */
  async issueWorkflowGit(
    invocationId: string,
    grant: WorkflowGitPassGrant,
  ): Promise<WorkflowGitCredential> {
    const { passStore } = await this.composed;
    return await passStore.issue(invocationId, grant);
  }
  /** A live native replay extends its lease; it never issues another. */
  async renewWorkflowGit(
    invocationId: string,
    grant: WorkflowGitPassGrant,
  ): Promise<void> {
    const { passStore } = await this.composed;
    passStore.renew(invocationId, grant);
  }
  /** Close an invocation's credential, even before its issue arrives. */
  async closeWorkflowGit(
    invocationId: string,
    grant: WorkflowGitPassGrant,
  ): Promise<void> {
    const { passStore } = await this.composed;
    passStore.close(invocationId, grant);
  }
  /** The tenant Git door's per-request admission of a presented bearer. */
  async admitWorkflowGitPass(
    bearer: string,
    repository: RepositoryRef,
    scope: "read" | "write",
  ): Promise<Extract<GitWriter, { kind: "actor" }> | null> {
    const { owner, passStore, gitAccess, computerId } = await this.composed;
    const libraryId = this.libraryId();
    const admitted = await passStore.admit({ bearer, repository, scope });
    if (libraryId === null || admitted === null || computerId === undefined)
      return null;
    const { grant, invocationId } = admitted;
    if (
      // The selected Computer proves the credential's native command live.
      !(await this.env.COMPUTER.getByName(computerId).executionIsLive(
        invocationId,
      )) ||
      owner.store.outcome(grant.runId) !== "active" ||
      !(await gitAccess(libraryId)(grant.memberId, repository, scope))
    )
      return null;
    // The live root admission above holds only for the canonical owner.
    return { ...workflowGitPassWriter(grant), role: "owner" };
  }
  /** A finished run's passes and recorded Git steps end with it. */
  private async endRunGit(runId: string): Promise<void> {
    const { owner, passStore } = await this.composed;
    const run = owner.store.read(runId);
    if (run !== null)
      passStore.revokeWorkflowRunGitPasses({ teamId: run.teamId, runId });
    owner.forgetGitNodes(runId);
  }
  private libraryId(): string | null {
    const row = this.ctx.storage.sql
      .exec("SELECT installation_id FROM standalone_workflow_library")
      .toArray()[0];
    return row === undefined
      ? null
      : S.decodeUnknownSync(S.Struct({ installation_id: S.String }))(row)
          .installation_id;
  }
  /** Trigger controls open the library named by the admitted frame. */
  private async library(
    facts: InvocationFacts,
    operation: ScheduleOperation | EventTriggerOperation,
  ) {
    const { owner, libraryTriggers } = await this.composed;
    const { libraryId } = await owner.admitInvocation(facts, operation);
    return libraryTriggers(libraryId);
  }
  /** Idempotently ensure a recorded run has its engine instance. */
  private async launch(
    installationId: string,
    run: Readonly<{ runId: string; planDigest: string }>,
  ): Promise<void> {
    try {
      await this.env.GRAPH_WORKFLOWS.create({
        id: run.runId,
        params: {
          kind: "run",
          teamId: installationId,
          runId: run.runId,
          planDigest: run.planDigest,
        },
      });
    } catch (cause) {
      // The durable run survives a lost create reply. Confirm its owned engine
      // instance exists; unrelated create failures remain failures.
      try {
        await (await this.env.GRAPH_WORKFLOWS.get(run.runId)).status();
      } catch {
        throw cause;
      }
    }
  }
  async armSchedule(facts: InvocationFacts, input: TriggerArmTarget) {
    return (await this.library(facts, "armSchedule")).schedules.arm(
      facts,
      input,
    );
  }
  async disarmSchedule(facts: InvocationFacts, input: ScheduleDisarmInput) {
    return (await this.library(facts, "disarmSchedule")).schedules.disarm(
      facts,
      input,
    );
  }
  async pauseSchedule(facts: InvocationFacts, input: { scheduleId: string }) {
    return (await this.library(facts, "pauseSchedule")).schedules.pause(
      facts,
      input,
    );
  }
  async resumeSchedule(facts: InvocationFacts, input: { scheduleId: string }) {
    return (await this.library(facts, "resumeSchedule")).schedules.resume(
      facts,
      input,
    );
  }
  async schedules(facts: InvocationFacts, input: ScheduleListInput) {
    return (await this.library(facts, "schedules")).schedules.list(
      facts,
      input,
    );
  }
  async armEventTrigger(facts: InvocationFacts, input: TriggerArmTarget) {
    return (await this.library(facts, "armEventTrigger")).events.arm(
      facts,
      input,
    );
  }
  async disarmEventTrigger(facts: InvocationFacts, input: EventDisarmInput) {
    return (await this.library(facts, "disarmEventTrigger")).events.disarm(
      facts,
      input,
    );
  }
  async eventTriggers(facts: InvocationFacts) {
    return (await this.library(facts, "eventTriggers")).events.list(facts);
  }
  /** Up to 50 runs of this library, newest first; this host has no per-member rule. */
  async runs(facts: InvocationFacts, input: { workflowId?: string }) {
    const owner = await this.owner;
    const { libraryId } = await owner.admitInvocation(facts, "runs");
    const filter =
      input.workflowId === undefined
        ? { installationId: libraryId }
        : { installationId: libraryId, workflowId: input.workflowId };
    return {
      runs: owner.store.list(filter).map((run) => {
        const row = {
          runId: run.runId,
          workflowId: run.publication?.workflowId ?? run.trigger?.workflowId,
          commit: run.publication?.commit ?? run.trigger?.commit,
          source: run.source,
          initiatedBy: wireRunInitiator(run.initiatedBy),
          startedAt: run.startedAt,
        };
        return run.trigger === undefined
          ? row
          : { ...row, triggerId: run.trigger.triggerId };
      }),
    };
  }
  /** Native alarm delivery: fire every due schedule of this library. */
  override async alarm(): Promise<void> {
    const { libraryTriggers } = await this.composed;
    const libraryId = this.libraryId();
    if (libraryId === null) return;
    await libraryTriggers(libraryId).schedules.alarm();
    await libraryTriggers(libraryId).webhooks?.recover();
  }
  /** Signed traffic uses the native fetch interface; no sender principal is accepted. */
  override async fetch(request: Request): Promise<Response> {
    return new Hono()
      .all("/webhooks/:bindingId", async (context) => {
        const { libraryTriggers } = await this.composed;
        const libraryId = this.libraryId();
        const webhooks =
          libraryId === null ? null : libraryTriggers(libraryId).webhooks;
        return webhooks === null
          ? workflowWebhookRefusal()
          : webhooks.receive(context.req.param("bindingId"), context.req.raw);
      })
      .fetch(request);
  }
  async #isWebhookOwner(principal: TenantPrincipal) {
    const shared = await standaloneTenancy(this.env);
    const current = await shared.owner();
    return (
      principal.actor.kind === "member" &&
      current?.actor.memberId === principal.actor.memberId
    );
  }
  /** Root-authenticated owner RPC; command data cannot nominate an actor or pin. */
  async webhookControl(
    principal: TenantPrincipal,
    installationId: string,
    raw: unknown,
  ): Promise<Response> {
    if (!(await this.#isWebhookOwner(principal)))
      return workflowWebhookRefusal();
    const parsed = workflowWebhookCommandSchema.safeParse(raw);
    if (!parsed.success) return workflowWebhookRefusal();
    const { owner, libraryTriggers } = await this.composed;
    const webhooks = libraryTriggers(installationId).webhooks;
    if (webhooks === null) return workflowWebhookRefusal();
    return workflowWebhookControlResponse(
      webhooks,
      principal,
      parsed.data,
      async (target) => ({
        target: { ...target, installationId },
        authority: (await owner.triggerAuthority(installationId)).pin,
      }),
    );
  }
  /**
   * The emitting App's Instance delivers each accepted event here. The
   * emitter's live Release must declare the event and its payload schema
   * must accept it before any armed trigger of this library fires.
   */
  async deliverEvent(fact: AppEventFact): Promise<"accepted"> {
    const { owner, libraryTriggers } = await this.composed;
    const libraryId = this.libraryId();
    if (libraryId === null) return "accepted";
    const admitted = await owner.admitEventFact(fact);
    return libraryTriggers(libraryId).events.deliver(admitted);
  }
  async catalog(
    facts: InvocationFacts,
    input?: Readonly<{ installationId?: string }>,
  ) {
    const owner = await this.owner;
    return owner.catalog(facts, input);
  }
  async start(facts: InvocationFacts, input: GraphStartRequest) {
    const owner = await this.owner;
    const result = await owner.prepare(facts, input);
    const installationId = facts.selection.owner.id;
    if (
      !("kind" in result) ||
      (result.kind !== "started" && result.kind !== "replay")
    )
      return result;
    if (owner.store.outcome(result.runId) !== "active") return result;
    this.nameLibrary(installationId);
    await this.launch(installationId, result);
    return result;
  }
  async loadRun(installationId: string, runId: string) {
    const owner = await this.owner;
    return owner.loadRun(installationId, runId);
  }
  async beforeNode(event: NodeEvent) {
    const owner = await this.owner;
    return owner.beforeNode(event);
  }
  async dispatch(call: NodeCall) {
    const owner = await this.owner;
    return owner.dispatch(call);
  }
  async recordEvent(event: NodeEvent): Promise<void> {
    const owner = await this.owner;
    owner.store.recordEvent(event);
  }
  async openReview(review: GraphReview): Promise<number> {
    const owner = await this.owner;
    return owner.store.openReview(review);
  }
  async answerReview(facts: InvocationFacts, raw: typeof reviewKey.Type) {
    const owner = await this.owner;
    const input = S.decodeUnknownSync(reviewKey)(raw, {
      onExcessProperty: "error",
    });
    const { libraryId, context } = await (
      await this.owner
    ).admitInvocation(facts, "answerReview");
    const run = owner.store.read(input.runId);
    if (run?.teamId !== libraryId || context.actor.kind !== "member")
      return { result: "denied" };
    const result = owner.store.answerReview(input, input.answer, {
      kind: "member",
      actorId: context.actor.memberId,
      isOwner: context.role === "owner",
    });
    if (result === "denied" || result === "invalid") return { result };
    for (const delivery of owner.store.pendingReviewDeliveries(input.runId)) {
      const instance = await this.env.GRAPH_WORKFLOWS.get(delivery.instanceId);
      await owner.admitInvocation(facts, "answerReview");
      if (owner.store.outcome(input.runId) !== "active") break;
      await instance.sendEvent({
        type: delivery.eventType,
        payload: delivery.answer,
      });
      owner.store.markReviewDelivered(delivery);
    }
    return { result };
  }
  /** Record the engine's ending, then report it to the run's declared delivery. */
  async terminal(runId: string, ending: GraphRunEnding): Promise<void> {
    const owner = await this.owner;
    owner.store.markTerminal(runId, "terminal");
    await this.endRunGit(runId);
    await this.report(runId, ending);
  }
  /**
   * One idempotent follow-up into the run's declared delivery Session, however
   * the run started, through the same Session send that the AGENTS binding
   * uses. Delivery never changes the run's recorded outcome.
   */
  private async report(
    runId: string,
    ending: WorkflowRunEnding,
  ): Promise<void> {
    const owner = await this.owner;
    const run = owner.store.read(runId);
    const delivery = run?.delivery;
    if (run === null || delivery === undefined) return;
    try {
      await this.env.AGENTS.getByName(delivery.agentId).sendFromApp(
        run.teamId,
        delivery.sessionId,
        {
          requestId: `workflow-run-report:${runId}`,
          text: workflowRunReport(run.plan.definition.title, runId, ending),
          delivery: "followUp",
        },
      );
    } catch (cause) {
      console.error("Workflow run report was not delivered", runId, cause);
    }
  }
  async status(facts: InvocationFacts, raw: { runId: string }) {
    const owner = await this.owner;
    const { runId } = S.decodeUnknownSync(runKey)(raw, {
      onExcessProperty: "error",
    });
    const { libraryId: installationId } = await (
      await this.owner
    ).admitInvocation(facts, "graphStatus");
    const run = owner.store.read(runId);
    if (run?.teamId !== installationId) return { error: "not_found" };
    return this.runStatus(runId);
  }
  private async runStatus(runId: string) {
    const owner = await this.owner;
    const run = owner.store.read(runId);
    if (run === null) return null;
    const outcome = owner.store.outcome(runId);
    let status: Pick<InstanceStatus, "status"> &
      Partial<Pick<InstanceStatus, "output" | "error">>;
    try {
      status = await (await this.env.GRAPH_WORKFLOWS.get(runId)).status();
    } catch (cause) {
      // The recorded run is visible before its engine instance is: while
      // the run is still active, a failed instance lookup is that honest
      // wait, not a fault. A settled run's lookup failure stays a failure.
      if (outcome !== "active") throw cause;
      status = { status: "queued" };
    }
    return {
      runId,
      planDigest: run.plan.planDigest,
      title: run.plan.definition.title,
      outcome,
      events: owner.store.events(runId),
      reviews: owner.store.reviews(runId),
      status: outcome === "cancelled" ? "terminated" : status.status,
      output: outcome === "cancelled" ? null : (status.output ?? null),
      error: status.error ?? null,
    };
  }
  async cancel(facts: InvocationFacts, raw: { runId: string }) {
    const owner = await this.owner;
    const { runId } = S.decodeUnknownSync(runKey)(raw, {
      onExcessProperty: "error",
    });
    const { libraryId: installationId } = await (
      await this.owner
    ).admitInvocation(facts, "cancel");
    const run = owner.store.read(runId);
    if (run?.teamId !== installationId)
      return { kind: "refused", reason: "denied" };
    return this.cancelRun(runId);
  }
  /** Host-only MCP control reopens the configured owner's authority on every call. */
  async control(
    principal: TenantPrincipal,
    operation: "status" | "cancel",
    runId: string,
  ) {
    const shared = await standaloneTenancy(this.env);
    const current = await shared.owner();
    if (
      principal.actor.kind !== "member" ||
      current?.actor.memberId !== principal.actor.memberId
    )
      throw new AppInstanceError("revoked");
    const owner = await this.owner;
    if (owner.store.read(runId) === null) return null;
    return operation === "status"
      ? this.runStatus(runId)
      : this.cancelRun(runId);
  }
  private async cancelRun(runId: string) {
    const owner = await this.owner;
    if (owner.store.outcome(runId) !== "active") return { kind: "terminal" };
    const instance = await this.env.GRAPH_WORKFLOWS.get(runId);
    try {
      await instance.terminate();
    } catch (cause) {
      const status = await instance.status();
      if (
        status.status !== "terminated" &&
        status.status !== "complete" &&
        status.status !== "errored"
      )
        throw cause;
      owner.store.markTerminal(
        runId,
        status.status === "terminated" ? "cancelled" : "terminal",
      );
      await this.endRunGit(runId);
      if (status.status === "terminated")
        await this.report(runId, { kind: "cancelled" });
      return {
        kind: status.status === "terminated" ? "cancelled" : "terminal",
      };
    }
    owner.store.markTerminal(runId, "cancelled");
    await this.endRunGit(runId);
    await this.report(runId, { kind: "cancelled" });
    return { kind: "cancelled" };
  }
}

/** The SAME extracted interpreter as Hub, with this host's owned ports. */
export class StandaloneGraphWorkflow extends GraphWorkflow<StandaloneWorkflowEnv> {
  protected override codeExecution() {
    const localCpuUnenforced =
      "WORKFLOW_CODE_LOCAL_DEV" in this.env &&
      this.env.WORKFLOW_CODE_LOCAL_DEV === "true";
    return {
      sandbox: createCodemodeSandbox(this.env.LOADER, "workflow-code", {
        localDevUnenforcedLimits: localCpuUnenforced ? ["cpu"] : [],
      }),
      // Workflow data transforms have a host-owned 30-second execution budget.
      timeoutMs: 30_000,
    };
  }
  protected override dispatcher(params: GraphParams): NodeDispatcher {
    const runs = this.env.WORKFLOW_RUNS.getByName(params.teamId);
    return {
      loadRun: (installationId, runId) => runs.loadRun(installationId, runId),
      beforeNode: (event) => runs.beforeNode(event),
      dispatch: (call) => runs.dispatch(call),
      recordEvent: (event) => runs.recordEvent(event),
      openReview: (review) => runs.openReview(review),
    };
  }
  protected override terminalTriggerRun(
    params: GraphParams,
    ending: GraphRunEnding,
  ): Promise<void> {
    return this.env.WORKFLOW_RUNS.getByName(params.teamId).terminal(
      params.runId,
      ending,
    );
  }
}
