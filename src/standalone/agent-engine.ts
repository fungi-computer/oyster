import type {
  ColdSessionPage,
  ColdSessionPageRequest,
} from "@fungi.computer/shiitake";
import {
  ShiitakeOwner,
  type CloudflareShiitake,
  type CloudflareShiitakeOptions,
  type CloudflareShiitakeState,
  type SessionInboxChanges,
} from "@fungi.computer/shiitake/cloudflare";
import type { StandaloneAgentEnv } from "./agents.js";

/**
 * The engine an Oyster Agent's Durable Object composes. The Durable Object
 * keeps Oyster's own Agent state (policy pin, MCP servers, channels); the
 * engine owns Sessions, their wire and their wakes. Shiitake is the only
 * engine today.
 */
export type AgentEngine = Readonly<{
  kind: "shiitake";
  /** Serve one request on the Session wire. */
  fetch: (request: Request) => Promise<Response>;
  /** Reconcile due runtime and host work after a native alarm. */
  alarm: () => Promise<void>;
  /** Persist a wake and run one reconciliation pass now. */
  wake: () => Promise<void>;
  /** The open Session agent, for App sends, channels and fleet operations. */
  agent: () => Promise<CloudflareShiitake>;
  /** Bounded strict-after read of the Agent's changed inbox rows. */
  inboxChanges: (after: number, limit: number) => Promise<SessionInboxChanges>;
  /** Latest inbox clock, without reading Session rows. */
  inboxRevision: () => Promise<number>;
  /** Whether a readable Session is stored under this id. */
  hasStoredSession: (sessionId: string) => Promise<boolean>;
  /** One bounded page of cold Sessions for the store keeper. */
  coldSessions: (request: ColdSessionPageRequest) => Promise<ColdSessionPage>;
  /** Close owned resources before storage erasure; a cold engine has none. */
  close: () => Promise<void>;
}>;

/** Shiitake as an Agent engine: its composable Cloudflare owner, unchanged. */
export function shiitakeEngine(
  ctx: CloudflareShiitakeState,
  env: StandaloneAgentEnv,
  options: () => CloudflareShiitakeOptions | Promise<CloudflareShiitakeOptions>,
): AgentEngine {
  const owner = new (class extends ShiitakeOwner<StandaloneAgentEnv> {
    protected override shiitakeOptions() {
      return options();
    }
  })(ctx, env);
  return {
    kind: "shiitake",
    fetch: (request) => owner.fetch(request),
    alarm: () => owner.alarm(),
    wake: () => owner.wakeRuntime(),
    agent: () => owner.shiitake(),
    inboxChanges: (after, limit) => owner.readInboxChanges(after, limit),
    inboxRevision: async () => {
      await owner.shiitake();
      return owner.readInboxRevision();
    },
    hasStoredSession: (sessionId) => owner.hasStoredSession(sessionId),
    coldSessions: (request) => owner.readColdSessions(request),
    close: () => owner.closeShiitake(),
  };
}
