import * as z from "zod";
import type { AppPermissionRequest } from "@fungi.computer/agar";
import {
  type AppDeclaration,
  type AppCapabilityId,
} from "@fungi.computer/puffball/app";
import { permissionCatalog, type PermissionCatalogEntry } from "./catalog.js";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import type { SigilName } from "@fungi.computer/sigils";
import {
  appAuthoritySchema,
  declaredOperationsSchema,
  ownerCodec,
  type AppAuthority,
  type DeclaredOperations,
  type GrantCommand,
  grantCommandSchema,
  type GrantChange,
  type ResourceRef,
} from "./installation.js";

/** A host-provided resource identity and its display label. */
export type ResourceOption = {
  kind: string;
  id: string;
  label: string;
};
/** Includes newly declared operations and capabilities the owner has narrowed. */
export function pendingCapabilities(
  authority: Pick<AppAuthority, "approvedGrants">,
  declaration: Pick<AppDeclaration, "capabilities">,
  declaredOperations: DeclaredOperations,
): AppDeclaration["capabilities"] {
  return declaration.capabilities.filter((capability) => {
    if (permissionCatalog[capability].consent === "affordance") return false;
    const grant = authority.approvedGrants.find(
      (row) => row.capability === capability,
    );
    return (
      grant === undefined ||
      (grant.resources !== "tenant-scope" && grant.resources.length === 0) ||
      declaredOperations.capabilities
        .find((row) => row.capability === capability)
        ?.operations.some(
          (operation) => !grant.operations.includes(operation),
        ) === true
    );
  });
}

/** How an App's runtime permission request relates to the owner's stored grants. */
export type GrantRequestDecision =
  | Readonly<{ kind: "covered" }>
  | Readonly<{ kind: "customize" }>
  | Readonly<{
      kind: "refused";
      code: "not_declared" | "stale_authority" | "window_scope_unavailable";
    }>
  | Readonly<{
      kind: "ask";
      adds: readonly GrantChange[];
      command: Extract<GrantCommand, { kind: "change-grants" }>;
    }>;

/** Bound the real SDK request; an Allow never silently widens selected resources. */
export function grantRequestFor(
  authority: AppAuthority,
  facts: Readonly<{
    declaration: Pick<AppDeclaration, "capabilities">;
    declaredOperations: DeclaredOperations;
  }>,
  request: AppPermissionRequest,
  window: Readonly<{ computerId: string | null }>,
): GrantRequestDecision {
  if (authority.declaredOperationsDigest !== facts.declaredOperations.digest)
    return { kind: "refused", code: "stale_authority" };
  const requested = [
    ...new Set([...(request.agents ?? []), ...(request.computers ?? [])]),
  ];
  if (
    requested.some(
      (capability) => !facts.declaration.capabilities.includes(capability),
    )
  )
    return { kind: "refused", code: "not_declared" };
  const adds: GrantChange[] = [];
  for (const capability of requested) {
    const existing = authority.approvedGrants.find(
      (row) => row.capability === capability,
    );
    const operations =
      facts.declaredOperations.capabilities.find(
        (row) => row.capability === capability,
      )?.operations ?? [];
    if (
      existing !== undefined &&
      existing.resources !== "tenant-scope" &&
      existing.resources.length > 0
    ) {
      // approvedGrantSchema admits only capabilityApproved: true.
      // A replay can use that approval, but cannot extend its finite scope.
      if (
        permissionCatalog[capability].scope === "computer" &&
        window.computerId !== null &&
        existing.resources.some(
          (resource) =>
            resource.kind === "computer" && resource.id === window.computerId,
        ) &&
        operations.every((operation) => existing.operations.includes(operation))
      )
        continue;
      return { kind: "customize" };
    }
    if (
      existing?.resources === "tenant-scope" &&
      operations.every((operation) => existing.operations.includes(operation))
    )
      continue;
    let resources: "tenant-scope" | ResourceRef[] = "tenant-scope";
    if (permissionCatalog[capability].scope === "computer") {
      // Only the embedding host supplies this fact, never the App's request.
      const computerId = window.computerId;
      if (computerId == null)
        return { kind: "refused", code: "window_scope_unavailable" };
      resources = [{ kind: "computer", id: computerId }];
    }
    adds.push({ capability, grant: { operations, resources } });
  }
  if (adds.length === 0) return { kind: "covered" };
  return {
    kind: "ask",
    adds,
    command: { kind: "change-grants", changes: adds },
  };
}

