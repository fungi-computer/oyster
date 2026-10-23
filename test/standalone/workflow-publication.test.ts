import * as Result from "effect/Result";
import {
  applyInstallationCommand,
  deriveDeclaredOperations,
  approvedBindingGrants,
  type Installation,
} from "@fungi.computer/oyster/apps";
import {
  graphStartRequestSchema,
  createWorkflowRunAuthority,
  createWorkflowCeilingCapture,
  armedWorkflowTriggerSchema,
  createTeamWorkflowTriggers,
  createTriggerPlans,
} from "@fungi.computer/braid/runtime";
import * as S from "effect/Schema";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import {
  createWorkflowPublishedDefinitionPort,
  readPublishedWorkflow,
  runReply,
} from "@fungi.computer/workflows-wire";
import { appSurfaceCache, oysterAppMethods } from "../../src/mcp.js";
import { workflowAgentAuthority } from "../../src/workflow-agent-authority.js";
import { createStandaloneWorkflowSchedules } from "../../src/standalone/workflow-schedules.js";
import { standaloneTriggerErrors } from "../../src/standalone/workflow-trigger-host.js";
import { triggerArmTargetSchema } from "../../src/standalone/workflow-binding.js";
import type { AppToolPolicy } from "../../src/apps/index.js";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  parseAppId,
  parseReleaseId,
  parseArtifactRef,
  parseSourceRevision,
  parseSha256Digest,
} from "@fungi.computer/puffball";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { createWorkflowLibrary } from "../../../../apps/trellis/backend/library.js";
import { createWorkflowIndexes } from "../../../../apps/trellis/backend/indexes.js";
import {
  appBackend,
  type WorkflowMethodContext,
} from "../../../../apps/trellis/backend/methods.js";
import { unusedGraphOperations } from "../../../../apps/trellis/test/library.fixture.js";
import { realGit } from "@fungi.computer/agar/test-kit/git";
import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { z } from "zod";
import { catalogReplySchema } from "../../../../apps/trellis/backend/catalog.js";
import { probeDeclaration } from "./workflow-probe/declaration.js";
import {
  sha256,
  verifyRelease,
  type ArtifactStore,
  type InstanceResult,
  type VerifiedRelease,
  type OysterHost,
} from "@fungi.computer/oyster/host";
import type { AppMethodReply } from "@fungi.computer/agar/backend";
import { admittedCallerFacts } from "@fungi.computer/oyster/invocation";
import { instanceIds, type AppInstanceErrorCode } from "@fungi.computer/oyster";
import { ownerKeyAuth } from "../../src/auth.js";
import { createInstallationStoreGeneration } from "../../src/installation-store-generation.js";
import { OysterApprovalHome } from "../../src/approval-home.js";
import { defaultTenant, tenantScope } from "../../src/tenant.js";
import { createAdmittedGit } from "@fungi.computer/oyster/git";
import type { InvocationFacts } from "@fungi.computer/oyster/invocation";
import type { WorkflowDefinition } from "@fungi.computer/braid";
import {
  createStandaloneWorkflowHost,
  type StandaloneWorkflowHost,
} from "../../src/standalone/workflow-host.js";
import { appBackend as workflowsBackend } from "../../../../apps/trellis/backend/methods.js";
import { appBackend as printsBackend } from "../../../../apps/prints/backend/methods.js";
import printsMetadata from "../../../../apps/prints/package.json" with { type: "json" };
import storyboardTemplate from "../../../../apps/trellis/templates/storyboard.json" with { type: "json" };
import { appCapabilityIdSchema } from "@fungi.computer/puffball/app";
import workflowsMetadata from "../../../../apps/trellis/package.json" with { type: "json" };
const printsDeclaration = buildAppDeclaration(
  printsBackend,
  printsMetadata.fungi.app,
);
const appDeclaration = buildAppDeclaration(
  workflowsBackend,
  workflowsMetadata.fungi.app,
);

