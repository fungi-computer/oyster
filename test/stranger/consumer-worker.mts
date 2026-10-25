// Worker profile: the consumer's use of every Worker-side Oyster entry, checked
// against the runtime types Wrangler generates for the documented Worker
// config. Shared declarations are not re-checked here (skipLibCheck); the
// browser profile checks them strictly.
import { ownerKeyAuth, ownerKeyCookieName } from "@fungi.computer/oyster/auth";
import {
  installationSchema,
  approvedGrantSchema,
  type ApprovedGrant,
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

import * as Effect from "effect/Effect";
import { createOysterRootData } from "@fungi.computer/oyster/root-data";
export const rootData: typeof createOysterRootData = createOysterRootData;

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
import {
  oysterAppMethods,
  oysterMcpCatalogLoad,
  type OysterMcpCatalogSnapshot,
} from "@fungi.computer/oyster/mcp";
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
  defaultTenant,
  implicitTenancy,
  singleTenant,
  tenantIdSchema,
  tenantScope,
  type TenantId,
  type TenantResolver,
  type TenantScope,
  type TenantPrincipal,
  type OysterTenancy,
  type ResolvedTenant,
} from "@fungi.computer/oyster/tenant";

const parsedTenant: TenantId =
  Schema.decodeUnknownSync(tenantIdSchema)("shop-one");
const scope: TenantScope = tenantScope(
  parsedTenant,
  "https://shop-one.example",
);
const resolvers: readonly TenantResolver[] = [
  singleTenant("https://oyster.example"),
];
void [
  defaultTenant,
  scope.durableName("registry"),
  scope.repositoryPrefix("bonsai"),
  resolvers,
];

const tenancy: OysterTenancy = implicitTenancy("https://oyster.example", {
  resolve: () => Promise.resolve(null),
  authenticate: () => Promise.resolve({ kind: "refused", status: 401 }),
});
const resolvedTenant: ResolvedTenant | null = await tenancy.resolve(
  new Request("https://oyster.example"),
);
const memberPrincipal: TenantPrincipal = {
  actor: { kind: "member", memberId: "member-one" },
  role: "member",
};
const ownerPrincipal: TenantPrincipal = {
  actor: { kind: "member", memberId: "owner-one" },
  role: "owner",
};
const agentPrincipal: TenantPrincipal = {
  actor: { kind: "agent", agentId: "agent-one" },
};
const keyPrincipal: TenantPrincipal = {
  actor: { kind: "team-key", keyId: "key-one" },
};
// Negative type laws without suppressing compiler diagnostics.
const memberRequiresRole: {
  actor: { kind: "member"; memberId: string };
} extends TenantPrincipal
  ? false
  : true = true;
const nonMemberHasNoRole: "role" extends keyof Exclude<
  TenantPrincipal,
  { role: "owner" | "member" }
>
  ? false
  : true = true;
void [
  resolvedTenant,
  memberPrincipal,
  ownerPrincipal,
  agentPrincipal,
  keyPrincipal,
  memberRequiresRole,
  nonMemberHasNoRole,
];

export const eventApproval: ApprovedGrant = approvedGrantSchema.parse({
  capability: "app.events.emit",
  capabilityApproved: true,
  operations: ["binding:EVENTS:emit"],
  resources: "tenant-scope",
});
import {
  oysterPrincipalIsOwner,
  oysterPrincipalIsVisitor,
  oysterPrincipalId,
  type OysterAuthResult,
} from "@fungi.computer/oyster/host";
const tenantRefusal: OysterAuthResult = {
  kind: "refused",
  status: 429,
  retryAfter: 9,
};
void [
  tenantRefusal,
  oysterPrincipalIsOwner(memberPrincipal),
  oysterPrincipalIsVisitor(agentPrincipal),
  oysterPrincipalId(keyPrincipal),
];

