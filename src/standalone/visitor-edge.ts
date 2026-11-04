import type { Context, Env as HonoEnv } from "hono";
import type { ConversationBinding } from "../channels/binding.js";
import {
  createVisitorEdge,
  type EdgeVerifiedVisitor,
  type VisitorEdgeChannel,
  type VisitorSiteFacts,
  type VisitorTurnstile,
} from "../channels/visitor-edge.js";
import type { AuthenticatedChannelVisitor } from "../channels/visitor-channel.js";
import type { ChannelVisitors } from "../channels/visitors.js";
import type { StandaloneAgentBase } from "./agents.js";
import { proveVisitor } from "./visitor-proof.js";

/** The central owner keeps every binding's visitor families and address caps.
 * A Durable Object can supply these four RPCs; no token store lives in Agents. */
export type StandaloneVisitorIdentity = Pick<
  ChannelVisitors,
  "mint" | "refresh" | "rotate" | "authenticate"
>;
export type StandaloneVisitorAgent = Pick<
  StandaloneAgentBase,
  | "sendChannelVisitor"
  | "withdrawChannelVisitor"
  | "latestPendingChannelVisitor"
  | "openChannelVisitor"
  | "watchChannelVisitor"
>;

/** A web binding and the Agent it puts in front of visitors. */
export type StandaloneVisitorBinding = ConversationBinding &
  Readonly<{ agentId: string }>;

/** A resolved site: the binding the edge enforces and the chrome it serves. */
export type StandaloneVisitorSite = Readonly<{
  binding: StandaloneVisitorBinding;
  facts: VisitorSiteFacts;
}>;

/**
 * Web sites with central identity and one dedicated Agent per site. The host
 * supplies the address salt, the site lookup and the Agent; the edge
 * authenticates before selecting an Agent and never sends a bearer into it.
 */
export function standaloneVisitorEdge<E extends HonoEnv>(host: {
  /** Re-read on every request and stream beat; suspension never freezes. */
  site: (
    context: Context<E>,
    siteKey: string,
  ) => StandaloneVisitorSite | null | Promise<StandaloneVisitorSite | null>;
  visitors: (context: Context<E>) => StandaloneVisitorIdentity;
  agent: (
    context: Context<E>,
    binding: StandaloneVisitorBinding,
    visitor: EdgeVerifiedVisitor<AuthenticatedChannelVisitor>,
  ) => StandaloneVisitorAgent | Promise<StandaloneVisitorAgent>;
  /** Private host secret shared with the Agent subclass, never the browser. */
  proofKey: (context: Context<E>) => string;
  addressHash: (context: Context<E>) => Promise<string>;
  turnstile: (context: Context<E>) => VisitorTurnstile;
  assetPath: (kind: "widget" | "styles") => string;
  onError: (error: Error, context: Context<E>) => Response | Promise<Response>;
}) {
  type Site = Readonly<{
    bindingId: string;
    binding: StandaloneVisitorBinding;
    facts: VisitorSiteFacts;
  }>;
  const identityDoor = (
    context: Context<E>,
    site: Site,
  ): VisitorEdgeChannel => ({
    [Symbol.dispose]: () => undefined,
    readChannelSite: ({ bindingId, siteKey: key }) =>
      Promise.resolve(
        bindingId === site.bindingId &&
          site.binding.selector.provider === "web" &&
          key === site.binding.selector.siteKey &&
          site.binding.lifecycle === "active"
          ? site.facts
          : null,
      ),
    mintChannelVisitor: ({ siteKey: key, addressHash }) =>
      host.visitors(context).mint(site.binding, key, addressHash),
    refreshChannelVisitor: ({ refreshSecret }) =>
      host.visitors(context).refresh(site.binding, refreshSecret),
    rotateChannelVisitor: ({ siteKey: key, accessToken, addressHash }) =>
      host
        .visitors(context)
        .rotate(site.binding, key, accessToken, addressHash),
    sendAsChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
    withdrawAsChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
    latestPendingAsChannelVisitor: () =>
      Promise.resolve({ kind: "unauthorized" }),
    openVisitorSession: () => Promise.resolve({ kind: "unauthorized" }),
    watchAsChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
    // The old GET /conversation has no standalone caller. Do not invent an
    // unauthenticated site-wide transcript for a per-visitor Agent directory.
    readAsChannelVisitor: () => Promise.resolve({ kind: "unauthorized" }),
  });
  return createVisitorEdge<E, Site, AuthenticatedChannelVisitor>({
    resolveSite: async (context, key) => {
      const resolved = await host.site(context, key);
      if (resolved === null) return null;
      const { binding, facts } = resolved;
      return binding.selector.provider === "web" &&
        binding.selector.siteKey === key
        ? { bindingId: binding.bindingId, binding, facts }
        : null;
    },
    openSite: (context, site) => Promise.resolve(identityDoor(context, site)),
    authenticateVisitor: (context, site, token) =>
      host.visitors(context).authenticate(site.bindingId, token),
    openChannel: async (context, site, visitor) => {
      const proven = await proveVisitor(
        site.bindingId,
        visitor,
        host.proofKey(context),
      );
      const agent = await host.agent(context, site.binding, visitor);
      const identity = identityDoor(context, site);
      return {
        [Symbol.dispose]: () => undefined,
        readChannelSite: identity.readChannelSite,
        mintChannelVisitor: identity.mintChannelVisitor,
        refreshChannelVisitor: identity.refreshChannelVisitor,
        rotateChannelVisitor: identity.rotateChannelVisitor,
        readAsChannelVisitor: identity.readAsChannelVisitor,
        sendAsChannelVisitor: ({ requestId, text }) =>
          agent.sendChannelVisitor(site.bindingId, proven, requestId, text),
        withdrawAsChannelVisitor: ({ requestId }) =>
          agent.withdrawChannelVisitor(site.bindingId, proven, requestId),
        latestPendingAsChannelVisitor: () =>
          agent.latestPendingChannelVisitor(site.bindingId, proven),
        openVisitorSession: ({ options }) =>
          agent.openChannelVisitor(site.bindingId, proven, options),
        watchAsChannelVisitor: () =>
          agent.watchChannelVisitor(site.bindingId, proven),
      };
    },
    addressHash: host.addressHash,
    turnstile: host.turnstile,
    assetPath: host.assetPath,
    onError: host.onError,
  });
}
