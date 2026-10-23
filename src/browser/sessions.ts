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
 * Provider session ids stay inside the module; agent leases use their own ids.
 */

export type AcquireOptions = Readonly<{
  /** Provider idle keep-alive, clamped to Browser Run's 10s–20min range. */
  keepAliveMs: number;
  /** Provider guardrail: the only hosts this session may load. */
  allowedDomains?: readonly string[];
}>;

/**
 * The provider half of the host port. Built only by the two functions below.
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
  /** Reads the provider's session record until it reports an end time. @internal */
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
