import * as z from "zod";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import {
  appCapabilityIdSchema,
  appApiMethodNameSchema,
  type AppDeclaration,
  type HostActor,
} from "@fungi.computer/puffball/app";
import { hostActorSchema } from "@fungi.computer/puffball/app-method-runtime";
import {
  appIdSchema,
  releaseSchema,
  sha256DigestSchema,
} from "@fungi.computer/puffball/effect";
import { instanceIdSchema } from "../instance-id.js";
import type { OwnerState } from "../index.js";
import type { CapabilityDescriptor } from "../capability-descriptor.js";
import { permissionCatalog } from "./catalog.js";
import type { HostPrincipal } from "./gate.js";

/** Reuse the owning Effect codec at a JSON/storage boundary. */
export function ownerCodec<A, I>(schema: Schema.Codec<A, I>) {
  const decode = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
  });
  return z.unknown().transform((value, ctx) => {
    const result = decode(value);
    if (Result.isFailure(result)) {
      ctx.addIssue({ code: "custom", message: "Invalid owner-defined value" });
      return z.NEVER;
    }
    return result.success;
  });
}

/** Installation names cannot contain the tenant separator. */
export const installationIdSchema = z.lazy(() =>
  z.string().regex(/^[a-z](?:[a-z0-9]|-(?!-)){0,62}$/u),
);
/** A resource identity minted and resolved by the host, never by this module. */
export const resourceRefSchema = z.lazy(() =>
  z
    .strictObject({
      kind: z.string().min(1),
      id: z.string().min(1),
    })
    .readonly(),
);
export type ResourceRef = Exclude<
  ApprovedGrant["resources"],
  "tenant-scope"
>[number];
const operationsSchema = z.lazy(() =>
  z
    .array(z.string().min(1))
    .refine(
      (values) => new Set(values).size === values.length,
      "Operations must be unique",
    )
    .readonly(),
);
/**
 * Consent approves capabilities, with explicit operation and resource ceilings.
 * A Release adding a method that requires an already-approved capability needs
 * no new consent; a new capability does. Release selection intersects stored
 * operations instead of adding approvals. Each Worker call is still restricted
 * to that method's declared requires, never the App's complete capability set.
 * Only an approved install or change-grants command mints capabilityApproved.
 * Empty operation rows retain that consent; removing the capability revokes it.
 * route:app.methods rows record approval detail, not a method allowlist: narrowing
 * them in change-grants does not restrict methods using an approved capability.
 * Exact operation rows are enforced for capability routes and backend bindings.
 */
export const approvedGrantSchema = z
  .strictObject({
    capability: ownerCodec(appCapabilityIdSchema),
    capabilityApproved: z.literal(true),
    operations: operationsSchema,
    resources: z.union([
      z.literal("tenant-scope"),
      z.array(resourceRefSchema).readonly(),
    ]),
  })
  .readonly();
export type ApprovedGrant = Readonly<z.output<typeof approvedGrantSchema>>;
/** One grant per capability keeps operation/resource pairs unambiguous. */
const approvedGrantsSchema = z.lazy(() =>
  z
    .array(approvedGrantSchema)
    .refine(
      (grants) =>
        new Set(grants.map((grant) => grant.capability)).size === grants.length,
      "Capabilities must be unique",
    )
    .readonly(),
);
/** A bounded owner edit. Unnamed approvals are not part of the command. */
export const grantChangeSchema = z
  .strictObject({
    capability: ownerCodec(appCapabilityIdSchema),
    grant: approvedGrantSchema
      .unwrap()
      .omit({ capabilityApproved: true, capability: true })
      .readonly()
      .nullable(),
  })
  .readonly();
export type GrantChange = z.output<typeof grantChangeSchema>;
const grantChangesSchema = z
  .array(grantChangeSchema)
  .min(1)
  .refine(
    (changes) =>
      new Set(changes.map((change) => change.capability)).size ===
      changes.length,
    "Capabilities must be unique",
  )
  .readonly();
