import { authorMeta } from "@fungi.computer/agar/agents";
import { ShiitakeError } from "@fungi.computer/shiitake";
import type { ShiitakeOwnerAgent } from "@fungi.computer/shiitake/cloudflare";
import {
  participantSnapshot,
  visitorPendingPrompt,
  visitorSnapshot,
  type ParticipantPolicy,
} from "@fungi.computer/shiitake/client";
import { visitorStream } from "@fungi.computer/shiitake/server-visitor-stream";
import type {
  ChannelConversations,
  SessionDoor,
} from "../channels/conversations.js";

/** Translate a standalone Agent's Shiitake owner into Oyster's channel Session port. */
export function channelSessionDoor(
  open: () => Promise<ShiitakeOwnerAgent>,
  deliverGrants: (sessionId: string) => void,
  conversations: () => ChannelConversations,
): SessionDoor {
  const policy = (): ParticipantPolicy => conversations();
  return {
    createSession: async (requestId) => (await open()).createSession(requestId),
    deliverGrants,
    withdraw: async (sessionId, requestId) =>
      (await open()).session(sessionId).withdraw(requestId),
    latestPending: async (sessionId, visitor) => {
      const prompt = await (
        await open()
      )
        .withMeta(authorMeta(visitor))
        .session(sessionId)
        .latestPending();
      return prompt === null ? null : visitorPendingPrompt(prompt, visitor.id);
    },
    participantDocument: async (sessionId, visitorId, options) => {
      const snapshot = await (await open()).session(sessionId).read(options);
      return JSON.stringify(
        visitorSnapshot(participantSnapshot(snapshot, policy()), visitorId),
      );
    },
    participantStream: async (sessionId, visitorId, options) => {
      let watch;
      try {
        watch = await (await open()).session(sessionId).watch();
      } catch (cause) {
        options.release();
        throw cause;
      }
      return visitorStream({
        ...options,
        watch,
        visitorId,
        filter: (snapshot) => participantSnapshot(snapshot, policy()),
        read: async () => (await open()).session(sessionId).read(),
        onError: (event, cause) => {
          console.warn(event, cause);
        },
      });
    },
    prompt: async (sessionId, { requestId, text, meta }) => {
      // The conversation row exists now, so its channel admission is known;
      // deliver Agent tools before the first run can call one.
      deliverGrants(sessionId);
      const agent = await open();
      return await agent.withMeta(meta).session(sessionId).command({
        type: "prompt",
        requestId,
        text,
        delivery: "followUp",
      });
    },
    line: async (sessionId, input) => {
      const agent = await open();
      const meta =
        input.author === "operator" ? authorMeta(input.identity) : input.meta;
      await agent.withMeta(meta).session(sessionId).command({
        type: "operator",
        requestId: input.requestId,
        author: input.author,
        text: input.text,
      });
    },
    errorKind: (error, requestId) =>
      error instanceof ShiitakeError &&
      error.boundary === "contract" &&
      error.cause === "closed" &&
      error.requestId === requestId
        ? "closed_request"
        : null,
  };
}