/**
 * A draft contains approvals, never the broader declared-operation projection.
 * @inline
 */
export type PermissionGrant = Readonly<{
  operations: readonly string[];
  resources: "tenant-scope" | readonly ResourceRef[];
}>;
/**
 * Capability approvals being edited; null removes the capability's grant.
 * @inlineType PermissionGrant
 */
export type PermissionDraft = ReadonlyMap<
  AppCapabilityId,
  PermissionGrant | null
>;
/** One switch, scope, resource or operation change applied to a draft. */
export type PermissionEdit =
  | Readonly<{
      kind: "switch" | "all";
      capability: AppCapabilityId;
      on: boolean;
    }>
  | Readonly<{
      kind: "resource";
      capability: AppCapabilityId;
      resource: ResourceRef;
      on: boolean;
    }>
  | Readonly<{
      kind: "operation";
      capability: AppCapabilityId;
      operation: string;
      on: boolean;
    }>;

/** The saved operation ceiling is the starting point, including empty operation rows. */
export function draftOf(authority: AppAuthority): PermissionDraft {
  return new Map(
    authority.approvedGrants.map(({ capability, operations, resources }) => [
      capability,
      { operations, resources },
    ]),
  );
}

function sameGrant(
  a: PermissionGrant | null | undefined,
  b: PermissionGrant | null | undefined,
): boolean {
  if (a == null || b == null) return a == null && b == null;
  const sameValues = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length &&
    left.every((value) => right.includes(value));
  if (!sameValues(a.operations, b.operations)) return false;
  if (a.resources === "tenant-scope" || b.resources === "tenant-scope")
    return a.resources === b.resources;
  return (
    a.resources.length === b.resources.length &&
    a.resources.every(
      (resource) =>
        b.resources !== "tenant-scope" &&
        b.resources.some(
          (other) => resource.kind === other.kind && resource.id === other.id,
        ),
    )
  );
}

/** An edit changes one capability; unrelated saved operations and scopes are retained. */
export function editPermissions(
  draft: PermissionDraft,
  edit: PermissionEdit,
  declared: DeclaredOperations,
): PermissionDraft {
  const row = declared.capabilities.find(
    ({ capability }) => capability === edit.capability,
  );
  const policy = permissionCatalog[edit.capability];
  if (row === undefined || policy.consent === "affordance") return draft;
  const next = new Map(draft);
  const existing = draft.get(edit.capability);
  const enabled: PermissionGrant = existing ?? {
    operations: row.operations,
    resources: "tenant-scope",
  };
  switch (edit.kind) {
    case "switch":
      next.set(edit.capability, edit.on ? enabled : null);
      break;
    case "all":
      if (policy.scope === null) return draft;
      next.set(
        edit.capability,
        edit.on ? { ...enabled, resources: "tenant-scope" } : null,
      );
      break;
    case "resource": {
      if (
        policy.scope !== edit.resource.kind ||
        existing?.resources === "tenant-scope"
      )
        return draft;
      const resources = existing?.resources ?? [];
      const kept = resources.filter(
        (resource) =>
          resource.kind !== edit.resource.kind ||
          resource.id !== edit.resource.id,
      );
      const changed = edit.on ? [...kept, edit.resource] : kept;
      next.set(
        edit.capability,
        changed.length === 0 ? null : { ...enabled, resources: changed },
      );
      break;
    }
    case "operation": {
      if (
        edit.capability !== "apps.call" ||
        !row.operations.includes(edit.operation)
      )
        return draft;
      const kept = (existing?.operations ?? []).filter(
        (operation) => operation !== edit.operation,
      );
      const operations = edit.on ? [...kept, edit.operation] : kept;
      next.set(
        edit.capability,
        operations.length === 0 ? null : { ...enabled, operations },
      );
      break;
    }
  }
  return next;
}

