import { z } from "zod";
import { channelIds } from "./ids.js";

/** The runtime needs a binding, not a Team or an authority projection. */
export type ConversationBinding = Readonly<{
  bindingId: string;
  lifecycle: "active" | "suspended";
  selector:
    | Readonly<{
        provider: "event";
        target: "new" | "named";
        verifier: "fungi-v1" | "github" | "secret-url";
        eventsPerMinute: number;
      }>
    | Readonly<{
        provider: "web";
        siteKey: string;
        origins: readonly string[];
        accent?: string | undefined;
      }>
    | Readonly<{ provider: "discord" | "email" | "game" }>;
  /** Zod's optional binding projection may carry an explicit undefined. */
  limits?: BindingLimits | undefined;
}>;

/** Does one allowlisted origin admit this exact browser origin? */
export function originAllowed(
  allowed: readonly string[],
  origin: string,
): boolean {
  return allowed.some((entry) => {
    if (!entry.startsWith("https://*.")) return entry === origin;
    const suffix = entry.slice("https://*".length);
    if (!origin.startsWith("https://") || !origin.endsWith(suffix))
      return false;
    const label = origin.slice("https://".length, -suffix.length);
    return label.length > 0 && !label.includes(".");
  });
}

/** Per-party edge limits applied before any work is accepted. */
export const bindingLimitsSchema = z.strictObject({
  messagesPerPartyPerDay: z.number().int().min(1).max(10_000),
  charsPerMessage: z.number().int().min(1).max(16_000),
  newPartiesPerHour: z.number().int().min(1).max(100_000),
});
/** Per-binding edge limits. */
export type BindingLimits = z.infer<typeof bindingLimitsSchema>;
/** Edge limits of a binding whose owner set none. */
export const DEFAULT_BINDING_LIMITS: BindingLimits = Object.freeze({
  messagesPerPartyPerDay: 30,
  charsPerMessage: 4_000,
  newPartiesPerHour: 200,
});

/**
 * Edge limits of an incoming-events binding whose owner set none. Events are
 * not people: `eventsPerMinute` bounds intake, so the
 * per-party and new-party limits sit at their ceilings, and one event may
 * carry the longest message intake accepts.
 */
const DEFAULT_EVENT_LIMITS: BindingLimits = Object.freeze({
  messagesPerPartyPerDay: 10_000,
  charsPerMessage: 16_000,
  newPartiesPerHour: 100_000,
});

/**
 * How long a GitHub body digest keeps a changed-id replay out: the verifiers'
 * signed-timestamp skew (Veil's `WEBHOOK_SIGNATURE_MAX_SKEW_SECONDS`; a test
 * pins them equal). GitHub signs no timestamp, so this window is the bound.
 */
export const EVENT_REPLAY_WINDOW_SECONDS = 300;

/** The edge limits one binding runs under: its owner's, else its kind's default. */
export function limitsOf(binding: ConversationBinding): BindingLimits {
  return (
    binding.limits ??
    (binding.selector.provider === "event"
      ? DEFAULT_EVENT_LIMITS
      : DEFAULT_BINDING_LIMITS)
  );
}

export const discordSnowflakeSchema = z.string().regex(/^\d{17,20}$/u);
/** The party on the other side of a channel conversation; never a member. */
export const channelPartySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("visitor"),
    visitorId: z
      .string()
      .refine(
        (value): boolean => channelIds.visitor.is(value),
        "Invalid visitor",
      ),
  }),
  z.strictObject({
    kind: z.literal("discord-user"),
    guildId: discordSnowflakeSchema,
    userId: discordSnowflakeSchema,
  }),
  z.strictObject({
    kind: z.literal("email-sender"),
    address: z.email(),
    dmarc: z.enum(["pass", "fail", "none"]),
  }),
  z.strictObject({
    kind: z.literal("player"),
    worldId: z.string().min(1).max(160),
    playerId: z.string().min(1).max(160),
  }),
  z.strictObject({
    kind: z.literal("source"),
    /** The sender's declared source identity, such as `github`. */
    source: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  }),
]);
/** One channel party. */
export type ChannelParty = z.infer<typeof channelPartySchema>;

/** Short human label for a party, used in author metadata and owner rows. */
export function partyLabel(party: ChannelParty): string {
  switch (party.kind) {
    case "visitor":
      return `Visitor ${party.visitorId.slice(-4)}`;
    case "discord-user":
      return `Discord user ${party.userId}`;
    case "email-sender":
      return party.dmarc === "pass"
        ? party.address
        : `${party.address} (unverified)`;
    case "player":
      return `Player ${party.playerId}`;
    case "source":
      return party.source;
  }
}
