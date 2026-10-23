// Browser profile: the DOM-facing and Node-only Oyster entries, with every
// shared declaration checked strictly (skipLibCheck false).
import { ownerKeyAuth, ownerKeyCookieName } from "@fungi.computer/oyster/auth";
import {
  installationSchema,
  applyInstallationCommand,
  approvedBindingGrants,
  admitMethodMetadata,
  appInvocationCeiling,
  type AppMethodMetadataDecision,
  type GateFacts,
  type Installation,
  type AppToolPolicy,
  appToolPolicySchema,
} from "@fungi.computer/oyster/apps";

export const captureMethodMetadata = (
  facts: GateFacts,
  name: string,
): AppMethodMetadataDecision => admitMethodMetadata(facts, name);

export const captureCeiling = (facts: GateFacts): "read" | "write" =>
  appInvocationCeiling(facts);

export const toolPolicy: AppToolPolicy = {
  level: "read",
  revision: "policy-1",
  grantedBy: "fixture-owner",
};
export const parseToolPolicy = (value: unknown): AppToolPolicy =>
  Schema.decodeUnknownSync(appToolPolicySchema)(value);
export const parseInstallation = (value: unknown): Installation =>
  installationSchema.parse(value);
export const reduceInstallation: typeof applyInstallationCommand =
  applyInstallationCommand;
export const bindingApproval: typeof approvedBindingGrants =
  approvedBindingGrants;

export const ownerCookie: "oyster_session" = ownerKeyCookieName;
export const canonicalOwnerSignIn = ownerKeyAuth(
  "stranger-owner-key-1234567890",
  "stored-member",
);

import {
  mountOysterPage,
  connectOysterApp,
  oysterAppCapabilities,
  oysterShellHandles,
  readOysterPageConfig,
  appSandbox,
} from "@fungi.computer/oyster/page";
import { createOysterRootData } from "@fungi.computer/oyster/root-data";
export const mountPage: typeof mountOysterPage = mountOysterPage;
export const connectPage: typeof connectOysterApp = connectOysterApp;
export const pageCapabilities: typeof oysterAppCapabilities =
  oysterAppCapabilities;
export const rootData: typeof createOysterRootData = createOysterRootData;
export const shellHandles: typeof oysterShellHandles = oysterShellHandles;
export const pageConfig: typeof readOysterPageConfig = readOysterPageConfig;
export const appFrameSandbox: string = appSandbox;

import * as Effect from "effect/Effect";
import {
  ComputerTerminalHost,
  type ComputerTerminalHostOptions,
} from "@fungi.computer/oyster/computer";

export const provideTerminal: new (
  options: ComputerTerminalHostOptions,
) => ComputerTerminalHost = ComputerTerminalHost;
import {
  createOyster,
  type OysterCapability,
  type InstanceHandle,
} from "@fungi.computer/oyster/host";
import {
  fileCapabilities,
  type FileSource,
} from "@fungi.computer/oyster/files";
import * as Schema from "effect/Schema";
import { oysterAppMethods } from "@fungi.computer/oyster/mcp";
import type { CapabilitySource, Grants } from "@fungi.computer/mycelium";
import {
  AppInstanceError,
  createAppInstance,
  instanceIds,
  ownerStateSchema,
  type AppInstance,
  type Instance,
  type InstancePorts,
} from "@fungi.computer/oyster";

const instanceId = instanceIds.instance.generate();
let stored: Instance | null = null;
const ports: InstancePorts<undefined> = {
  instanceId,
  read: () => Effect.succeed(stored),
  write: (instance) =>
    Effect.sync(() => {
      stored = instance;
    }),
  resolve: () => Effect.fail(new Error("No Releases in this consumer")),
  boot: () => Effect.succeed({ kind: "passed" as const }),
  abort: () => Effect.void,
  purge: () => Effect.void,
  connect: () => Effect.fail(new Error("No backend in this consumer")),
};
const instance: AppInstance<undefined> = createAppInstance(ports);
const state = Schema.decodeUnknownSync(ownerStateSchema)({
  instanceId,
  owner: { kind: "installation", id: "installation_typed" },
  appId: "app_typed",
  releaseId: "rel_typed",
  authorityVersion: 1,
  status: "disabled",
});
await Effect.runPromise(instance.prepare(state));
export const receipt: Instance = await Effect.runPromise(instance.apply(state));
export const staleCode: AppInstanceError["code"] = "stale_authority";

export const server: typeof createOyster = createOyster;
export const appMethods: (
  ...args: Parameters<typeof oysterAppMethods>
) => Promise<CapabilitySource & { readonly grants: Grants }> = oysterAppMethods;
export const provideFiles: (source: FileSource) => readonly OysterCapability[] =
  fileCapabilities;

import {
  createAppStorage,
  appStorageSchemaStatements,
  type AppStorageAdmission,
  type AppStorageInstallationAdmission,
} from "@fungi.computer/oyster/app-storage";

export const createStorageOwner: typeof createAppStorage = createAppStorage;
export const storageSchema: readonly string[] = appStorageSchemaStatements;
export const lifecycleStorageAdmission: AppStorageInstallationAdmission = {
  address: "installation_typed",
  appId: "app_typed",
  keys: [{ key: "document", scopes: ["team"], maxBytes: 1024 }],
  assertCurrent: () => undefined,
};
export const memberStorageAdmission: AppStorageAdmission = {
  ...lifecycleStorageAdmission,
  memberId: "member_typed",
  membershipVersion: 1,
  isOwner: false,
};

