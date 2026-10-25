import { canonicalJson } from "@fungi.computer/braid";
import type { Release } from "@fungi.computer/puffball";
import {
  OysterRegistry,
  r2ArtifactStore,
  type OysterWorkerEnv,
} from "../workers.js";
import { installOrSelect, type OysterHost } from "../host.js";
import { installationOperationsPort } from "../installation-operations.js";
import { tenantScope, type TenantScope, type TenantId } from "../tenant.js";
import { artifactsOf, type OysterGitEnv } from "../workers-git.js";
import {
  forkAppSource,
  recordTemplateSeed,
  templateRepositoryForApp,
  type AppSourceForkResult,
  type TemplateSeedClaim,
} from "../source/index.js";
import {
  exchangeOysterTemplateGit,
  exchangeOysterTemplateSource,
} from "../app-sources.js";
import {
  createCloudflareArtifacts,
  type CloudflareArtifactsOptions,
} from "@fungi.computer/burrow/cloudflare";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import * as Schema from "effect/Schema";
import { parseAppId } from "@fungi.computer/puffball";
import { appIdSchema } from "@fungi.computer/puffball/effect";
import {
  createOysterAppBuilds,
  OysterBuildStartError,
  type OysterBuildStartResult,
  type OysterAppBuilds,
  type OysterBuildView,
} from "../app-builds.js";
import { buildJobsFromOlderOyster } from "../older-oyster-store.js";
import type { TeamAppCandidateManifest } from "../build-contract.js";
import { readBuildManifest, appBuildRecipe } from "../build/workspace-build.js";
import type { BuildGitEvent } from "../build-egress.js";
import { standaloneTenancy, type StandaloneTenancyEnv } from "./tenancy.js";
import type { ComputerDO } from "./computer.js";
import type { ComputerEnv } from "@fungi.computer/computer";
import {
  createFleetComputers,
  ComputerInventoryError,
} from "@fungi.computer/computer/fleet";
import {
  standaloneFleetRequestSchema,
  type StandaloneFleetRequest,
} from "./computer-fleet.js";

/** What the registry needs to build Apps on the standalone's one Computer. */
export type StandaloneRegistryEnv = OysterWorkerEnv &
  Pick<ComputerEnv, "COMPUTER_VM_DEFAULT_HOST"> &
  StandaloneTenancyEnv &
  OysterGitEnv &
  Readonly<{
    OYSTER_COMPUTER_ID: string;
    COMPUTER: DurableObjectNamespace<ComputerDO>;
  }>;

/** One repository a build clone may read, at one installation. */
export type BuildTarget = Readonly<{
  installationId: string;
  repository: string;
  scope: "read" | "write";
}>;

const standaloneAppForkIds = defineIdFamily({
  family: "oyster-app-fork",
  version: 1,
  kinds: { app: { prefix: "app" } },
});

/** The Git transports of the maintained Artifacts owner, which the host's
 * composition may supply; absent, Git goes to the provider's own remotes. */
export type StandaloneRegistryGit = Pick<
  CloudflareArtifactsOptions,
  "gitFetch" | "gitHttp"
>;

/** The existing REGISTRY class identity with standalone host-owned admission. */
/**
 * Operations other Worker contexts call through the REGISTRY Durable Object
 * namespace: the APPS binding (app-builds-binding.ts) and the fleet routes
 * (computer-fleet.ts). Each is an RPC entrypoint, not an in-process helper.
 */
export type StandaloneRegistryRpc = {
  computerFleet(
    memberId: string,
    request: StandaloneFleetRequest,
  ): ReturnType<StandaloneRegistry["computerFleet"]>;
  registerRepositoryApp(
    input: Parameters<StandaloneRegistry["registerRepositoryApp"]>[0],
  ): ReturnType<StandaloneRegistry["registerRepositoryApp"]>;
  repositoryBuildSource(
    installationId: string,
    repository: string,
  ): ReturnType<StandaloneRegistry["repositoryBuildSource"]>;
  readRepositoryBuild(
    installationId: string,
    repository: string,
  ): ReturnType<StandaloneRegistry["readRepositoryBuild"]>;
  readInstallationBuild(
    installationId: string,
    jobId: string,
  ): ReturnType<StandaloneRegistry["readInstallationBuild"]>;
  installWorkflowBuild(
    jobId: string,
    target: string,
    release: Release,
    memberId: string,
    callerInstallationId: string,
  ): ReturnType<StandaloneRegistry["installWorkflowBuild"]>;
};

