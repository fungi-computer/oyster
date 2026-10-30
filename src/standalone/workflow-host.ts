import * as S from "effect/Schema";
import {
  admitRunInput,
  accepts,
  catalogEvents,
  catalogMethods,
  catalogSchema,
  contentDigest,
  canonicalJson,
  parseProjection,
  nodeEventSchema,
  type Catalog,
  type DispatchResult,
  type NodeAdmissionResult,
  type NodeCall,
  type NodeEvent,
} from "@fungi.computer/braid";
import {
  deriveDeclaredOperations,
  approvedBindingGrants,
  grantsFor,
  type Installation,
} from "../apps/index.js";
import {
  pendingSchema,
  presentMethodName,
} from "@fungi.computer/agar/backend-definition";
import { resultRowSchemaV1, type ResultRow } from "@fungi.computer/gills";
import type { AppMethodReply } from "@fungi.computer/agar/backend";
import {
  verifyRelease,
  type InstanceResult,
  type OysterHost,
  type VerifiedRelease,
} from "../host.js";
import {
  APP_INVOCATION_CEILING_MS,
  invocationAuthorityOf,
  invocationFacts,
  invocationFactsSchema,
  type InvocationFacts,
} from "../invocation.js";
import { AppInstanceError } from "../index.js";
import { appCapabilityIds } from "@fungi.computer/puffball";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  createGraphWorkflowRuns,
  createTriggerRunReservations,
  compileForMember,
  graphStartRequestSchema,
  preparationFromRun,
  type GraphStartRequest,
  type WorkflowAgentInitiator,
  type WorkflowKeyInitiator,
  type WorkflowCatalogEntry,
  type WorkflowRunAuthority,
  planNodeCall,
  workflowRunContextSchema,
  type WorkflowGitPassNode,
  type WorkflowRunPreparation,
  type WorkflowRunDelivery,
} from "@fungi.computer/braid/runtime";
import { appMethodCallContextSchema } from "@fungi.computer/puffball/app";
import {
  appEventFactSchema,
  type AppEventFact,
} from "@fungi.computer/puffball/app-event-facts";
import { keyAppAccess } from "../authorization.js";
import type { LiveOysterKey } from "../keys.js";
import { Validator } from "@cfworker/json-schema";

// Mirrors packages/oyster/src/cloudflare.ts's MAX_APP_REPLY_BYTES. That
// module imports "cloudflare:workers" at the top level, so it cannot be
// imported for its value outside a Workers runtime (e.g. this file's own
// node/vitest tests); apps/hub/src/app-workflow-broker.ts duplicates the
// same literal for the same reason.
const MAX_APP_REPLY_BYTES = 240 * 1024;

export type StandaloneWorkflowHost = Pick<
  OysterHost,
  | "installations"
  | "artifacts"
  | "instances"
  | "computerId"
  | "git"
  | "capabilities"
  | "keys"
>;

/**
 * The key's own catalog view: an installation it cannot reach at all drops
 * out, and a read-only installation keeps only its read methods. A node
 * that reaches past the key then fails to compile with the engine's own
 * "Installation is not available to you" or unknown-method issue -- never a
 * live grant computed here.
 */
function keyCatalogEntries(
  entries: readonly WorkflowCatalogEntry[],
  key: LiveOysterKey,
): readonly WorkflowCatalogEntry[] {
  const kept: WorkflowCatalogEntry[] = [];
  for (const entry of entries) {
    const access = keyAppAccess(key, entry.installationId);
    if (access === null) continue;
    if (access.level === "write") {
      kept.push(entry);
      continue;
    }
    const methods = Object.fromEntries(
      Object.entries(entry.methods).filter(
        ([, method]) => method.effect === "read",
      ),
    );
    kept.push({ ...entry, methods });
  }
  return kept;
}
const catalogProjectionSchema = S.Struct({
  ...catalogSchema.value.fields,
  displayName: S.String,
  icon: S.optionalKey(S.String),
  capabilities: S.optionalKey(S.Array(S.Literals(appCapabilityIds))),
});
const catalogRecordSchema = S.Struct({
  release_key: S.String,
  record: S.String,
});
const catalogProjectionCodec = S.fromJsonString(
  S.NullOr(catalogProjectionSchema),
);
/** Cached rows from another projection shape are recomputed, never read. */
const catalogProjectionVersion = "methods+events";
const releaseKey = (installation: Installation) =>
  JSON.stringify([
    catalogProjectionVersion,
    installation.release.appId,
    installation.release.releaseId,
    installation.release.artifact.artifactRef,
    installation.release.artifact.artifactDigest,
  ]);
