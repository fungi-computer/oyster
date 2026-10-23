import { RpcTarget } from "@fungi.computer/capnweb";
import { compile, parse, pathToRegexp } from "path-to-regexp";
import * as Schema from "effect/Schema";
import { AppError, type CapabilityContract } from "@fungi.computer/agar";
import type { AppHostLaunch } from "@fungi.computer/agar/host";
import { parseJsonValue } from "@fungi.computer/whistle/wire";
import type { CapabilityDescriptor } from "../capability-descriptor.js";
import { computerTargetUrl } from "./computer-target.js";

const queryInput = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
);
const capabilityInputSchema = Schema.Union([Schema.Json, Schema.Undefined]);
type CapabilityInput = Schema.Schema.Type<typeof capabilityInputSchema>;
/** Agar's opaque host handle, shared by the page's exported factory contracts. */
export type HostCapabilityHandle =
  AppHostLaunch["capabilities"][number]["handle"];

function resolveRoute(path: string, input: CapabilityInput) {
  const template = parse(path);
  const names = new Set(pathToRegexp(template).keys.map((key) => key.name));
  if (names.size === 0) return { path: compile(template)(), input };
  const fields = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Json),
  )(input);
  const params = Object.fromEntries(
    Object.entries(fields)
      .filter(([name]) => names.has(name))
      .map(([name, value]) => [
        name,
        String(
          Schema.decodeUnknownSync(
            Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
          )(value),
        ),
      ]),
  );
  return {
    path: compile(template)(params),
    input: Object.fromEntries(
      Object.entries(fields).filter(([name]) => !names.has(name)),
    ),
  };
}

function query(input: CapabilityInput): string {
  if (input === undefined) return "";
  const entries = Object.entries(Schema.decodeUnknownSync(queryInput)(input));
  const params = new URLSearchParams(
    entries.map(([name, value]) => [name, String(value)]),
  );
  return params.size === 0 ? "" : `?${params.toString()}`;
}

function check(response: Response): void {
  if (response.ok) return;
  throw new AppError("Capability request failed", {
    code:
      response.status === 401 || response.status === 403
        ? "CAPABILITY_DENIED"
        : response.status === 413
          ? "FILE_TOO_LARGE"
          : response.status === 404
            ? "INVALID_ARGUMENT"
            : "HOST_FAILURE",
    retryable: response.status >= 500,
  });
}

// Chromium can expose an empty stream for bodyless HTTP responses. Cap'n Web
// reconstructs Responses in the App; their constructor rejects a stream for
// 204/205/304, which would otherwise break the entire App RPC connection.
async function fetchResponse(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetch(url, init);
  if (
    init.method === "HEAD" ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  ) {
    await response.body?.cancel();
    return new Response(null, response);
  }
  return response;
}

class ReadHandle extends RpcTarget {
  readonly #abort = new AbortController();
  readonly #url: string;
  readonly #init: RequestInit;
  constructor(url: string, init: RequestInit) {
    super();
    this.#url = url;
    this.#init = init;
  }
  async response(): Promise<Response> {
    const response = await fetchResponse(this.#url, {
      ...this.#init,
      signal: this.#abort.signal,
    });
    check(response);
    return response;
  }
  close(): Promise<void> {
    this.#abort.abort();
    return Promise.resolve();
  }
}

class WriteHandle extends RpcTarget {
  readonly #abort = new AbortController();
  readonly #url: string;
  readonly #init: RequestInit;
  constructor(url: string, init: RequestInit) {
    super();
    this.#url = url;
    this.#init = init;
  }
  async write(content: ReadableStream<Uint8Array>): Promise<void> {
    // R2 requires a known length, as on the existing file upload route.
    const body = await new Response(content).arrayBuffer();
    check(
      await fetch(this.#url, {
        ...this.#init,
        body,
        signal: this.#abort.signal,
      }),
    );
  }
  close(): Promise<void> {
    this.#abort.abort();
    return Promise.resolve();
  }
}

