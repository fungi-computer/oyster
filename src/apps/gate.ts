import { AppInstanceError } from "../index.js";
import { appMethodSchemas } from "@fungi.computer/forage";
import { bindingOperationKey } from "./operations.js";
import * as z from "zod";
import * as Schema from "effect/Schema";
import {
  appBackendBindingKinds,
  appBackendBindingOperation,
  scopeOperationToMethod,
  appApiMethodNameSchema,
  appBackendBindingsSchema,
  appCapabilityIdSchema,
  type AppApi,
  type AppDeclaration,
  type HostActor,
} from "@fungi.computer/puffball/app";
import { appToolAccessSchema, type AppToolAccess } from "./tools.js";
import {
  ownerCodec,
  resourceRefSchema,
  type ResourceRef,
  type DeclaredOperations,
  type Installation,
  type ApprovedGrant,
} from "./installation.js";

/** Attested by the host, never authenticated by decoding request JSON. */
export type HostPrincipal = Readonly<{
  actor: HostActor | Readonly<{ kind: "visitor" }>;
  role: "owner" | "member" | null;
}>;
const bindingNameSchema = ownerCodec(
  Schema.Literals(
    Object.values(appBackendBindingKinds).map((kind) => kind.name),
  ),
);
/** Requests select existing SDK methods, opaque backend calls and derived operation identities. */
export const gateRequestSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("method"),
      name: z.string(),
      input: z.unknown(),
      via: z.enum(["ui", "agent", "mcp", "workflow"]),
      resource: resourceRefSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal("capability"),
      capability: ownerCodec(appCapabilityIdSchema),
      operation: z.string().min(1).optional(),
      resource: z.union([resourceRefSchema, z.literal("any")]),
    }),
    z.strictObject({
      kind: z.literal("capability-route"),
      capability: ownerCodec(appCapabilityIdSchema),
      operation: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal("binding"),
      binding: bindingNameSchema,
      operation: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal("list-tools") }),
    z.strictObject({ kind: z.literal("backend") }),
  ]),
);
/** One decoded method, route, binding or catalog admission request. */
export type GateRequest = z.output<typeof gateRequestSchema>;
/** Immutable values the host already read; resource/grantor freshness remains host-owned. */
export type GateFacts = Readonly<{
  principal: HostPrincipal;
  installation: Readonly<
    Pick<Installation, "status" | "visibility" | "instanceId" | "authority"> & {
      artifactDigest: string;
    }
  >;
  declaration: AppDeclaration;
  declaredOperations: DeclaredOperations;
  api: AppApi | null;
  access: AppToolAccess | null;
  pins?: Readonly<{ authorityVersion: number; artifactDigest: string }>;
}>;
/** Binding grants have the exact S2 InvocationFacts shape and its maintained registry grammar. */
export const invocationGrantsSchema = z.lazy(() =>
  z
    .array(
      z.strictObject({
        binding: bindingNameSchema,
        operations: z.array(z.string().min(1)).readonly(),
      }),
    )
    .refine(
      (grants) =>
        Schema.is(appBackendBindingsSchema)(
          grants.map((grant) => ({
            name: grant.binding,
            operations: grant.operations,
          })),
        ),
      "Invalid declared binding operations",
    )
    .readonly(),
);
/** The explicit binding ceiling passed to an invocation frame. */
export type InvocationGrants = z.output<typeof invocationGrantsSchema>;
/** A declared method from the canonical Puffball API grammar. */
export type AppMethodDeclaration = AppApi["methods"][string];
/** Ordered, closed refusal vocabulary; external methods always require approval. */
export const gateRefusalSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("refused"),
    code: z.enum([
      "unavailable",
      "stale_authority",
      "not_declared",
      "not_approved",
      "level_too_low",
      "approval_required",
      "requires_not_granted",
      "invalid_input",
      "visitor_read_only",
    ]),
  }),
);
/** Either an admitted scoped ceiling or one closed refusal code. */
export type GateDecision =
  | Readonly<{
      kind: "admitted";
      grants: InvocationGrants;
      method?: AppMethodDeclaration;
    }>
  | z.output<typeof gateRefusalSchema>;