/** Selected lifecycle delivery preserves the canonical accepted fact. */
export type SelectedGitPushDelivery = InstanceHandle["onGitPush"];

import {
  createAppCandidatePreparer,
  createLocalBuildExecutor,
  createLocalCommitSourceCapture,
  type AppPublisherCoreConfigInput,
} from "@fungi.computer/oyster/build";
import { parseSourceRevision } from "@fungi.computer/puffball";
const buildConfig: AppPublisherCoreConfigInput = {
  appId: "app_consumer",
  recipe: {
    entry: "backend/index.ts",
    maxOutputBytes: 65536,
    backend: {
      exportName: "App",
      compatibilityDate: "2026-09-04",
      runtime: { kind: "durable-facet", stateSchema: 1 },
    },
  },
};
export const prepare = createAppCandidatePreparer({
  config: buildConfig,
  sourceCapture: createLocalCommitSourceCapture(
    "/captured/repository",
    parseSourceRevision(`git:${"a".repeat(40)}`),
  ),
  buildExecutor: createLocalBuildExecutor(),
});

import {
  packRelease,
  installFromSource,
  type PackOptions,
  type PackedRelease,
} from "@fungi.computer/oyster/pack";
export const committedPackOptions: PackOptions = {
  appId: buildConfig.appId,
  recipe: buildConfig.recipe,
  sourceDirectory: "/captured/repository",
  sourceRevision: `git:${"a".repeat(40)}`,
  outDirectory: "/packed/release",
};
export const packCommitted: (options: PackOptions) => Promise<PackedRelease> =
  packRelease;
export const installCommitted: typeof installFromSource = installFromSource;

import type * as DInvocation from "@fungi.computer/oyster/invocation";
export type DInvocationSurface = typeof DInvocation;

import type * as DGit from "@fungi.computer/oyster/git";
export type DGitSurface = typeof DGit;

import type * as DWorkflows from "@fungi.computer/oyster/workflows";
export type DWorkflowsSurface = typeof DWorkflows;

import type * as DAgents from "@fungi.computer/oyster/agents";
export type DAgentsSurface = typeof DAgents;

import type * as DKeys from "@fungi.computer/oyster/keys";
export type DKeysSurface = typeof DKeys;

import type * as DEventRecipients from "@fungi.computer/oyster/event-recipients";
export type DEventRecipientsSurface = typeof DEventRecipients;

import type * as DBootGate from "@fungi.computer/oyster/boot-gate";
export type DBootGateSurface = typeof DBootGate;

import type * as DBootCapability from "@fungi.computer/oyster/boot-capability";
export type DBootCapabilitySurface = typeof DBootCapability;

import type * as DBootCapabilityRoute from "@fungi.computer/oyster/boot-capability/route";
export type DBootCapabilityRouteSurface = typeof DBootCapabilityRoute;

import type * as DAppBuilds from "@fungi.computer/oyster/app-builds";
export type DAppBuildsSurface = typeof DAppBuilds;

import type * as DBuildContract from "@fungi.computer/oyster/build-contract";
export type DBuildContractSurface = typeof DBuildContract;

import type * as DBuildEgress from "@fungi.computer/oyster/build-egress";
export type DBuildEgressSurface = typeof DBuildEgress;

import type * as DBuildJobs from "@fungi.computer/oyster/build-jobs";
export type DBuildJobsSurface = typeof DBuildJobs;

import type * as DSource from "@fungi.computer/oyster/source";
export type DSourceSurface = typeof DSource;

import type * as DSourceTemplatePush from "@fungi.computer/oyster/source/template-push";
export type DSourceTemplatePushSurface = typeof DSourceTemplatePush;

import type * as DAppSources from "@fungi.computer/oyster/app-sources";
export type DAppSourcesSurface = typeof DAppSources;

import type * as DMedia from "@fungi.computer/oyster/media";
export type DMediaSurface = typeof DMedia;

import type * as DStandaloneAppSet from "@fungi.computer/oyster/standalone/app-set";
export type DStandaloneAppSetSurface = typeof DStandaloneAppSet;

import type * as DTenant from "@fungi.computer/oyster/tenant";
export type DTenantSurface = typeof DTenant;

import type * as DTenancy from "@fungi.computer/oyster/tenancy";
export type DTenancySurface = typeof DTenancy;

import type * as DTenancyResolve from "@fungi.computer/oyster/tenancy/resolve";
export type DTenancyResolveSurface = typeof DTenancyResolve;

import type * as DTenancyRegistry from "@fungi.computer/oyster/tenancy/registry";
export type DTenancyRegistrySurface = typeof DTenancyRegistry;

import type * as DTenancyOwnerKey from "@fungi.computer/oyster/tenancy/owner-key";
export type DTenancyOwnerKeySurface = typeof DTenancyOwnerKey;

import type * as DTenancyAuth0 from "@fungi.computer/oyster/tenancy/auth0";
export type DTenancyAuth0Surface = typeof DTenancyAuth0;

import type * as DTenancyColdDirectory from "@fungi.computer/oyster/tenancy/cold-directory";
export type DTenancyColdDirectorySurface = typeof DTenancyColdDirectory;
