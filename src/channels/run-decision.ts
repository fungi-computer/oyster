import type { ConversationBinding } from "./binding.js";

/**
 * Whether one Session of an Agent may run, and under which channel binding.
 * A channel never narrows or widens the Agent's own tools and permissions; it
 * only admits or refuses the run. A missing, suspended or unreadable binding
 * denies the run.
 */
export type ChannelRunDecision<B extends ConversationBinding> =
  | Readonly<{ kind: "private" }>
  | Readonly<{ kind: "channel"; binding: B }>
  | Readonly<{ kind: "denied"; bindingId: string; reason: ChannelDenial }>;

/** Why a channel Session may not run. */
export type ChannelDenial =
  "binding_missing" | "binding_suspended" | "lookup_failed";

/**
 * Decide one Session. `conversationBindingId` is the binding the Session was
 * opened under (null for an owner Session); `binding` is that binding as the
 * Agent currently knows it, or null when it knows none.
 */
export function decideChannelRun<B extends ConversationBinding>(
  input: Readonly<{
    conversationBindingId: string | null;
    binding: B | null;
  }>,
): ChannelRunDecision<B> {
  const { conversationBindingId: bindingId, binding } = input;
  if (bindingId === null) return { kind: "private" };
  if (binding?.bindingId !== bindingId)
    return { kind: "denied", bindingId, reason: "binding_missing" };
  if (binding.lifecycle !== "active")
    return { kind: "denied", bindingId, reason: "binding_suspended" };
  return { kind: "channel", binding };
}

/** Run the lookup and decision together; a throwing lookup denies. */
export function decideChannelRunSafely<B extends ConversationBinding>(
  lookup: () => Readonly<{
    conversationBindingId: string | null;
    binding: B | null;
  }>,
  sessionId: string,
  onFailure: (cause: unknown) => void,
): ChannelRunDecision<B> {
  try {
    return decideChannelRun(lookup());
  } catch (cause) {
    onFailure(cause);
    return { kind: "denied", bindingId: sessionId, reason: "lookup_failed" };
  }
}