const versionSchema = z.lazy(() => z.number().int().positive());
/** An owner's approval of a fixed operation snapshot. */
const approvalSchema = z.lazy(() =>
  z
    .strictObject({
      by: hostActorSchema,
      at: z.number().int().nonnegative(),
      authorityVersion: versionSchema,
    })
    .readonly(),
);
/** The owner and version that approved a fixed operation snapshot. */
export type Approval = Readonly<{
  by: HostActor;
  at: number;
  authorityVersion: number;
}>;
/** The complete grant state. Hosts own storage and compare-and-set commits. */
export const appAuthoritySchema = z.strictObject({
  authorityVersion: versionSchema,
  declaredOperationsDigest: ownerCodec(sha256DigestSchema),
  approvedGrants: approvedGrantsSchema,
  approval: approvalSchema.nullable(),
});
export type AppAuthority = z.output<typeof appAuthoritySchema>;
export const grantCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("install") }),
  z.strictObject({
    kind: z.literal("change-grants"),
    changes: grantChangesSchema,
  }),
  z.strictObject({ kind: z.literal("select-release") }),
  z.strictObject({ kind: z.literal("delete") }),
]);
export type GrantCommand = z.output<typeof grantCommandSchema>;
export type GrantContext = Readonly<{
  principal: HostPrincipal;
  expectedVersion: number | null;
  declaration: AppDeclaration;
  declaredOperations: DeclaredOperations;
  now: number;
}>;
export type GrantRefusal = Readonly<{
  kind: "refused";
  code: "stale_authority" | "not_owner" | "not_declared" | "invalid_command";
}>;

/** One host-independent approval policy; selection only intersects existing grants. */
export function applyGrantCommand(
  current: AppAuthority | null,
  rawCommand: GrantCommand,
  context: GrantContext,
): Result.Result<AppAuthority, GrantRefusal> {
  const refuse = (code: GrantRefusal["code"]) =>
    Result.fail<GrantRefusal>({ kind: "refused", code });
  const parsed = grantCommandSchema.safeParse(rawCommand);
  if (!parsed.success) return refuse("invalid_command");
  const command = parsed.data;
  if (
    (current === null && command.kind !== "install") ||
    (current !== null && command.kind === "install")
  )
    return refuse("invalid_command");
  if (
    (context.expectedVersion ?? 0) !== (current?.authorityVersion ?? 0) ||
    (current !== null &&
      command.kind !== "select-release" &&
      current.declaredOperationsDigest !== context.declaredOperations.digest)
  )
    return refuse("stale_authority");
  if (
    context.principal.role === null ||
    context.principal.actor.kind === "visitor" ||
    (command.kind === "change-grants" && context.principal.role !== "owner")
  )
    return refuse("not_owner");
  const declared = (capability: ApprovedGrant["capability"]) =>
    context.declaredOperations.capabilities.find(
      (row) => row.capability === capability,
    )?.operations ?? [];
  const version = (current?.authorityVersion ?? 0) + 1;
  let grants = current?.approvedGrants ?? [];
  let approval = current?.approval ?? null;
  switch (command.kind) {
    case "install":
      grants =
        context.principal.role === "owner"
          ? context.declaration.capabilities
              .filter(
                (capability) =>
                  permissionCatalog[capability].consent === "install",
              )
              .map((capability): ApprovedGrant => ({
                capability,
                capabilityApproved: true,
                operations: declared(capability),
                resources: "tenant-scope",
              }))
          : [];
      break;
    case "change-grants": {
      for (const { capability, grant } of command.changes) {
        if (
          !context.declaration.capabilities.includes(capability) ||
          grant?.operations.some(
            (operation) => !declared(capability).includes(operation),
          )
        )
          return refuse("not_declared");
        const scope = permissionCatalog[capability].scope;
        if (
          grant !== null &&
          grant.resources !== "tenant-scope" &&
          (scope === null ||
            grant.resources.some((resource) => resource.kind !== scope))
        )
          return refuse("invalid_command");
      }
      const changed = new Map(
        command.changes.map((change) => [change.capability, change.grant]),
      );
      grants = [
        ...grants.filter((grant) => !changed.has(grant.capability)),
        ...command.changes.flatMap(({ capability, grant }): ApprovedGrant[] =>
          grant === null ||
          (grant.resources !== "tenant-scope" && grant.resources.length === 0)
            ? []
            : [{ capability, ...grant, capabilityApproved: true }],
        ),
      ];
      break;
    }
    case "select-release":
      grants = grants
        .filter((grant) =>
          context.declaration.capabilities.includes(grant.capability),
        )
        .map((grant) => ({
          ...grant,
          operations: grant.operations.filter((operation) =>
            declared(grant.capability).includes(operation),
          ),
        }));
      break;
    case "delete":
      grants = [];
      break;
  }
  if (grants.length === 0) approval = null;
  else if (command.kind === "install" || command.kind === "change-grants") {
    approval = {
      by: context.principal.actor,
      at: context.now,
      authorityVersion: version,
    };
  }
  return Result.succeed({
    authorityVersion: version,
    declaredOperationsDigest: context.declaredOperations.digest,
    approvedGrants: grants,
    approval,
  });
}
const anonymousMethodsSchema = z
  .array(
    z
      .strictObject({
        name: ownerCodec(appApiMethodNameSchema),
        digest: ownerCodec(sha256DigestSchema),
      })
      .readonly(),
  )
  .refine(
    (methods) =>
      methods.every((method, index) => {
        const previous = methods[index - 1];
        return previous === undefined || previous.name < method.name;
      }),
    "Anonymous method identities must have unique, sorted names",
  )
  .readonly();