class TransportHandle extends RpcTarget {
  readonly #abort = new AbortController();
  readonly #url: string;
  readonly #init: RequestInit;
  constructor(url: string, init: RequestInit) {
    super();
    this.#url = url;
    this.#init = init;
  }
  async fetch(raw: unknown): Promise<Response> {
    const request = Schema.decodeUnknownSync(Schema.instanceOf(Request))(raw);
    if (this.#init.method !== "ANY" && request.method !== this.#init.method)
      throw new AppError("This transport does not admit that HTTP method", {
        code: "CAPABILITY_DENIED",
        retryable: false,
      });
    const incoming = new URL(request.url);
    const target = new URL(this.#url, "https://oyster.invalid");
    target.pathname = `${target.pathname.replace(/\/$/u, "")}${incoming.pathname}`;
    for (const [name, value] of incoming.searchParams) {
      if (target.searchParams.has(name))
        throw new AppError(
          "A transport request cannot replace its handle arguments",
          {
            code: "INVALID_ARGUMENT",
            retryable: false,
          },
        );
      target.searchParams.append(name, value);
    }
    const headers = new Headers(this.#init.headers);
    for (const name of [
      "accept",
      "content-type",
      "last-event-id",
      "acp-connection-id",
      "acp-session-id",
    ]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const init: RequestInit = {
      ...this.#init,
      method: request.method,
      headers,
      signal: AbortSignal.any([request.signal, this.#abort.signal]),
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      const body = await request.arrayBuffer();
      if (body.byteLength > 512 * 1024)
        throw new AppError("Transport request is too large", {
          code: "INVALID_ARGUMENT",
          retryable: false,
        });
      init.body = body;
    }
    return fetchResponse(`${target.pathname}${target.search}`, init);
  }
  close(): Promise<void> {
    this.#abort.abort();
    return Promise.resolve();
  }
}

function capabilityRequest(
  descriptor: CapabilityDescriptor,
  installationId: string,
  route: CapabilityDescriptor["methods"][string],
  raw: CapabilityInput,
  computerTarget?: string,
) {
  const resolved = resolveRoute(route.path, raw);
  const input = resolved.input;
  const headers = new Headers({ "X-Oyster-Installation": installationId });
  const url = `${descriptor.base}${resolved.path}`;
  const target = new URL(url, "https://oyster.invalid");
  if (target.origin !== "https://oyster.invalid" || target.pathname !== url)
    throw new AppError("Capability arguments change the route", {
      code: "INVALID_ARGUMENT",
      retryable: false,
    });
  const init: RequestInit = {
    method: route.method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  };
  if (route.kind === "json" && route.method !== "GET") {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(input);
    return { url: computerTargetUrl(url, computerTarget), init };
  }
  return {
    url: computerTargetUrl(`${url}${query(input)}`, computerTarget),
    init,
  };
}

async function jsonReply(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  check(response);
  if (response.status === 204) return undefined;
  return parseJsonValue(await response.json());
}

/** Bind a page-local JSON caller; cancellation never enters serialized input. */
export function capabilityJsonCaller(
  descriptor: CapabilityDescriptor,
  installationId: string,
  computerTarget?: string,
) {
  return async (
    method: string,
    raw?: unknown,
    options?: { readonly signal?: AbortSignal },
  ) => {
    const input = Schema.decodeUnknownSync(capabilityInputSchema)(raw);
    const route = descriptor.methods[method];
    if (route?.kind !== "json")
      throw new AppError("This method is not a JSON capability method", {
        code: "INVALID_ARGUMENT",
        retryable: false,
      });
    const { url, init } = capabilityRequest(
      descriptor,
      installationId,
      route,
      input,
      computerTarget,
    );
    return jsonReply(url, { ...init, signal: options?.signal });
  };
}

/** Local JSON calls carry cancellation separately from their serialized input. */
export type CapabilityJsonCaller = ReturnType<typeof capabilityJsonCaller>;

/** Open a browser transport using the page's admitted installation. */
function capabilityTransportOpener(
  descriptor: CapabilityDescriptor,
  installationId: string,
  computerTarget?: string,
) {
  return (method: string, raw?: unknown): WebSocket => {
    const route = descriptor.methods[method];
    if (
      route?.kind !== "transport" ||
      (route.method !== "GET" && route.method !== "ANY")
    )
      throw new AppError("This method does not admit a WebSocket transport", {
        code: "INVALID_ARGUMENT",
        retryable: false,
      });
    const { url } = capabilityRequest(
      descriptor,
      installationId,
      route,
      Schema.decodeUnknownSync(capabilityInputSchema)(raw),
      computerTarget,
    );
    const target = new URL(url, "https://oyster.invalid");
    // Browser WebSockets cannot send the installation header used by Fetch.
    target.searchParams.set("oysterInstallation", installationId);
    return new WebSocket(`${target.pathname}${target.search}`);
  };
}

/** Local factories may open only transports present in their descriptor. */
export type CapabilityTransportOpener = (
  method: string,
  input?: Schema.Json,
) => WebSocket;

/** Build the App's RPC handle from its admitted descriptor and installation. */
export function capabilityHandle(
  descriptor: CapabilityDescriptor,
  installationId: string,
  computerTarget?: string,
): HostCapabilityHandle {
  // Cap'n Web exposes prototype methods, never an instance's own properties.
  // Only input crosses RPC; AbortSignal options belong to the local caller.
  class CapabilityHandle extends RpcTarget {}
  Object.assign(
    CapabilityHandle.prototype,
    Object.fromEntries(
      Object.entries(descriptor.methods).map(([name, route]) => [
        name,
        async (raw: unknown) => {
          const input = Schema.decodeUnknownSync(capabilityInputSchema)(raw);
          const { url, init } = capabilityRequest(
            descriptor,
            installationId,
            route,
            input,
            computerTarget,
          );
          if (route.kind === "read") return new ReadHandle(url, init);
          if (route.kind === "write") return new WriteHandle(url, init);
          if (route.kind === "transport") return new TransportHandle(url, init);
          return jsonReply(url, init);
        },
      ]),
    ),
  );
  return new CapabilityHandle();
}

/** A supported contract may adapt local JSON calls into its App-facing handle. */
export type CapabilityRegistration = Readonly<{
  contract: CapabilityContract<unknown>;
  createHandle?: (
    call: CapabilityJsonCaller,
    transport: CapabilityTransportOpener,
  ) => HostCapabilityHandle | Promise<HostCapabilityHandle>;
}>;

/** Create a registered handle, using the descriptor's ordinary RPC handle by default. */
export async function registeredCapabilityHandle(
  registration: CapabilityRegistration,
  descriptor: CapabilityDescriptor,
  installationId: string,
  computerTarget?: string,
): Promise<HostCapabilityHandle> {
  if (registration.createHandle === undefined)
    return capabilityHandle(descriptor, installationId, computerTarget);
  return await registration.createHandle(
    capabilityJsonCaller(descriptor, installationId, computerTarget),
    capabilityTransportOpener(descriptor, installationId, computerTarget),
  );
}