type CatalogMethodSummary = Readonly<{
  pending?: true;
  description: string;
  effect: Catalog[string]["methods"][string]["effect"];
  approval: Catalog[string]["methods"][string]["approval"];
  requires: Catalog[string]["methods"][string]["requires"];
  digest: string;
}>;
type CatalogEventSummary = Readonly<{ description: string; digest: string }>;
/** The palette index entry: every method/event name, with no port schemas. */
type CatalogIndexEntry = Readonly<{
  installationId: string;
  appId: string;
  displayName: string;
  icon?: string;
  capabilities?: WorkflowCatalogEntry["capabilities"];
  workflowPublishGranted: boolean;
  workflowRunGranted: boolean;
  methods: Readonly<Record<string, CatalogMethodSummary>>;
  events?: Readonly<Record<string, CatalogEventSummary>>;
}>;
/** A build-time view of the same contract: assignable field by field, then frozen by its return type. */
type MutableCatalogIndexEntry = {
  -readonly [Key in keyof CatalogIndexEntry]: CatalogIndexEntry[Key];
};
function summarizedMethod(
  method: WorkflowCatalogEntry["methods"][string],
): CatalogMethodSummary {
  const summary: CatalogMethodSummary = {
    description: method.description,
    effect: method.effect,
    approval: method.approval,
    requires: method.requires,
    digest: method.digest,
  };
  if (method.pending === true) return { ...summary, pending: true as const };
  return summary;
}
const summarizedEntry = (entry: WorkflowCatalogEntry): CatalogIndexEntry => {
  const summary: MutableCatalogIndexEntry = {
    installationId: entry.installationId,
    appId: entry.appId,
    displayName: entry.displayName,
    workflowPublishGranted: entry.workflowPublishGranted ?? false,
    workflowRunGranted: entry.workflowRunGranted ?? false,
    methods: Object.fromEntries(
      Object.entries(entry.methods).map(([name, method]) => [
        name,
        summarizedMethod(method),
      ]),
    ),
  };
  if (entry.icon !== undefined) summary.icon = entry.icon;
  if (entry.capabilities !== undefined)
    summary.capabilities = entry.capabilities;
  if (entry.events !== undefined)
    summary.events = Object.fromEntries(
      Object.entries(entry.events).map(([name, event]) => [
        name,
        { description: event.description, digest: event.digest },
      ]),
    );
  return summary;
};