// Tenancy: resolve provisioned tenants, verify identities, apply membership.
import {
  createTenancy,
  type AuthAdapter,
  type ManagedTenancy,
  type ReadonlyTenancy,
  type ReadonlyTenantRegistry,
} from "@fungi.computer/oyster/tenancy";
import { subdomain, path } from "@fungi.computer/oyster/tenancy/resolve";
import { memoryRegistry } from "@fungi.computer/oyster/tenancy/registry";
import {
  ownerKey,
  type OwnerKeyRecord,
} from "@fungi.computer/oyster/tenancy/owner-key";
import {
  auth0,
  type Auth0Transaction,
  type Auth0Session,
} from "@fungi.computer/oyster/tenancy/auth0";
import {
  durableObjectRegistry,
  rateLimit,
  TenancyRegistryDO,
  type DurableRegistry,
  type DurableReadonlyRegistry,
} from "@fungi.computer/oyster/tenancy/cloudflare";
import {
  subdomain as originResolver,
  path as pathResolver,
} from "@fungi.computer/oyster/tenancy/resolve";
import { memoryRegistry as adapterRegistry } from "@fungi.computer/oyster/tenancy/registry";
import {
  coldTenantDirectory,
  type ColdTenantDirectory,
} from "@fungi.computer/oyster/tenancy/cold-directory";
declare const namespace: DurableObjectNamespace<TenancyRegistryDO>;
declare const limiterBinding: RateLimit;
declare const capturedScope: TenantScope;
{
  const registry = memoryRegistry();
  const identity = { provider: "fixture", subject: "owner" };
  const auth: AuthAdapter = {
    id: "identity",
    authenticate: () => Promise.resolve({ kind: "identity", identity }),
  };
  const managed: ManagedTenancy = createTenancy({
    resolve: subdomain("example.test"),
    registry,
    auth: [auth],
  });
  const read: ReadonlyTenantRegistry = {
    get: registry.get,
    byHandle: registry.byHandle,
    status: registry.status,
    membershipOf: registry.membershipOf,
    memberById: registry.memberById,
  };
  const readonly: ReadonlyTenancy = createTenancy({
    resolve: path("/t/:tenant"),
    registry: read,
    auth: [auth],
  });
  type HasCreate = "create" extends keyof typeof readonly ? true : false;
  const hasCreate: HasCreate = false;
  void [managed, readonly, hasCreate];
  const records = new Map<string, OwnerKeyRecord>();
  const ownerAdapter: AuthAdapter = ownerKey({
    registry,
    keys: { get: (id) => Promise.resolve(records.get(id) ?? null) },
  });
  const issuerAdapter: AuthAdapter = auth0({
    domain: "identity.example.test",
    clientId: "application",
    audience: "https://api.example.test",
  });
  const transactions = new Map<string, Auth0Transaction>();
  const sessions = new Map<string, Auth0Session>();
  const browserAdapter: AuthAdapter = auth0({
    domain: "identity.example.test",
    clientId: "application",
    audience: "https://api.example.test",
    browser: {
      callbackPath: "/auth/callback",
      resolveTenant: managed.resolve,
      registry,
      transactions: {
        put: (id, value) => {
          transactions.set(id, value);
          return Promise.resolve();
        },
        take: (id) => {
          const value = transactions.get(id) ?? null;
          transactions.delete(id);
          return Promise.resolve(value);
        },
      },
      sessions: {
        put: (id, value) => {
          sessions.set(id, value);
          return Promise.resolve();
        },
        get: (id) => Promise.resolve(sessions.get(id) ?? null),
      },
    },
  });
  void [ownerAdapter, issuerAdapter, browserAdapter];
  const durableManaged: DurableRegistry = durableObjectRegistry(namespace);
  const durableRead: DurableReadonlyRegistry = durableObjectRegistry(
    namespace,
    {
      readonly: true,
    },
  );
  type DurableReadHasCreate = "create" extends keyof typeof durableRead
    ? true
    : false;
  type DurableReadHasDelete = "delete" extends keyof typeof durableRead
    ? true
    : false;
  const noDurableCreate: DurableReadHasCreate = false;
  const noDurableDelete: DurableReadHasDelete = false;
  const policy = rateLimit(limiterBinding, { retryAfterSeconds: 60 });
  void [
    TenancyRegistryDO,
    durableManaged,
    durableRead,
    noDurableCreate,
    noDurableDelete,
    policy,
  ];
  const originApi = createTenancy({
    resolve: originResolver("oyster.test"),
    registry: adapterRegistry(),
    auth: [],
  });
  const pathApi = createTenancy({
    resolve: pathResolver("/t/:tenant"),
    registry: adapterRegistry(),
    auth: [],
  });
  const originCanHost: "oyster" extends keyof typeof originApi ? true : false =
    true;
  const pathCannotHost: "oyster" extends keyof typeof pathApi ? false : true =
    true;
  void [originCanHost, pathCannotHost, originApi.oyster(), pathApi];
  const cold: ColdTenantDirectory = coldTenantDirectory(read);
  const selectedCold: Promise<ResolvedTenant | null> =
    cold.resolve(capturedScope);
  type ColdHasCreate = "create" extends keyof ColdTenantDirectory
    ? true
    : false;
  const coldHasCreate: ColdHasCreate = false;
  void [selectedCold, coldHasCreate];
}