async function fixture(
  publisher = true,
  publishGranted = true,
  call: (
    facts: InvocationFacts,
  ) => Promise<InstanceResult<AppMethodReply>> = () =>
    Promise.resolve({ ok: true, value: { kind: "ok", value: [] } }),
  lifecycleMember: Parameters<
    typeof createStandaloneWorkflowHost
  >[2]["lifecycleMember"] = () => Promise.resolve(null),
) {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const generation = createInstallationStoreGeneration(storage.sql);
  const git = realGit();
  const blobs = new Map<string, Uint8Array>();
  const artifactReads: string[] = [];
  const artifacts: ArtifactStore = {
    get: (ref) => {
      artifactReads.push(ref);
      return Promise.resolve(blobs.get(ref) ?? null);
    },
    put: (ref, bytes) => {
      blobs.set(ref, bytes);
      return Promise.resolve();
    },
  };
  async function put(value: unknown) {
    const bytes = new TextEncoder().encode(
      JSON.stringify(S.decodeUnknownSync(S.Json)(value)),
    );
    const digest = parseSha256Digest(await sha256(bytes));
    const artifactRef = parseArtifactRef(`artifact:sha256-${digest.slice(7)}`);
    blobs.set(artifactRef, bytes);
    return {
      artifactRef,
      digest,
      version: "fixture",
      byteLength: bytes.length,
    };
  }
  async function install(
    id: string,
    declaration: typeof appDeclaration,
  ): Promise<Installation> {
    const backend = {
      ...(await put({
        runtime: { kind: "durable-facet", stateSchema: 1 },
        compatibilityDate: "2026-09-04",
        exportName: "Fixture",
        code: "export class Fixture {}",
      })),
      mediaType: backendMediaType,
    };
    const root = await put(createAppBuild(null, backend, declaration));
    const release = {
      appId: parseAppId(`app_${id}`),
      releaseId: parseReleaseId(`rel_${id}`),
      artifact: {
        artifactRef: root.artifactRef,
        artifactDigest: root.digest,
        provenance: {
          sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
          sourceTreeDigest: root.digest,
          buildRecipeDigest: root.digest,
        },
      },
    };
    const declaredOperations = await deriveDeclaredOperations(
      release,
      declaration,
      [],
    );
    const result = applyInstallationCommand(
      null,
      {
        kind: "install",
        release,
        releasePin: "pinned",
      },
      {
        by: { kind: "member", memberId: "arming-owner" },
        role: "owner",
        expectedVersion: null,
        declaration,
        declaredOperations,
        now: 1000,
        identity: {
          installationId: id,
          instanceId: instanceIds.instance.generate(),
        },
      },
    );
    if (Result.isFailure(result)) throw new Error(result.failure.code);
    if (declaredOperations.capabilities.length === 0)
      return result.success.next;
    const approved = applyInstallationCommand(
      result.success.next,
      {
        kind: "change-grants",
        changes: declaredOperations.capabilities.map(
          ({ capability, operations }) => ({
            capability,
            grant:
              publishGranted || capability !== "workflow.publish"
                ? { operations, resources: "tenant-scope" }
                : null,
          }),
        ),
      },
      {
        by: { kind: "member", memberId: "arming-owner" },
        role: "owner",
        expectedVersion: result.success.next.authority.authorityVersion,
        declaration,
        declaredOperations,
        now: 1001,
        identity: result.success.next,
      },
    );
    if (Result.isFailure(approved)) throw new Error(approved.failure.code);
    return approved.success.next;
  }
  const runner = buildAppDeclaration(
    defineAppBackend({
      methods: {
        run: defineAppMethod({
          description: "Run a supplied graph",
          effect: "write",
          requires: ["workflow.run"],
          input: z.object({}),
          output: z.object({}),
          handler: () => ({}),
        }),
      },
    }),
    {
      capabilities: ["workflow.run"],
      handlers: [],
      roles: [],
      backend: {
        bindings: [{ name: "WORKFLOWS", operations: ["catalog", "runGraph"] }],
      },
    },
  );
  const installation = await install(
    "library",
    publisher ? appDeclaration : runner,
  );
  const probe = await install("probe", {
    ...probeDeclaration,
    displayName: "Runtime probe",
    icon: "prints",
  });
  const installations = [installation, probe];
  let allowGit = true;
  const calls: InvocationFacts[] = [];
  const admittedGit = createAdmittedGit({
    installationId: "library",
    store: git.git,
    grants: { admits: () => Promise.resolve(allowGit) },
    policy: { authorize: () => Promise.reject(new Error("Read-only proof")) },
    journal: {
      tip: () => Promise.resolve(null),
      record: () => Promise.reject(new Error("Read-only proof")),
    },
  });
  const host: StandaloneWorkflowHost = {
    artifacts,
    installations: {
      generation: () => Promise.resolve(generation()),
      list: () => Promise.resolve(installations),
      get: (id) =>
        Promise.resolve(
          installations.find((entry) => entry.installationId === id) ?? null,
        ),
      compareAndPut: () =>
        Promise.reject(new Error("Fixture installation is fixed")),
    },
    git: {
      writerOf: () => {
        throw new Error("No HTTP writer");
      },
      git: (selected) => {
        if (selected.installationId !== "library")
          throw new Error("Wrong library");
        return Promise.resolve(admittedGit);
      },
    },
    instances: {
      get: () => ({
        call: (facts) => {
          calls.push(facts);
          return call(facts);
        },
        gill: () => Promise.reject(new Error("Unexpected Gill")),
        prepare: () => Promise.reject(new Error("Unexpected prepare")),
        apply: () => Promise.reject(new Error("Unexpected apply")),
        fetch: () => Promise.reject(new Error("Unexpected fetch")),
        onGitPush: () => Promise.reject(new Error("Unexpected lifecycle")),
        syncRefused: () => Promise.reject(new Error("Unexpected sync refusal")),
        authorizeGitPush: () =>
          Promise.reject(new Error("Unexpected lifecycle")),
      }),
    },
  };
  const authorityOptions = {
    lifecycleMember,
    admitDelivery: (_memberId: string, delivery: { agentId: string }) =>
      Promise.resolve(delivery.agentId === "agent_reports"),
    authority: () =>
      createWorkflowRunAuthority({
        member: (id) =>
          Promise.resolve(
            id === "arming-owner" || id === "another-member"
              ? { membershipVersion: 1 }
              : null,
          ),
        memberComputer: (_id, computerId) =>
          Promise.resolve(computerId === "storyboard-computer"),
        catalog: () =>
          Promise.reject(new Error("Unexpected authority catalog")),
        admitAgent: () => Promise.resolve(false),
        capture: createWorkflowCeilingCapture({
          async node(_actor, _member, target) {
            const current = await host.installations.get(target.installationId);
            if (current?.installationId === "prints") {
              const prints = await verifyRelease(
                artifacts,
                current.release,
                undefined,
                false,
              );
              const method = prints.api?.methods[target.method];
              if (method === undefined) return null;
              return {
                level: method.effect === "read" ? "read" : "write",
                capabilities: S.decodeUnknownSync(
                  S.Array(appCapabilityIdSchema),
                )(method.requires),
                bindings: [],
              };
            }
            if (
              current?.status !== "enabled" ||
              current.installationId !== "probe" ||
              target.method !== "counts"
            )
              return null;
            const release = await verifyRelease(
              artifacts,
              current.release,
              undefined,
              false,
            );
            const method = release.api?.methods.counts;
            if (method?.effect !== "read" || method.requires.length !== 0)
              return null;
            return { level: "read", capabilities: [], bindings: [] };
          },
          git: () => Promise.resolve(false),
        }),
        denied: () => new Error("Fixture member revoked"),
      }),
  };
  const owner = createStandaloneWorkflowHost(storage, host, authorityOptions);
  const verified = await verifyRelease(
    artifacts,
    installation.release,
    undefined,
    false,
  );
  const facts = admittedCallerFacts(
    installation,
    verified,
    {
      actor: { kind: "member", memberId: "arming-owner" },
      role: "owner",
      computerId: null,
    },
    approvedBindingGrants(installation, appDeclaration),
  );
  const detail = await owner.catalog(facts, { installationId: "probe" });
  if (!("app" in detail)) throw new Error("Missing probe");
  const entry = detail.app;
  const method = entry.methods.counts;
  if (!method) throw new Error("Missing method");
  const indexes = createWorkflowIndexes(storage);
  const library = createWorkflowLibrary({
    index: indexes,
    git: git.git,
    author: { name: "Test", email: "test@example.invalid" },
    catalog: () => Promise.resolve({ app_probe: { methods: entry.methods } }),
  });
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Published definition",
    apps: { probe: { appId: "app_probe", role: "probe" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "done",
        kind: "app",
        app: "probe",
        method: "counts",
        methodDigest: method.digest,
        values: {},
      },
    ],
    edges: [],
    output: { value: { node: "done", port: "value" } },
  };
  const saved = await library.saveDraft(
    "example",
    { definition, layout: {} },
    0,
  );
  if (saved.kind !== "saved") throw new Error("Draft not saved");
  const published = await library.publish("example", saved.revision);
  if (published.kind !== "published") throw new Error("Draft not published");
  const storedPublication = library.publishedRow("example", {
    commit: published.commit,
  });
  if (storedPublication === null) throw new Error("Published row missing");
  const revokeCapability = async (
    capability: "workflow.publish" | "workflow.run",
  ) => {
    const current = installations[0];
    if (!current) throw new Error("Missing library installation");
    const selected = await verifyRelease(
      artifacts,
      current.release,
      undefined,
      false,
    );
    const declaration = selected.declaration;
    if (!declaration) throw new Error("Missing library declaration");
    const changed = applyInstallationCommand(
      current,
      {
        kind: "change-grants",
        changes: [{ capability, grant: null }],
      },
      {
        by: { kind: "member", memberId: "arming-owner" },
        role: "owner",
        expectedVersion: current.authority.authorityVersion,
        declaration,
        declaredOperations: await deriveDeclaredOperations(
          current.release,
          declaration,
          [],
        ),
        now: 1001,
        identity: {
          installationId: current.installationId,
          instanceId: current.instanceId,
        },
      },
    );
    if (Result.isFailure(changed)) throw new Error(changed.failure.code);
    installations[0] = changed.success.next;
  };
  return {
    owner,
    storage,
    facts,
    method,
    definition,
    commit: published.commit,
    revision: saved.revision,
    digest: storedPublication.digest,
    indexes,
    calls,
    git,
    host,
    installation,
    artifactReads,
    disableInstallation: (id: string) => {
      const position = installations.findIndex(
        (entry) => entry.installationId === id,
      );
      const current = installations[position];
      if (!current) throw new Error("Missing installation");
      installations[position] = { ...current, status: "disabled" };
    },
    revokePublication: () => revokeCapability("workflow.publish"),
    revokeRun: () => revokeCapability("workflow.run"),
    recreateOwner: (selectedHost = host) =>
      createStandaloneWorkflowHost(storage, selectedHost, authorityOptions),
    /** Install the maintained Prints App the Storyboard template binds. */
    addPrints: async () => {
      installations.push(await install("prints", printsDeclaration));
    },
    /** The library caller's facts on a Computer this member may pin. */
    factsOn: (computerId: string) =>
      admittedCallerFacts(
        installation,
        verified,
        {
          actor: { kind: "member", memberId: "arming-owner" },
          role: "owner",
          computerId,
        },
        approvedBindingGrants(installation, appDeclaration),
      ),
    addPeer: async (
      id: string,
      declaration: typeof appDeclaration = probeDeclaration,
    ) => {
      installations.push(
        await install(id, {
          ...declaration,
          displayName: id,
        }),
      );
    },
    replaceProbe: async () => {
      const replacement = await install("probe", {
        ...probeDeclaration,
        displayName: "Updated probe",
        icon: "shed",
      });
      installations[1] = replacement;
    },
    library,
    revokeGit: () => {
      allowGit = false;
    },
    close: () => {
      database.close();
      git.close();
    },
  };
}

