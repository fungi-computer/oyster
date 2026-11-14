import {
  appBackendBindingOperation,
  type AppBackendBindingName,
  type AppDeclaration,
} from "@fungi.computer/puffball/app";
import { sha256 } from "../release.js";
import {
  declaredOperationsSchema,
  type CapabilityOperationDescriptor,
  type DeclaredOperations,
  type Installation,
} from "./installation.js";

/** Qualify backend operations so a same-named browser method grants no backend authority. */
export function bindingOperationKey(
  binding: AppBackendBindingName,
  operation: string,
): string {
  return `binding:${binding}:${operation}`;
}

/** Approval identity for one UI-side target method; upgrades intersect these exact pairs. */
export function appCallOperation(appId: string, method: string): string {
  return `route:apps.call:${appId}:${method}`;
}

/**
 * What a backend binding operation does: the broker class, effect and required
 * capabilities from Puffball's registry. Null for an operation the registry lacks.
 */
export function bindingOperationFingerprint(
  binding: AppBackendBindingName,
  operation: string,
): string | null {
  const definition = appBackendBindingOperation(binding, operation);
  return definition === undefined
    ? null
    : JSON.stringify([
        definition.cap,
        definition.effect,
        [...definition.requires].sort(),
      ]);
}

/** What a host route operation does: where its descriptor method entry sends the call. */
function routeFingerprint(
  descriptor: CapabilityOperationDescriptor,
  method: CapabilityOperationDescriptor["methods"][string],
): string {
  return JSON.stringify([
    descriptor.base,
    method.kind,
    method.method,
    method.path,
  ]);
}

/**
 * Operations the signed declaration alone defines (`apps.call` targets and the
 * `route:app.methods:*` approval-detail rows) have nothing host-side to change.
 */
const declarationFingerprint = JSON.stringify(["declaration"]);

/** Sole derivation owner. Inputs are the verified Release declaration and existing host adapters. */
export async function deriveDeclaredOperations(
  release: Installation["release"],
  declaration: AppDeclaration,
  descriptors: readonly CapabilityOperationDescriptor[],
): Promise<DeclaredOperations> {
  if (descriptors.some((descriptor) => descriptor.id === "app.methods"))
    throw new Error("app_methods_descriptor_reserved");
  const capabilities = new Map(
    declaration.capabilities.map((capability) => [
      capability,
      new Map<string, string>(),
    ]),
  );
  for (const call of declaration.calls ?? [])
    for (const method of call.methods)
      capabilities
        .get("apps.call")
        ?.set(appCallOperation(call.appId, method), declarationFingerprint);
  for (const [name, method] of Object.entries(declaration.api?.methods ?? {}))
    for (const capability of method.requires)
      capabilities
        .get(capability)
        ?.set(`route:app.methods:${name}`, declarationFingerprint);
  const routes = descriptors
    .filter((descriptor) => capabilities.has(descriptor.permission))
    .map((descriptor) => {
      const methods = Object.entries(descriptor.methods).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      for (const [name, method] of methods)
        capabilities
          .get(descriptor.permission)
          ?.set(
            `route:${descriptor.id}:${name}`,
            routeFingerprint(descriptor, method),
          );
      return { id: descriptor.id, permission: descriptor.permission, methods };
    })
    .sort((a, b) =>
      a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : a.permission < b.permission
            ? -1
            : a.permission > b.permission
              ? 1
              : 0,
    );
  const bindings = (declaration.backend?.bindings ?? [])
    .flatMap((binding) =>
      binding.operations.flatMap((name) => {
        const operation = appBackendBindingOperation(binding.name, name);
        if (
          !operation?.requires.every((capability) =>
            capabilities.has(capability),
          )
        )
          return [];
        const fingerprint = bindingOperationFingerprint(binding.name, name);
        if (fingerprint === null) return [];
        for (const capability of operation.requires)
          capabilities
            .get(capability)
            ?.set(bindingOperationKey(binding.name, name), fingerprint);
        return [
          {
            binding: binding.name,
            operation: name,
            effect: operation.effect,
            requires: [...operation.requires].sort(),
          },
        ];
      }),
    )
    .sort((a, b) =>
      bindingOperationKey(a.binding, a.operation) <
      bindingOperationKey(b.binding, b.operation)
        ? -1
        : bindingOperationKey(a.binding, a.operation) >
            bindingOperationKey(b.binding, b.operation)
          ? 1
          : 0,
    );
  const rows = [...capabilities]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([capability, operations]) => {
      const sorted = [...operations].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return {
        capability,
        operations: sorted.map(([name]) => name),
        fingerprints: Object.fromEntries(sorted),
      };
    });
  const artifactDigest = release.artifact.artifactDigest;
  const digest = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        artifactDigest,
        capabilities: rows,
        routes,
        bindings,
      }),
    ),
  );
  return declaredOperationsSchema.parse({
    artifactDigest,
    digest,
    capabilities: rows,
  });
}