/** Only touched capability rows cross the save boundary. */
export function planGrantChange(
  baseline: AppAuthority,
  draft: PermissionDraft,
): readonly GrantChange[] {
  const saved = draftOf(baseline);
  const capabilities = new Set([...saved.keys(), ...draft.keys()]);
  return [...capabilities].flatMap((capability) =>
    sameGrant(saved.get(capability), draft.get(capability))
      ? []
      : [{ capability, grant: draft.get(capability) ?? null }],
  );
}

/** A conflict preserves the person's edits while taking fresh untouched capabilities. */
export function rebaseDraft(
  draft: PermissionDraft,
  baseline: AppAuthority,
  current: AppAuthority,
): PermissionDraft {
  const rebased = new Map(draftOf(current));
  for (const change of planGrantChange(baseline, draft))
    rebased.set(change.capability, change.grant);
  return rebased;
}

/** Serializable host facts; the browser derives presentation, never authority. */
export const appPermissionsWireSchema = z.strictObject({
  authority: appAuthoritySchema,
  declaredOperations: declaredOperationsSchema,
});
/** Host-supplied authority and declared operations used to derive permission UI. */
export type AppPermissionsWire = z.output<typeof appPermissionsWireSchema>;
export type PermissionCellState = "on" | "off" | "via-all";
/**
 * Catalog copy and pending status shared by a group's scoped and switch columns.
 * @inline
 */
export type PermissionColumn = Readonly<{
  capability: AppCapabilityId;
  label: string;
  caption: string;
  description: string;
  sigil: SigilName;
  warning: string | null;
  pending: boolean;
}>;
/**
 * Catalog-derived permission groups, resource cells and operation switches.
 * @inlineType PermissionColumn
 */
export type PermissionScreen = Readonly<{
  canEdit: boolean;
  pending: readonly AppCapabilityId[];
  groups: readonly Readonly<{
    id: PermissionCatalogEntry["group"];
    scope: "computer" | "agent" | null;
    columns: readonly PermissionColumn[];
    rows: readonly Readonly<{
      resource: ResourceRef | "all";
      label: string;
      cells: readonly Readonly<{
        capability: AppCapabilityId;
        state: PermissionCellState;
      }>[];
    }>[];
    switches: readonly (PermissionColumn & Readonly<{ on: boolean }>)[];
    operations: readonly Readonly<{
      capability: "apps.call";
      operation: string;
      on: boolean;
    }>[];
  }>[];
}>;