import {
  decodeMachineAgentHome,
  type MachineAgentHome,
} from "@fungi.computer/oyster/machine-link";
const machineHome: MachineAgentHome = decodeMachineAgentHome({
  kind: "machine",
  deviceId: "device-one",
});
if (machineHome.kind === "machine") {
  const deviceId: string = machineHome.deviceId;
  void deviceId;
}

import type * as WCloudflare from "@fungi.computer/oyster/cloudflare";
export type WCloudflareSurface = typeof WCloudflare;

import type * as WWorkers from "@fungi.computer/oyster/workers";
export type WWorkersSurface = typeof WWorkers;

import type * as WWorkersGit from "@fungi.computer/oyster/workers-git";
export type WWorkersGitSurface = typeof WWorkersGit;

import type * as WStandalone from "@fungi.computer/oyster/standalone";
export type WStandaloneSurface = typeof WStandalone;

import type * as WStandaloneMedia from "@fungi.computer/oyster/standalone/media";
export type WStandaloneMediaSurface = typeof WStandaloneMedia;

import type * as WCatalogFrame from "@fungi.computer/oyster/catalog-frame";
export type WCatalogFrameSurface = typeof WCatalogFrame;

import type * as WMachineLinkWorkers from "@fungi.computer/oyster/machine-link/workers";
export type WMachineLinkWorkersSurface = typeof WMachineLinkWorkers;

import type * as WTesting from "@fungi.computer/oyster/testing";
export type WTestingSurface = typeof WTesting;

import type * as WTestingWorker from "@fungi.computer/oyster/testing/worker";
export type WTestingWorkerSurface = typeof WTestingWorker;

import type * as WTestingWorkersRuntime from "@fungi.computer/oyster/testing/workers-runtime";
export type WTestingWorkersRuntimeSurface = typeof WTestingWorkersRuntime;

import type * as WBrowser from "@fungi.computer/oyster/browser";
export type WBrowserSurface = typeof WBrowser;

import type * as WBrowserBoot from "@fungi.computer/oyster/browser/boot";
export type WBrowserBootSurface = typeof WBrowserBoot;

import type * as WBootGate from "@fungi.computer/oyster/boot-gate";
export type WBootGateSurface = typeof WBootGate;

import type * as WBootCapability from "@fungi.computer/oyster/boot-capability";
export type WBootCapabilitySurface = typeof WBootCapability;

import type * as WBootCapabilityRoute from "@fungi.computer/oyster/boot-capability/route";
export type WBootCapabilityRouteSurface = typeof WBootCapabilityRoute;

import type * as WInvocation from "@fungi.computer/oyster/invocation";
export type WInvocationSurface = typeof WInvocation;

import type * as WGit from "@fungi.computer/oyster/git";
export type WGitSurface = typeof WGit;

import type * as WWorkflows from "@fungi.computer/oyster/workflows";
export type WWorkflowsSurface = typeof WWorkflows;

import type * as WAgents from "@fungi.computer/oyster/agents";
export type WAgentsSurface = typeof WAgents;

import type * as WKeys from "@fungi.computer/oyster/keys";
export type WKeysSurface = typeof WKeys;

import type * as WEventRecipients from "@fungi.computer/oyster/event-recipients";
export type WEventRecipientsSurface = typeof WEventRecipients;

import type * as WBuildContract from "@fungi.computer/oyster/build-contract";
export type WBuildContractSurface = typeof WBuildContract;

import type * as WBuildEgress from "@fungi.computer/oyster/build-egress";
export type WBuildEgressSurface = typeof WBuildEgress;

import type * as WBuildJobs from "@fungi.computer/oyster/build-jobs";
export type WBuildJobsSurface = typeof WBuildJobs;

import type * as WAppBuilds from "@fungi.computer/oyster/app-builds";
export type WAppBuildsSurface = typeof WAppBuilds;

import type * as WSource from "@fungi.computer/oyster/source";
export type WSourceSurface = typeof WSource;

import type * as WAppSources from "@fungi.computer/oyster/app-sources";
export type WAppSourcesSurface = typeof WAppSources;

import type * as WMedia from "@fungi.computer/oyster/media";
export type WMediaSurface = typeof WMedia;

// The catalog contract keeps the server SDK declarations private.
export const catalogProvider: (
  host: Parameters<typeof oysterMcpCatalogLoad>[0],
) => (principal: TenantPrincipal) => Promise<OysterMcpCatalogSnapshot> =
  oysterMcpCatalogLoad;