it.each([
  "write",
  "read",
  "revoked",
  "reapproved",
  "regranted",
  "downgraded",
] as const)(
  "an Agent's %s App grant controls Trellis arming and durable provenance",
  async (approval) => {
    const f = await fixture();
    const unexpected = (): never => {
      throw new Error(
        "Arming dispatched a run or requested undeclared authority",
      );
    };
    const policy: AppToolPolicy = {
      level: approval === "read" ? "read" : "write",
      revision: "approved-agent-policy",
      grantedBy: "arming-owner",
    };
    const agentId = "agent-author";
    let currentPolicy: AppToolPolicy | null = policy;
    const readPolicy = () => Promise.resolve(currentPolicy);
    const canArm = approval === "write";
    try {
      const git = f.host.git;
      const instanceId = f.installation.instanceId;
      if (git === undefined || instanceId === null)
        throw new Error("Missing installed library");
      const draft = await f.library.saveDraft(
        "example",
        {
          definition: {
            ...f.definition,
            triggers: [
              {
                id: "nightly",
                on: "schedule",
                cron: { expression: "0 6 * * *", timeZone: "UTC" },
                input: {},
              },
            ],
          },
          layout: {},
        },
        f.revision,
      );
      if (draft.kind !== "saved") throw new Error("Schedule draft not saved");
      const publication = await f.library.publish("example", draft.revision);
      if (publication.kind !== "published")
        throw new Error("Schedule not published");
      const triggers = createTeamWorkflowTriggers({
        runs: {
          member: (memberId) => {
            expect(memberId).toBe("arming-owner");
            return Promise.resolve({ membershipVersion: 1 });
          },
          memberComputer: (memberId, computerId) =>
            Promise.resolve(
              memberId === "arming-owner" &&
                computerId === "storyboard-computer",
            ),
          catalog: async () => {
            const catalog = await f.owner.catalog(f.facts, {
              installationId: "probe",
            });
            if (!("app" in catalog)) throw new Error("Catalog not admitted");
            return [catalog.app];
          },
          admitDelivery: unexpected,
          triggerPlans: createTriggerPlans(f.storage.sql),
          startCachedGraph: unexpected,
        },
        published: createWorkflowPublishedDefinitionPort((git) => ({
          published: (workflowId, at) =>
            readPublishedWorkflow(git, workflowId, at),
        })),
        source: async (memberId) =>
          (await git.git(f.installation)).binding({
            kind: "member",
            memberId,
          }),
        admit: async () => (await f.owner.triggerAuthority("library")).pin,
        readAgentAccess: () =>
          Promise.resolve(
            currentPolicy === null
              ? null
              : {
                  kind: "policy",
                  agentId,
                  policyRevision: currentPolicy.revision,
                  grantorMemberId: currentPolicy.grantedBy,
                  level: currentPolicy.level,
                },
          ),
        admitGitAccess: unexpected,
        launch: unexpected,
        errors: standaloneTriggerErrors,
      });
      const schedules = createStandaloneWorkflowSchedules<InvocationFacts>({
        sql: f.storage.sql,
        triggers,
        teamId: () => "library",
        now: () => Date.parse("2026-10-13T12:00:00Z"),
        commit: (body) => Promise.resolve(f.storage.transactionSync(body)),
        authorize: (memberId, installationId) => {
          expect(memberId).toBe("arming-owner");
          expect(installationId).toBe("library");
          return Promise.resolve();
        },
        wake: () => Promise.resolve(),
        reportFailure: unexpected,
        admitInvocation: async (facts, operation) => ({
          ...(await f.owner.admitInvocation(facts, operation)),
          authority: await workflowAgentAuthority(facts, operation, readPolicy),
        }),
      });
      const results: unknown[] = [];
      let armDispatches = 0;
      const host: OysterHost = {
        ...f.host,
        auth: ownerKeyAuth(
          "workflow-fixture-owner-secret-123456789",
          "arming-owner",
        ),
        bootUi: unexpected,
        computerId: "storyboard-computer",
        appToolPolicy: readPolicy,
        instances: {
          get: () => ({
            ...f.host.instances.get(instanceId),
            async call(
              facts: InvocationFacts,
              _api: NonNullable<VerifiedRelease["api"]>,
              name: string,
              input: unknown,
            ) {
              if (facts.subject.kind !== "call")
                throw new Error("Expected admitted App method");
              if (name === "arm") armDispatches++;
              const value = await appBackend.call(
                name,
                S.decodeUnknownSync(S.Json)(input),
                {
                  indexes: f.indexes,
                  env: {
                    GIT: f.git.git,
                    WORKFLOWS: {
                      ...unusedGraphOperations,
                      armSchedule: async (target) =>
                        S.decodeUnknownSync(S.Json)(
                          await schedules.arm(
                            facts,
                            triggerArmTargetSchema.parse(target),
                          ),
                        ),
                    },
                  },
                },
                facts.subject.context,
              );
              return {
                ok: true as const,
                value: {
                  kind: "ok" as const,
                  value: S.decodeUnknownSync(S.Json)(value),
                },
              };
            },
          }),
        },
      };
      const approvals = new OysterApprovalHome({
        owner: f.storage,
        // The SQLite fixture has no native alarm owner.
        commit: (write) => write(),
        scope: tenantScope(defaultTenant, "https://workflow.fixture.invalid"),
        current: () => Promise.resolve(host),
      });
      const source = await oysterAppMethods(
        { ...host, approvals: { submit: (call) => approvals.submit(call) } },
        { actor: { kind: "agent", agentId } },
        { kind: "agent", policy },
        appSurfaceCache(host),
      );
      // The acquired App source retains its original approval. Real grant
      // changes either remove that policy or replace it with a new revision.
      if (approval === "revoked") currentPolicy = null;
      else if (approval !== "write" && approval !== "read")
        currentPolicy = {
          ...policy,
          revision: "replacement-agent-policy",
          grantedBy:
            approval === "regranted" ? "another-member" : policy.grantedBy,
          level: approval === "downgraded" ? "read" : policy.level,
        };
      const runtime = await Mycelium.make({
        sources: [source],
        sandbox: directSandbox(async (bindings) => {
          const arm = bindings.LIBRARY?.arm;
          if (arm === undefined) throw new Error("Missing library arm tool");
          const target = {
            workflowId: "example",
            commit: publication.commit,
            triggerId: "nightly",
            bindings: { probe: "probe" },
          };
          if (!canArm)
            await expect(arm(target)).resolves.toMatchObject({
              kind: "refused",
              reason:
                approval === "revoked"
                  ? "not-granted"
                  : approval === "read" || approval === "downgraded"
                    ? "read-only"
                    : "fenced",
            });
          else results.push(await arm(target));
          return null;
        }),
      });
      const lease = await runtime.acquire();
      try {
        const call = await Effect.runPromise(
          lease.executeTool.prepare({
            type: "toolCall",
            id: "agent-arm",
            name: "execute",
            arguments: { code: "return await env.LIBRARY.arm(target)" },
          }),
        );
        await Effect.runPromise(Stream.runCollect(call.execute()));
        expect(results).toHaveLength(canArm ? 1 : 0);
        if (canArm) expect(results[0]).toMatchObject({ kind: "armed" });
      } finally {
        await lease.release();
        await runtime.close();
      }
      const rows = f.storage.sql
        .exec("SELECT record FROM hub_workflow_schedules")
        .toArray();
      expect(armDispatches).toBe(canArm ? 1 : 0);
      expect(rows).toHaveLength(canArm ? 1 : 0);
      if (!canArm) {
        expect(schedules.nextWake()).toBeNull();
        return;
      }
      // This assertion is at the durable row boundary, using its owning decoder,
      // not an injected armer or a spy on the scheduler.
      const stored = S.decodeUnknownSync(S.Struct({ record: S.String }))(
        rows[0],
      );
      const binding = armedWorkflowTriggerSchema
        .strip()
        .parse(JSON.parse(stored.record));
      expect(binding.armedBy).toBe("arming-owner");
      expect(binding.armedVia).toEqual({
        kind: "policy",
        agentId: "agent-author",
        policyRevision: "approved-agent-policy",
        grantorMemberId: "arming-owner",
      });
      expect(binding.computerId).toBe("storyboard-computer");
      expect(binding.commit).toBe(publication.commit);
    } finally {
      f.close();
    }
  },
);

