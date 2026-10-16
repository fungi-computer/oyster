import * as Schema from "effect/Schema";
import {
  appDeclaredCommandSchema,
  appCallsSchema,
} from "@fungi.computer/puffball/app";
import {
  appDeclaredGillSchema,
  appGillParamsSchema,
} from "@fungi.computer/gills";
import * as z from "zod";

/** An App address selects a host default or a specific installation. */
export const appAddressSchema = z.lazy(() =>
  z.union([
    z.strictObject({
      kind: z.literal("default"),
      appId: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal("installation"),
      installationId: z.string().min(1),
    }),
  ]),
);

/** Host-reported progress of applying a revised App authority version. */
export const appAuthorityEnforcementSchema = z.lazy(() =>
  z.strictObject({
    requestId: z.string().min(1),
    address: appAddressSchema,
    authorityVersion: z.number().int().positive(),
    state: z.enum(["unaffected", "pending", "applied", "expired"]),
    outstanding: z.number().int().nonnegative(),
  }),
);

/** Decoded address of a default App or an installation. */
export type AppAddress = z.output<typeof appAddressSchema>;
/** Stable identity of one App address across directory and settings views. */
export const addressKey = (address: AppAddress) =>
  address.kind === "default"
    ? `default:${address.appId}`
    : `installation:${address.installationId}`;
/** A host-reported authority change and its remaining work. */
export type AppAuthorityEnforcement = z.output<
  typeof appAuthorityEnforcementSchema
>;

/**
 * A Release-declared Gill carried by the host's App directory. The named
 * mapped type keeps consumer declarations attached to this public contract.
 */
export type AppDirectoryGill = {
  [
    Field in keyof Schema.Schema.Type<typeof appDeclaredGillSchema>
  ]: Schema.Schema.Type<typeof appDeclaredGillSchema>[Field];
};

/** Reusable App metadata supplied by an embedding host; it conveys no permissions. */
export const appDirectoryEntrySchema = z.strictObject({
  address: appAddressSchema,
  installationId: z.string().min(1).nullable(),
  surfaceId: z.string().min(1),
  appId: z.string().min(1),
  displayName: z.string().trim().min(1).optional(),
  icon: z.string().min(1).nullable().optional(),
  releaseId: z.string().min(1).nullable(),
  authorityVersion: z.number().int().nonnegative(),
  enforcement: appAuthorityEnforcementSchema.nullable(),
  handlers: z.array(z.literal("file.open")),
  roles: z.array(z.string().min(1)),
  /** Capabilities the Release declares: the ceiling for host consent, never a grant. */
  declaredCapabilities: z.array(z.string().min(1)),
  calls: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(appCallsSchema)(value))
    .optional(),
  commands: z
    .array(z.unknown())
    .transform((values) =>
      values.map((value) =>
        Schema.decodeUnknownSync(appDeclaredCommandSchema)(value),
      ),
    ),
  gills: z.array(z.unknown()).transform((values): AppDirectoryGill[] =>
    values.map((value) =>
      Schema.decodeUnknownSync(appDeclaredGillSchema, {
        onExcessProperty: "error",
      })(value),
    ),
  ),
  availability: z.enum(["available", "unavailable"]),
  surface: z
    .strictObject({
      stableRoute: z.string().min(1),
    })
    .nullable(),
  surfacePath: z.string().startsWith("/"),
});
/** An App directory row before host-specific permissions are attached. */
export type AppDirectoryEntry = z.output<typeof appDirectoryEntrySchema>;
/** A host-resolved role selection; a surface address is not launch authority. */
export const appRoleSelectionSchema = z.strictObject({
  surfaceId: z.string().min(1).nullable(),
  chosen: z.boolean(),
});
const appComputerOperationSchema = z.enum([
  "computer.list",
  "computer.readFile",
  "computer.writeFile",
  "computer.execute",
]);

const selectedComputerPermissionSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("selected-computers"),
    computers: z.array(
      z.strictObject({
        computerId: z.string().min(1),
        operations: z.array(appComputerOperationSchema),
      }),
    ),
  }),
);
const allTeamComputersPermissionSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("all-team-computers"),
    operations: z.array(appComputerOperationSchema),
  }),
);
/** App Computer permissions limited to selected Computers or the Team's Computers. */
export const appComputerPermissionSchema = z.discriminatedUnion("kind", [
  selectedComputerPermissionSchema,
  allTeamComputersPermissionSchema,
]);
/** One operation an App may request for a Computer. */
export type AppComputerOperation = Extract<
  z.output<typeof appComputerPermissionSchema>,
  { kind: "all-team-computers" }
>["operations"][number];
/** Decoded Computer permission scope attached to an App directory entry. */
export type AppComputerPermission = z.output<
  typeof appComputerPermissionSchema
>;

