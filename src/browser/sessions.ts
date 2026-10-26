import { z } from "zod";
import {
  createCdpClient,
  openCdpSocket,
  type CdpClient,
  type CdpSocket,
  type HttpFetch,
} from "./cdp-client.js";
import { CloudBrowserUpstreamError } from "./errors.js";

/**
 * One browser session's provider lifecycle: create, connect CDP, delete and
 * confirm closure. Cloudflare Browser Run's REST API and a Workers BROWSER
 * binding speak the same devtools protocol under different roots, so both
 * hosts share this one implementation:
 *
 * - REST: `https://api.cloudflare.com/client/v4/accounts/{account}/browser-run/devtools`
 *   with `Authorization: Bearer` (https://developers.cloudflare.com/browser-run/cdp/,
 *   .../cdp/session-management/).
 * - Binding: `binding.fetch("http://fake.host/v1/devtools/…")`, the endpoints
 *   a Workers Browser Run binding answers.
 *
 * Chromium on staging uses browser contexts rather than Browser Run endpoints.
 * Provider session ids stay inside the module; agent leases use their own ids.
 */

export type AcquireOptions = Readonly<{
  /** Browser Run idle keep-alive (10s–20min); Chromium has no equivalent. */
  keepAliveMs: number;
  /** Browser Run provider guardrail; Chromium relies on its caller's URL gate. */
  allowedDomains?: readonly string[];
}>;

/**
 * The provider half of the host port.
 * Each step is separate so `createBrowser` owns a provider session id from the
 * moment it exists, including when its CDP connect then fails.
 */
export type BrowserSessions = Readonly<{
  /** Create one provider session; resolves its provider id. @internal */
  create: (options: AcquireOptions, signal: AbortSignal) => Promise<string>;
  /** Connect the CDP socket of a created session, bounded by `signal`. @internal */
  connect: (sessionId: string, signal: AbortSignal) => Promise<CdpClient>;
  /** Ask the provider to delete a session; 404 is already gone. @internal */
  release: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<"closed" | "closing">;
  /** Confirm provider closure (Chromium checks context absence). @internal */
  confirmClosed: (sessionId: string, deadlineAt: number) => Promise<void>;
}>;

/** A Workers BROWSER binding (`Fetcher`), reduced to the call this module makes. */
export type BrowserBinding = Readonly<{ fetch: HttpFetch }>;