it("preserves Release display names and icons through the catalog wire", async () => {
  const f = await fixture();
  try {
    const reply = await f.owner.catalog(f.facts);
    if (!("apps" in reply)) throw new Error("Index refused");
    expect(
      reply.apps.find((entry) => entry.installationId === "probe"),
    ).toMatchObject({ displayName: "Runtime probe", icon: "prints" });
    expect(catalogReplySchema.parse(reply)).toEqual(reply);
  } finally {
    f.close();
  }
});

it("reuses verified catalog data after owner recreation while rechecking the library", async () => {
  const f = await fixture();
  try {
    const expected = await f.owner.catalog(f.facts);
    f.artifactReads.length = 0;
    const recreated = f.recreateOwner();
    expect(await recreated.catalog(f.facts)).toEqual(expected);
    expect(f.artifactReads).toHaveLength(2);
    expect(f.artifactReads[0]).toBe(
      f.installation.release.artifact.artifactRef,
    );
    f.disableInstallation("probe");
    const afterDisable = await recreated.catalog(f.facts);
    if (!("apps" in afterDisable)) throw new Error("Index refused");
    expect(afterDisable.apps.map((app) => app.appId)).toEqual(["app_library"]);
    f.disableInstallation("library");
    await expect(recreated.catalog(f.facts)).rejects.toThrow("unavailable");
  } finally {
    f.close();
  }
});

it("refreshes catalog metadata when the selected Release root changes", async () => {
  const f = await fixture();
  try {
    await f.replaceProbe();
    f.artifactReads.length = 0;
    const reply = await f.recreateOwner().catalog(f.facts);
    if (!("apps" in reply)) throw new Error("Index refused");
    expect(
      reply.apps.find((entry) => entry.installationId === "probe"),
    ).toMatchObject({ displayName: "Updated probe", icon: "shed" });
    expect(f.artifactReads).toHaveLength(4);
  } finally {
    f.close();
  }
});

it("bounds parallel cold catalog reads and settles them inside the method", async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 9; n++) await f.addPeer(`peer${String(n)}`);
    let active = 0;
    let maximum = 0;
    const host: StandaloneWorkflowHost = {
      ...f.host,
      artifacts: {
        ...f.host.artifacts,
        get: async (ref) => {
          active++;
          maximum = Math.max(maximum, active);
          try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return await f.host.artifacts.get(ref);
          } finally {
            active--;
          }
        },
      },
    };
    const afterReads = await f.recreateOwner(host).catalog(f.facts);
    if (!("apps" in afterReads)) throw new Error("Index refused");
    expect(afterReads.apps).toHaveLength(11);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
  } finally {
    f.close();
  }
});

/**
 * Three methods, each with a declared output just under the engine's 20 KiB
 * single-projection ceiling, totalling roughly 50 KiB for this one App --
 * well under the whole-declaration ceiling, but enough that a handful of
 * these Apps fully ported exceeds the 240 KiB App reply ceiling.
 */