/** Intersect stored approvals with the current verified Release without widening resource selectors. */
export function grantsFor(
  installation: Pick<
    GateFacts["installation"],
    "status" | "authority" | "artifactDigest"
  >,
  declaration: AppDeclaration,
  snapshot: DeclaredOperations,
  capability: ApprovedGrant["capability"],
  resource: ResourceRef | "any" = "any",
): ApprovedGrant | null {
  if (
    installation.status !== "enabled" ||
    snapshot.digest !== installation.authority.declaredOperationsDigest ||
    snapshot.artifactDigest !== installation.artifactDigest ||
    !declaration.capabilities.includes(capability)
  )
    return null;
  const approved = installation.authority.approvedGrants.find(
    (grant) => grant.capability === capability,
  );
  const declared =
    snapshot.capabilities.find((row) => row.capability === capability)
      ?.operations ?? [];
  if (
    !approved?.capabilityApproved ||
    (approved.resources !== "tenant-scope" &&
      (resource === "any"
        ? approved.resources.length === 0
        : !approved.resources.some(
            (ref) => ref.kind === resource.kind && ref.id === resource.id,
          )))
  )
    return null;
  const operations = approved.operations.filter((operation) =>
    declared.includes(operation),
  );
  return { ...approved, operations };
}

/** Approved binding operations from an already verified declaration. Hosts still pin
 * the selection/version/artifact and compare running frame grants as a subset. */
export function approvedBindingGrants(
  installation: Pick<GateFacts["installation"], "status" | "authority">,
  declaration: AppDeclaration,
): InvocationGrants {
  if (installation.status !== "enabled") return [];
  const bindings: InvocationGrants[number][] = [];
  for (const binding of declaration.backend?.bindings ?? []) {
    const operations = binding.operations.filter((name) => {
      const operation = appBackendBindingOperation(binding.name, name);
      return (
        operation !== undefined &&
        operation.requires.length > 0 &&
        operation.requires.every((capability) => {
          const approved = installation.authority.approvedGrants.find(
            (grant) => grant.capability === capability,
          );
          return (
            declaration.capabilities.includes(capability) &&
            approved?.capabilityApproved &&
            (approved.resources === "tenant-scope" ||
              approved.resources.length > 0) &&
            approved.operations.includes(
              bindingOperationKey(binding.name, name),
            )
          );
        })
      );
    });
    if (operations.length > 0)
      bindings.push({ binding: binding.name, operations });
  }
  return bindings;
}

/** Narrow captured binding operations to the method's verified requirements and effect.
 * The captured set is the ceiling; this never adds an operation or resource authority. */
export function scopedBindings(
  captured: InvocationGrants,
  method?: AppMethodDeclaration,
  ceiling: "read" | "write" = "write",
): InvocationGrants {
  return captured.flatMap((binding) => {
    const operations = binding.operations.filter((name) => {
      const operation = appBackendBindingOperation(binding.binding, name);
      if (operation === undefined)
        throw new AppInstanceError("invalid_invocation_facts");
      return scopeOperationToMethod(operation, method, ceiling);
    });
    return operations.length > 0
      ? [{ binding: binding.binding, operations }]
      : [];
  });
}

/** Principal ceiling for invocation and metadata capture. Captures must pass this
 * to scopedBindings; its default write ceiling does not encode caller access. */
export function appInvocationCeiling(
  facts: Pick<GateFacts, "principal" | "access">,
): "read" | "write" {
  return facts.access?.level === "read" ||
    facts.principal.actor.kind === "visitor"
    ? "read"
    : "write";
}