/** Every declared permission is visible, including removable saved resources no longer listed by the host. */
export function permissionScreen(
  input: AppPermissionsWire &
    Readonly<{ resources: readonly ResourceOption[]; canEdit: boolean }>,
): PermissionScreen {
  const pending = pendingCapabilities(
    input.authority,
    {
      capabilities: input.declaredOperations.capabilities.map(
        (row) => row.capability,
      ),
    },
    input.declaredOperations,
  );
  const draft = draftOf(input.authority);
  const grouped = new Map<PermissionCatalogEntry["group"], AppCapabilityId[]>();
  for (const { capability } of input.declaredOperations.capabilities) {
    const group = permissionCatalog[capability].group;
    grouped.set(group, [...(grouped.get(group) ?? []), capability]);
  }
  const column = (capability: AppCapabilityId): PermissionColumn => {
    const { label, caption, description, sigil, warning } =
      permissionCatalog[capability];
    return {
      capability,
      label,
      caption,
      description,
      sigil,
      warning,
      pending: pending.includes(capability),
    };
  };
  return {
    canEdit: input.canEdit,
    pending,
    groups: [...grouped].map(([id, capabilities]) => {
      const scoped = capabilities.filter(
        (capability) => permissionCatalog[capability].scope !== null,
      );
      const scope =
        scoped.length === 0
          ? null
          : permissionCatalog[scoped[0] ?? "apps.open"].scope;
      const resources = new Map(
        input.resources
          .filter((resource) => resource.kind === scope)
          .map((resource) => [resource.id, resource]),
      );
      for (const capability of scoped) {
        const grant = draft.get(capability);
        if (grant == null || grant.resources === "tenant-scope") continue;
        for (const resource of grant.resources) {
          if (resource.kind === scope && !resources.has(resource.id))
            resources.set(resource.id, { ...resource, label: resource.id });
        }
      }
      const row = (resource: ResourceRef | "all", label: string) => ({
        resource,
        label,
        cells: scoped.map((capability) => {
          const grant = draft.get(capability);
          const state =
            grant == null
              ? "off"
              : grant.resources === "tenant-scope"
                ? resource === "all"
                  ? "on"
                  : "via-all"
                : resource !== "all" &&
                    grant.resources.some(
                      (ref) =>
                        ref.kind === resource.kind && ref.id === resource.id,
                    )
                  ? "on"
                  : "off";
          return { capability, state } satisfies Readonly<{
            capability: AppCapabilityId;
            state: PermissionCellState;
          }>;
        }),
      });
      return {
        id,
        scope,
        columns: scoped.map(column),
        rows:
          scope === null
            ? []
            : [
                row(
                  "all",
                  scope === "computer" ? "All Computers" : "All Agents",
                ),
                ...[...resources.values()].map((resource) =>
                  row({ kind: resource.kind, id: resource.id }, resource.label),
                ),
              ],
        switches: capabilities
          .filter((capability) => permissionCatalog[capability].scope === null)
          .map((capability) => ({
            ...column(capability),
            on:
              permissionCatalog[capability].consent === "affordance" ||
              draft.get(capability) != null,
          })),
        operations: capabilities.includes("apps.call")
          ? (
              input.declaredOperations.capabilities.find(
                (capability) => capability.capability === "apps.call",
              )?.operations ?? []
            ).map((operation) => ({
              capability: "apps.call",
              operation,
              on:
                draft.get("apps.call")?.operations.includes(operation) === true,
            }))
          : [],
      };
    }),
  };
}

/** Owner-direct permission page and JSON projection. Copy stays in the catalog. */
export const permissionPinsSchema = z.strictObject({
  storeGeneration: z.string().min(1),
  authorityVersion: z.number().int().positive(),
  artifactDigest: ownerCodec(sha256DigestSchema),
});
/** Generation, authority version and artifact digest fencing a permission edit. */
export type PermissionPins = z.output<typeof permissionPinsSchema>;
/** Permission edit command coupled to the version pins read by the owner. */
export const permissionSaveSchema = permissionPinsSchema.extend({
  command: grantCommandSchema,
});
/** Owner permission-page identity, artifact and current permission facts. */
export const appPermissionPageSchema = z.strictObject({
  storeGeneration: permissionPinsSchema.shape.storeGeneration,
  installationId: z.string(),
  appId: z.string(),
  appName: z.string(),
  artifactDigest: ownerCodec(sha256DigestSchema),
  permissions: appPermissionsWireSchema,
  canEdit: z.boolean(),
  resources: z.array(
    z.strictObject({
      kind: z.string(),
      id: z.string(),
      label: z.string(),
    }),
  ),
});

/** A host's live authority and resource directory, never browser-minted grants. */
export type AppPermissionsViewData = z.output<typeof appPermissionPageSchema>;

/**
 * Hosts authenticate, fence and commit; the shared view owns the permission draft.
 * @interface
 */
export type AppPermissionsPort = Readonly<{
  /** Read the installation's current permissions, whether the caller can edit them, and the available resources. */
  read(appKey: string): Promise<AppPermissionsViewData | "unavailable">;
  /** Submit edited grants with the store generation, authority version and artifact digest. The host checks authorization and freshness before saving. */
  submit(
    appKey: string,
    pins: PermissionPins,
    changes: readonly GrantChange[],
  ): Promise<"accepted" | "stale" | "refused" | "unavailable" | "unconfirmed">;
}>;