function largeAppDeclaration() {
  const bigEnum = (seed: string) =>
    Array.from(
      { length: 1000 },
      (_, index) => `${seed}-option-${String(index)}`,
    );
  const bigMethod = (seed: string) =>
    defineAppMethod({
      description: "A method whose declared ports are deliberately large",
      effect: "read" as const,
      requires: [],
      input: z.object({}),
      output: z.object({ choice: z.enum(bigEnum(seed)) }),
      handler: () => ({ choice: `${seed}-option-0` }),
    });
  return buildAppDeclaration(
    defineAppBackend({
      methods: {
        big1: bigMethod("big1"),
        big2: bigMethod("big2"),
        big3: bigMethod("big3"),
        big4: bigMethod("big4"),
      },
    }),
    {
      capabilities: [],
      handlers: [],
      roles: [],
      backend: { bindings: [] },
    },
  );
}

it("keeps the palette index small and one installation's detail complete over a large installed set", async () => {
  const f = await fixture();
  try {
    const large = largeAppDeclaration();
    for (let n = 0; n < 5; n++) await f.addPeer(`large${String(n)}`, large);
    const index = await f.owner.catalog(f.facts);
    if (!("apps" in index)) throw new Error("Index refused");
    // Five ~50 KiB Apps would total well over the 240 KiB App reply ceiling
    // fully ported; the index carries no port schemas, so it stays tiny.
    const indexBytes = new TextEncoder().encode(
      JSON.stringify(index),
    ).byteLength;
    expect(indexBytes).toBeLessThan(20_000);
    const indexJson = JSON.stringify(index);
    expect(indexJson).not.toContain("big1-option-0");
    const summary = index.apps.find(
      (entry) => entry.installationId === "large0",
    );
    expect(summary?.methods.big1).toMatchObject({
      description: "A method whose declared ports are deliberately large",
      effect: "read",
      approval: "none",
      requires: [],
    });
    expect(summary?.methods.big1).not.toHaveProperty("input");
    expect(summary?.methods.big1).not.toHaveProperty("output");
    // The per-installation detail fetch still returns the complete ports.
    const detail = await f.owner.catalog(f.facts, {
      installationId: "large0",
    });
    if (!("app" in detail)) throw new Error("Detail refused");
    const detailJson = JSON.stringify(detail);
    expect(detailJson).toContain("big1-option-0");
    expect(detailJson).toContain("big4-option-999");
    const detailBytes = new TextEncoder().encode(detailJson).byteLength;
    expect(detailBytes).toBeGreaterThan(40_000);
    expect(detailBytes).toBeLessThan(240 * 1024);
  } finally {
    f.close();
  }
});

it("never refuses the live authority's full sweep, even past the App reply ceiling, while the bounded index still succeeds", async () => {
  const f = await fixture();
  try {
    const large = largeAppDeclaration();
    for (let n = 0; n < 5; n++) await f.addPeer(`large${String(n)}`, large);
    const selected = await f.owner.admitLibrary("library", "catalog");
    // Five ~50 KiB Apps fully ported total well over 240 KiB. The internal
    // full-sweep scope (the live authority/trigger readers' own compile,
    // and prepare()'s bound-installation compile) never crosses the
    // App-reply wire as its own reply, so it must never refuse. Regression
    // (batch 1345, Sonnet-P2's workflows.native.mjs): an App-free
    // schedule's `arm` 502'd once the installed set grew past 240 KiB,
    // because this scope wrongly refused before compileForMember ever ran.
    const full = await f.owner.catalogForLibrary(selected, { full: true });
    expect(full.apps).toHaveLength(2 + 5); // library + probe + 5 large peers
    const fullBytes = new TextEncoder().encode(JSON.stringify(full)).byteLength;
    expect(fullBytes).toBeGreaterThan(240 * 1024);
    // The bounded index over the same installed set stays small and succeeds.
    const index = await f.owner.catalog(f.facts);
    if (!("apps" in index)) throw new Error("Index refused");
    const indexBytes = new TextEncoder().encode(
      JSON.stringify(index),
    ).byteLength;
    expect(indexBytes).toBeLessThan(20_000);
  } finally {
    f.close();
  }
});

it("starts the bundled Storyboard template as an ordinary graph run on standalone Oyster", async () => {
  const f = await fixture();
  try {
    await f.addPrints();
    const input = { beats: ["A lantern in the forest", "A fox arrives"] };
    const request = {
      requestId: "storyboard",
      definition: storyboardTemplate.definition,
      bindings: { prints: "prints" },
      input,
    };
    const facts = f.factsOn("storyboard-computer");
    const started = await f.owner.prepare(facts, request);
    if (!("runId" in started) || started.runId === undefined)
      throw new Error("Storyboard did not start");
    expect(started.kind).toBe("started");
    const run = f.owner.store.read(started.runId);
    expect(run?.plan.definition.title).toBe("Storyboard");
    expect(run?.computerId).toBe("storyboard-computer");
    expect(run?.input).toMatchObject(input);
    expect(f.owner.store.outcome(started.runId)).toBe("active");
    expect(await f.owner.prepare(facts, request)).toMatchObject({
      kind: "replay",
    });
  } finally {
    f.close();
  }
});

it("normalizes standalone defaults before recording run identity and refuses explicit invalid input", async () => {
  const f = await fixture();
  try {
    const request = {
      requestId: "default-input",
      definition: {
        ...f.definition,
        input: {
          type: "object",
          properties: { aspect: { type: "string", default: "16:9" } },
          required: ["aspect"],
          additionalProperties: false,
        },
      },
      bindings: { probe: "probe" },
      input: {},
    };
    const first = await f.owner.prepare(f.facts, request);
    if (!("runId" in first) || first.runId === undefined)
      throw new Error("Defaulted run not created");
    expect(first.kind).toBe("started");
    expect(f.owner.store.read(first.runId)?.input).toEqual({ aspect: "16:9" });
    expect(
      await f.owner.prepare(f.facts, { ...request, input: { aspect: "16:9" } }),
    ).toMatchObject({ kind: "replay" });
    expect(
      await f.owner.prepare(f.facts, {
        ...request,
        requestId: "invalid-input",
        input: { aspect: 42 },
      }),
    ).toEqual({ error: "invalid_input" });
  } finally {
    f.close();
  }
});

