import { partyLabel, type ConversationBinding } from "./binding.js";
import {
  channelRequestId,
  type ChannelConversations,
  type ChannelWithdrawResult,
  type InboundEvent,
  type IntakeResult,
  type SessionDoor,
  type VisitorPendingPrompt,
  type VisitorReadOptions,
} from "./conversations.js";
import { visitorMessageId, visitorRequestSchema } from "./visitor-request.js";
import type { ChannelVisitors, VisitorGrant } from "./visitors.js";

/**
 * Web visitor sequencing only. The host owns authorization, its admission
 * receipt and the Session implementation; identity and conversations can live
 * in different stores (and, in standalone, different Agents).
 */
export function createVisitorChannel(
  options: Readonly<{
    binding: (bindingId: string) => ConversationBinding | null;
    visitors: () => ChannelVisitors;
    conversations: () => ChannelConversations;
    sessionDoor: () => SessionDoor;
    intake: (event: InboundEvent) => Promise<IntakeResult>;
    acquireStream: (
      bindingId: string,
      visitorId: string,
      addressHash: string,
    ) => (() => void) | null;
    now: () => number;
  }>,
) {
  const active = (bindingId: string): ConversationBinding | null => {
    const binding = options.binding(bindingId);
    return binding?.lifecycle === "active" &&
      binding.selector.provider === "web"
      ? binding
      : null;
  };
  const authenticate = (bindingId: string, token: string) =>
    options.visitors().authenticate(bindingId, token);

  return {
    mint: (
      bindingId: string,
      siteKey: string,
      addressHash: string,
    ): Promise<VisitorGrant> =>
      options.visitors().mint(options.binding(bindingId), siteKey, addressHash),
    refresh: (bindingId: string, secret: string): Promise<VisitorGrant> =>
      options.visitors().refresh(options.binding(bindingId), secret),
    rotate: async (
      bindingId: string,
      siteKey: string,
      token: string,
      addressHash: string,
    ): Promise<VisitorGrant | Readonly<{ kind: "unauthorized" }>> => {
      const visitors = options.visitors();
      const visitor = await visitors.authenticate(bindingId, token);
      if (visitor === null) return { kind: "unauthorized" };
      visitors.forget(visitor.visitorId);
      return await visitors.mint(
        options.binding(bindingId),
        siteKey,
        addressHash,
      );
    },
    send: async (
      bindingId: string,
      token: string,
      requestId: string,
      text: string,
    ): Promise<IntakeResult | Readonly<{ kind: "unauthorized" }>> => {
      const visitor = await authenticate(bindingId, token);
      if (visitor === null) return { kind: "unauthorized" };
      const { visitorId } = visitor;
      return options.intake({
        bindingId,
        conversation: visitorId,
        eventId: await visitorMessageId(requestId),
        party: { kind: "visitor", visitorId },
        text,
        sourceRequestId: requestId,
      });
    },
    withdraw: async (
      bindingId: string,
      token: string,
      rawRequestId: string,
    ): Promise<
      | ChannelWithdrawResult
      | Readonly<{ kind: "unauthorized" }>
      | Readonly<{
          kind: "denied";
          reason: "event_conflict" | "new_party_limit" | "banned";
        }>
    > => {
      const binding = active(bindingId);
      const visitor = await authenticate(bindingId, token);
      if (visitor === null || binding === null) return { kind: "unauthorized" };
      const { requestId } = visitorRequestSchema.parse({
        requestId: rawRequestId,
      });
      const eventId = await visitorMessageId(requestId);
      const conversations = options.conversations();
      if (
        conversations.visitorEventConflict(
          bindingId,
          visitor.visitorId,
          eventId,
        )
      )
        return { kind: "denied", reason: "event_conflict" };
      const opened = await conversations.open(binding, visitor.visitorId, {
        kind: "visitor",
        visitorId: visitor.visitorId,
      });
      if (opened.kind === "denied") return opened;
      return options
        .sessionDoor()
        .withdraw(
          opened.conversation.sessionId,
          channelRequestId(binding.bindingId, eventId),
        );
    },
    latestPending: async (
      bindingId: string,
      token: string,
    ): Promise<
      VisitorPendingPrompt | null | Readonly<{ kind: "unauthorized" }>
    > => {
      const binding = active(bindingId);
      const visitor = await authenticate(bindingId, token);
      if (visitor === null || binding === null) return { kind: "unauthorized" };
      const { visitorId } = visitor;
      const conversation = options.conversations().find(bindingId, visitorId);
      if (conversation === null) return null;
      return await options.sessionDoor().latestPending(conversation.sessionId, {
        id: visitorId,
        name: partyLabel({ kind: "visitor", visitorId }),
      });
    },
    open: async (
      bindingId: string,
      token: string,
      read: VisitorReadOptions,
    ): Promise<
      | Readonly<{ kind: "session"; snapshot: string }>
      | Readonly<{ kind: "unauthorized" }>
      | Readonly<{ kind: "denied"; reason: "new_party_limit" | "banned" }>
    > => {
      const binding = active(bindingId);
      const visitor = await authenticate(bindingId, token);
      if (visitor === null || binding === null) return { kind: "unauthorized" };
      const { visitorId } = visitor;
      const opened = await options.conversations().open(binding, visitorId, {
        kind: "visitor",
        visitorId,
      });
      if (opened.kind === "denied") return opened;
      return {
        kind: "session",
        snapshot: await options
          .sessionDoor()
          .participantDocument(opened.conversation.sessionId, visitorId, read),
      };
    },
    watch: async (
      bindingId: string,
      token: string,
      canRead: (visitorId: string) => Promise<boolean>,
    ): Promise<
      | Readonly<{ kind: "stream"; body: ReadableStream<Uint8Array> }>
      | Readonly<{ kind: "empty" | "unauthorized" }>
      | Readonly<{ kind: "denied"; reason: "suspended" | "stream_limit" }>
    > => {
      const visitor = await authenticate(bindingId, token);
      if (visitor === null) return { kind: "unauthorized" };
      if (options.binding(bindingId)?.lifecycle !== "active")
        return { kind: "denied", reason: "suspended" };
      const { visitorId } = visitor;
      const conversation = options.conversations().find(bindingId, visitorId);
      if (conversation === null) return { kind: "empty" };
      const release = options.acquireStream(
        bindingId,
        visitorId,
        visitor.addressHash,
      );
      if (release === null) return { kind: "denied", reason: "stream_limit" };
      return {
        kind: "stream",
        body: await options
          .sessionDoor()
          .participantStream(conversation.sessionId, visitorId, {
            expiresAt: visitor.expiresAt,
            now: options.now,
            release,
            canRead: () => canRead(visitorId),
          }),
      };
    },
  };
}