/** Immutable operation facts derived from descriptor methods and the binding registry. */
export const declaredOperationsSchema = z.lazy(() =>
  z.strictObject({
    artifactDigest: ownerCodec(sha256DigestSchema),
    digest: ownerCodec(sha256DigestSchema),
    anonymousMethods: anonymousMethodsSchema,
    capabilities: z
      .array(
        z
          .strictObject({
            capability: ownerCodec(appCapabilityIdSchema),
            operations: operationsSchema,
          })
          .readonly(),
      )
      .readonly(),
  }),
);
export type DeclaredOperations = Readonly<
  z.output<typeof declaredOperationsSchema>
>;
/** Use the existing adapter's permission and methods; hosts author no operation lists. */
export type CapabilityOperationDescriptor = Pick<
  CapabilityDescriptor,
  "id" | "methods"
> &
  Readonly<{ permission: ApprovedGrant["capability"] }>;
/** Resolved immutable Release plus host-owned installation and approval state. */
export const installationSchema = z
  .strictObject({
    installationId: installationIdSchema,
    instanceId: ownerCodec(instanceIdSchema).nullable(),
    appId: ownerCodec(appIdSchema),
    release: ownerCodec(releaseSchema),
    releasePin: z.enum(["pinned", "floating"]),
    authority: appAuthoritySchema,
    status: z.enum(["enabled", "disabled", "deleted"]),
    visibility: z.enum(["private", "public"]),
    approvedAnonymousMethods: anonymousMethodsSchema,
    anonymousApproval: approvalSchema.nullable(),
  })
  .refine(
    (installation) => installation.appId === installation.release.appId,
    "Release must belong to the installation's App",
  )
  .refine((installation) => {
    const approval = installation.anonymousApproval;
    return approval === null
      ? installation.approvedAnonymousMethods.length === 0
      : installation.status !== "deleted" &&
          installation.approvedAnonymousMethods.length > 0 &&
          approval.by.kind === "member" &&
          approval.authorityVersion <= installation.authority.authorityVersion;
  }, "Anonymous authority requires a retained human approval receipt");
