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
import { instanceIdSchema } from "../index.js";
import type { CapabilityDescriptor } from "../capability-descriptor.js";

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
export const installationIdSchema = z
  .string()
  .regex(/^[a-z](?:[a-z0-9]|-(?!-)){0,62}$/u);
/** A resource identity minted and resolved by the host, never by this module. */
const resourceRefSchema = z
  .strictObject({
    kind: z.string().min(1),
    id: z.string().min(1),
  })
  .readonly();
export type ResourceRef = Exclude<
  ApprovedGrant["resources"],
  "tenant-scope"
>[number];
const operationsSchema = z
  .array(z.string().min(1))
  .refine(
    (values) => new Set(values).size === values.length,
    "Operations must be unique",
  )
  .readonly();
/**
 * Consent approves capabilities, with explicit operation and resource ceilings.
 * A Release adding a method that requires an already-approved capability needs
 * no new consent; a new capability does. Release selection intersects stored
 * operations instead of adding approvals. Each Worker call is still restricted
 * to that method's declared requires, never the App's complete capability set.
 * Only an approved install or set-grants command mints capabilityApproved.
 * Empty operation rows retain that consent; removing the capability revokes it.
 * route:app.methods rows record approval detail, not a method allowlist: narrowing
 * them in set-grants does not restrict methods using an approved capability.
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
const approvedGrantsSchema = z
  .array(approvedGrantSchema)
  .refine(
    (grants) =>
      new Set(grants.map((grant) => grant.capability)).size === grants.length,
    "Capabilities must be unique",
  )
  .readonly();
/** Shorthand is accepted only on a command and expanded at approval time. */
const grantRequestSchema = z.union([
  z.literal("none"),
  z.literal("declared"),
  z
    .array(
      approvedGrantSchema
        .unwrap()
        .omit({ capabilityApproved: true })
        .readonly(),
    )
    .refine(
      (grants) =>
        new Set(grants.map((grant) => grant.capability)).size === grants.length,
      "Capabilities must be unique",
    )
    .readonly(),
]);
export type GrantRequest = Extract<
  InstallationCommand,
  { kind: "install" }
>["grants"];
const versionSchema = z.number().int().positive();
/** An owner's approval of a fixed operation snapshot. */
const approvalSchema = z
  .strictObject({
    by: hostActorSchema,
    at: z.number().int().nonnegative(),
    authorityVersion: versionSchema,
  })
  .readonly();
export type Approval = NonNullable<Installation["approval"]>;
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
export const declaredOperationsSchema = z.strictObject({
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
});
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
    authorityVersion: versionSchema,
    status: z.enum(["enabled", "disabled", "deleted"]),
    visibility: z.enum(["private", "public"]),
    declaredOperationsDigest: ownerCodec(sha256DigestSchema),
    approvedGrants: approvedGrantsSchema,
    approval: approvalSchema.nullable(),
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
          approval.authorityVersion <= installation.authorityVersion;
  }, "Anonymous authority requires a retained human approval receipt");
export type Installation = Readonly<z.output<typeof installationSchema>>;
const releaseFields = {
  release: ownerCodec(releaseSchema),
  releasePin: installationSchema.shape.releasePin,
};
/** Host commands; floating targets have already been resolved to immutable Releases. */
export const installationCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("install"),
    ...releaseFields,
    grants: grantRequestSchema,
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
  z.strictObject({ kind: z.literal("set-grants"), grants: grantRequestSchema }),
  z.strictObject({
    kind: z.literal("approve-anonymous"),
    methods: anonymousMethodsSchema,
  }),
]);
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
export const installationRefusalSchema = z.strictObject({
  kind: z.literal("refused"),
  code: z.enum([
    "unavailable",
    "stale_authority",
    "not_owner",
    "not_declared",
    "release_app_mismatch",
    "invalid_command",
  ]),
});
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
    context.expectedVersion !== current.authorityVersion
  ) {
    return refuse("stale_authority");
  }
  if (
    (command.kind === "set-grants" ||
      (command.kind === "install" && command.grants !== "none")) &&
    context.role !== "owner"
  )
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
      context.declaredOperations.digest !== current.declaredOperationsDigest)
  )
    return refuse("stale_authority");
  const declared = (capability: ApprovedGrant["capability"]) =>
    context.declaration.capabilities.includes(capability)
      ? (context.declaredOperations.capabilities.find(
          (row) => row.capability === capability,
        )?.operations ?? [])
      : [];
  const version = (current?.authorityVersion ?? 0) + 1;
  let grants = current?.approvedGrants ?? [];
  let approval = current?.approval ?? null;
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
  if (command.kind === "install" || command.kind === "set-grants") {
    grants =
      command.grants === "none"
        ? []
        : command.grants === "declared"
          ? context.declaredOperations.capabilities
              .filter((row) =>
                context.declaration.capabilities.includes(row.capability),
              )
              .map((row) => ({
                ...row,
                capabilityApproved: true as const,
                resources: "tenant-scope" as const,
              }))
          : command.grants.map((grant) => ({
              ...grant,
              capabilityApproved: true as const,
            }));
    if (
      grants.some(
        (grant) =>
          !context.declaration.capabilities.includes(grant.capability) ||
          grant.operations.some(
            (operation) => !declared(grant.capability).includes(operation),
          ),
      )
    )
      return refuse("not_declared");
    approval =
      command.grants === "none"
        ? null
        : { by: context.by, at: context.now, authorityVersion: version };
  }
  if (command.kind === "select-release") {
    anonymousMethods = anonymousMethods.filter((method) =>
      context.declaredOperations.anonymousMethods.some(
        (declared) =>
          declared.name === method.name && declared.digest === method.digest,
      ),
    );
    if (anonymousMethods.length === 0) anonymousApproval = null;
    grants = grants
      .map((grant) => ({
        ...grant,
        operations: grant.operations.filter((operation) =>
          declared(grant.capability).includes(operation),
        ),
      }))
      .filter((grant) =>
        context.declaration.capabilities.includes(grant.capability),
      );
  }
  if (command.kind === "set-status" && command.status === "deleted") {
    grants = [];
    approval = null;
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
    authorityVersion: version,
    status:
      command.kind === "set-status"
        ? command.status
        : (current?.status ?? "enabled"),
    visibility:
      command.kind === "set-visibility"
        ? command.visibility
        : (current?.visibility ?? "private"),
    declaredOperationsDigest: context.declaredOperations.digest,
    approvedGrants: grants,
    approval,
    approvedAnonymousMethods: anonymousMethods,
    anonymousApproval,
  });
  return next.success
    ? Result.succeed({ next: next.data, authorityChanged: true })
    : refuse("invalid_command");
}