it("runs the stored version through the real App method and host without Git", async () => {
  const f = await fixture();
  try {
    const edited = await f.library.saveDraft(
      "example",
      {
        definition: { ...f.definition, title: "Unpublished edit" },
        layout: {},
      },
      1,
    );
    expect(edited.kind).toBe("saved");
    const reads = [
      vi.spyOn(f.git.git, "info"),
      vi.spyOn(f.git.git, "refs"),
      vi.spyOn(f.git.git, "log"),
      vi.spyOn(f.git.git, "readCommit"),
      vi.spyOn(f.git.git, "readTree"),
      vi.spyOn(f.git.git, "readBlob"),
      vi.spyOn(f.git.git, "exchange"),
      vi.spyOn(f.git.git, "cloneUrl"),
    ];
    const context: WorkflowMethodContext = {
      indexes: f.indexes,
      env: {
        GIT: f.git.git,
        WORKFLOWS: {
          ...unusedGraphOperations,
          runGraph: async (input) =>
            S.decodeUnknownSync(S.Json)(
              await f.owner.prepare(
                f.facts,
                S.decodeUnknownSync(graphStartRequestSchema)(input),
              ),
            ),
        },
      },
    };
    const result = await appBackend.call(
      "runWorkflow",
      {
        requestId: "row-to-host",
        workflowId: "example",
        version: 1,
        bindings: { probe: "probe" },
        input: {},
      },
      context,
      {
        actor: { kind: "member", memberId: "arming-owner" },
        computerId: null,
        role: "owner",
      },
    );
    expect(result).toMatchObject({ kind: "started" });
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    const parsedResult = runReply.parse(result);
    if (!("runId" in parsedResult))
      throw new Error("Run not started by the host");
    // The run is recorded once, by the host's own store, with its source.
    const recorded = f.owner.store.read(parsedResult.runId);
    expect(recorded?.publication?.commit).toBe(f.commit);
    expect(recorded?.source).toBe("manual");
    expect(recorded?.plan.definition).toEqual(f.definition);
  } finally {
    f.close();
  }
});