export type Installation = Readonly<z.output<typeof installationSchema>>;
const releaseFields = {
  release: ownerCodec(releaseSchema),
  releasePin: installationSchema.shape.releasePin,
};
/** Host commands; floating targets have already been resolved to immutable Releases. */
export const installationCommandSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("install"),
      ...releaseFields,
    }),
    z.strictObject({ kind: z.literal("select-release"), ...releaseFields }),
    z.strictObject({
      kind: z.literal("set-status"),
      status: installationSchema.shape.status,
    }),
    z.strictObject({
      kind: z.literal("set-visibility"),
      visibility: installationSchema.shape.visibility,
    }),
    z.strictObject({
      kind: z.literal("change-grants"),
      changes: grantChangesSchema,
    }),
    z.strictObject({
      kind: z.literal("approve-anonymous"),
      methods: anonymousMethodsSchema,
    }),
  ]),
);
export type InstallationCommand = z.output<typeof installationCommandSchema>;
/** Values captured by the host; identities and time are never generated by the reducer. */
export type InstallationContext = Readonly<{
  by: HostActor;
  role: "owner" | "member" | null;
  expectedVersion: number | null;
  declaration: AppDeclaration;
  declaredOperations: DeclaredOperations;
  now: number;
  identity: Pick<Installation, "installationId" | "instanceId">;
  /** Trusted interactive consent; never copied from a command or inferred from a key's owner role. */
  anonymousConsent?: Readonly<{ memberId: string }>;
}>;
/** Closed refusals: failed commands produce no installation update. */
export const installationRefusalSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("refused"),
    code: z.enum([
      "unavailable",
      "stale_authority",
      "not_owner",
      "not_declared",
      "release_app_mismatch",
      "invalid_command",
    ]),
  }),
);
export type InstallationRefusal = z.output<typeof installationRefusalSchema>;
export type InstallationUpdate = Readonly<{
  next: Installation;
  authorityChanged: boolean;
}>;
/** Read port for one host tenant; commits, receipts and revocation stay with that host. */
export type InstallationReader = Readonly<{
  /** Read every installation in the selected tenant. */
  list(): Promise<readonly Installation[]>;
  /** Read one installation in the same selected tenant. */
  get(id: string): Promise<Installation | null>;
}>;

