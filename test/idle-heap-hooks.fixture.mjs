// Module hooks for idle-heap.fixture.mjs: Node has no `cloudflare:*`
// modules, so each resolves to inert classes with the names the bundle
// imports. A new name fails to link, naming itself.
const stub = `
export class DurableObject {}
export class RpcTarget {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
export class NonRetryableError extends Error {}
`;

export async function resolve(specifier, context, next) {
  return specifier.startsWith("cloudflare:")
    ? { url: `stub:${specifier}`, shortCircuit: true }
    : next(specifier, context);
}

export async function load(url, context, next) {
  return url.startsWith("stub:cloudflare:")
    ? { format: "module", source: stub, shortCircuit: true }
    : next(url, context);
}
