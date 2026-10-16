import {
  WorkbenchHost,
  type WorkbenchHostOptions,
  type TeamWorkbenchHostHandle,
} from "@fungi.computer/oyster/shell/workbench";
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

declare const workbenchOptions: WorkbenchHostOptions;
const workbenchHost: TeamWorkbenchHostHandle = new WorkbenchHost(
  workbenchOptions,
);
void workbenchHost;

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
export const receipt: Instance = await Effect.runPromise(instance.apply(state));
export const staleCode: AppInstanceError["code"] = "stale_authority";

export const server: typeof createOyster = createOyster;
export const appMethods: (
  ...args: Parameters<typeof oysterAppMethods>
) => Promise<CapabilitySource & { readonly grants: Grants }> = oysterAppMethods;
export const provideFiles: (source: FileSource) => readonly OysterCapability[] =
  fileCapabilities;

import {
  createWindowManager,
  createAppSurfaceCommandHost,
} from "@fungi.computer/oyster/shell";
import { parseChord } from "@fungi.computer/oyster/shell/keys";
import { appDirectoryEntrySchema } from "@fungi.computer/oyster/shell/app-directory";
export const createShellWindows: typeof createWindowManager =
  createWindowManager;
export const createShellCommands: typeof createAppSurfaceCommandHost =
  createAppSurfaceCommandHost;
export const shellChord = parseChord("mod+k", false);
export const shellDirectory = appDirectoryEntrySchema;

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