it("runs the publisher-attested original definition and refuses a replacement digest", async () => {
  const f = await fixture();
  try {
    expect(() =>
      S.decodeUnknownSync(graphStartRequestSchema)(
        {
          requestId: "published",
          definition: { ...f.definition, title: "Forged replacement" },
          bindings: { probe: "probe" },
          input: {},
          published: { workflowId: "example", commit: f.commit },
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
    const result = await f.owner.prepare(f.facts, {
      requestId: "published",
      definition: f.definition,
      bindings: { probe: "probe" },
      input: {},
      published: { workflowId: "example", commit: f.commit, digest: f.digest },
    });
    expect(result).toMatchObject({ kind: "started" });
    if (!("runId" in result) || result.runId === undefined)
      throw new Error("Run not created");
    const stored = f.owner.store.read(result.runId);
    expect(stored?.plan.definition.title).toBe("Published definition");
    expect(stored?.publication).toEqual({
      installationId: "library",
      workflowId: "example",
      commit: f.commit,
      digest: f.digest,
      armedBy: { kind: "member", memberId: "arming-owner" },
    });
    expect(f.owner.caller(result.runId).actor).toEqual({
      kind: "member",
      memberId: "arming-owner",
    });
    const other: InvocationFacts = {
      ...f.facts,
      subject: {
        kind: "call",
        context: {
          actor: { kind: "member", memberId: "another-member" },
          computerId: null,
        },
      },
    };
    expect(
      await f.owner.prepare(other, {
        requestId: "published",
        definition: f.definition,
        bindings: { probe: "probe" },
        input: {},
        published: {
          workflowId: "example",
          commit: f.commit,
          digest: f.digest,
        },
      }),
    ).toMatchObject({ kind: "conflict" });
  } finally {
    f.close();
  }
});

it("refuses publication attribution from a run-only App", async () => {
  const f = await fixture(false);
  try {
    await expect(
      f.owner.prepare(f.facts, {
        requestId: "run-only-publication",
        definition: f.definition,
        bindings: { probe: "probe" },
        input: {},
        published: {
          workflowId: "example",
          commit: f.commit,
          digest: f.digest,
        },
      }),
    ).resolves.toEqual({ error: "not_granted" });
  } finally {
    f.close();
  }
});

it("refuses a declared publisher without an approved publish grant", async () => {
  const f = await fixture(true, false);
  try {
    await expect(
      f.owner.prepare(f.facts, {
        requestId: "publication-not-approved",
        definition: f.definition,
        bindings: { probe: "probe" },
        input: {},
        published: {
          workflowId: "example",
          commit: f.commit,
          digest: f.digest,
        },
      }),
    ).resolves.toEqual({ error: "not_granted" });
  } finally {
    f.close();
  }
});

it("refuses publisher consent revoked between preparation and acceptance", async () => {
  const f = await fixture();
  const get = f.host.installations.get;
  let libraryReads = 0;
  let revoked = false;
  const lookup = vi
    .spyOn(f.host.installations, "get")
    .mockImplementation(async (id) => {
      if (id === "library" && ++libraryReads === 2) {
        await f.revokePublication();
        revoked = true;
      }
      return get(id);
    });
  try {
    await expect(
      f.owner.prepare(f.facts, {
        requestId: "publication-revoked-before-accept",
        definition: f.definition,
        bindings: { probe: "probe" },
        input: {},
        published: {
          workflowId: "example",
          commit: f.commit,
          digest: f.digest,
        },
      }),
    ).rejects.toMatchObject({ code: "revoked" });
    expect(revoked).toBe(true);
  } finally {
    lookup.mockRestore();
    f.close();
  }
});

it("refuses a published Team-source Git step: standalone admits only installation repositories", async () => {
  const f = await fixture();
  try {
    const definition: WorkflowDefinition = {
      ...f.definition,
      nodes: f.definition.nodes.map((node) =>
        node.kind === "app"
          ? {
              ...node,
              gitAccess: {
                binding: "source",
                repository: "project",
                branches: ["refs/heads/main"],
              },
            }
          : node,
      ),
    };
    const saved = await f.library.saveDraft(
      "example",
      { definition, layout: {} },
      1,
    );
    if (saved.kind !== "saved") throw new Error("Draft not saved");
    const published = await f.library.publish("example", saved.revision);
    if (published.kind !== "published") throw new Error("Draft not published");
    const row = f.library.publishedRow("example", { commit: published.commit });
    if (row === null) throw new Error("Published row missing");
    await expect(
      f.owner.prepare(f.facts, {
        requestId: "published-git-step",
        definition: row.definition,
        bindings: { probe: "probe", source: { kind: "team-source" } },
        input: {},
        published: {
          workflowId: "example",
          commit: row.commit,
          digest: row.digest,
        },
      }),
    ).resolves.toEqual({ error: "not_granted" });
  } finally {
    f.close();
  }
});

it("refuses a definition that differs from its stored publication digest", async () => {
  const f = await fixture();
  try {
    await expect(
      f.owner.prepare(f.facts, {
        requestId: "publication-digest-mismatch",
        definition: { ...f.definition, title: "Forged definition" },
        bindings: { probe: "probe" },
        input: {},
        published: {
          workflowId: "example",
          commit: f.commit,
          digest: f.digest,
        },
      }),
    ).resolves.toEqual({ error: "invalid_publication" });
  } finally {
    f.close();
  }
});

it("a lifecycle-started published run dispatches with the host-owned Workflow node attestation", async () => {
  const f = await fixture(true, true, undefined, () =>
    Promise.resolve({
      memberId: "arming-owner",
      membershipVersion: 1,
    }),
  );
  try {
    const incoming: InvocationFacts = {
      ...f.facts,
      subject: {
        kind: "lifecycle",
        name: "onGitPush",
        eventId: "main-push-43",
      },
    };
    const started = await f.owner.prepare(incoming, {
      requestId: "not-the-authority",
      definition: f.definition,
      bindings: { probe: "probe" },
      input: {},
      published: { workflowId: "example", commit: f.commit, digest: f.digest },
    });
    if (!("runId" in started) || started.runId === undefined)
      throw new Error("Lifecycle run not admitted");
    expect(
      await f.owner.dispatch({
        teamId: "library",
        runId: started.runId,
        nodeId: "done",
        iteration: "0",
        installationId: "probe",
        method: "counts",
        methodSpec: f.method,
        input: {},
        idempotencyKey: "main-push-43:done",
      }),
    ).toMatchObject({ kind: "complete", output: [] });
    expect(incoming.subject.kind).toBe("lifecycle");
    const delivered = f.calls[0];
    if (delivered?.subject.kind !== "call")
      throw new Error("No dispatched node");
    expect(delivered.subject.context.workflow).toEqual({
      workflowId: "example",
      runId: started.runId,
      nodeId: "done",
      armedBy: { kind: "member", memberId: "arming-owner" },
    });
    expect(delivered.subject.context.idempotencyKey).toBe("main-push-43:done");
  } finally {
    f.close();
  }
});

for (const published of [false, true]) {
  it(`${published ? "published" : "raw"} dispatch retains the arming actor and only publisher attribution attests a Workflow`, async () => {
    const f = await fixture();
    try {
      const facts: InvocationFacts = {
        ...f.facts,
        subject: {
          kind: "call",
          context: {
            actor: { kind: "member", memberId: "arming-owner" },
            computerId: null,
            workflow: {
              workflowId: "outer",
              runId: "outer-run",
              nodeId: "outer-node",
              armedBy: { kind: "member", memberId: "arming-owner" },
            },
          },
        },
      };
      const request = {
        requestId: "dispatch",
        definition: f.definition,
        bindings: { probe: "probe" },
        input: {},
      };
      const result = await f.owner.prepare(
        facts,
        published
          ? {
              requestId: request.requestId,
              definition: request.definition,
              bindings: request.bindings,
              input: request.input,
              published: {
                workflowId: "example",
                commit: f.commit,
                digest: f.digest,
              },
            }
          : request,
      );
      if (!("runId" in result) || result.runId === undefined)
        throw new Error("Run not created");
      expect(
        await f.owner.dispatch({
          teamId: "library",
          runId: result.runId,
          nodeId: "done",
          iteration: "0",
          installationId: "probe",
          method: "counts",
          methodSpec: f.method,
          input: {},
          idempotencyKey: "opaque-key",
        }),
      ).toMatchObject({ kind: "complete", output: [] });
      const delivered = f.calls[0];
      expect(delivered?.subject.kind).toBe("call");
      if (delivered?.subject.kind !== "call") throw new Error("No App call");
      expect(delivered.subject.context.actor).toEqual({
        kind: "member",
        memberId: "arming-owner",
      });
      expect(delivered.subject.context.computerId).toBeNull();
      expect(delivered.subject.context.idempotencyKey).toBe("opaque-key");
      expect(delivered.subject.context.workflow).toEqual(
        published
          ? {
              workflowId: "example",
              runId: result.runId,
              nodeId: "done",
              armedBy: { kind: "member", memberId: "arming-owner" },
            }
          : undefined,
      );
      f.owner.store.markTerminal(result.runId, "cancelled");
      expect(
        await f.owner.dispatch({
          teamId: "library",
          runId: result.runId,
          nodeId: "done",
          iteration: "0",
          installationId: "probe",
          method: "counts",
          methodSpec: f.method,
          input: {},
          idempotencyKey: "opaque-key",
        }),
      ).toEqual({ kind: "refused", code: "revoked" });
      expect(f.calls).toHaveLength(1);
    } finally {
      f.close();
    }
  });
}

it("preserves the App's domain refusal reason in the failed Workflow node", async () => {
  const message = "No hosted build backend is attached to this Computer";
  const f = await fixture(true, true, () =>
    Promise.resolve({
      ok: true,
      value: { kind: "refused", code: "unavailable", message },
    }),
  );
  try {
    const result = await f.owner.prepare(f.facts, {
      requestId: "honest-refusal",
      definition: f.definition,
      bindings: { probe: "probe" },
      input: {},
    });
    if (!("runId" in result) || result.runId === undefined)
      throw new Error("Run not created");
    await expect(
      f.owner.dispatch({
        teamId: "library",
        runId: result.runId,
        nodeId: "done",
        iteration: "0",
        installationId: "probe",
        method: "counts",
        methodSpec: f.method,
        input: {},
        idempotencyKey: "opaque-key",
      }),
    ).rejects.toThrow("App method refused (unavailable): " + message);
  } finally {
    f.close();
  }
});

it("surfaces the App backend's real failure, not revoked, when the call itself fails for a non-authority reason", async () => {
  const f = await fixture(true, true, () =>
    Promise.resolve({ ok: false, code: "failed", causeClass: "Error" }),
  );
  try {
    const request = {
      requestId: "backend-failure",
      definition: f.definition,
      bindings: { probe: "probe" },
      input: {},
    };
    const result = await f.owner.prepare(f.facts, request);
    if (!("runId" in result) || result.runId === undefined)
      throw new Error("Run not created");
    await expect(
      f.owner.dispatch({
        teamId: "library",
        runId: result.runId,
        nodeId: "done",
        iteration: "0",
        installationId: "probe",
        method: "counts",
        methodSpec: f.method,
        input: {},
        idempotencyKey: "opaque-key",
      }),
    ).rejects.toThrow("App execution failed (Error)");
  } finally {
    f.close();
  }
});

// Every AppInstanceErrorCode the Instance call itself can return is a named,
// structural rejection (packages/oyster/src/index.ts's "bounded rejection
// grammar"); "failed" alone is its unclassified catch-all. Only a code that
// is itself a live decision about today's grant refuses the node, as
// "revoked" or (for a binding the Release never granted) "not_granted".
// Every execution or availability code -- a deadline "expired" included --
// throws instead, so the graph records a failed step and the engine's own
// retry applies; it must never surface as a silent, non-retryable "revoked"
// that misreports a timeout or a transient unavailability as an authority
// decision. These representative codes span both the admission gate
// (packages/oyster/src/index.ts:355-406 connect()) and the nested binding
// grant check (packages/oyster/src/workers.ts's executeBindingCall).
async function dispatchResultFor(code: AppInstanceErrorCode | "failed") {
  const f = await fixture(true, true, () =>
    Promise.resolve({ ok: false, code }),
  );
  try {
    const request = {
      requestId: `instance-refused-${code}`,
      definition: f.definition,
      bindings: { probe: "probe" },
      input: {},
    };
    const result = await f.owner.prepare(f.facts, request);
    if (!("runId" in result) || result.runId === undefined)
      throw new Error("Run not created");
    // Awaited here, before `finally` closes the fixture's database: a
    // returned-but-unawaited promise would otherwise still be running its
    // dispatch when `f.close()` tears it down.
    return await f.owner.dispatch({
      teamId: "library",
      runId: result.runId,
      nodeId: "done",
      iteration: "0",
      installationId: "probe",
      method: "counts",
      methodSpec: f.method,
      input: {},
      idempotencyKey: "opaque-key",
    });
  } finally {
    f.close();
  }
}

for (const code of [
  "revoked",
  "disabled",
  "instance_owner_mismatch",
  "instance_authority_version_mismatch",
  "instance_release_mismatch",
  "release_no_longer_matches_instance",
  "installation_tenant_mismatch",
  // A moved authority version is itself the live decision, not a retryable
  // fault; same for an instance the owner state marks inactive.
  "stale_authority",
  "instance_inactive",
] as const) {
  it(`still returns revoked, non-retryably, when the App Instance call itself refuses with the real authority code "${code}"`, async () => {
    await expect(dispatchResultFor(code)).resolves.toEqual({
      kind: "refused",
      code: "revoked",
    });
  });
}

it('returns not_granted, not revoked, when the App Instance call refuses with "binding_not_granted"', async () => {
  await expect(dispatchResultFor("binding_not_granted")).resolves.toEqual({
    kind: "refused",
    code: "not_granted",
  });
});

for (const code of [
  "expired",
  "binding_unavailable",
  "reentrant",
  "conflicting_owner_state",
  "invalid_owner_state",
  "invalid_invocation_facts",
  "instance_identity_mismatch",
  "instance_deleted",
  "release_app_mismatch",
  "state_schema_migration_unsupported",
] as const) {
  it(`throws, and never returns revoked, when the App Instance call itself refuses with the execution/availability code "${code}"`, async () => {
    await expect(dispatchResultFor(code)).rejects.toThrow(
      `App execution failed (${code})`,
    );
  });
}

it("starts an attested publication without Git and refuses a foreign or revoked library", async () => {
  const f = await fixture();
  try {
    f.revokeGit();
    const request = {
      requestId: "no-git",
      definition: f.definition,
      bindings: { probe: "probe" },
      input: {},
      published: { workflowId: "example", commit: f.commit, digest: f.digest },
    };
    expect(await f.owner.prepare(f.facts, request)).toMatchObject({
      kind: "started",
    });
    await expect(
      f.owner.prepare(
        {
          ...f.facts,
          selection: {
            ...f.facts.selection,
            owner: { kind: "installation", id: "foreign-library" },
          },
        },
        { ...request, requestId: "foreign" },
      ),
    ).rejects.toThrow("unavailable");
    f.disableInstallation("library");
    await expect(
      f.owner.prepare(f.facts, { ...request, requestId: "revoked" }),
    ).rejects.toThrow("unavailable");
    expect(f.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

it("refuses lifecycle, expired, stale-selection and ungranted start facts", async () => {
  const f = await fixture();
  try {
    const request = {
      requestId: "refused",
      definition: f.definition,
      bindings: { probe: "probe" },
      input: {},
    };
    const refused: InvocationFacts[] = [
      {
        ...f.facts,
        subject: { kind: "lifecycle", name: "onGitPush", eventId: "event" },
      },
      { ...f.facts, deadlineAt: 1 },
      {
        ...f.facts,
        selection: {
          ...f.facts.selection,
          authorityVersion: f.facts.selection.authorityVersion + 1,
        },
      },
      {
        ...f.facts,
        artifactDigest: parseSha256Digest(`sha256:${"0".repeat(64)}`),
      },
      { ...f.facts, grants: [] },
    ];
    for (const facts of refused)
      await expect(f.owner.prepare(facts, request)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

it("never replays a raw request across member and key actor identities with the same name", async () => {
  const f = await fixture();
  try {
    const request = {
      requestId: "actor-kind",
      definition: f.definition,
      bindings: { probe: "probe" },
      input: {},
    };
    const started = await f.owner.prepare(f.facts, request);
    expect(started).toMatchObject({ kind: "started" });
    const key: InvocationFacts = {
      ...f.facts,
      subject: {
        kind: "call",
        context: {
          actor: { kind: "team-key", keyId: "arming-owner" },
          computerId: null,
        },
      },
    };
    expect(await f.owner.prepare(key, request)).toEqual({
      error: "not_granted",
    });
    if (!("runId" in started) || started.runId === undefined)
      throw new Error("Missing accepted run");
    expect(f.owner.caller(started.runId).actor).toEqual({
      kind: "member",
      memberId: "arming-owner",
    });
  } finally {
    f.close();
  }
});

it("projects publisher consent live across catalog recreation and revocation", async () => {
  const f = await fixture();
  try {
    const initial = await f.owner.catalog(f.facts);
    if (!("apps" in initial)) throw new Error("Index refused");
    const entry = initial.apps.find((row) => row.installationId === "library");
    expect(entry).toMatchObject({
      workflowPublishGranted: true,
      workflowRunGranted: true,
    });
    expect(entry?.capabilities).toContain("workflow.publish");
    await f.revokePublication();
    const reopened = f.recreateOwner();
    const current = await reopened.admitLibrary("library", "catalog");
    const afterRevokePublication = await reopened.catalogForLibrary(current);
    if (!("apps" in afterRevokePublication)) throw new Error("Index refused");
    const updated = afterRevokePublication.apps.find(
      (row) => row.installationId === "library",
    );
    expect(updated).toMatchObject({
      workflowPublishGranted: false,
      workflowRunGranted: true,
    });
    await f.revokeRun();
    const runRevoked = f.recreateOwner();
    const selected = await runRevoked.admitLibrary("library", "catalog");
    const afterRevokeRun = await runRevoked.catalogForLibrary(selected);
    if (!("apps" in afterRevokeRun)) throw new Error("Index refused");
    expect(
      afterRevokeRun.apps.find((row) => row.installationId === "library"),
    ).toMatchObject({
      workflowPublishGranted: false,
      workflowRunGranted: false,
    });
  } finally {
    f.close();
  }
});
