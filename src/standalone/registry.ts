import {
  OysterRegistry,
  r2ArtifactStore,
  type OysterWorkerEnv,
} from "../workers.js";
import type { TenantId } from "../tenant.js";
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
  type OysterAppBuilds,
  type OysterBuildSource,
  type OysterBuildView,
} from "../app-builds.js";
import type { TeamAppCandidateManifest } from "../build-contract.js";
import type { BuildGitEvent } from "../build-egress.js";
import { standaloneTenancy, type StandaloneTenancyEnv } from "./tenancy.js";
import type { ComputerDO } from "./computer.js";

/** What the registry needs to build Apps on the standalone's one Computer. */
export type StandaloneRegistryEnv = OysterWorkerEnv &
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
export class StandaloneRegistry extends OysterRegistry {
  readonly #env: StandaloneRegistryEnv;
  readonly #git: StandaloneRegistryGit;
  #builds: Promise<OysterAppBuilds> | undefined;

  constructor(
    state: DurableObjectState,
    env: StandaloneRegistryEnv,
    git: StandaloneRegistryGit = {},
  ) {
    super(state, env);
    this.#env = env;
    this.#git = git;
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
            runBuild: (input) => env.COMPUTER.getByName(name).runBuild(input),
          },
        },
        artifacts: r2ArtifactStore(env.RELEASES),
        templates: this.appSourceReceipts,
      });
    });
    return this.#builds;
  }

  /** Owner: record an App's build source (one repository, pinned recipe). */
  async registerBuildSource(source: OysterBuildSource): Promise<void> {
    (await this.#appBuilds()).registerSource(source);
  }

  /** Owner: start one build of an App's source at one commit; it runs on. */
  async startBuild(input: {
    appId: string;
    sourceRevision: string;
    requestedBy: string;
  }): Promise<OysterBuildView> {
    const { build, run } = await (await this.#appBuilds()).start(input);
    this.ctx.waitUntil(run());
    return build;
  }

  async readBuild(jobId: string): Promise<OysterBuildView | null> {
    return (await this.#appBuilds()).read(jobId);
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