/** Opens the CDP WebSocket for one provider session URL. */
export type CdpConnect = (
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<CdpSocket>;

const createdSchema = z.object({ sessionId: z.string().min(1).max(256) });
const releasedSchema = z.object({ status: z.enum(["closing", "closed"]) });
const sessionDetailsSchema = z
  .object({ sessionId: z.string(), endTime: z.number().optional() })
  .nullable();

const minKeepAliveMs = 10_000;
const maxKeepAliveMs = 1_200_000;

function devtoolsSessions(
  input: Readonly<{
    root: string;
    fetch: HttpFetch;
    headers: Readonly<Record<string, string>>;
    connect: CdpConnect;
  }>,
): BrowserSessions {
  const sessionUrl = (sessionId: string) =>
    `${input.root}/browser/${encodeURIComponent(sessionId)}`;

  async function create(
    options: AcquireOptions,
    signal: AbortSignal,
  ): Promise<string> {
    const keepAlive = Math.min(
      Math.max(options.keepAliveMs, minKeepAliveMs),
      maxKeepAliveMs,
    );
    const init: RequestInit = {
      method: "POST",
      headers: input.headers,
      signal,
    };
    if (options.allowedDomains !== undefined) {
      // Guardrails travel in the create body (the WebSocket upgrade for an
      // existing session carries none).
      init.headers = { ...input.headers, "content-type": "application/json" };
      init.body = JSON.stringify({
        guardrails: { allowedDomains: options.allowedDomains },
      });
    }
    const response = await input.fetch(
      `${input.root}/browser?keep_alive=${String(keepAlive)}`,
      init,
    );
    if (!response.ok)
      throw new CloudBrowserUpstreamError({
        op: "open",
        status: response.status,
        message: "The browser provider refused to create a session",
      });
    const created = createdSchema.safeParse(await response.json());
    if (!created.success)
      throw new CloudBrowserUpstreamError({
        op: "open",
        status: null,
        message: "The browser provider returned an unreadable session",
      });
    return created.data.sessionId;
  }

  async function deleteSession(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<"closed" | "closing"> {
    const response = await input.fetch(sessionUrl(sessionId), {
      method: "DELETE",
      headers: input.headers,
      signal,
    });
    if (response.status === 404) return "closed";
    if (!response.ok)
      throw new CloudBrowserUpstreamError({
        op: "close",
        status: response.status,
        message: "The browser provider refused to close the session",
      });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // An unreadable acknowledgement is not proof of closure.
      return "closing";
    }
    const released = releasedSchema.safeParse(body);
    return released.success ? released.data.status : "closing";
  }

  return {
    create,
    connect: async (sessionId, signal) =>
      createCdpClient(
        await input.connect(sessionUrl(sessionId), input.headers, signal),
      ),
    release: deleteSession,
    confirmClosed: async (sessionId, deadlineAt) => {
      const url = `${input.root}/session/${encodeURIComponent(sessionId)}`;
      while (Date.now() < deadlineAt) {
        const response = await input.fetch(url, {
          method: "GET",
          headers: input.headers,
          signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
        });
        if (response.status !== 200) break;
        const details = sessionDetailsSchema.safeParse(await response.json());
        if (!details.success || details.data?.sessionId !== sessionId) break;
        if ((details.data.endTime ?? 0) > 0) return;
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            Math.min(50, Math.max(0, deadlineAt - Date.now())),
          ),
        );
      }
      throw new CloudBrowserUpstreamError({
        op: "close.confirm",
        status: null,
        message: "The browser provider did not confirm the session closed",
      });
    },
  };
}

