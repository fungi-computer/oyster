import {
  appBackendBindingOperation,
  type AppBackendBindingName,
  type AppDeclaration,
} from "@fungi.computer/puffball/app";
import { sha256 } from "../release.js";
import canonicalJson from "fast-json-stable-stringify";
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
      new Set<string>(),
    ]),
  );
  for (const call of declaration.calls ?? [])
    for (const method of call.methods)
      capabilities.get("apps.call")?.add(appCallOperation(call.appId, method));
  for (const [name, method] of Object.entries(declaration.api?.methods ?? {}))
    for (const capability of method.requires)
      capabilities.get(capability)?.add(`route:app.methods:${name}`);
  const routes = descriptors
    .filter((descriptor) => capabilities.has(descriptor.permission))
    .map((descriptor) => {
      const methods = Object.entries(descriptor.methods).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      for (const [name] of methods)
        capabilities
          .get(descriptor.permission)
          ?.add(`route:${descriptor.id}:${name}`);
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
        for (const capability of operation.requires)
          capabilities
            .get(capability)
            ?.add(bindingOperationKey(binding.name, name));
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
    .map(([capability, operations]) => ({
      capability,
      operations: [...operations].sort(),
    }));
  const artifactDigest = release.artifact.artifactDigest;
  const anonymousMethods = await Promise.all(
    Object.entries(declaration.api?.methods ?? {})
      .filter(([, method]) => method.anonymous === true)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(async ([name, method]) => ({
        name,
        digest: await sha256(new TextEncoder().encode(canonicalJson(method))),
      })),
  );
  const digest = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        artifactDigest,
        capabilities: rows,
        routes,
        bindings,
        anonymousMethods,
      }),
    ),
  );
  return declaredOperationsSchema.parse({
    artifactDigest,
    digest,
    capabilities: rows,
    anonymousMethods,
  });
}