/** The standalone host's installation admission, above the portable engine. */
export function createStandaloneWorkflowHost(
  owner: WatchdogSqliteOwner,
  host: StandaloneWorkflowHost,
  options: Readonly<{
    authority(libraryInstallationId: string): WorkflowRunAuthority;
    /** The standalone root's live canonical owner, never an App-supplied actor. */
    lifecycleMember(): Promise<Readonly<{
      memberId: string;
      membershipVersion: number;
    }> | null>;
    /** Whether this member may have run endings reported to the Agent Session. */
    admitDelivery(
      memberId: string,
      delivery: WorkflowRunDelivery,
    ): Promise<boolean>;
  }>,
) {
  const graph = createGraphWorkflowRuns(owner);
  const reservations = createTriggerRunReservations(owner);
  const store = {
    ...graph,
    markTerminal(...args: Parameters<typeof graph.markTerminal>): void {
      // The standalone run owner ends graph/review state and the SAME Braid
      // reservation atomically, without creating a Hub Computer-cleanup queue.
      owner.transactionSync(() => {
        graph.markTerminal(...args);
        reservations.terminalTriggerRun(args[0]);
      });
    },
  };
  // Only the host's attested invocation context is associated here. Lifecycle,
  // events, reviews and replay are owned by the shared runtime store.
  owner.sql.exec(`CREATE TABLE IF NOT EXISTS standalone_workflow_callers (
    run_id TEXT PRIMARY KEY, caller TEXT NOT NULL
  ) STRICT`);
  const readCaller = (runId: string): AppMethodCallContext | null => {
    const row = owner.sql
      .exec(
        "SELECT caller FROM standalone_workflow_callers WHERE run_id=?",
        runId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const saved = S.decodeUnknownSync(S.Struct({ caller: S.String }))(row);
    return S.decodeUnknownSync(appMethodCallContextSchema)(
      JSON.parse(saved.caller),
    );
  };
  const caller = (runId: string): AppMethodCallContext => {
    const saved = readCaller(runId);
    if (saved === null) throw new Error("Workflow caller is unavailable");
    return saved;
  };
  // A dispatched Git step, keyed by its engine call identity: the only
  // admission a Workflow Git pass mint accepts. Removed when the run ends.
  owner.sql.exec(`CREATE TABLE IF NOT EXISTS standalone_workflow_git_nodes (
    idempotency_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, record TEXT NOT NULL
  ) STRICT`);
  const gitNodeCodec = S.fromJsonString(
    S.Struct({
      teamId: S.String,
      memberId: S.String,
      installationId: S.String,
      appId: S.String,
      method: S.String,
      methodDigest: S.String,
      computerId: S.NullOr(S.String),
      context: workflowRunContextSchema,
    }),
  );
  const recordGitNode = (
    idempotencyKey: string,
    node: Omit<WorkflowGitPassNode, "context"> & Readonly<{ context: unknown }>,
  ) => {
    const record = S.encodeSync(gitNodeCodec)({
      ...node,
      context: S.decodeUnknownSync(workflowRunContextSchema)(node.context),
    });
    owner.sql.exec(
      "INSERT INTO standalone_workflow_git_nodes(idempotency_key,run_id,record) VALUES(?,?,?) ON CONFLICT(idempotency_key) DO UPDATE SET record=excluded.record",
      idempotencyKey,
      S.decodeUnknownSync(workflowRunContextSchema)(node.context).runId,
      record,
    );
  };
  /** The dispatched Git step this call key names, while its run is active. */
  const gitNode = (idempotencyKey: string): WorkflowGitPassNode | null => {
    const row = owner.sql
      .exec(
        "SELECT record FROM standalone_workflow_git_nodes WHERE idempotency_key=?",
        idempotencyKey,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const node = S.decodeUnknownSync(gitNodeCodec)(
      S.decodeUnknownSync(S.Struct({ record: S.String }))(row).record,
    );
    const run = store.read(node.context.runId);
    return run?.teamId === node.teamId &&
      store.outcome(node.context.runId) === "active"
      ? node
      : null;
  };
  owner.sql.exec(`CREATE TABLE IF NOT EXISTS standalone_workflow_catalog (
    installation_id TEXT PRIMARY KEY, release_key TEXT NOT NULL, record TEXT NOT NULL
  ) STRICT`);
  const admitted = async (installationId: string) => {
    const installation = await host.installations.get(installationId);
    if (installation?.status !== "enabled")
      throw new Error("Workflow installation is unavailable");
    const verified = await verifyRelease(
      host.artifacts,
      installation.release,
      undefined,
      false,
    );
    return { installation, verified };
  };
  const publisherGranted = async (
    selected: Awaited<ReturnType<typeof admitted>>,
  ) => {
    const declaration = selected.verified.declaration;
    if (declaration === null) return false;
    const snapshot = await deriveDeclaredOperations(
      selected.installation.release,
      declaration,
      host.capabilities ?? [],
    );
    return (
      grantsFor(
        {
          status: selected.installation.status,
          authority: selected.installation.authority,
          artifactDigest: selected.installation.release.artifact.artifactDigest,
        },
        declaration,
        snapshot,
        "workflow.publish",
      ) !== null
    );
  };
  const runGranted = async (selected: Awaited<ReturnType<typeof admitted>>) => {
    const declaration = selected.verified.declaration;
    if (declaration === null) return false;
    const snapshot = await deriveDeclaredOperations(
      selected.installation.release,
      declaration,
      host.capabilities ?? [],
    );
    if (
      grantsFor(
        {
          status: selected.installation.status,
          authority: selected.installation.authority,
          artifactDigest: selected.installation.release.artifact.artifactDigest,
        },
        declaration,
        snapshot,
        "workflow.run",
      ) === null
    )
      return false;
    return approvedBindingGrants(selected.installation, declaration).some(
      (binding) =>
        binding.binding === "WORKFLOWS" &&
        binding.operations.includes("runGraph"),
    );
  };
  const checkLibraryOperation = (
    selected: Awaited<ReturnType<typeof admitted>>,
    operation: string,
  ) => {
    if (
      !selected.verified.declaration?.capabilities.includes("workflow.run") ||
      !selected.verified.declaration.backend?.bindings.some(
        (binding) =>
          binding.name === "WORKFLOWS" &&
          binding.operations.includes(operation),
      )
    )
      throw new Error("Workflow operation is not granted");
  };
  const admitLibrary = async (installationId: string, operation: string) => {
    const selected = await admitted(installationId);
    checkLibraryOperation(selected, operation);
    return selected;
  };
  // All frame kinds re-open the same live installation pin and grants.
  // A lifecycle admission does not turn the frame into a member call.
  const admitFrame = async (facts: InvocationFacts, operation: string) => {
    if (facts.selection.owner.kind !== "installation")
      throw new AppInstanceError("revoked");
    if (facts.deadlineAt <= Date.now()) throw new AppInstanceError("expired");
    if (
      !facts.grants.some(
        (grant) =>
          grant.binding === "WORKFLOWS" && grant.operations.includes(operation),
      )
    )
      throw new AppInstanceError("revoked");
    const libraryId = facts.selection.owner.id;
    const selected = await admitLibrary(libraryId, operation);
    const current = invocationAuthorityOf(
      selected.installation,
      selected.verified,
    );
    if (
      current.instanceId !== facts.instanceId ||
      current.selection.appId !== facts.selection.appId ||
      current.selection.releaseId !== facts.selection.releaseId ||
      current.selection.authorityVersion !== facts.selection.authorityVersion ||
      current.artifactDigest !== facts.artifactDigest
    )
      throw new AppInstanceError("revoked");
    if (facts.deadlineAt <= Date.now()) throw new AppInstanceError("expired");
    return {
      ...selected,
      libraryId,
      installationAuthority: {
        selection: current.selection,
        artifactDigest: current.artifactDigest,
      },
    };
  };
  const admitInvocation = async (raw: InvocationFacts, operation: string) => {
    const facts = S.decodeUnknownSync(invocationFactsSchema)(raw, {
      onExcessProperty: "error",
    });
    if (facts.subject.kind !== "call") throw new AppInstanceError("revoked");
    return {
      ...(await admitFrame(facts, operation)),
      context: facts.subject.context,
    };
  };
  const admitLifecycle = async (
    raw: InvocationFacts,
    operation: "catalog" | "runGraph",
  ) => {
    const facts = S.decodeUnknownSync(invocationFactsSchema)(raw, {
      onExcessProperty: "error",
    });
    if (
      facts.subject.kind !== "lifecycle" ||
      facts.subject.name !== "onGitPush"
    )
      throw new AppInstanceError("revoked");
    return admitFrame(facts, operation);
  };
  const admitStart = async (raw: InvocationFacts) => {
    const facts = S.decodeUnknownSync(invocationFactsSchema)(raw, {
      onExcessProperty: "error",
    });
    if (facts.subject.kind === "call")
      return admitInvocation(facts, "runGraph");
    const selected = await admitLifecycle(facts, "runGraph");
    const member = await options.lifecycleMember();
    if (member === null) throw new AppInstanceError("revoked");
    const current = await options
      .authority(selected.libraryId)
      .member(member.memberId);
    if (current.membershipVersion !== member.membershipVersion)
      throw new AppInstanceError("revoked");
    const context: AppMethodCallContext = {
      actor: { kind: "member", memberId: member.memberId },
      role: "owner",
      computerId: host.computerId ?? null,
    };
    return { ...selected, context };
  };
  /** A trigger's live library pin; any missing grant is a typed revocation. */
  const triggerAuthority = async (installationId: string) => {
    const installation = await host.installations.get(installationId);
    if (installation?.status !== "enabled")
      throw new AppInstanceError("revoked");
    const selected = await admitted(installationId);
    if (
      !(await runGranted(selected)) ||
      !selected.verified.declaration?.capabilities.includes("git.repository")
    )
      throw new AppInstanceError("revoked");
    const current = invocationAuthorityOf(
      selected.installation,
      selected.verified,
    );
    return {
      installation: selected.installation,
      pin: {
        selection: current.selection,
        artifactDigest: current.artifactDigest,
      },
    };
  };
  /** An emitted event fires triggers only as its live Release declares it. */
  const admitEventFact = async (raw: AppEventFact): Promise<AppEventFact> => {
    const fact = appEventFactSchema.parse(raw);
    const { installation, verified } = await admitted(fact.installationId);
    const declared = verified.api?.events?.[fact.type];
    if (
      installation.release.appId !== fact.appId ||
      installation.release.releaseId !== fact.releaseId ||
      declared === undefined ||
      fact.payload.type !== fact.type ||
      !new Validator(declared.payload, "2020-12").validate(fact.payload).valid
    )
      throw new AppInstanceError("revoked");
    return fact;
  };
  // Immutable discovery data only. Admission and dispatch never read this copy.
  const projection = async (
    installation: Installation,
    verifiedLibrary?: VerifiedRelease,
  ) => {
    const key = releaseKey(installation);
    const row = owner.sql
      .exec(
        "SELECT release_key,record FROM standalone_workflow_catalog WHERE installation_id=?",
        installation.installationId,
      )
      .toArray()[0];
    if (row !== undefined) {
      const record = S.decodeUnknownSync(catalogRecordSchema)(row);
      if (record.release_key === key)
        return S.decodeUnknownSync(catalogProjectionCodec)(record.record);
    }
    const verified =
      verifiedLibrary ??
      (await verifyRelease(
        host.artifacts,
        installation.release,
        undefined,
        false,
      ));
    let value: S.Schema.Type<typeof catalogProjectionSchema> | null = null;
    if (verified.api !== null) {
      value = {
        ...(await catalogMethods(verified.api.methods)),
        displayName:
          verified.declaration?.displayName ?? installation.installationId,
        capabilities: verified.declaration?.capabilities ?? [],
      };
      if (verified.api.events !== undefined)
        value = { ...value, ...(await catalogEvents(verified.api.events)) };
      if (verified.declaration?.icon !== undefined)
        value = { ...value, icon: verified.declaration.icon };
    }
    const record = JSON.stringify(value);
    // A cache ceiling does not restrict the App API: larger projections still return.
    if (new TextEncoder().encode(record).byteLength <= 512 * 1024)
      owner.sql.exec(
        "INSERT INTO standalone_workflow_catalog(installation_id,release_key,record) VALUES(?,?,?) ON CONFLICT(installation_id) DO UPDATE SET release_key=excluded.release_key,record=excluded.record",
        installation.installationId,
        key,
        record,
      );
    return value;
  };
  /**
   * With no scope, every enabled installation's bounded palette summary (no
   * port schemas) -- the external `catalog({})` palette. This is the only
   * shape that ever crosses the App-reply wire boundary unbounded, so it is
   * the only one that can refuse `too_large`.
   *
   * With `installationIds`, the named installations' full entries -- the
   * server's own compile/validate, which reads only the Apps a request's own
   * bindings name. With `full: true`, every enabled installation's full
   * entry -- the live authority/trigger readers' own compile, which does not
   * yet know which Apps a definition will name when it asks. Neither of
   * these ever returns the full entries as *this* method's own wire reply
   * (prepare()/arm() compile a plan from them; the external single-App
   * detail fetch applies its own ceiling at the `catalog()` wrapper below),
   * so they are never bounded here -- doing so would make a large but
   * otherwise ordinary installed-App set refuse live authority reads and
   * trigger arming outright (regression: an App-free schedule's `arm` 502'd
   * once the installed set grew past 240 KiB, since `full: true` refused
   * before `compileForMember` ever ran).
   */
  type CatalogScope =
    Readonly<{ installationIds: readonly string[] }> | Readonly<{ full: true }>;
  type CatalogForLibraryReply<Entry> =
    Readonly<{ apps: readonly Entry[] }> | Readonly<{ error: "too_large" }>;
  // Overloaded: the index shape (no scope) and the full shape (with scope)
  // are different types, so a caller that forgets a scope cannot be handed
  // port-less entries where it needs real ones (e.g. to compile a plan).
  async function catalogForLibrary(
    library: Awaited<ReturnType<typeof admitted>>,
  ): Promise<CatalogForLibraryReply<CatalogIndexEntry>>;
  async function catalogForLibrary(
    library: Awaited<ReturnType<typeof admitted>>,
    scope: CatalogScope,
  ): Promise<Readonly<{ apps: readonly WorkflowCatalogEntry[] }>>;
  async function catalogForLibrary(
    library: Awaited<ReturnType<typeof admitted>>,
    scope?: CatalogScope,
  ): Promise<
    | CatalogForLibraryReply<CatalogIndexEntry>
    | Readonly<{ apps: readonly WorkflowCatalogEntry[] }>
  > {
    checkLibraryOperation(library, "catalog");
    const wanted =
      scope !== undefined && "installationIds" in scope
        ? new Set(scope.installationIds)
        : null;
    const installations = (await host.installations.list()).filter(
      (installation) =>
        installation.status === "enabled" &&
        (wanted === null || wanted.has(installation.installationId)),
    );
    // This is the wire catalog's existing bound, not an installation limit.
    if (installations.length > 200)
      throw new Error("Workflow catalog is too large");
    // Only a full sweep (no filter) ever enumerates every installation, so
    // only a full sweep may prune cache rows for installations no longer
    // present; a narrow filter must never touch other installations' rows.
    if (wanted === null)
      owner.sql.exec(
        "DELETE FROM standalone_workflow_catalog WHERE installation_id NOT IN (SELECT value FROM json_each(?))",
        JSON.stringify(
          installations.map((installation) => installation.installationId),
        ),
      );
    const apps = [];
    for (let offset = 0; offset < installations.length; offset += 8) {
      // Settle every sibling before returning, so no read outlives this method.
      const results = await Promise.allSettled(
        installations.slice(offset, offset + 8).map(async (installation) => {
          const value = await projection(
            installation,
            releaseKey(installation) === releaseKey(library.installation)
              ? library.verified
              : undefined,
          );
          if (value === null) return null;
          let workflowPublishGranted = false;
          let workflowRunGranted = false;
          if (
            value.capabilities?.includes("workflow.publish") ||
            value.capabilities?.includes("workflow.run")
          ) {
            const current = await host.installations.get(
              installation.installationId,
            );
            if (
              current?.status !== "enabled" ||
              releaseKey(current) !== releaseKey(installation)
            )
              throw new AppInstanceError("revoked");
            const selected =
              releaseKey(current) === releaseKey(library.installation)
                ? { installation: current, verified: library.verified }
                : await admitted(current.installationId);
            workflowPublishGranted = await publisherGranted(selected);
            workflowRunGranted = await runGranted(selected);
            const after = await host.installations.get(current.installationId);
            if (
              after?.status !== "enabled" ||
              after.authority.authorityVersion !==
                current.authority.authorityVersion ||
              releaseKey(after) !== releaseKey(current)
            )
              throw new AppInstanceError("revoked");
          }
          return {
            ...value,
            workflowPublishGranted,
            workflowRunGranted,
            installationId: installation.installationId,
            appId: installation.release.appId,
          };
        }),
      );
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        if (result.value !== null) apps.push(result.value);
      }
    }
    // Only the index ever crosses the App-reply wire boundary unbounded, so
    // only it can refuse too_large; a typed refusal beats the generic
    // App-reply ceiling's untyped throw when it still grows too large.
    if (scope === undefined) {
      const reply = { apps: apps.map(summarizedEntry) };
      const bytes = new TextEncoder().encode(JSON.stringify(reply)).byteLength;
      return bytes > MAX_APP_REPLY_BYTES
        ? { error: "too_large" as const }
        : reply;
    }
    return { apps };
  }
  const catalog = async (
    facts: InvocationFacts,
    input?: Readonly<{ installationId?: string | undefined }>,
  ) => {
    const library =
      facts.subject.kind === "call"
        ? await admitInvocation(facts, "catalog")
        : await admitLifecycle(facts, "catalog");
    if (input?.installationId === undefined) return catalogForLibrary(library);
    const { apps } = await catalogForLibrary(library, {
      installationIds: [input.installationId],
    });
    const [app] = apps;
    if (app === undefined) return { error: "not_found" as const };
    // The single-installation detail is this method's own wire reply, so it
    // alone (of the scoped fetches) still applies the ceiling.
    const reply = { app };
    const bytes = new TextEncoder().encode(JSON.stringify(reply)).byteLength;
    return bytes > MAX_APP_REPLY_BYTES
      ? { error: "too_large" as const }
      : reply;
  };
  return {
    store,
    caller,
    admitLibrary,
    admitInvocation,
    triggerAuthority,
    admitEventFact,
    gitNode,
    /** A finished run's Git steps can no longer be named by a pass mint. */
    forgetGitNodes(runId: string) {
      owner.sql.exec(
        "DELETE FROM standalone_workflow_git_nodes WHERE run_id=?",
        runId,
      );
    },
    /** Trigger runs act as the owner who armed them on their pinned Computer. */
    recordTriggerCaller(
      runId: string,
      memberId: string,
      computerId: string | null,
    ) {
      const context: AppMethodCallContext = {
        actor: { kind: "member", memberId },
        computerId,
        role: "owner",
      };
      owner.sql.exec(
        "INSERT OR IGNORE INTO standalone_workflow_callers(run_id,caller) VALUES(?,?)",
        runId,
        JSON.stringify(context),
      );
    },
    catalog,
    // Host readers use this only after admitting the live member and library.
    catalogForLibrary,
    async prepare(facts: InvocationFacts, raw: GraphStartRequest) {
      const selected = await admitStart(facts);
      const { libraryId, context } = selected;
      const request = S.decodeUnknownSync(graphStartRequestSchema)(raw, {
        onExcessProperty: "error",
      });
      const publication = request.published;
      // Only immutable, published runs receive Workflow node attestations.
      if (facts.subject.kind === "lifecycle" && publication === undefined)
        return { error: "not_granted" as const };
      if (publication !== undefined) {
        if (!(await publisherGranted(selected)))
          return { error: "not_granted" as const };
        if (
          publication.digest !==
          (await contentDigest(S.decodeUnknownSync(S.Json)(request.definition)))
        )
          return { error: "invalid_publication" as const };
      }
      // A team-key caller never becomes a principal: it compiles against its
      // own grants, strictly under the live member's access it borrows. The
      // MCP gate has already required `apps.use` on this Workflows
      // installation, because `runGraph` is a write.
      const keyActor = context.actor.kind === "team-key" ? context.actor : null;
      const key =
        keyActor === null
          ? null
          : ((await host.keys?.live(keyActor.keyId)) ?? null);
      if (keyActor !== null && key === null)
        return { error: "not_granted" as const };
      // Compile reads only the Apps this request's own bindings name, never
      // every installed App; a key then narrows those to its own grants.
      const boundInstallationIds = [
        ...new Set(
          Object.values(request.bindings).filter(
            (value): value is string => typeof value === "string",
          ),
        ),
      ];
      const available = await catalogForLibrary(selected, {
        installationIds: boundInstallationIds,
      });
      if ("error" in available) return available;
      const entries =
        key === null ? available.apps : keyCatalogEntries(available.apps, key);
      const compiled = await compileForMember(entries, request);
      if (compiled.kind === "invalid") return compiled;
      // This host has no human external-effect approval owner. A Git step needs
      // a published run: its pass names the Workflow and the arming member.
      // A key never gets a Git step either way: the key vocabulary has no
      // Git grant yet.
      const graphs = [
        compiled.plan.definition,
        ...Object.values(compiled.plan.definition.subgraphs ?? {}),
      ];
      if (
        graphs.some((graph) =>
          graph.nodes.some((node) => {
            if (node.kind !== "app") return false;
            const binding = compiled.plan.bindings[node.app];
            return (
              (node.gitAccess !== undefined &&
                (key !== null || publication === undefined)) ||
              (binding !== undefined &&
                "appId" in binding &&
                compiled.plan.catalog[binding.appId]?.methods[node.method]
                  ?.effect === "external")
            );
          }),
        )
      )
        return { error: "not_granted" as const };
      const admitted = admitRunInput(compiled.plan.definition, request.input);
      if (admitted.kind === "invalid")
        return { error: "invalid_input" as const };
      // The host's accepted event owns lifecycle replay, not a guest request id.
      const requestId =
        facts.subject.kind === "lifecycle" && facts.subject.name === "onGitPush"
          ? ["onGitPush", facts.subject.eventId]
          : request.requestId;
      const runId =
        "run_" + (await contentDigest([libraryId, requestId])).slice(7, 47);
      // An Agent runs with the access of the person who approved its App
      // tools.
      const subject = facts.subject.kind === "call" ? facts.subject : null;
      const agent: WorkflowAgentInitiator | null =
        context.actor.kind === "agent" &&
        subject?.agentPolicy !== undefined &&
        subject.sessionId !== undefined
          ? {
              kind: "agent",
              agentId: context.actor.agentId,
              sessionId: subject.sessionId,
              grantorMemberId: subject.agentPolicy.grantorMemberId,
            }
          : null;
      // A key's run always acts as its owner, with role owner, the same
      // path an Agent's grantor already takes. The key never becomes a
      // member or an Agent principal on its own request.
      const keyInitiator: WorkflowKeyInitiator | null =
        keyActor === null || key === null
          ? null
          : { kind: "key", keyId: keyActor.keyId, grantorMemberId: key.owner };
      if (
        context.actor.kind !== "member" &&
        agent === null &&
        keyInitiator === null
      )
        return { error: "not_granted" as const };
      const actorId =
        agent !== null
          ? agent.grantorMemberId
          : keyInitiator !== null
            ? keyInitiator.grantorMemberId
            : context.actor.kind === "member"
              ? context.actor.memberId
              : undefined;
      if (actorId === undefined) return { error: "not_granted" as const };
      // A key has no Agent Session, so it can never declare a delivery.
      if (
        request.delivery !== undefined &&
        (keyInitiator !== null ||
          !(await options.admitDelivery(actorId, request.delivery)))
      )
        return { error: "not_granted" as const };
      const preparation: WorkflowRunPreparation =
        agent !== null
          ? {
              initiatedBy: agent,
              source: "agent",
              libraryInstallationId: libraryId,
              computerId: context.computerId,
              plan: compiled.plan,
            }
          : keyInitiator !== null
            ? {
                initiatedBy: keyInitiator,
                source: "key",
                libraryInstallationId: libraryId,
                computerId: context.computerId,
                plan: compiled.plan,
              }
            : {
                initiatedBy: { kind: "member", memberId: actorId },
                source: facts.subject.kind === "lifecycle" ? "event" : "manual",
                libraryInstallationId: libraryId,
                computerId: context.computerId,
                plan: compiled.plan,
              };
      const captured = await options.authority(libraryId).resolve(preparation);
      if (captured.kind !== "admitted" || captured.actor.memberId !== actorId)
        return { error: "not_granted" as const };
      // A declared delivery wins; an Agent's own run reports to its Session.
      const delivery =
        request.delivery ??
        (agent === null
          ? undefined
          : { agentId: agent.agentId, sessionId: agent.sessionId });
      const started = {
        teamId: libraryId,
        runId,
        requestId: await contentDigest([libraryId, requestId]),
        actorId,
        computerId: context.computerId,
        plan: compiled.plan,
        ceiling: captured.ceiling,
        input: admitted.input,
        source: preparation.source,
        initiatedBy: preparation.initiatedBy,
      };
      const record =
        delivery === undefined ? started : { ...started, delivery };
      const current = await admitStart(facts);
      if (
        canonicalJson(S.decodeUnknownSync(S.Json)(current.context)) !==
        canonicalJson(S.decodeUnknownSync(S.Json)(context))
      )
        return { error: "not_granted" as const };
      if (publication !== undefined && !(await publisherGranted(current)))
        return { error: "not_granted" as const };
      const callContext: AppMethodCallContext = {
        actor: captured.actor,
        computerId: context.computerId,
      };
      // Standalone admits only the owner, so an Agent's or a key's grantor
      // acts as owner.
      if (agent !== null || keyInitiator !== null) callContext.role = "owner";
      else if (context.role !== undefined) callContext.role = context.role;
      const run =
        publication === undefined
          ? record
          : {
              ...record,
              publication: {
                installationId: libraryId,
                workflowId: publication.workflowId,
                commit: publication.commit,
                digest: publication.digest,
                armedBy: captured.actor,
              },
            };
      const kind = owner.transactionSync(() => {
        const savedCaller = readCaller(runId);
        if (
          savedCaller !== null &&
          canonicalJson(S.decodeUnknownSync(S.Json)(savedCaller)) !==
            canonicalJson(S.decodeUnknownSync(S.Json)(callContext))
        )
          return "conflict" as const;
        // A replay from a different source or initiator fails here too: the
        // store compares the whole stored record, source and initiator included.
        const accepted = store.startCompiled(run);
        if (accepted !== "conflict")
          owner.sql.exec(
            "INSERT OR IGNORE INTO standalone_workflow_callers(run_id,caller) VALUES(?,?)",
            runId,
            JSON.stringify(callContext),
          );
        return accepted;
      });
      return { kind, runId, planDigest: compiled.plan.planDigest };
    },
    async loadRun(libraryId: string, runId: string) {
      await admitLibrary(libraryId, "runGraph");
      const run = store.read(runId);
      if (run?.teamId !== libraryId || store.outcome(runId) !== "active")
        throw new Error("Workflow run is not active");
      return { plan: run.plan, input: run.input };
    },
    /** Live member, Computer and library run grant, before every node kind. */
    async beforeNode(raw: NodeEvent): Promise<NodeAdmissionResult> {
      const event = S.decodeUnknownSync(nodeEventSchema)(raw, {
        onExcessProperty: "error",
      });
      const run = store.read(event.runId);
      if (run === null || store.outcome(event.runId) !== "active")
        return { kind: "refused", code: "revoked" };
      const savedCaller = caller(run.runId);
      if (savedCaller.actor.kind !== "member")
        return { kind: "refused", code: "revoked" };
      const decision = await options
        .authority(run.teamId)
        .recheckRun(preparationFromRun(run, run.teamId));
      if (decision.kind === "refused")
        store.recordEvent({
          ...event,
          state: "failed",
          refusal: decision.code,
          errorMessage: decision.code.replaceAll("_", " "),
        });
      return decision;
    },
    async dispatch(call: NodeCall): Promise<DispatchResult> {
      const run = store.read(call.runId);
      if (run?.teamId !== call.teamId || store.outcome(call.runId) !== "active")
        return { kind: "refused", code: "revoked" };
      await admitLibrary(run.teamId, "runGraph");
      const resolved = planNodeCall(run, call);
      if (resolved === null) return { kind: "refused", code: "not_granted" };
      const pinned = run.plan.catalog[resolved.appId]?.methods[resolved.method];
      const { installation, verified } = await admitted(call.installationId);
      if (
        verified.api === null ||
        installation.release.appId !== resolved.appId
      )
        return { kind: "refused", code: "revoked" };
      const current = (await catalogMethods(verified.api.methods)).methods[
        resolved.method
      ];
      if (
        !pinned ||
        current?.digest !== pinned.digest ||
        pinned.effect === "external"
      )
        return { kind: "refused", code: "revoked" };
      if (store.outcome(call.runId) !== "active")
        return { kind: "refused", code: "revoked" };
      const savedCaller = caller(run.runId);
      if (savedCaller.actor.kind !== "member")
        return { kind: "refused", code: "revoked" };
      const live = options.authority(run.teamId);
      await live.member(savedCaller.actor.memberId);
      if (
        run.computerId !== null &&
        !(await live.memberComputer(savedCaller.actor.memberId, run.computerId))
      )
        return { kind: "refused", code: "revoked" };
      const currentAuthority = invocationAuthorityOf(installation, verified);
      const authority = {
        ...currentAuthority,
        // A binding this node's ceiling leaves no operation on is not granted.
        grants: currentAuthority.grants
          .map((grant) => ({
            ...grant,
            operations: grant.operations.filter((operation) =>
              resolved.bindingCeiling.some(
                (binding) =>
                  binding.name === grant.binding &&
                  binding.operations.includes(operation),
              ),
            ),
          }))
          .filter((grant) => grant.operations.length > 0),
      };
      const deadlineAt = Date.now() + APP_INVOCATION_CEILING_MS;
      const deadline = { deadlineAt, grantExpiresAt: deadlineAt };
      const factsFor = (idempotencyKey: string) =>
        run.publication === undefined
          ? invocationFacts.fromCaller(
              authority,
              { ...savedCaller, idempotencyKey },
              deadline,
            )
          : invocationFacts.fromWorkflowNode(
              authority,
              {
                ...savedCaller,
                workflow: {
                  workflowId: run.publication.workflowId,
                  runId: run.runId,
                  nodeId: resolved.nodeId,
                  armedBy: savedCaller.actor,
                },
                idempotencyKey,
              },
              deadline,
            );
      const facts = factsFor(call.idempotencyKey);
      if (resolved.gitAccess !== undefined)
        recordGitNode(call.idempotencyKey, {
          teamId: run.teamId,
          memberId: savedCaller.actor.memberId,
          installationId: resolved.installationId,
          appId: resolved.appId,
          method: resolved.method,
          methodDigest: resolved.methodDigest,
          computerId: run.computerId,
          context: resolved,
        });
      const result = await host.instances
        .get(authority.instanceId)
        .call(facts, verified.api, resolved.method, resolved.input);
      if (store.outcome(call.runId) !== "active")
        return { kind: "refused", code: "revoked" };
      if (!result.ok) {
        // InstanceResult's own producer vocabulary (packages/oyster) names
        // every structural/authority rejection as an AppInstanceErrorCode;
        // "failed" is its sole catch-all for an unclassified backend
        // failure. Only a code that is actually a live decision about
        // today's grant refuses the node as "revoked" (or, for a binding
        // the Release never granted, "not_granted"). Every execution or
        // availability code -- a deadline "expired" included -- throws, so
        // the graph records a failed step and the engine's own retry
        // applies, never a silent "revoked" that misreports a timeout or a
        // transient unavailability as an authority decision.
        switch (result.code) {
          // A moved authority version is itself the live decision, not a
          // retryable fault; same for an instance the owner state marks
          // inactive.
          case "revoked":
          case "disabled":
          case "instance_owner_mismatch":
          case "instance_authority_version_mismatch":
          case "instance_release_mismatch":
          case "release_no_longer_matches_instance":
          case "installation_tenant_mismatch":
          case "stale_authority":
          case "instance_inactive":
            return { kind: "refused", code: "revoked" };
          case "binding_not_granted":
            return { kind: "refused", code: "not_granted" };
          case "failed":
            throw new Error(
              result.causeClass === undefined
                ? "App execution failed"
                : `App execution failed (${result.causeClass})`,
            );
          case "expired":
          case "backend_load_failed":
          case "backend_construction_failed":
          case "ui_mount_failed":
          case "boot_runner_unavailable":
          case "boot_browser_binding_missing":
          case "boot_clone_unavailable":
          case "boot_timeout":
          case "boot_cleanup_failed":
          case "binding_unavailable":
          case "reentrant":
          case "conflicting_owner_state":
          case "invalid_owner_state":
          case "invalid_invocation_facts":
          case "instance_identity_mismatch":
          case "instance_deleted":
          case "release_app_mismatch":
          case "state_schema_migration_unsupported":
            throw new Error(`App execution failed (${result.code})`);
          default: {
            const exhaustive: never = result.code;
            throw new Error(`App execution failed (${String(exhaustive)})`);
          }
        }
      }
      // The engine's closed refusal vocabulary names host decisions; an App's
      // own domain refusal fails the node with its code and caller-facing reason.
      if (result.value.kind === "refused")
        throw new Error(
          `App method refused (${result.value.code}): ${result.value.message}`,
        );
      const value = result.value.value;
      const pending =
        pinned.pending === true ? pendingSchema.safeParse(value) : null;
      if (pending?.success) return pending.data;
      if (!accepts(parseProjection(pinned.output), value))
        return { kind: "refused", code: "invalid_output" };
      const output = S.decodeUnknownSync(S.Json)(value);
      const row =
        verified.api.methods[resolved.method]?.present === undefined
          ? undefined
          : await presentedRow(
              resolved.method,
              host.instances
                .get(authority.instanceId)
                .call(
                  factsFor(`${call.idempotencyKey}:present`),
                  verified.api,
                  presentMethodName,
                  { method: resolved.method, input: resolved.input, output },
                ),
            );
      const complete = {
        kind: "complete" as const,
        output,
        costMilliunits: 0,
      };
      return row === undefined ? complete : { ...complete, row };
    },
  };
}

/**
 * A failed or malformed projection costs the step only its row: the step stays
 * complete, Trellis reads it as "<App> ran <method>" with the raw view, and
 * the operator log records why.
 */
async function presentedRow(
  method: string,
  reply: Promise<InstanceResult<AppMethodReply>>,
): Promise<ResultRow | undefined> {
  try {
    const result = await reply;
    if (!result.ok || result.value.kind !== "ok") {
      console.error("Workflow step presentation was refused", method);
      return undefined;
    }
    return S.decodeUnknownSync(resultRowSchemaV1, {
      onExcessProperty: "error",
    })(result.value.value);
  } catch (cause) {
    console.error("Workflow step presentation failed", method, cause);
    return undefined;
  }
}