function admittedBindings(
  facts: GateFacts,
  method?: AppMethodDeclaration,
): InvocationGrants {
  return scopedBindings(
    approvedBindingGrants(facts.installation, facts.declaration),
    method,
    appInvocationCeiling(facts),
  );
}

/** Permission metadata only: this is neither an invocation grant nor input admission. */
export type AppMethodMetadataDecision =
  | Readonly<{ kind: "admitted"; method: AppMethodDeclaration }>
  | z.output<typeof gateRefusalSchema>;

const refusal = (
  code: z.output<typeof gateRefusalSchema>["code"],
): z.output<typeof gateRefusalSchema> => ({ kind: "refused", code });

function admissionRefusal(
  facts: GateFacts,
): z.output<typeof gateRefusalSchema> | null {
  const { installation, principal } = facts;
  const visitor = principal.actor.kind === "visitor";
  if (
    installation.status !== "enabled" ||
    (visitor && installation.visibility !== "public")
  )
    return refusal("unavailable");
  if (
    facts.declaredOperations.digest !==
      installation.authority.declaredOperationsDigest ||
    facts.declaredOperations.artifactDigest !== installation.artifactDigest ||
    (facts.pins !== undefined &&
      (facts.pins.authorityVersion !==
        installation.authority.authorityVersion ||
        facts.pins.artifactDigest !== installation.artifactDigest))
  )
    return refusal("stale_authority");
  if (
    (principal.actor.kind === "agent" || principal.actor.kind === "team-key") &&
    !Schema.is(appToolAccessSchema)(facts.access)
  )
    return refusal("not_approved");
  return null;
}

function methodMetadata(
  facts: GateFacts,
  name: string,
): AppMethodMetadataDecision {
  const { installation, principal } = facts;
  const visitor = principal.actor.kind === "visitor";
  if (installation.instanceId === null) return refusal("unavailable");
  if (
    !Schema.is(appApiMethodNameSchema)(name) ||
    facts.api === null ||
    !Object.hasOwn(facts.api.methods, name)
  )
    return refusal("not_declared");
  const method = facts.api.methods[name];
  if (method === undefined) return refusal("not_declared");
  if (method.effect === "external") return refusal("approval_required");
  if (visitor && method.effect !== "read") return refusal("visitor_read_only");
  if (method.effect === "write" && facts.access?.level === "read")
    return refusal("level_too_low");
  return { kind: "admitted", method };
}

function methodGrantRefusal(
  facts: GateFacts,
  method: AppMethodDeclaration,
  resource: ResourceRef | "any" = "any",
): z.output<typeof gateRefusalSchema> | null {
  const { installation } = facts;
  if (
    method.requires.some(
      (capability) =>
        grantsFor(
          installation,
          facts.declaration,
          facts.declaredOperations,
          capability,
          resource,
        ) === null,
    )
  )
    return refusal("requires_not_granted");
  return null;
}

/** Check a verified method's Release, principal, effect and real capability consent.
 * Captures have no mapped runtime input yet. This result cannot authorize execution:
 * dispatch must still use admits, including its ordinary input validation.
 * Input schemas are not compiled here; execution may still refuse invalid_input.
 * Project captured bindings with appInvocationCeiling(facts).
 */
export function admitMethodMetadata(
  facts: GateFacts,
  name: string,
): AppMethodMetadataDecision {
  const denied = admissionRefusal(facts);
  if (denied !== null) return denied;
  const metadata = methodMetadata(facts, name);
  if (metadata.kind === "refused") return metadata;
  return methodGrantRefusal(facts, metadata.method) ?? metadata;
}

