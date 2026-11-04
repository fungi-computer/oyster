import type { CapabilitySource } from "@fungi.computer/mycelium";
import { match } from "path-to-regexp";
import {
  bindingSessions,
  browserCapabilitySource,
  createBrowser,
  liveView,
  liveViewPaths,
  type Browser,
  type BrowserBinding,
  type BrowserMeter,
  type SaveBrowserFile,
} from "../browser/index.js";
import { causeClass } from "../cause-class.js";

/**
 * A standalone Oyster's `BrowserHost`: its own Workers BROWSER binding, no
 * Quick Reads (the binding has none), and the owner-funded meter below.
 */

/**
 * A standalone Oyster has no credit ledger: its owner's Cloudflare account
 * pays Browser Rendering directly. This is that host's explicit metering
 * decision, not a missing meter; the Hub supplies its Billing owner instead.
 */
const ownerFundedMeter: BrowserMeter = {
  hold: () => Promise.resolve(),
  start: () => Promise.resolve(),
  settle: () => Promise.resolve(),
  release: () => Promise.resolve(),
};

/** One Browser per binding per isolate, so a lease survives between calls. */
const browsers = new WeakMap<BrowserBinding, Browser>();

function standaloneBrowser(binding: BrowserBinding): Browser {
  let browser = browsers.get(binding);
  if (browser === undefined) {
    browser = createBrowser(
      {
        sessions: bindingSessions(binding),
        quickReads: null,
        meter: () => ownerFundedMeter,
        report: (event) => {
          // Code-only: never a URL, page text or provider body.
          console.warn("Oyster browser", {
            kind: event.kind,
            executionId: event.executionId,
            cause: causeClass(event.cause),
          });
        },
      },
      {
        maxConcurrentPerTeam: 2,
        maxLifetimeMs: 30 * 60_000,
        idleTimeoutMs: 5 * 60_000,
      },
    );
    browsers.set(binding, browser);
  }
  return browser;
}

/** The owner-admitted live-view base for one Agent's lease (see `agents.ts`'s cloud-browser route). */
function viewBase(agentId: string, leaseId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/cloud-browser/${encodeURIComponent(leaseId)}`;
}

/**
 * The agent's `cloudBrowser` tool on a standalone Oyster, or an empty source
 * when the deployment declares no BROWSER binding. Driven sessions only: no
 * Quick Reads. `handoff` pauses the lease and returns the owner's live view;
 * `channel` stays null until the host supplies a conversations owner, which
 * is the seam a channel Session's conversation handoff plugs into. Screenshots
 * and PDFs save to an attached Computer through `saveFile`.
 */
export function standaloneBrowserSource(
  binding: BrowserBinding | undefined,
  identity: () => Readonly<{ teamId: string; agentId: string }>,
  saveFile: SaveBrowserFile,
): CapabilitySource {
  if (binding === undefined)
    return {
      id: "cloud-browser",
      acquire: () =>
        Promise.resolve({
          snapshot: { version: "0", modules: [] },
          release: () => Promise.resolve(),
        }),
    };
  const browser = standaloneBrowser(binding);
  return browserCapabilitySource({
    identity,
    browser: {
      call: (owner, op, signal) => browser.call(owner, op, signal),
      handoff: (owner, leaseId) => {
        browser.handoff(owner, leaseId);
        return Promise.resolve();
      },
    },
    quickReads: false,
    saveFile,
    handoff: {
      channel: null,
      viewPath: (owner, leaseId) =>
        liveViewPaths(viewBase(owner.agentId, leaseId)).view,
    },
  });
}

/**
 * The Agent DO's side of the owner's live view. The browser singleton lives in
 * this isolate, so the Worker's owner-admitted `/agents/:agentId/cloud-browser`
 * route forwards here and this calls `Browser.member` on the Agent's own
 * lease. Admission is the Worker's; this only serves already-admitted requests.
 */
export function standaloneBrowserLiveView(
  binding: BrowserBinding | undefined,
  identity: () => Readonly<{ teamId: string; agentId: string }>,
): (request: Request) => Promise<Response> {
  const route = match<{ leaseId: string; part: string }>(
    "/cloud-browser/:leaseId/:part",
  );
  const handlers = (leaseId: string) => {
    if (binding === undefined) return null;
    const { teamId, agentId } = identity();
    const browser = standaloneBrowser(binding);
    return liveView(
      (action, signal) => browser.member(teamId, leaseId, action, signal),
      liveViewPaths(viewBase(agentId, leaseId)),
      (event, cause) => {
        console.warn("Oyster browser", {
          kind: event,
          cause: causeClass(cause),
        });
      },
    );
  };
  const none = () => Response.json({ error: "no_browser" }, { status: 404 });
  return (request) => {
    const found = route(new URL(request.url).pathname);
    if (found === false) return Promise.resolve(none());
    const { leaseId, part } = found.params;
    const view = handlers(leaseId);
    if (view === null) return Promise.resolve(none());
    if (part === "view" && request.method === "GET")
      return Promise.resolve(view.page());
    if (part === "frame" && request.method === "GET")
      return view.frame(request.signal);
    if (part === "input" && request.method === "POST")
      return view.input(request, request.signal);
    return Promise.resolve(none());
  };
}