const agentDirectoryOperationSchema = z.enum(["agent.list"]);
const agentSessionOperationSchema = z.enum([
  "agent.read",
  "agent.send",
  "agent.manage",
]);
/** Agent directory and session operations an App may request from its host. */
export const appAgentPermissionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("all-team-agents"),
    directoryOperations: z.array(agentDirectoryOperationSchema),
    sessionOperations: z.array(agentSessionOperationSchema),
  }),
  z.strictObject({
    kind: z.literal("selected-agents"),
    directoryOperations: z.array(agentDirectoryOperationSchema),
    agents: z.array(
      z.strictObject({
        agentId: z.string().min(1).max(256),
        sessionOperations: z.array(agentSessionOperationSchema),
      }),
    ),
  }),
]);
/** Decoded Agent permission scope attached to an App directory entry. */
export type AppAgentPermission = z.output<typeof appAgentPermissionSchema>;

/** Whether an App may use language-model and media generation services. */
export const appGenerationPermissionsSchema = z.strictObject({
  llm: z.boolean(),
  media: z.boolean(),
});
/** Decoded generation permissions attached to an App directory entry. */
export type AppGenerationPermissions = z.output<
  typeof appGenerationPermissionsSchema
>;

/** Whether an App may browse, buy, or install free marketplace entries. */
export const appMarketplacePermissionsSchema = z.strictObject({
  browse: z.boolean(),
  purchase: z.boolean(),
  installFree: z.boolean(),
});
/** Decoded marketplace permissions attached to an App directory entry. */
export type AppMarketplacePermissions = z.output<
  typeof appMarketplacePermissionsSchema
>;

/**
 * A host's Team App directory with its permission projection, parsed strictly
 * by every consumer: an unknown field is a contract change both sides make.
 */
export const appDirectoryResponseSchema = z.lazy(() =>
  z.strictObject({
    actorIsTeamOwner: z.boolean(),
    needsUpdate: z
      .array(
        z.strictObject({
          installationId: z.string().min(1).nullable(),
          appId: z.string().min(1).nullable(),
          displayName: z.string().min(1),
        }),
      )
      .optional(),
    apps: z.array(
      appDirectoryEntrySchema.extend({
        override: z
          .strictObject({
            appId: z.string().min(1).optional(),
            releaseId: z.string().min(1),
            surfaceRoute: z.string().min(1).nullable(),
          })
          .nullable(),
        grants: z.array(
          z.strictObject({
            operation: z.string().min(1),
            resourceId: z.string().min(1),
          }),
        ),
        computerPermission: appComputerPermissionSchema.nullable().optional(),
        generationPermissions: appGenerationPermissionsSchema,
        marketplacePermissions: appMarketplacePermissionsSchema,
        agentPermission: appAgentPermissionSchema,
      }),
    ),
    /** The Team's effective App per role, owned and resolved by the host. */
    roles: z.record(z.string().min(1), appRoleSelectionSchema),
  }),
);

/** The host-resolved Team App directory and its permission projections. */
export type AppDirectory = z.output<typeof appDirectoryResponseSchema>;

/** Desktop metadata is a method result, distinct from the full Release Gill declaration. */
const catalogGillParamsSchema = z.lazy(() =>
  z
    .array(
      z.strictObject({
        key: z.string().max(64),
        label: z.string().max(256),
        kind: z.enum(["computer", "repository", "branch"]),
        required: z.boolean(),
        options: z.string().max(256).optional(),
      }),
    )
    .max(4)
    // The wire shape is representable; Gill owns its domain refinements.
    .refine(
      Schema.is(appGillParamsSchema),
      "Invalid Gill placement parameters",
    ),
);
const catalogGillSchema = z.strictObject({
  id: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(256),
  params: catalogGillParamsSchema.optional(),
  desktop: z
    .strictObject({
      sizes: z
        .array(z.enum(["S", "M", "L"]))
        .min(1)
        .max(3)
        .refine(
          (sizes) => new Set(sizes).size === sizes.length,
          "Repeated Gill size",
        ),
    })
    .optional(),
});
/** Read-only catalog metadata for one App, without host-specific role policy. */
export const appCatalogEntrySchema = appDirectoryEntrySchema
  .pick({
    surfaceId: true,
    appId: true,
    displayName: true,
  })
  .extend({ gills: z.array(catalogGillSchema).max(16) });

/** Read-only desktop metadata; identities are surface addresses, never launch authority. */
export const appCatalogResponseSchema = z.lazy(() =>
  z.strictObject({
    apps: z.array(appCatalogEntrySchema).max(50),
    roles: z.strictObject({
      inbox: appRoleSelectionSchema.optional(),
    }),
  }),
);
/** Parsed metadata returned by the read-only APPS.catalog binding. */
export type AppCatalog = z.output<typeof appCatalogResponseSchema>;

/** Complete APPS.catalog reply, including broker admission failures. */
export const appCatalogBrokerResultSchema = z.lazy(() =>
  z.union([appCatalogResponseSchema, z.strictObject({ error: z.string() })]),
);
