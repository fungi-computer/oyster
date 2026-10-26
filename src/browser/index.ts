/**
 * `@fungi.computer/oyster/browser`: the one agent browser for the Hub and a
 * standalone Oyster. A host builds the port from a provider (`browserRunSessions`
 * or `bindingSessions` or `onboxBrowserSessions` on staging, plus Browser Run
 * Quick Reads when it has them), its
 * required metering owner and an event sink; `createBrowser` owns lease
 * ownership, egress policy and billing order; `browserCapabilitySource` is
 * the agent's `cloudBrowser` tool. Raw CDP stays internal to this directory.
 */
export {
  createBrowser,
  type Browser,
  type BrowserEvent,
  type BrowserHost,
  type BrowserLimits,
  type BrowserMemberAction,
  type BrowserMeter,
} from "./browser.js";
export {
  browserCapabilitySource,
  CLOUD_BROWSER_DESCRIPTIONS,
  type AgentBrowserDoor,
  type SaveBrowserFile,
} from "./capability-source.js";
export {
  CloudBrowserCapacityExceeded,
  CloudBrowserCreditDenied,
  CloudBrowserLeaseNotFound,
  CloudBrowserLeasePaused,
  CloudBrowserTimeout,
  CloudBrowserUnavailable,
  CloudBrowserUpstreamError,
  CloudBrowserUrlDenied,
  type CloudBrowserFailure,
} from "./errors.js";
export type { LeaseOwner } from "./lease-registry.js";
export {
  cloudBrowserBounds,
  extractInputSchema,
  extractResultSchema,
  linksResultSchema,
  markdownInputSchema,
  markdownResultSchema,
  navigateResultSchema,
  openResultSchema,
  scrapeInputSchema,
  scrapeResultSchema,
  snapshotResultSchema,
  type BinaryResult,
  type CloudBrowserAck,
  type CloudBrowserClosed,
  type CloudBrowserOperation,
  type CloudBrowserOperationResult,
  type ExtractInput,
  type ExtractResult,
  type LinksResult,
  type MarkdownInput,
  type MarkdownResult,
  type NavigateResult,
  type OpenResult,
  type ScrapeInput,
  type ScrapeResult,
  type SnapshotResult,
} from "./operations.js";
export type { CdpSocket, HttpFetch } from "./cdp-client.js";
export {
  browserRunQuickReads,
  type BrowserRunQuickReadsConfig,
  type QuickRead,
  type QuickReads,
} from "./quick-reads.js";
export {
  bindingSessions,
  browserRunSessions,
  onboxBrowserSessions,
  type BrowserBinding,
  type BrowserSessions,
  type CdpConnect,
} from "./sessions.js";