/** Whether a registered source lives in this installation's own repository. */
function sourceOwnedBy(
  source: ReturnType<OysterAppBuilds["readSource"]>,
  installationId: string,
) {
  return (
    source?.location.kind === "installation" &&
    source.location.installationId === installationId
  );
}

export abstract class StandaloneRegistry
  extends OysterRegistry
  implements StandaloneRegistryRpc
{
  protected abstract hostFor(scope: TenantScope): Promise<OysterHost>;
  readonly #env: StandaloneRegistryEnv;
  readonly #git: StandaloneRegistryGit;
  #builds: Promise<OysterAppBuilds> | undefined;
  readonly #computers: ReturnType<typeof createFleetComputers>;
  readonly #fleetStorage: DurableObjectStorage;

  constructor(
    state: DurableObjectState,
    env: StandaloneRegistryEnv,
    git: StandaloneRegistryGit = {},
  ) {
    super(state, env);
    this.#env = env;
    this.#git = git;
    this.#fleetStorage = state.storage;
    // Native hosts own infrastructure capacity. Standalone has no Team quota.
    this.#computers = createFleetComputers(state.storage, {
      limit: Number.MAX_SAFE_INTEGER,
      retryAfterSeconds: 30,
    });
    this.#computers.ensure();
  }

  /** Whether installations or build jobs were written by Oyster 0.2 or earlier. */
  override storeFromOlderOyster(): boolean {
    return (
      super.storeFromOlderOyster() ||
      buildJobsFromOlderOyster(this.ctx.storage.sql)
    );
  }

  /** Re-admit the live owner before inventory access or a hosted start. */
  async computerFleet(memberId: string, request: StandaloneFleetRequest) {
    const shared = await standaloneTenancy(this.#env);
    if ((await shared.owner())?.actor.memberId !== memberId)
      return { error: "owner_required" };
    const input = standaloneFleetRequestSchema.parse(request);
    switch (input.operation) {
      case "create": {
        const hostId = this.#env.COMPUTER_VM_DEFAULT_HOST;
        let created;
        try {
          created = this.#computers.create(
            { kind: "owner", id: memberId },
            input.request,
            [
              hostId === undefined
                ? { kind: "platform-container" }
                : { kind: "on-box-vm", hostId },
            ],
          ).computer;
        } catch (cause) {
          if (cause instanceof ComputerInventoryError)
            return { error: cause.code };
          throw cause;
        }
        const backings = this.#computers.readBacking(created.computerId);
        if (backings === null) throw new Error("Computer backing is missing");
        await this.#env.COMPUTER.getByName(
          created.computerId,
        ).initializeFleetBackings(backings);
        return created;
      }
      case "list":
        return this.#computers.list(input.page);
      case "choices": {
        // The configured build Computer is an existing supported workspace,
        // not a fabricated fleet creation receipt. Keep its UI row outside inventory.
        const { limit, offset } = input.page;
        const first = offset === 0;
        const configured = {
          computerId: this.#env.OYSTER_COMPUTER_ID,
          name: this.#env.OYSTER_COMPUTER_ID,
        };
        if (first && limit === 1)
          return {
            computers: [configured],
            nextOffset: this.#computers.count() > 0 ? 1 : null,
          };
        const page = this.#computers.list({
          limit: limit - (first ? 1 : 0),
          offset: Math.max(0, offset - 1),
        });
        return {
          computers: first ? [configured, ...page.computers] : page.computers,
          nextOffset: page.nextOffset === null ? null : page.nextOffset + 1,
        };
      }
      case "read":
        return this.#computers.read(input.computerId);
      case "resolve":
        // Context may name the configured build Computer, which has no fleet
        // creation receipt. Keep canonical-owner admission above this lookup.
        return this.ownsComputer(input.computerId)
          ? { computerId: input.computerId }
          : null;
      case "read-internet-access":
      case "set-internet-access": {
        if (this.#computers.read(input.computerId) === null) return null;
        const computer = this.#env.COMPUTER.getByName(input.computerId);
        return {
          enabled: await computer.internetAccess(
            input.operation === "set-internet-access"
              ? input.enabled
              : undefined,
          ),
        };
      }
      case "select": {
        const computer = this.#computers.read(input.computerId);
        if (computer === null) return null;
        await this.#fleetStorage.put("selected-computer", input.computerId);
        return computer;
      }
      case "start":
        if (this.#computers.read(input.computerId) === null) return null;
        return this.#env.COMPUTER.getByName(
          input.computerId,
        ).startHostedComputer({
          computerId: input.computerId,
          actions: new Set(["start"]),
          expiresAt: Date.now() + 60_000,
          provenance: { actor: memberId },
        });
    }
  }

  /** A durable selection snapshot; the configured default remains the App build Computer. */
  async selectedComputer(): Promise<string> {
    const selected = await this.#fleetStorage.get("selected-computer");
    if (selected === undefined) return this.#env.OYSTER_COMPUTER_ID;
    const computerId = Schema.decodeUnknownSync(Schema.NonEmptyString)(
      selected,
    );
    if (this.#computers.read(computerId) === null)
      throw new Error("Selected Computer is missing");
    return computerId;
  }

  /** Frame dispatch checks inventory ownership, not a mutable UI selection. */
  ownsComputer(computerId: string): boolean {
    return (
      computerId === this.#env.OYSTER_COMPUTER_ID ||
      this.#computers.read(computerId) !== null
    );
  }

  /** One atomic registry admission proves the stored creator is still the owner. */
  protected override async currentOwner(
    memberId: string,
    tenantId: TenantId,
  ): Promise<string | null> {
    const shared = await standaloneTenancy(this.#env);
    if (tenantId !== shared.tenantId) return null;
    return (await shared.owner())?.actor.memberId === memberId
      ? memberId
      : null;
  }

  #artifacts() {
    return createCloudflareArtifacts({
      ...this.#git,
      namespace: artifactsOf(this.#env),
      repositories: this.artifactsRepositories,
    });
  }

  /** Operator-only: one smart-HTTP exchange with an App's template
   * repository, the `git push` that seeds it. */
  async exchangeTemplateSource(
    rawAppId: string,
    suffix: string,
    request: Request,
  ): Promise<Response> {
    return exchangeOysterTemplateSource(
      this.#artifacts(),
      rawAppId,
      suffix,
      request,
    );
  }

  /** Operator-only: record the seed the operator just pushed to this
   * Oyster's editable App source template, register the platform App itself
   * as this tenant's own publisher so a later `forkApp` can authorize
   * against it (`fork.ts` reads this record), and make that template the
   * App's build source with the recipe its seed receipt pins, so the
   * published seed revision builds on the Computer. */
  async publishSource(
    rawAppId: string,
    claim: TemplateSeedClaim,
    teamId: string,
  ) {
    const result = await recordTemplateSeed(
      this.appSourceReceipts,
      this.#artifacts(),
      rawAppId,
      claim,
    );
    if (result.kind === "recorded" || result.kind === "existing") {
      const appId = parseAppId(rawAppId);
      const registered = await this.appRegistrations.register({
        appId,
        teamId,
        source: {
          provider: "artifacts",
          repository: templateRepositoryForApp(appId),
          branch: "main",
        },
      });
      if (registered.kind === "conflict") return { kind: "conflict" as const };
      const receipt = await this.appSourceReceipts.read(
        appId,
        result.receipt.seedRevision,
      );
      if (receipt === null) return { kind: "conflict" as const };
      (await this.#appBuilds()).registerSource({
        appId,
        location: { kind: "template" },
        recipe: receipt.recipe,
        buildRecipeDigest: receipt.buildRecipeDigest,
      });
    }
    return result;
  }

  /** Fork a published platform App's source into its own Team-owned App,
   * as repository `name` of the calling installation's Git (so its owner
   * edits and merges it there), and register that repository as the new
   * App's build source with the template's pinned recipe, so a merged
   * commit builds without further setup. */
  async forkApp(
    input: Readonly<{
      teamId: string;
      platformAppId: string;
      /** The installation whose Git holds the fork, e.g. Bonsai. */
      installationId: string;
      /** That installation's provider repository prefix (`TenantScope`). */
      repositoryPrefix: string;
      name: string;
    }>,
  ): Promise<AppSourceForkResult> {
    const appId = Schema.decodeUnknownSync(appIdSchema)(
      standaloneAppForkIds.app.generate(),
    );
    const platformAppId = parseAppId(input.platformAppId);
    const forked = await forkAppSource(
      {
        teamId: input.teamId,
        platformAppId,
        appId,
        repository: `${input.repositoryPrefix}${input.name}`,
      },
      {
        registry: this.appRegistrations,
        artifacts: this.#artifacts(),
        receipts: this.appSourceReceipts,
      },
    );
    if (forked.kind !== "forked") return forked;
    const registration = await this.appRegistrations.read(appId);
    const seed =
      registration.kind === "found"
        ? registration.registration.templateSeed
        : undefined;
    const receipt =
      seed === undefined
        ? null
        : await this.appSourceReceipts.read(seed.appId, seed.revision);
    if (receipt === null) return { kind: "conflict" };
    (await this.#appBuilds()).registerSource({
      appId,
      location: {
        kind: "installation",
        installationId: input.installationId,
        repository: input.name,
      },
      recipe: receipt.recipe,
      buildRecipeDigest: receipt.buildRecipeDigest,
    });
    return { kind: "forked", appId, repository: input.name };
  }

  /** The tenant's App build owner on its one fixed Computer. */
  #appBuilds(): Promise<OysterAppBuilds> {
    this.#builds ??= standaloneTenancy(this.#env).then((shared) => {
      const env = this.#env;
      const name = env.OYSTER_COMPUTER_ID;
      return createOysterAppBuilds({
        owner: {
          sql: this.ctx.storage.sql,
          transactionSync: (operation) =>
            this.ctx.storage.transactionSync(operation),
        },
        tenantId: shared.tenantId,
        computer: {
          name,
          objectId: env.COMPUTER.idFromName(name).toString(),
          port: {
            buildBackend: () => env.COMPUTER.getByName(name).buildBackend(),
            runBuild: (input) => env.COMPUTER.getByName(name).runBuild(input),
          },
        },
        artifacts: r2ArtifactStore(env.RELEASES),
        templates: this.appSourceReceipts,
      });
    });
    return this.#builds;
  }

  /** Register the committed root App, never the installation's mutable Files projection. */
  async registerRepositoryApp(
    input: Readonly<{
      memberId: string;
      installationId: string;
      repository: string;
    }>,
  ): Promise<
    | Readonly<{ kind: "registered"; appId: string; sourceRevision: string }>
    | Readonly<{ kind: "unauthorized" | "invalid_app" | "conflict" }>
  > {
    const shared = await standaloneTenancy(this.#env);
    if ((await shared.owner())?.actor.memberId !== input.memberId)
      return { kind: "unauthorized" };
    const scope = tenantScope(shared.tenantId, this.#env.OYSTER_ORIGIN);
    const repository = await artifactsOf(this.#env).get(
      scope.repositoryPrefix(input.installationId) + input.repository,
    );
    const [head] = await repository.log({ ref: "main", limit: 1, offset: 0 });
    if (head === undefined) return { kind: "invalid_app" };
    const tree = await repository.readTree(head.treeHash);
    const entry = tree?.find(
      (item) => item.name === "package.json" && item.type === "blob",
    );
    if (entry === undefined) return { kind: "invalid_app" };
    const blob = await repository.readBlob(entry.hash);
    // Package metadata is a bounded input; this is not an App build-output budget.
    if (blob === null || blob.size > 1_048_576) return { kind: "invalid_app" };
    const packageJson = await blob.text();
    let app;
    try {
      const manifest = readBuildManifest(packageJson);
      if (
        manifest.fungi.appId === undefined ||
        manifest.fungi.build === undefined
      )
        return { kind: "invalid_app" };
      app = {
        appId: manifest.fungi.appId,
        recipe: appBuildRecipe(manifest, ""),
      };
    } catch (cause) {
      if (Schema.isSchemaError(cause)) return { kind: "invalid_app" };
      throw cause;
    }
    const registered = (await this.#appBuilds()).registerRepositorySource({
      appId: app.appId,
      location: {
        kind: "installation",
        installationId: input.installationId,
        repository: input.repository,
      },
      recipe: app.recipe,
    });
    if (registered.kind === "conflict") return registered;
    return {
      kind: "registered",
      appId: registered.source.appId,
      sourceRevision: "git:" + head.hash,
    };
  }

  /** Owner: start one build of an App's source at one commit; it runs on. */
  async startBuild(input: {
    appId: string;
    sourceRevision: string;
    requestedBy: string;
    workflow?: {
      requestId: string;
      /** The installation whose admitted Workflow node asks; it must own the source. */
      callerInstallationId: string;
      installationId?: string;
    };
  }): Promise<OysterBuildStartResult> {
    try {
      const builds = await this.#appBuilds();
      const request: Parameters<OysterAppBuilds["start"]>[0] = {
        appId: input.appId,
        sourceRevision: input.sourceRevision,
        requestedBy: input.requestedBy,
      };
      if (input.workflow !== undefined) {
        // A Workflow builds only its own installation's registered App. A
        // foreign App reads as unregistered, never as another's existence.
        if (
          !sourceOwnedBy(
            builds.readSource(input.appId),
            input.workflow.callerInstallationId,
          )
        )
          return { kind: "refused", reason: "no_source" };
        request.requestId = input.workflow.requestId;
        if (input.workflow.installationId !== undefined)
          request.installAt = input.workflow.installationId;
      }
      const { build, run } = await builds.start(request);
      this.ctx.waitUntil(run());
      return { kind: "started", build };
    } catch (cause) {
      if (cause instanceof OysterBuildStartError)
        return { kind: "refused", reason: cause.reason };
      throw cause;
    }
  }

  /** The calling installation's existing source record, never a registration. */
  async repositoryBuildSource(installationId: string, repository: string) {
    const source = (await this.#appBuilds()).readRepositorySource(
      installationId,
      repository,
    );
    return source === null ? null : { appId: source.appId };
  }

  async readBuild(jobId: string): Promise<OysterBuildView | null> {
    return (await this.#appBuilds()).read(jobId);
  }

  /** A job ID alone never grants another installation access to its status. */
  async readInstallationBuild(
    installationId: string,
    jobId: string,
  ): Promise<OysterBuildView | null> {
    const builds = await this.#appBuilds();
    const build = builds.read(jobId);
    return build !== null &&
      sourceOwnedBy(builds.readSource(build.appId), installationId)
      ? build
      : null;
  }

  /** Repository status belongs to the same captured Git owner as registration. */
  async readRepositoryBuild(installationId: string, repository: string) {
    const latest = (await this.#appBuilds()).latestRepositoryBuild(
      installationId,
      repository,
    );
    return latest === null ? null : this.readBuild(latest.jobId);
  }

  /** Only the APPS dispatcher of an admitted Workflow node calls this operation.
   * Reads and alarms never choose a Release. The build row owns the decision. */
  async installWorkflowBuild(
    jobId: string,
    target: string,
    release: Release,
    memberId: string,
    callerInstallationId: string,
  ) {
    const builds = await this.#appBuilds();
    const build = builds.read(jobId);
    if (
      build === null ||
      !sourceOwnedBy(builds.readSource(build.appId), callerInstallationId) ||
      build.installation?.installationId !== target ||
      build.release === null ||
      canonicalJson(Schema.decodeUnknownSync(Schema.Json)(build.release)) !==
        canonicalJson(Schema.decodeUnknownSync(Schema.Json)(release))
    )
      return {
        status: 409,
        body: { error: "Release does not match this build and installation" },
      };
    const shared = await standaloneTenancy(this.#env);
    if ((await shared.owner())?.actor.memberId !== memberId)
      return { status: 403, body: { error: "Workflow authority revoked" } };
    await builds.install(jobId, async (release, installationId) => {
      const owner = await shared.owner();
      if (owner?.actor.memberId !== memberId)
        return {
          kind: "failed",
          installationId,
          detail: "App owner unavailable",
        };
      const scope = tenantScope(shared.tenantId, this.#env.OYSTER_ORIGIN);
      const root = await this.hostFor(scope);
      // Use the in-process owner port; do not RPC this registry back into itself.
      const host: OysterHost = {
        ...root,
        installations: {
          ...root.installations,
          get: (id) => Promise.resolve(this.get(id)),
          generation: () => Promise.resolve(this.generation()),
          // Only the owner's journal commits; nothing here writes around it.
          compareAndPut: () =>
            Promise.reject(
              new Error("Workflow installation commits only through its owner"),
            ),
          operations: installationOperationsPort(
            (request) => this.installationOperation(request),
            { tenantId: scope.tenantId, origin: scope.origin },
          ),
        },
      };
      const principal = await host.auth.resolve(owner.actor);
      if (principal === null)
        return {
          kind: "failed",
          installationId,
          detail: "App owner unavailable",
        };
      const response = await installOrSelect(
        host,
        installationId,
        release,
        principal,
        "install-or-select",
        "workflow",
        // One retained owner command per build: a retry observes it.
        "workflow-build:" + jobId,
      );
      if (response.ok) return { kind: "installed", installationId };
      const body: unknown = await response.json();
      if (
        Schema.is(Schema.Struct({ error: Schema.Literal("needs_consent") }))(
          body,
        )
      )
        return { kind: "needs_consent", installationId };
      return {
        kind: "failed",
        installationId,
        detail:
          "Automatic installation refused (HTTP " +
          String(response.status) +
          ")",
      };
    });
    const outcome = builds.read(jobId)?.installation;
    switch (outcome?.kind) {
      case "installed":
        return {
          status: 200,
          body: { installationId: target, status: "enabled" },
        };
      case "needs_consent":
        return {
          status: 409,
          body: {
            code: "needs_consent",
            error: "New Release needs owner consent",
          },
        };
      case "failed":
        return { status: 503, body: { error: outcome.detail } };
      default:
        // Another installer holds this owner: the Workflow waits and retries.
        return { status: 202, body: { pending: true } };
    }
  }

  /** The Computer re-admits each build execution here. */
  async admitBuildExecution(
    jobId: string,
    computerObjectId: string,
  ): Promise<boolean> {
    return (await this.#appBuilds()).admitExecution(jobId, computerObjectId);
  }

  /** The egress: which live job a build report from this Computer speaks for. */
  async admitBuildReport(
    jobId: string,
    computerObjectId: string,
  ): Promise<Readonly<{ credentialId: string }> | null> {
    return (await this.#appBuilds()).admitBuild(jobId, computerObjectId);
  }

  /** The egress: the clone pass for this Computer's live job on one repository. */
  async buildGitPassFor(
    computerObjectId: string,
    target: BuildTarget,
  ): Promise<string | null> {
    return (await this.#appBuilds()).gitPassFor(computerObjectId, target);
  }

  /** The Git door: admit a presented build clone pass. */
  async admitBuildGitPass(
    pass: string,
    target: BuildTarget,
  ): Promise<Readonly<{ requestedBy: string }> | null> {
    return (await this.#appBuilds()).admitGitPass(pass, target);
  }

  /** The egress: one read-only Git exchange with a template repository, for
   * this Computer's live template build job only. */
  async exchangeBuildTemplate(
    computerObjectId: string,
    repository: string,
    request: Request,
  ): Promise<Response> {
    if (
      !(await this.#appBuilds()).admitTemplateClone(
        computerObjectId,
        repository,
      )
    )
      return new Response(null, { status: 403 });
    return exchangeOysterTemplateGit(
      this.#artifacts(),
      `https://git.team.internal/${repository}.git`,
      repository,
      request,
      "read",
    );
  }

  async recordBuildEvent(event: BuildGitEvent): Promise<void> {
    (await this.#appBuilds()).record(event);
  }

  /** The egress: may this Computer's live job upload one object, how large? */
  async admitBuildObject(
    jobId: string,
    computerObjectId: string,
    grant: string,
  ): Promise<Readonly<{ maxObjectBytes: number }> | null> {
    return (await this.#appBuilds()).admitObjectUpload(
      jobId,
      computerObjectId,
      grant,
    );
  }

  /** The egress: a live job's candidate manifest; its objects are stored. */
  async submitBuildCandidate(
    jobId: string,
    manifest: TeamAppCandidateManifest,
    grant: string,
    credentialId: string,
  ): Promise<Response> {
    return (await this.#appBuilds()).submitCandidate(
      jobId,
      manifest,
      grant,
      credentialId,
    );
  }
}