/** Pure transition; hosts retain transactions, receipts, epochs and delivery. */
export function applyInstallationCommand(
  current: Installation | null,
  rawCommand: InstallationCommand,
  context: InstallationContext,
): Result.Result<InstallationUpdate, InstallationRefusal> {
  const refuse = (code: InstallationRefusal["code"]) =>
    Result.fail<InstallationRefusal>({ kind: "refused", code });
  const parsed = installationCommandSchema.safeParse(rawCommand);
  if (!parsed.success) return refuse("invalid_command");
  const command = parsed.data;
  if (context.role === null || current?.status === "deleted")
    return refuse("unavailable");
  if (current === null) {
    if (command.kind !== "install") return refuse("unavailable");
    if (context.expectedVersion !== null && context.expectedVersion !== 0)
      return refuse("stale_authority");
  } else if (
    command.kind === "install" ||
    context.expectedVersion !== current.authority.authorityVersion
  ) {
    return refuse("stale_authority");
  }
  if (command.kind === "change-grants" && context.role !== "owner")
    return refuse("not_owner");
  const anonymousConsent =
    context.by.kind === "member" &&
    context.anonymousConsent?.memberId === context.by.memberId;
  if (command.kind === "approve-anonymous") {
    const narrows = command.methods.every((method) =>
      current?.approvedAnonymousMethods.some(
        (approved) =>
          approved.name === method.name && approved.digest === method.digest,
      ),
    );
    if (context.role !== "owner" || (!narrows && !anonymousConsent))
      return refuse("not_owner");
  }
  const release =
    command.kind === "install" || command.kind === "select-release"
      ? command.release
      : current?.release;
  if (release === undefined) return refuse("unavailable");
  if (current !== null && release.appId !== current.appId)
    return refuse("release_app_mismatch");
  if (
    context.declaredOperations.artifactDigest !==
      release.artifact.artifactDigest ||
    (current !== null &&
      command.kind !== "select-release" &&
      context.declaredOperations.digest !==
        current.authority.declaredOperationsDigest)
  )
    return refuse("stale_authority");
  const version = (current?.authority.authorityVersion ?? 0) + 1;
  const grantCommand: GrantCommand | null =
    command.kind === "install" || command.kind === "select-release"
      ? { kind: command.kind }
      : command.kind === "change-grants"
        ? command
        : command.kind === "set-status" && command.status === "deleted"
          ? { kind: "delete" }
          : null;
  const authority =
    grantCommand === null
      ? current === null
        ? Result.fail<GrantRefusal>({
            kind: "refused",
            code: "invalid_command",
          })
        : Result.succeed<AppAuthority>({
            authorityVersion: version,
            declaredOperationsDigest:
              current.authority.declaredOperationsDigest,
            approvedGrants: current.authority.approvedGrants,
            approval: current.authority.approval,
          })
      : applyGrantCommand(current?.authority ?? null, grantCommand, {
          principal: { actor: context.by, role: context.role },
          expectedVersion: context.expectedVersion,
          declaration: context.declaration,
          declaredOperations: context.declaredOperations,
          now: context.now,
        });
  if (Result.isFailure(authority)) return refuse(authority.failure.code);
  let anonymousMethods = current?.approvedAnonymousMethods ?? [];
  let anonymousApproval = current?.anonymousApproval ?? null;
  if (command.kind === "approve-anonymous") {
    if (
      command.methods.some(
        (method) =>
          !context.declaredOperations.anonymousMethods.some(
            (declared) =>
              declared.name === method.name &&
              declared.digest === method.digest,
          ),
      )
    )
      return refuse("not_declared");
    anonymousMethods = command.methods;
    if (command.methods.length === 0) anonymousApproval = null;
    else if (anonymousConsent)
      anonymousApproval = {
        by: context.by,
        at: context.now,
        authorityVersion: version,
      };
  }
  if (command.kind === "select-release") {
    anonymousMethods = anonymousMethods.filter((method) =>
      context.declaredOperations.anonymousMethods.some(
        (declared) =>
          declared.name === method.name && declared.digest === method.digest,
      ),
    );
    if (anonymousMethods.length === 0) anonymousApproval = null;
  }
  if (command.kind === "set-status" && command.status === "deleted") {
    anonymousMethods = [];
    anonymousApproval = null;
  }
  const next = installationSchema.safeParse({
    installationId: current?.installationId ?? context.identity.installationId,
    instanceId:
      current === null ? context.identity.instanceId : current.instanceId,
    appId: release.appId,
    release,
    releasePin:
      command.kind === "install" || command.kind === "select-release"
        ? command.releasePin
        : current?.releasePin,
    status:
      command.kind === "set-status"
        ? command.status
        : (current?.status ?? "enabled"),
    visibility:
      command.kind === "set-visibility"
        ? command.visibility
        : (current?.visibility ?? "private"),
    authority: authority.success,
    approvedAnonymousMethods: anonymousMethods,
    anonymousApproval,
  });
  return next.success
    ? Result.succeed({ next: next.data, authorityChanged: true })
    : refuse("invalid_command");
}

/** Only the committed installation may activate this exact owner selection. */
export function isCommittedInstallation(
  current: Installation | null,
  state: OwnerState,
  release: Installation["release"],
): boolean {
  return (
    current !== null &&
    state.owner.kind === "installation" &&
    current.installationId === state.owner.id &&
    current.instanceId === state.instanceId &&
    current.appId === state.appId &&
    current.authority.authorityVersion === state.authorityVersion &&
    current.status === state.status &&
    current.release.releaseId === state.releaseId &&
    release.releaseId === state.releaseId &&
    release.appId === state.appId &&
    current.release.artifact.artifactDigest === release.artifact.artifactDigest
  );
}
