import { frameBindingWireScript } from "#frame-binding-wire-script";
import { appInstanceErrorCodeSchema } from "./index.js";

/** Trusted Loader facade: code is cached, while each invocation receives its own bindings. */
export function facetInvocationModule(exportName: string): string {
  return `import { DurableObject } from "cloudflare:workers";
import * as backend from "./backend.js";
import { createFrameBindingWire } from "./frame-binding-wire.js";
const Backend = backend[${JSON.stringify(exportName)}];
const wire = createFrameBindingWire(${JSON.stringify(appInstanceErrorCodeSchema.literals)});
// Only the App's own class chain is callable; platform and Object members never are.
function methodOf(method) {
  for (
    let prototype = Backend.prototype;
    prototype !== null &&
    prototype !== DurableObject.prototype &&
    prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    if (descriptor === undefined) continue;
    if (method === "constructor" || typeof descriptor.value !== "function")
      break;
    return descriptor.value;
  }
  throw new Error("App method unavailable");
}
export class AppInvocation extends DurableObject {
  async invoke(method, args, bindings) {
    if (method === "fetch") throw new Error("App method unavailable");
    return await methodOf(method).apply(new Backend(this.ctx, wire.wrap(bindings)), args);
  }
  async http(input, bindings) {
    const request = new Request(input.url, {
      method: input.method, headers: input.headers,
      ...(input.body === null ? {} : {body: input.body}),
    });
    const response = await methodOf("fetch").call(new Backend(this.ctx, wire.wrap(bindings)), request);
    return {status: response.status, statusText: response.statusText,
      headers: [...response.headers], body: response.body};
  }
}
`;
}

/** The facade's private maintained decoder module, bundled at package build time. */
export const facetFrameBindingModule = frameBindingWireScript;