/** Cloudflare Browser Run over REST with an account token (Hub, any celld host). */
export function browserRunSessions(
  config: Readonly<{
    accountId: string;
    apiToken: string;
    fetch?: HttpFetch;
    /** The CDP WebSocket transport; defaults to the outbound upgrade over `fetch`. */
    connect?: CdpConnect;
  }>,
): BrowserSessions {
  const fetcher: HttpFetch = config.fetch ?? ((url, init) => fetch(url, init));
  return devtoolsSessions({
    root: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/browser-run/devtools`,
    fetch: fetcher,
    headers: { authorization: `Bearer ${config.apiToken}` },
    connect:
      config.connect ??
      ((url, headers, signal) => openCdpSocket(fetcher, url, headers, signal)),
  });
}

/** A standalone Oyster's own Workers BROWSER binding. */
export function bindingSessions(binding: BrowserBinding): BrowserSessions {
  const fetcher: HttpFetch = (url, init) => binding.fetch(url, init);
  return devtoolsSessions({
    root: "http://fake.host/v1/devtools",
    fetch: fetcher,
    headers: {},
    connect: (url, headers, signal) =>
      openCdpSocket(fetcher, url, headers, signal),
  });
}

/** Staging uses Chromium's native CDP browser contexts; no session store. */
export function onboxBrowserSessions(
  origin: string,
  fetcher: HttpFetch = (url, init) => fetch(url, init),
): BrowserSessions {
  const base = new URL(origin);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new TypeError("On-box browser origin must be bare IPv4 loopback");
  const browserEndpointSchema = z.object({ webSocketDebuggerUrl: z.url() });
  const contextsSchema = z.object({ browserContextIds: z.array(z.string()) });
  const createdContextSchema = z.object({
    browserContextId: z.string().min(1),
  });
  async function connectBrowser(signal: AbortSignal): Promise<CdpClient> {
    // Chromium's native discovery endpoint is not a Botanical session server.
    let discovery: Response;
    try {
      discovery = await fetcher(new URL("/json/version", base).href, {
        signal,
      });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new CloudBrowserUpstreamError({
        op: "onbox.connect",
        status: null,
        message: "On-box Chromium is unavailable",
      });
    }
    if (!discovery.ok)
      throw new CloudBrowserUpstreamError({
        op: "onbox.connect",
        status: discovery.status,
        message: "On-box Chromium is unavailable",
      });
    let body: unknown;
    try {
      body = await discovery.json();
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new CloudBrowserUpstreamError({
        op: "onbox.connect",
        status: null,
        message: "On-box browser returned an unreadable CDP endpoint",
      });
    }
    const discovered = browserEndpointSchema.safeParse(body);
    if (!discovered.success)
      throw new CloudBrowserUpstreamError({
        op: "onbox.connect",
        status: null,
        message: "On-box browser returned an unreadable CDP endpoint",
      });
    const { webSocketDebuggerUrl } = discovered.data;
    const endpoint = new URL(webSocketDebuggerUrl);
    if (
      endpoint.protocol !== "ws:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.port !== base.port ||
      !/^\/devtools\/browser\/[^/]+$/u.test(endpoint.pathname) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new CloudBrowserUpstreamError({
        op: "onbox.connect",
        status: null,
        message: "On-box browser returned an invalid CDP endpoint",
      });
    return createCdpClient(
      await openCdpSocket(
        fetcher,
        endpoint.href.replace(/^ws:/u, "http:"),
        {},
        signal,
      ),
    );
  }
  async function contexts(client: CdpClient, signal: AbortSignal) {
    const result = contextsSchema.safeParse(
      await client.call("Target.getBrowserContexts", {}, { signal }),
    );
    if (!result.success)
      throw new CloudBrowserUpstreamError({
        op: "onbox.contexts",
        status: null,
        message: "On-box browser returned unreadable contexts",
      });
    return result.data.browserContextIds;
  }
  return {
    create: async (_options, signal) => {
      // Chromium has no idle keep-alive or allowedDomains create guardrail:
      // Oyster's Agent URL policy and the boot page request gate remain active.
      // A Chromium restart ends every context; no restart recovery is claimed.
      const client = await connectBrowser(signal);
      try {
        const created = createdContextSchema.safeParse(
          await client.call("Target.createBrowserContext", {}, { signal }),
        );
        if (!created.success)
          throw new CloudBrowserUpstreamError({
            op: "onbox.create",
            status: null,
            message: "On-box browser returned an unreadable context",
          });
        const { browserContextId } = created.data;
        try {
          await client.call(
            "Target.createTarget",
            { url: "about:blank", browserContextId },
            { signal },
          );
          return browserContextId;
        } catch (error) {
          await client.call(
            "Target.disposeBrowserContext",
            { browserContextId },
            { signal },
          );
          throw error;
        }
      } finally {
        client.close();
      }
    },
    connect: async (id, signal) => {
      const client = await connectBrowser(signal);
      try {
        if (!(await contexts(client, signal)).includes(id))
          throw new CloudBrowserUpstreamError({
            op: "onbox.connect",
            status: null,
            message: "On-box browser context is gone",
          });
        return { ...client, browserContextId: id };
      } catch (error) {
        client.close();
        throw error;
      }
    },
    release: async (id, signal) => {
      const client = await connectBrowser(signal);
      try {
        if ((await contexts(client, signal)).includes(id))
          await client.call(
            "Target.disposeBrowserContext",
            { browserContextId: id },
            { signal },
          );
        return "closed";
      } finally {
        client.close();
      }
    },
    confirmClosed: async (id, deadlineAt) => {
      const signal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
      const client = await connectBrowser(signal);
      try {
        if (!(await contexts(client, signal)).includes(id)) return;
      } finally {
        client.close();
      }
      throw new CloudBrowserUpstreamError({
        op: "onbox.close.confirm",
        status: null,
        message: "On-box browser did not confirm closure",
      });
    },
  };
}
