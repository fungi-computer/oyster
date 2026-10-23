import type { CapabilitySource } from "@fungi.computer/mycelium";
import {
  bindingSessions,
  browserCapabilitySource,
  createBrowser,
  type Browser,
  type BrowserBinding,
  type BrowserMeter,
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

/**
 * The agent's `cloudBrowser` tool on a standalone Oyster, or an empty source
 * when the deployment declares no BROWSER binding. Driven sessions only: no
 * Quick Reads, no Computer save, no member handoff on this host.
 */
export function standaloneBrowserSource(
  binding: BrowserBinding | undefined,
  identity: () => Readonly<{ teamId: string; agentId: string }>,
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
    saveFile: null,
    requestHandoff: null,
  });
}