/** Ordered admission only. Host freshness/resource admission and effect execution stay outside this pure gate. */
export function admits(
  facts: GateFacts,
  rawRequest: GateRequest,
): GateDecision {
  const parsed = gateRequestSchema.safeParse(rawRequest);
  if (!parsed.success) return refusal("invalid_input");
  const request = parsed.data;
  const { installation, principal } = facts;
  const visitor = principal.actor.kind === "visitor";
  const denied = admissionRefusal(facts);
  if (denied !== null) return denied;
  switch (request.kind) {
    case "backend":
      // Opaque App requests have no verified method selector; they require write authority.
      if (visitor) return refusal("visitor_read_only");
      if (installation.instanceId === null) return refusal("unavailable");
      if (facts.access?.level === "read") return refusal("level_too_low");
      return { kind: "admitted", grants: admittedBindings(facts) };
    case "method": {
      const metadata = methodMetadata(facts, request.name);
      if (metadata.kind === "refused") return metadata;
      const { method } = metadata;
      // The maintained JSON-Schema compiler can reject unsupported declared schemas.
      // Return the typed input refusal; never leak compiler diagnostics or throw from admission.
      try {
        const input = appMethodSchemas({ methods: { [request.name]: method } })[
          request.name
        ]?.input;
        if (!input?.safeParse(request.input).success)
          return refusal("invalid_input");
        if (
          new TextEncoder().encode(JSON.stringify(request.input)).byteLength >
          64 * 1024
        )
          return refusal("invalid_input");
      } catch {
        return refusal("invalid_input");
      }
      const grantDenied = methodGrantRefusal(facts, method, request.resource);
      if (grantDenied !== null) return grantDenied;
      return {
        kind: "admitted",
        grants: admittedBindings(facts, method),
        method,
      };
    }
    case "capability": {
      if (visitor) return refusal("visitor_read_only");
      if (
        !facts.declaration.capabilities.includes(request.capability) ||
        (request.operation !== undefined &&
          facts.declaredOperations.capabilities
            .find((row) => row.capability === request.capability)
            ?.operations.includes(request.operation) !== true)
      )
        return refusal("not_declared");
      const grant = grantsFor(
        installation,
        facts.declaration,
        facts.declaredOperations,
        request.capability,
        request.resource,
      );
      if (
        grant === null ||
        (request.operation !== undefined &&
          !grant.operations.includes(request.operation))
      )
        return refusal("not_approved");
      return { kind: "admitted", grants: [] };
    }
    case "capability-route": {
      if (visitor) return refusal("visitor_read_only");
      if (
        !request.operation.startsWith("route:") ||
        !facts.declaration.capabilities.includes(request.capability) ||
        facts.declaredOperations.capabilities
          .find((row) => row.capability === request.capability)
          ?.operations.includes(request.operation) !== true
      )
        return refusal("not_declared");
      if (
        grantsFor(
          installation,
          facts.declaration,
          facts.declaredOperations,
          request.capability,
        )?.operations.includes(request.operation) !== true
      )
        return refusal("not_approved");
      return { kind: "admitted", grants: [] };
    }
    case "binding": {
      if (visitor) return refusal("visitor_read_only");
      if (installation.instanceId === null) return refusal("unavailable");
      const operation = appBackendBindingOperation(
        request.binding,
        request.operation,
      );
      if (
        operation === undefined ||
        facts.declaration.backend?.bindings
          .find((binding) => binding.name === request.binding)
          ?.operations.includes(request.operation) !== true ||
        !operation.requires.every((capability) =>
          facts.declaration.capabilities.includes(capability),
        )
      )
        return refusal("not_declared");
      if (operation.effect === "write" && facts.access?.level === "read")
        return refusal("level_too_low");
      if (
        operation.requires.length < 1 ||
        !operation.requires.every(
          (capability) =>
            grantsFor(
              installation,
              facts.declaration,
              facts.declaredOperations,
              capability,
            )?.operations.includes(
              bindingOperationKey(request.binding, request.operation),
            ) === true,
        )
      )
        return refusal("not_approved");
      return {
        kind: "admitted",
        grants: [{ binding: request.binding, operations: [request.operation] }],
      };
    }
    case "list-tools":
      return facts.api === null || installation.instanceId === null
        ? refusal("unavailable")
        : { kind: "admitted", grants: admittedBindings(facts) };
  }
}
